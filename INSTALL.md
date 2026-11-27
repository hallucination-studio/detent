# Install Detent with your coding agent

Run this procedure from the repository root in Claude Code, Codex, Antigravity, or Cursor. Docker Engine and Compose v2 or later run the whole installation, including bootstrap. Keep shell tracing off. Read credentials from the user's local environment or secret manager. Keep their values out of chat, command arguments, logs, and Git.

## 1. Collect the installation parameters

| Input | Requirement | Values |
| --- | --- | --- |
| GitLab access | Required | `GITLAB_BASE_URL` reachable **from Detent**, plus `GITLAB_ADMIN_TOKEN` to provision a bot and PAT, or `GITLAB_TOKEN` for an existing dedicated bot. The latter needs `api`, `read_repository`, and `write_repository` scopes, permission to provision the Hub, Maintainer access to manage project hooks, and sufficient group access to manage any requested memberships. |
| Webhook callback | Required | `DETENT_PUBLIC_URL` reachable **from GitLab**, e.g. `https://detent.example.com`. Use the service base URL. Bootstrap appends `/webhooks/gitlab`. |
| Target repositories | Required | `DETENT_TARGET_GROUPS` or `DETENT_TARGET_PROJECTS`, or both. Each accepts comma-separated paths or numeric IDs. Groups must exist. Group discovery uses GitLab’s active project list, including subgroups and projects shared with the group. An explicit missing project path requests creation. |
| Model access | Required | `ANTHROPIC_API_KEY`. Optionally set `ANTHROPIC_BASE_URL` for an Anthropic Messages-compatible gateway and `CLAUDE_MODEL` for a model available to this key. |
| Jev risk assessment | Optional | `JEV_PROVIDER=bailian` with `JEV_BASE_URL` and `JEV_API_KEY`, or `JEV_PROVIDER=typesafe` with `JEV_API_KEY`. Set `JEV_MODEL` if needed. Default is off. |
| JumpServer | Optional | `JUMPSERVER_BASE_URL` and distinct read-only and Job Center credentials. Set `JUMPSERVER_READONLY_TOKEN` and `JUMPSERVER_JOB_TOKEN`, or configure the corresponding access key ID/secret pairs. |

Create a mode-0600 `.env` if absent (`umask 077 && touch .env && chmod 600 .env`). Populate it locally with the supplied **runtime** values from the table, plus `MYSQL_HOST=mysql`. For a fresh MySQL volume, generate a random hex `MYSQL_PASSWORD` and save it here before starting MySQL. On reruns reuse the existing file, database settings, bot PAT, Hub ID and webhook secret. Use Compose-compatible dotenv quoting for credentials. The example file documents supported keys and contains placeholder credentials. [Environment reference](./.env.example)

Export the **install-only** inputs in the agent's shell: `GITLAB_ADMIN_TOKEN` if supplied, the target selectors, and optionally `DETENT_HUB_PROJECT` (default `ai/workspace-hub`). Keep them available for subsequent provisioning runs. If using an existing Hub, set `GITLAB_HUB_PROJECT_ID` in `.env`. Check for stale shell overrides of `PORT` and `MYSQL_*` before running Compose.

## 2. Run preflight checks

Run `docker compose version`, `docker compose config --quiet`, then `docker compose build detent`. Use quiet config validation because the expanded Compose configuration contains credentials.

Check GitLab identity and send one Messages request with a one-token output limit from the Detent container. The probe prints only operation names and status codes. Resolve any failure before provisioning.

```sh
docker compose run --rm --no-deps -T -e GITLAB_ADMIN_TOKEN detent node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const e = process.env;
async function probe(name, url, options) {
  const r = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  console.log(name, r.status);
  if (!r.ok) process.exit(1);
}
await probe('GitLab identity', e.GITLAB_BASE_URL.replace(/\/$/, '') + '/api/v4/user', {
  headers: { 'PRIVATE-TOKEN': e.GITLAB_ADMIN_TOKEN || e.GITLAB_TOKEN }
});
await probe('Model ping', (e.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': e.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({ model: e.CLAUDE_MODEL || parseEnv(readFileSync('.env.example', 'utf8')).CLAUDE_MODEL,
    max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
});
JS
```

Check the return route **from the GitLab host or container that delivers webhooks**. Inside a GitLab container, `127.0.0.1` points to GitLab itself. Configure DNS, proxy routing and GitLab outbound webhook permissions for the intended destination. For GitLab on the Docker host, Detent can reach a host service via `host.docker.internal`.

If Detent is already running, request `<DETENT_PUBLIC_URL>/healthz` from GitLab and require HTTP 200. On a fresh install, start this temporary responder on Detent's published port, then request the same URL from GitLab and check for the exact body `detent-preflight`. Stop the probe with `docker stop "$probe_id"` immediately after the check, including on failure. If the GitLab-side probe requires operator access, record that check as pending until the operator verifies it.

```sh
probe_id=$(docker compose run -d --rm --service-ports --no-deps detent node -e \
  "require('node:http').createServer((q,r)=>r.end('detent-preflight')).listen(process.env.PORT||3000,'0.0.0.0')")
# Run in the GitLab network context with the actual public base URL:
# curl --fail --silent --show-error --max-time 10 "${DETENT_PUBLIC_URL%/}/healthz"
```

## 3. Start MySQL and wait for health

```sh
docker compose up -d mysql
docker compose up -d --wait --wait-timeout 180 mysql
```

Continue on success. The named volume `mysql_data` retains database state. Existing volumes require their original database credentials.

## 4. Bootstrap GitLab

Run once at a time. Mount the checkout directory so bootstrap can atomically replace the host's `.env`. Running as the host UID preserves ownership of the mode-0600 output. Node 22 in the image runs the TypeScript script directly.

```sh
docker compose run --rm --no-deps -T \
  --user "$(id -u):$(id -g)" -v "$PWD:/install" -w /install \
  -e GITLAB_ADMIN_TOKEN -e DETENT_TARGET_GROUPS -e DETENT_TARGET_PROJECTS -e DETENT_HUB_PROJECT \
  -e MYSQL_HOST=mysql detent node /app/scripts/bootstrap.ts --welcome-issue --env-out .env
```

With an admin token, bootstrap creates or opens the Hub and grants `@detent-bot` Owner (50) on that project. With only the bot PAT, grant the bot effective Maintainer (40) or Owner (50) access to the Hub first. Bootstrap uses the bot PAT to seed Hub files, create labels, configure the Hub webhook, and post the optional welcome Issue. It grants Developer (30) on target business projects and groups, preserving any higher existing access.

Bootstrap prints the bot username and each configured project. Repeat this step with the same file and selectors to pick up new group projects. The welcome option creates a bot-authored Issue only in an empty Hub, counting both open and closed Issues. Ordinary bootstrap runs leave Issues alone unless `--welcome-issue` or `DETENT_WELCOME_ISSUE=true` is supplied.

## 5. Start Detent and verify the handoff

```sh
docker compose up -d detent
docker compose up -d --wait --wait-timeout 180 detent
```

From GitLab, request `<DETENT_PUBLIC_URL>/healthz` again. Require HTTP **200** and JSON with `ok: true`. Then run this read-only check with the runtime bot PAT. For a fresh Hub, require the exact Welcome Issue title and bot author. For a previously occupied Hub, report a skipped Welcome Issue if it was never created.

```sh
docker compose exec -T detent node --input-type=module <<'JS'
const e = process.env;
async function get(path) {
  const r = await fetch(e.GITLAB_BASE_URL + '/api/v4' + path, {
    headers: { 'PRIVATE-TOKEN': e.GITLAB_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw Error('GitLab HTTP ' + r.status);
  return r.json();
}
const bot = await get('/user');
const hub = await get('/projects/' + e.GITLAB_HUB_PROJECT_ID);
const title = '🎉 Detent 已就绪 — 1 分钟上手与接入自检';
const issues = await get('/projects/' + hub.id + '/issues?' + new URLSearchParams({
  search: title, in: 'title', author_id: String(bot.id)
}));
const welcome = issues.find(i => i.title === title && i.author.id === bot.id);
console.log('Hub', hub.web_url, 'Bot', '@' + bot.username);
console.log(welcome ? 'Welcome ' + welcome.web_url : 'Welcome Issue absent');
JS
```

Give the user the verified Hub URL, bot `@username`, Welcome Issue link or skip reason, and health result. Redact all secrets. Finish with three lines of usage guidance:

1. Open a Hub Issue, select a template, and name the target repository and task.
2. Comment `/status` to see progress. React 👍 or 👎 on the approval card to approve or reject.
3. Assign an open target MR to the bot for review and CI follow-up.
