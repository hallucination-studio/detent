import { runHubCapabilities } from './suites/phase5-hub-capabilities.js';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createOfflineAnthropic } from './offline-anthropic.js';
import { checkStartupFailures, brownfieldOnboarding, protectedHubInstall, standaloneAndUpgrade } from './suites/phase0-install.js';
import { onboardPayment, runIssueScenarios } from './suites/phase1-issues.js';
import { checkSession } from './suites/harness.js';
import { runConcurrency } from './suites/phase3-concurrency.js';
import { runSecurity } from './suites/phase4-security.js';
import { webhookProxy } from './suites/cluster.js';
import { runMrScenarios, verifyOnboardedMr } from './suites/phase2-mrs.js';
import { gitlabApi } from './gitlab-driver.js';
import { liveGitLab } from './live-gitlab.js';
import { offlineGitLab } from './offline-gitlab.js';
import { offlineJev } from './offline-jev.js';
import { offlineJumpServer } from './offline-jumpserver.js';
import { imageMirror, offlineMcp } from './offline-mcp.js';

const run = promisify(execFile);
const loopback = '127.0.0.1';
async function listen(server: Server, port = 0, host = loopback) {
  server.listen(port, host);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}
function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function main() {
  const tmp = await mkdtemp('/tmp/detent-e2e-');
  const cleanup: (() => Promise<unknown>)[] = [() => rm(tmp, { recursive: true, force: true })];
  let failure: Error | undefined;
  const pods = new Set<ChildProcess>();
  const interrupt = () => { failure = Error('E2E interrupted'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  async function until<T>(label: string, probe: () => Promise<T> | T) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      for (const pod of pods) if ((pod.exitCode !== null || pod.signalCode !== null)) throw Error('Delivery exited while waiting for ' + label);
      const value = await probe();
      if (value) return value;
      await delay(150);
    }
    throw Error('Timed out waiting for ' + label);
  }

  // Serve the same HTTP Request/Response contract for JSON, SSE, multipart, and binary Git traffic.
  async function serve(handler: (req: Request) => Promise<Response>, bindPort = 0) {
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const request = new Request('http://' + loopback + ':' + req.socket.localPort + req.url, {
          method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        failure ??= error instanceof Error ? error : Error(String(error));
        res.writeHead(500).end();
      }
    });
    const port = await listen(server, bindPort);
    return { baseUrl: 'http://' + loopback + ':' + port, close: () => close(server) };
  }

  async function stopPod(requireCleanExit = false) {
    await Promise.all([...pods].map(child => stopChild(child, requireCleanExit)));
  }

  async function stopChild(child: ChildProcess, requireCleanExit: boolean) {
    pods.delete(child);
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      assert.ok(!requireCleanExit, 'Expected a running Pod for a planned restart');
      return;
    }
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    // Allow active turns and the SDK's five-second transport teardown to drain on planned restarts.
    // Failed runs may still hold an approval, so bound their cleanup separately.
    const kill = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, requireCleanExit ? 90_000 : 4000);
    try {
      const [code] = await stopped;
      if (requireCleanExit) assert.equal(code, 0, 'Pod must finish draining webhooks and MR turns');
    } finally { clearTimeout(kill); }
  }

  try {
    const env = process.env;
    if (env.npm_lifecycle_event === 'e2e:gitlab') assert.ok(env.E2E_GITLAB_URL, 'Set E2E_GITLAB_URL for live GitLab');
    const gitlab = env.E2E_GITLAB_URL ? liveGitLab(env.E2E_GITLAB_URL) : await offlineGitLab(tmp, serve);
    cleanup.push(gitlab.close);
    await gitlab.ensureUsers();
    const { web: webRepo, api: apiRepo, ansible: ansibleRepo } = gitlab.targetProjects;
    const jms = offlineJumpServer({ ansibleRepo });
    const jmsServer = await serve(jms.handle);
    cleanup.push(jmsServer.close);
    const vaultCanary = randomUUID();
    const securityReport = jms.securityReport + '\n' + vaultCanary;
    const anthropic = createOfflineAnthropic({ webRepo, apiRepo, ansibleRepo, securityReport });
    const mock = await serve(anthropic.handle);
    cleanup.push(mock.close);
    const jev = offlineJev();
    const jevServer = await serve(jev.handle);
    cleanup.push(jevServer.close);
    const mcp = offlineMcp();
    const mcpServer = await serve(mcp.handle);
    cleanup.push(mcpServer.close);
    const capabilitiesFile = join(tmp, 'mcp-capabilities.json');
    await writeFile(capabilitiesFile, JSON.stringify({ capabilities: [{
      name: 'static-registry', approverTier: 'prod', toolPolicies: { check_image_exists: 'readonly' },
      transport: { type: 'streamable-http', url: mcpServer.baseUrl + '/mcp', headers: { Authorization: 'Bearer ${HARBOR_SYNC_TOKEN}' } },
    }] }));
    const external = env.E2E_MYSQL_HOST;
    const host = external || loopback;
    assert.ok([loopback, 'localhost', '::1'].includes(host), 'E2E_MYSQL_HOST must be local');
    const user = external ? env.E2E_MYSQL_USER ?? 'root' : 'detent';
    const password = external ? env.E2E_MYSQL_PASSWORD ?? '' : randomUUID();
    const database = external ? env.E2E_MYSQL_DATABASE ?? 'detent' : 'detent';
    let port = Number(env.E2E_MYSQL_PORT ?? 3306);
    const rootPassword = external ? password : randomUUID();
    if (!external) {
      const name = 'detent-e2e-' + randomUUID();
      await run('docker', ['run', '--pull=never', '--rm', '-d', '--name', name, '-p', loopback + '::3306',
        '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_ROOT_HOST=%', '-e', 'MYSQL_DATABASE=detent', '-e', 'MYSQL_USER=detent',
        '-e', 'MYSQL_PASSWORD', 'mysql:8.0'], { env: { ...env, MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_PASSWORD: password } });
      cleanup.push(() => run('docker', ['rm', '-f', name]));
      const binding = await run('docker', ['port', name, '3306/tcp']);
      port = Number(binding.stdout.trim().split(':').at(-1));
    }
    const db = mysql.createPool({ host, port, user, password, database, connectTimeout: 2000 });
    cleanup.push(() => db.end());
    const rows = async (sql: string, params: (string | number)[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0];
    const ready = await until('MySQL 8.0', async () => {
      try { return (await rows('SELECT VERSION() AS version'))[0]; } catch (error) {
        if (external) throw error;
      }
    });
    assert.match(ready.version, /^8\.0\./);

    const reservation = createServer();
    const podPort = await listen(reservation, Number(env.E2E_POD_PORT ?? 0), gitlab.podHost);
    cleanup.push(async () => { if (reservation.listening) await close(reservation); });
    const publicUrl = gitlab.detentPublicUrl(podPort);
    const sandbox = join(tmp, 'sandboxes'), envFile = join(tmp, '.env');
    await mkdir(sandbox);
    const localEnv = { PATH: env.PATH, HOME: tmp, TMPDIR: tmp };
    const provision = (extra: Record<string, string> = {}, welcome = false) => run(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/bootstrap.ts', '--env-out', envFile, ...(welcome ? ['--welcome-issue'] : [])], {
      env: { ...localEnv, GITLAB_BASE_URL: gitlab.baseUrl, GITLAB_ADMIN_TOKEN: gitlab.adminToken, DETENT_PUBLIC_URL: publicUrl,
        DETENT_HUB_PROJECT: gitlab.hubProjectPath, DETENT_TARGET_PROJECTS: [webRepo, apiRepo, ansibleRepo].join(','),
        DETENT_HUB_MEMBERS: gitlab.devUsername + ':30,' + gitlab.sreUsername + ':40',
        DETENT_BOT_USERNAME: 'e2e-detent-bot', DETENT_BOT_EMAIL: 'e2e-detent-bot@detent.local',
        DETENT_BOT_TOKEN_EXPIRES_AT: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        HOST: gitlab.podHost, PORT: String(podPort), EPHEMERAL_ROOT: sandbox, MYSQL_HOST: host, MYSQL_PORT: String(port),
        MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: database, ANTHROPIC_API_KEY: 'offline-api-key',
        ANTHROPIC_BASE_URL: mock.baseUrl, ...extra },
      timeout: 180000,
    });
    await provision({ DETENT_MCP_CAPABILITIES_FILE: capabilitiesFile });
    const noJmsFile = join(tmp, 'initial.env');
    await copyFile(envFile, noJmsFile);
    const config = parseEnv(await readFile(envFile, 'utf8'));
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal(config.GITLAB_ADMIN_TOKEN, undefined);
    assert.equal(config.DETENT_MCP_CAPABILITIES_FILE, capabilitiesFile);
    assert.equal(config.JEV_ROUTING_THRESHOLD, '0.8');
    const hub = Number(config.GITLAB_HUB_PROJECT_ID);
    const admin = gitlabApi(gitlab.baseUrl, gitlab.adminToken);
    if (env.E2E_GITLAB_URL) cleanup.push(() => admin.request('/personal_access_tokens/self', 'DELETE', undefined, config.GITLAB_TOKEN));
    const [developer] = await admin.json<{ id: number }[]>('/users?username=' + gitlab.devUsername);
    const project = (path: string) => admin.json<{ id: number; path_with_namespace: string }>('/projects/' + encodeURIComponent(path));
    const projects = await Promise.all([gitlab.hubProjectPath, webRepo, apiRepo, ansibleRepo].map(project));
    const [hubProject, web, api, target] = projects;
    assert.equal(hubProject.id, hub);
    assert.equal(new Set(projects.map(p => p.id)).size, 4);
    const releasePath = 'agents/release/AGENT.md';
    const imagePath = 'agents/image-sync/AGENT.md';
    const hubFile = (path: string) => gitlab.getFile(hub, path);
    const templates = ['README.md', 'CLAUDE.md', 'events.json', 'capabilities.json', imagePath, 'agents/image-sync/skills/mirror-to-harbor/SKILL.md', 'skills/gitlab-mr-conventions/SKILL.md'];
    for (const name of ['audit', 'code-delivery', 'env-change', 'release', 'onboarding'])
      templates.push('agents/' + name + '/AGENT.md', '.gitlab/issue_templates/' + name + '.md');
    for (const path of templates)
      assert.equal(await hubFile(path), await readFile(join('examples/hub-workspace', path), 'utf8'), path);

    const savedSop = await hubFile(releasePath) + '\nInclude the change ticket in release notes.\n';
    await gitlab.upsertFile(hub, releasePath, savedSop, 'Document team release notes');
    const hubHead = await gitlab.headSha(hub);
    const jmsEnv = { JUMPSERVER_BASE_URL: jmsServer.baseUrl, JUMPSERVER_READONLY_TOKEN: jms.readonly, JUMPSERVER_JOB_TOKEN: jms.job };
    await provision(jmsEnv);
    const withJms = parseEnv(await readFile(envFile, 'utf8'));
    assert.ok(isDeepStrictEqual({ ...withJms }, { ...config, ...jmsEnv }), 'Bootstrap changed existing settings or credentials');
    assert.equal(await hubFile(releasePath), savedSop, 'Bootstrap overwrote the customer Agent');
    assert.equal(await gitlab.headSha(hub), hubHead, 'Bootstrap changed the Hub repository on its second run');
    const labels = await admin.json<{ name: string }[]>('/projects/' + hub + '/labels?per_page=100');
    for (const name of ['agent::onboarding', 'agent::image-sync', 'claude::coding', 'claude::done', 'claude::failed', 'claude::idle', 'claude::planning',
      'claude::waiting-approval', 'delivery::audit', 'delivery::code', 'delivery::env-change', 'delivery::release'])
      assert.ok(labels.some(label => label.name === name), 'Missing Hub label ' + name);
    for (const p of projects) {
      const hooks = await admin.json<{ url: string; issues_events: boolean; note_events: boolean; emoji_events: boolean;
        merge_requests_events: boolean; pipeline_events: boolean; deployment_events: boolean; push_events: boolean }[]>('/projects/' + p.id + '/hooks');
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].url, publicUrl + '/webhooks/gitlab');
      assert.equal(hooks[0].issues_events, p.id === hub);
      assert.equal(hooks[0].note_events, true);
      assert.equal(hooks[0].emoji_events, true);
      assert.equal(hooks[0].merge_requests_events, p.id !== hub);
      assert.equal(hooks[0].pipeline_events, p.id !== hub);
      assert.equal(hooks[0].deployment_events, p.id !== hub);
      assert.equal(hooks[0].push_events, false);
    }
    const observed = new Map<string, number>();
    async function observe(key: string, act: () => Promise<unknown>) {
      const before = observed.get(key) ?? 0;
      await act();
      await until('Pod observed ' + key, () => (observed.get(key) ?? 0) > before);
    }
    const observeGet = (path: string, act: () => Promise<unknown>) => observe('/api/v4' + path, act);
    const secrets = [gitlab.adminToken, config.GITLAB_TOKEN, config.GITLAB_WEBHOOK_SECRET, config.ANTHROPIC_API_KEY,
      vaultCanary, 'offline-jev-key', mcp.token, mcp.hubToken, jms.readonly, jms.job, jms.accessKeyId, jms.accessKeySecret];
    if (password) secrets.push(password);
    function checkSecrets(value: unknown) {
      const body = JSON.stringify(value);
      assert.ok(!secrets.some(secret => secret && body.includes(secret)), 'A credential appeared in E2E output');
      assert.ok(!/https?:\/\/oauth2:(?!\*\*\*@)[^\s/@]+@/i.test(body), 'A Git URL exposed credentials');
    }
    anthropic.checkRequests(checkSecrets);
    async function startPod(id: string, settings: NodeJS.ProcessEnv = {}, service: 'core' | 'delivery' = 'delivery', file = noJmsFile) {
      assert.equal(config.ANTHROPIC_BASE_URL, mock.baseUrl, 'Claude Code requires the loopback mock');
      const pod = spawn(process.execPath, ['--env-file=' + file, '--import', './scripts/e2e/observe-gitlab.mjs', 'packages/' + service + '/dist/server.js'], {
        env: { ...localEnv, ...settings, POD_ID: id, JEV_PROVIDER: 'bailian',
          JEV_BASE_URL: jevServer.baseUrl + '/compatible-mode/v1/systemone', JEV_API_KEY: 'offline-jev-key', HARBOR_SYNC_TOKEN: mcp.token, DETENT_SECRET_CUSTOM_MCP_TOKEN: mcp.hubToken,
          DETENT_SECRET_CANARY: vaultCanary },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
      });
      pods.add(pod);
      for (const [stream, output] of [[pod.stdout!, process.stdout], [pod.stderr!, process.stderr]] as const) {
        createInterface({ input: stream }).on('line', line => {
          try { checkSecrets(line); output.write(line + '\n'); }
          catch { failure ??= Error('A credential appeared in the Pod log'); }
        });
      }
      pod.on('message', path => {
        if (typeof path === 'string') observed.set(path, (observed.get(path) ?? 0) + 1);
      });
      pod.on('error', error => { failure = error; });
      await until(id + ' health check', async () => {
        const res = await fetch('http://' + loopback + ':' + (settings.PORT ?? podPort) + '/healthz').catch(() => undefined);
        return res?.ok && (await res.json()).podId === id;
      });
    }
    await close(reservation);
    const issueIds: number[] = [];
    async function openIssue(title: string, description = '', label?: string) {
      const iid = await gitlab.openIssue(hub, { title, description, labels: label ? [label] : [] });
      issueIds.push(iid);
      return iid;
    }
    const standaloneMrs: [number, number][] = [];
    function trackMr<T extends { target_project_id: number; iid: number }>(mr: T) {
      standaloneMrs.push([mr.target_project_id, mr.iid]);
      return mr;
    }
    if (external) cleanup.push(async () => {
      if (!issueIds.length && !standaloneMrs.length) return;
      const cx = await db.getConnection();
      try {
        await cx.beginTransaction();
        const [owned] = await cx.query<RowDataPacket[]>(`SELECT id FROM issue_sessions WHERE
          (session_kind='issue' AND hub_project_id=? AND hub_issue_iid IN (?)) OR
          (session_kind='mr' AND ((hub_project_id,hub_issue_iid) IN (?) OR
            (hub_project_id,hub_issue_iid) IN (SELECT m.target_project_id,m.mr_iid FROM session_merge_requests m
              JOIN issue_sessions h ON h.id=m.session_id WHERE h.session_kind='issue' AND h.hub_project_id=? AND h.hub_issue_iid IN (?))))`,
          [hub, issueIds.length ? issueIds : [0], standaloneMrs.length ? standaloneMrs : [[0, 0]], hub, issueIds.length ? issueIds : [0]]);
        const [linked] = await cx.query<RowDataPacket[]>(`SELECT m.target_project_id,m.mr_iid FROM session_merge_requests m
          JOIN issue_sessions h ON h.id=m.session_id WHERE h.session_kind='issue' AND h.hub_project_id=? AND h.hub_issue_iid IN (?)`,
          [hub, issueIds.length ? issueIds : [0]]);
        for (const m of linked) standaloneMrs.push([m.target_project_id, m.mr_iid]);
        for (const fixture of owned) {
          for (const table of ['delivery_executions', 'session_inbox', 'approval_requests', 'session_merge_requests', 'session_worktrees', 'session_messages'])
            await cx.query('DELETE FROM ' + table + ' WHERE session_id=?', [fixture.id]);
          await cx.query('DELETE FROM issue_sessions WHERE id=?', [fixture.id]);
        }
        await cx.commit();
      } catch (error) {
        await cx.rollback();
        throw error;
      } finally { cx.release(); }
      const paths = new Set([...standaloneMrs.map(([id, iid]) => '/projects/' + id + '/merge_requests/' + iid),
        ...issueIds.map(iid => '/projects/' + hub + '/issues/' + iid)]);
      const deletions = await Promise.allSettled([...paths].map(path => admin.request(path, 'DELETE', undefined, gitlab.adminToken, [404])));
      const errors = deletions.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Could not remove GitLab fixtures');
    });
    cleanup.push(() => stopPod());
    const notes = (iid: number) => gitlab.listIssueNotes(hub, iid);
    const award = (iid: number, approval: RowDataPacket, actor: 'dev' | 'sre') =>
      gitlab.awardThumbsUp(hub, iid, approval.gitlab_note_id, actor);
    const records = (session: string, table: string) => rows('SELECT * FROM ' + table + ' WHERE session_id=?', [session]);
    async function state(iid: number, status: string, afterSeq = -1) {
      return until('#' + iid + ' ' + status, async () => {
        const [s] = await rows("SELECT * FROM issue_sessions WHERE session_kind='issue' AND hub_project_id=? AND hub_issue_iid=?", [hub, iid]);
        if (s?.status === 'FAILED') throw Error('Delivery failed: ' + (await notes(iid)).map(n => n.body).join('\n'));
        if (s?.status === status && s.last_message_seq > afterSeq && (status === 'WAITING_TOOL' || !s.locked_by_pod)) return s;
      });
    }

    async function done(iid: number) {
      const s = await state(iid, 'DONE');
      const issue = await gitlab.getIssue(hub, iid);
      assert.equal(issue.state, 'closed');
      assert.ok(issue.labels.includes('claude::done'));
      return s;
    }
    async function pendingCard(iid: number, tool: string, fields: string[]) {
      const s = await state(iid, tool === 'Plan' ? 'WAITING_PLAN' : 'WAITING_TOOL');
      const card = await until(tool + ' pending card', async () => {
        const [row] = await rows("SELECT * FROM approval_requests WHERE session_id=? AND tool_name=? AND status='PENDING'", [s.id, tool]);
        return row?.gitlab_note_id && row;
      });
      const body = (await notes(iid)).find(n => n.id === card.gitlab_note_id)?.body;
      for (const field of fields) assert.ok(body?.includes(field), 'Missing card field ' + field);
      return card;
    }
    async function rejectDeveloper(iid: number, approval: RowDataPacket) {
      const denial = '该操作需要生产审批权限';
      const count = async () => (await notes(iid)).filter(n => n.body.includes(denial)).length;
      const before = await count();
      await observeGet('/projects/' + hub + '/members/all/' + developer.id, () => award(iid, approval, 'dev'));
      await until('production approval feedback', async () => await count() === before + 1);
      assert.equal((await rows('SELECT status FROM approval_requests WHERE id=?', [approval.id]))[0].status, 'PENDING');
    }

    const shared = { gitlab, admin, hub, rows, records, state, until, openIssue, pendingCard, anthropic,
      checkSecrets, observeGet, sandbox, stopPod: () => stopPod(true) };
    const isolationIssue = await standaloneAndUpgrade({ ...shared, startPod, async checkWelcome() {
      const before = anthropic.getRequests();
      await provision(jmsEnv, true);
      await provision(jmsEnv, true);
      const welcome = await admin.json<{ iid: number; title: string; author: { username: string } }[]>('/projects/' + hub + '/issues');
      assert.equal(welcome.length, 1);
      assert.match(welcome[0].title, /Detent 已就绪/);
      assert.equal(welcome[0].author.username, 'e2e-detent-bot');
      issueIds.push(welcome[0].iid);
      assert.deepEqual(await rows('SELECT id FROM issue_sessions WHERE hub_project_id=?', [hub]), []);
      assert.equal(anthropic.getRequests(), before);
    }, sql: { host, port, user, password, database },
      adminSql: { host, port, user: external ? user : 'root', password: rootPassword } });
    await checkStartupFailures(shared, localEnv, isolationIssue);
    if (gitlab.synthetic) {
      await protectedHubInstall(shared, localEnv, tmp, publicUrl);
      await brownfieldOnboarding(shared, localEnv, tmp, publicUrl);
    }
    await startPod('detent-issue-lifecycles', { DETENT_SECRET_JMS_AUDIT_TOKEN: jms.readonly }, 'delivery', envFile);
    const hubTemplate = await hubFile('capabilities.json');
    await runHubCapabilities(shared, jms, jmsServer.baseUrl, hubTemplate);
    await runIssueScenarios({ ...shared, observeWebhook: act => observe('webhook-accepted', act), startPod: id => startPod(id, {}, 'delivery', envFile) });
    await stopPod(true);
    await startPod('detent-post-upgrade');

    const requestsBeforeMissing = anthropic.getRequests();
    const missing = await openIssue('Inspect web01', '', 'delivery::env-change');
    await state(missing, 'IDLE');
    assert.equal((await gitlab.getIssue(hub, missing)).state, 'opened');
    assert.equal(anthropic.getRequests(), requestsBeforeMissing);
    const guidance = (await notes(missing)).map(n => n.body).join('\n');
    assert.match(guidance, /### ⚪ 当前能力尚未开通/);
    assert.match(guidance, /jumpserver：.*jumpserver.base_url/);
    const alternatives = guidance.split('<details>')[0];
    for (const label of ['delivery::release', 'delivery::code', 'agent::image-sync']) assert.ok(alternatives.includes(label));
    assert.deepEqual(jev.routingRequests, []);
    console.log('Missing-capability guidance posted with zero Anthropic requests.');

    await gitlab.upsertFile(hub, 'capabilities.json', JSON.stringify({ 'harbor-sync': {
      type: 'mcp', transport: 'http', url: mcpServer.baseUrl + '/hub/mcp', approver_tier: 'prod',
      readonly_tools: ['check_image_exists'], headers: { Authorization: 'Bearer ${secret:CUSTOM_MCP_TOKEN}' },
    } }), 'Connect Hub-defined MCP pack');
    const imageAgent = await hubFile(imagePath);
    assert.match(imageAgent, /^requires: \[\]$/m);
    assert.match(imageAgent, /^approver_tier: standard$/m);
    await gitlab.upsertFile(hub, imagePath, imageAgent.replace(/^requires: \[\]$/m, 'requires: [harbor-sync]'), 'Enable Harbor MCP capability');
    const mirror = await openIssue('同步 nginx 镜像');
    const triage = await state(mirror, 'IDLE', 0);
    const unrouted = await gitlab.getIssue(hub, mirror);
    assert.equal(unrouted.state, 'opened');
    assert.deepEqual(unrouted.labels, ['claude::idle']);
    assert.deepEqual(await records(triage.id, 'approval_requests'), []);
    assert.ok(anthropic.getRequests() > 0);
    assert.ok((await notes(mirror)).some(n => /请提供带 Tag .*目标镜像仓库地址/.test(n.body)));
    const lowConfidence = { recentMessages: [], confidence: 0.55, ambiguity: 2 };
    assert.deepEqual(jev.routingRequests, [lowConfidence]);
    assert.deepEqual(mcp.calls, []);

    // Include a prior user note so routing must read GitLab history and discard bot replies.
    await gitlab.postNote(hub, mirror, '/status');
    await until('triage /status reply', async () => (await notes(mirror)).some(n => n.body.startsWith('💤 **待命**')));
    const { source_image, target_image } = imageMirror;
    const clarification = `请将 ${source_image} 同步到 ${target_image}。`;
    await gitlab.postNote(hub, mirror, clarification);
    const mirrorPlan = await pendingCard(mirror, 'Plan', ['🧭 已进入', '实施方案审批',
      source_image, target_image, '🔍 工具调用轨迹（2 步）', '1. **`Read`**', 'mirror-to-harbor/SKILL.md',
      '2. **`harbor-sync__check_image_exists`**', JSON.stringify({ target_image })]);
    const routed = await state(mirror, 'WAITING_PLAN', triage.last_message_seq);
    assert.equal(routed.permission_mode, 'plan');
    assert.equal(routed.claude_session_id, triage.claude_session_id);
    assert.ok((await gitlab.getIssue(hub, mirror)).labels.includes('agent::image-sync'));
    assert.deepEqual(jev.routingRequests, [lowConfidence, { recentMessages: ['/status', clarification], confidence: 0.96, ambiguity: 0.1 }]);
    const check = { name: 'check_image_exists', arguments: { target_image } };
    assert.deepEqual(mcp.calls, [check]);

    await award(mirror, mirrorPlan, 'dev');
    const mirrorSync = await pendingCard(mirror, 'harbor-sync__sync_image', ['外部 MCP 工具执行审批', 'harbor-sync', 'sync_image', source_image, target_image]);
    await rejectDeveloper(mirror, mirrorSync);
    assert.deepEqual(mcp.calls, [check]);
    await award(mirror, mirrorSync, 'sre');
    const mirrored = await done(mirror);
    assert.deepEqual(mcp.calls, [check, { name: 'sync_image', arguments: imageMirror }]);
    assert.equal(jev.routingRequests.length, 2, 'The sticky label should resolve subsequent turns and approvals');
    assert.equal(mirrored.claude_session_id, triage.claude_session_id);
    const mirrorApprovals = await records(mirrored.id, 'approval_requests');
    assert.equal(mirrorApprovals.length, 2);
    for (const approval of mirrorApprovals) {
      assert.equal(approval.status, 'APPROVED');
      assert.equal(approval.decided_by, approval.id === mirrorPlan.id ? gitlab.devUsername : gitlab.sreUsername);
    }
    const mirrorNotes = await notes(mirror);
    assert.ok(mirrorNotes.some(n => n.body.includes('镜像同步完成，目标为 ' + target_image)));
    assert.ok(mirrorNotes.every(n => !n.body.includes(mcp.token)), 'The MCP Bearer token appeared in an Issue note');
    assert.deepEqual(await readdir(sandbox), []);
    assert.ok((observed.get('isolated-claude-env') ?? 0) > 0, 'Expected observed SDK subprocess environment');
    assert.equal(mcp.sessions.size, 0);
    assert.ok(mcp.closedSessions() >= 3);
    checkSecrets(mirrorNotes);
    checkSecrets(await records(mirrored.id, 'session_messages'));
    console.log('Stage 15 branch 7 passed: Hub MCP bearer, tool results, traces, transcripts and production approval.');
    console.log('Triage clarified and routed image-sync. The scoped Skill and MCP tools ran with production approval.');

    const code = await openIssue('Deliver hello.txt', 'Update ' + webRepo + ' and ' + apiRepo, 'delivery::code');
    await award(code, await pendingCard(code, 'Plan', [webRepo, apiRepo]), 'dev');
    const review = await state(code, 'IDLE');
    const mrs = await records(review.id, 'session_merge_requests');
    assert.deepEqual(mrs.map(m => m.target_project_id).sort(), [web.id, api.id].sort());
    assert.ok(mrs.every(m => m.mr_state === 'opened'));
    const reviewNote = (await notes(code)).find(n => n.body.includes('Please review and merge both MRs'));
    assert.ok(reviewNote && mrs.every(m => reviewNote.body.includes(m.mr_web_url)));
    assert.equal((await gitlab.getIssue(hub, code)).state, 'opened');
    assert.match(reviewNote.body, /\*\*`Bash`\*\* [^\n]*pwd; ls -la[^\n]*\n +↳ `/);
    assert.ok(!reviewNote.body.includes('⏳ 执行中…'));
    assert.ok(jev.requests.includes('pwd; ls -la') && jev.requests.some(command => command.startsWith('git -C ')));
    assert.ok(!(await records(review.id, 'approval_requests')).some(a => a.tool_name === 'Bash'));
    const firstMr = mrs.find(m => m.target_project_id === web.id)!;
    const secondMr = mrs.find(m => m.target_project_id === api.id)!;
    const bot = await admin.json<{ id: number; username: string }>('/user', 'GET', undefined, config.GITLAB_TOKEN);
    for (const m of mrs) {
      const mr = await gitlab.getMr(m.target_project_id, m.mr_iid);
      assert.ok(mr.assignees.some(a => a.id === bot.id), 'Issue-created MR must be assigned to the bot');
      await admin.request('/projects/' + m.target_project_id + '/members', 'POST', { user_id: developer.id, access_level: 30 });
    }
    async function mrState(project: number, iid: number, status: 'IDLE' | 'DONE' | 'WAITING_PLAN' | 'WAITING_TOOL' | 'FAILED', afterSeq = -1) {
      return until(project + '!' + iid + ' ' + status, async () => {
        const [row] = await rows("SELECT * FROM issue_sessions WHERE session_kind='mr' AND hub_project_id=? AND hub_issue_iid=?", [project, iid]);
        if (row?.status === 'FAILED' && status !== 'FAILED') throw Error('MR worker failed: ' + (await gitlab.listMrNotes(project, iid)).map(n => n.body).join('\n'));
        if (row?.status === status && (status === 'WAITING_TOOL' || !row.locked_by_pod) && row.last_message_seq > afterSeq) return row;
      });
    }
    const hubNotes = await notes(code);
    if (gitlab.synthetic) {
      const before = await gitlab.getMr(web.id, firstMr.mr_iid);
      const pipeline = await gitlab.synthetic.failPipeline(web.id, before.iid, bot.id);
      const worker = await mrState(web.id, before.iid, 'IDLE');
      assert.notEqual(worker.id, review.id);
      assert.equal(worker.last_failed_pipeline_id, pipeline);
      const [linked] = await rows('SELECT latest_pipeline_id, latest_pipeline_status FROM session_merge_requests WHERE id=?', [firstMr.id]);
      assert.equal(linked.latest_pipeline_id, pipeline);
      assert.equal(linked.latest_pipeline_status, 'failed');
      const fixed = await gitlab.getMr(web.id, before.iid);
      assert.notEqual(fixed.sha, before.sha);
      assert.equal(await gitlab.getFile(web.id, 'ci/ready.txt', fixed.sha), 'ready\n');
      assert.ok((await gitlab.listMrNotes(web.id, before.iid)).some(n => n.body.includes('Restored the CI readiness file.')));
    } else {
      await gitlab.openDiscussion(web.id, firstMr.mr_iid, 'Please inspect this contribution');
      await mrState(web.id, firstMr.mr_iid, 'IDLE');
    }
    const inlineMr = await until('GitLab diff refs', async () => {
      const mr = await gitlab.getMr(api.id, secondMr.mr_iid);
      if (mr.diff_refs?.head_sha) return { ...mr, diff_refs: mr.diff_refs };
    });
    const thread = await gitlab.openDiscussion(api.id, inlineMr.iid, 'Add a regression test for this greeting.', {
      ...inlineMr.diff_refs, position_type: 'text', old_path: 'hello.txt', new_path: 'hello.txt', new_line: 1,
    });
    await mrState(api.id, inlineMr.iid, 'IDLE');
    const inlineNotes = (await gitlab.getDiscussion(api.id, inlineMr.iid, thread.id)).notes;
    assert.equal(inlineNotes[0].type, 'DiffNote');
    assert.ok(inlineNotes.some(n => n.author.username === bot.username && n.body.includes('Added the requested greeting regression test.') &&
      /<details><summary>🔍 工具调用轨迹（[1-9]\d* 步）/.test(n.body)));
    const reviewed = await gitlab.getMr(api.id, inlineMr.iid);
    assert.notEqual(reviewed.sha, inlineMr.sha);
    assert.ok((await gitlab.getFile(api.id, 'test-greeting.sh', reviewed.sha)).includes('Hello from ' + apiRepo));
    assert.deepEqual(await notes(code), hubNotes, 'The independent MR turns posted to the Hub Issue');
    await gitlab.mergeMergeRequest(firstMr.target_project_id, firstMr.mr_iid);
    const waitingForMerge = await state(code, 'IDLE', review.last_message_seq);
    assert.ok((await notes(code)).some(n => n.body.includes('Waiting for the remaining MR to merge.')));
    assert.equal((await records(review.id, 'session_merge_requests')).filter(m => m.mr_state === 'opened').length, 1);
    assert.equal((await gitlab.getIssue(hub, code)).state, 'opened');
    await gitlab.mergeMergeRequest(secondMr.target_project_id, secondMr.mr_iid);
    assert.ok((await done(code)).last_message_seq > waitingForMerge.last_message_seq);
    for (const m of mrs) await mrState(m.target_project_id, m.mr_iid, 'DONE');
    const trees = await records(review.id, 'session_worktrees');
    assert.equal(trees.length, 2);
    assert.ok(trees.every(t => t.status === 'ARCHIVED' && t.branch_name === 'feat/issue-' + code));
    for (const p of [web, api]) assert.equal(await gitlab.getFile(p.id, 'hello.txt'), 'Hello from ' + p.path_with_namespace + '!\n');
    console.log('Cross-repo Issue closed after both human merges.');

    const hubIssueIds = async () => (await admin.json<{ iid: number }[]>('/projects/' + hub + '/issues?scope=all&per_page=100')).map(i => i.iid).sort();
    const beforeStandalone = await hubIssueIds();
    const standalone = trackMr(await gitlab.openExternalMr(api.id, 'external-feature'));
    assert.deepEqual(standalone.assignees, []);
    const externalThread = await gitlab.openDiscussion(api.id, standalone.iid, '@' + bot.username + ' Please inspect this contribution');
    const mentioned = await mrState(api.id, standalone.iid, 'IDLE');
    assert.deepEqual((await gitlab.getMr(api.id, standalone.iid)).assignees, []);
    assert.ok((await gitlab.getDiscussion(api.id, standalone.iid, externalThread.id)).notes.some(n =>
      n.author.username === bot.username && n.body.includes('Inspected the external contribution.')));
    await gitlab.assignMr(api.id, standalone.iid, bot.id);
    const assigned = await mrState(api.id, standalone.iid, 'IDLE', mentioned.last_message_seq);
    assert.equal(assigned.id, mentioned.id);
    assert.ok((await gitlab.listMrNotes(api.id, standalone.iid)).some(n => n.body.includes('Accepted the assigned MR.')));
    assert.deepEqual(await hubIssueIds(), beforeStandalone);
    assert.deepEqual(await rows('SELECT id FROM session_merge_requests WHERE target_project_id=? AND mr_iid=?', [api.id, standalone.iid]), []);

    if (gitlab.synthetic) {
      const originalPolicy = await hubFile('events.json');
      const alertLabel = 'e2e::deployment';
      const policy = (action: 'notify' | 'run') => gitlab.upsertFile(hub, 'events.json', JSON.stringify({ version: 1, rules: [
        { event: 'pipeline', status: 'failed', project: apiRepo, action, notifyTarget: 'resource' },
        { event: 'deployment', status: 'failed', project: apiRepo, action: 'notify', notifyTarget: 'hub_issue', hubIssueLabel: alertLabel },
      ] }), 'Set pipeline policy to ' + action);
      await policy('notify');
      const before = await gitlab.getMr(api.id, standalone.iid);
      const requests = anthropic.getRequests();
      const notified = await gitlab.synthetic.failPipeline(api.id, before.iid, bot.id);
      await until('pipeline notification', async () => (await gitlab.listMrNotes(api.id, before.iid))
        .some(n => n.body.includes('Pipeline #' + notified + ' failed')));
      assert.equal((await gitlab.getMr(api.id, before.iid)).sha, before.sha);
      assert.equal((await mrState(api.id, before.iid, 'IDLE')).last_message_seq, assigned.last_message_seq);
      assert.equal(anthropic.getRequests(), requests);
      await policy('run');
      const receipt = 'steer-' + randomUUID();
      const instruction = 'Please include receipt ' + receipt + ' in the CI fix.';
      let steeringThread: string | undefined;
      anthropic.beforeNextTool('detent_get_pipeline_job_log', async () => {
        const [active] = await rows('SELECT status, locked_by_pod FROM issue_sessions WHERE id=?', [assigned.id]);
        assert.ok(active.status === 'CODING' && active.locked_by_pod);
        steeringThread = (await gitlab.openDiscussion(api.id, before.iid, instruction)).id;
        await until('reviewer instruction in active session inbox', async () => (await rows(
          "SELECT id FROM session_inbox WHERE session_id=? AND discussion_id=? AND content=? AND status='PENDING'",
          [assigned.id, steeringThread!, instruction])).length);
      });
      const retried = await gitlab.synthetic.failPipeline(api.id, before.iid, bot.id);
      const fixed = await mrState(api.id, before.iid, 'IDLE', assigned.last_message_seq);
      assert.equal(fixed.last_failed_pipeline_id, retried);
      assert.ok(steeringThread);
      const [consumed] = await rows('SELECT status,consumed_at FROM session_inbox WHERE session_id=? AND discussion_id=?', [assigned.id, steeringThread]);
      assert.ok(consumed.status === 'CONSUMED' && consumed.consumed_at);
      const after = await gitlab.getMr(api.id, before.iid);
      assert.notEqual(after.sha, before.sha);
      assert.equal(await gitlab.getFile(api.id, 'ci/ready.txt', after.sha), 'ready\n');
      const commit = await admin.json<{ title: string }>('/projects/' + api.id + '/repository/commits/' + after.sha);
      assert.ok(commit.title.includes(receipt));
      assert.ok((await gitlab.getDiscussion(api.id, before.iid, steeringThread)).notes.some(n =>
        n.author.username === bot.username && n.body.includes(receipt)));
      assert.deepEqual(await hubIssueIds(), beforeStandalone);
      await gitlab.synthetic.failDeployment(api.id);
      const alert = await until('deployment alert Issue', async () => (await admin.json<{ iid: number; title: string; description: string; labels: string[] }[]>(
        '/projects/' + hub + '/issues?search=deployment')).find(i => i.labels.includes(alertLabel)));
      issueIds.push(alert.iid);
      for (const detail of ['deployment', 'failed', apiRepo, 'staging']) assert.ok(alert.description.includes(detail));
      await gitlab.upsertFile(hub, 'events.json', originalPolicy, 'Restore Hub event policy');
      console.log('Verified live policy changes, in-turn MR steering, and the deployment alert Issue.');
    }

    const harness = { gitlab, admin, db, until, rows, records, mrState, state, openIssue, pendingCard, trackMr,
      anthropic, jev, bot, hub, api: api.id, isolationIssue, standalone, observeGet, checkSecrets, sandbox,
      stopPod: () => stopPod(true), startPod: (id: string, overrides?: NodeJS.ProcessEnv) => startPod(id, overrides) };
    const payment = await onboardPayment(harness, apiRepo.slice(0, apiRepo.lastIndexOf('/')), developer.id, publicUrl + '/webhooks/gitlab');
    await verifyOnboardedMr(harness, payment);
    console.log('Verified production-approved repository onboarding, signed MR delivery and zero-token help.');
    await runMrScenarios(harness);

    const shaToPublish = await gitlab.headSha(web.id);
    for (const workflow of ['release', 'hotfix']) {
      const hotfix = workflow === 'hotfix';
      const label = 'delivery::' + workflow;
      const tag = hotfix ? 'hotfix-1.0.1' : 'rel-1.0.0';
      const marker = hotfix ? 'CUSTOM_HOTFIX_WORKFLOW: hotfix-' : 'CUSTOM_RELEASE_TAG_PREFIX: rel-';
      if (hotfix) await gitlab.ensureLabel(hub, label);
      const sop = hotfix ? ['---', 'label: ' + label, 'mode: governed', 'requires: [gitlab-release]', 'approver_tier: prod',
        'close_policy: approve', '---', marker, 'List tags and publish the pinned commit after approval.', ''].join('\n')
        : savedSop + '\n' + marker + '\n';
      await gitlab.upsertFile(hub, hotfix ? 'workflows/hotfix.md' : releasePath, sop, 'Customize ' + workflow + ' SOP');
      const iid = await openIssue('Publish ' + tag, 'Publish ' + webRepo + ' at ' + shaToPublish, label);
      await award(iid, await pendingCard(iid, 'Plan', [tag, shaToPublish]), 'dev');
      const publish = await pendingCard(iid, 'detent_create_release', ['GitLab 发布审批', webRepo, tag, shaToPublish]);
      await rejectDeveloper(iid, publish);
      assert.equal(await gitlab.getTagCommit(web.id, tag), null);
      assert.equal(await gitlab.getRelease(web.id, tag), null);
      await award(iid, publish, 'sre');
      if (hotfix) {
        const closure = await pendingCard(iid, 'detent_close_issue', ['工单闭环关闭审批', tag]);
        assert.equal(await gitlab.getTagCommit(web.id, tag), shaToPublish);
        await rejectDeveloper(iid, closure);
        assert.equal((await gitlab.getIssue(hub, iid)).state, 'opened');
        await award(iid, closure, 'sre');
      }
      const published = await done(iid);
      const report = hotfix ? 'Hotfix tag approved and verified.' : 'Release ' + tag + ' published for ' + webRepo;
      assert.ok((await notes(iid)).some(n => n.body.includes(report)));
      assert.equal(await gitlab.getTagCommit(web.id, tag), shaToPublish);
      assert.deepEqual(await gitlab.getRelease(web.id, tag), hotfix ? null : { tag_name: tag, name: 'Release ' + tag,
        description: 'Live customized release workflow verified.', commitSha: shaToPublish });
      for (const approval of await records(published.id, 'approval_requests')) {
        assert.equal(approval.status, 'APPROVED');
        assert.equal(approval.decided_by, approval.tool_name === 'Plan' ? gitlab.devUsername : gitlab.sreUsername);
      }
      console.log('Verified live ' + workflow + ' SOP, production approvals and closed Issue.');
    }
    await stopPod();
    const sharedKeyEnv = { DETENT_SECRET_JMS_AK_ID: jms.accessKeyId, DETENT_SECRET_JMS_AK_SECRET: jms.accessKeySecret };
    const sharedCapabilities = JSON.parse(hubTemplate);
    sharedCapabilities.jumpserver.base_url = jmsServer.baseUrl;
    assert.equal(sharedCapabilities.jumpserver.default_account, '');
    for (const agent of ['audit', 'env-change']) assert.doesNotMatch(await hubFile('agents/' + agent + '/AGENT.md'), /^account:/m);
    await gitlab.upsertFile(hub, 'capabilities.json', JSON.stringify(sharedCapabilities), 'Configure single-key JumpServer');
    const baseline = jms.runAs.length;
    await startPod('detent-pod-1', sharedKeyEnv);
    const inspection = await openIssue('Diagnose nginx on web01', '', 'delivery::audit');
    const inspected = await done(inspection);
    assert.deepEqual(await records(inspected.id, 'approval_requests'), []);
    assert.deepEqual(jms.runAs.slice(baseline), [
      { assets: ['web01'], account: 'ops-first', command: 'ss -lntp', principal: 'shared' },
      { assets: ['web02'], account: 'ops-second', command: 'ss -lntp', principal: 'shared' },
    ]);
    assert.ok(jev.requests.includes('ss -lntp') && jev.requests.length >= 2);
    assert.ok((await notes(inspection)).some(n => n.body.includes('Diagnostic report: nginx is active on web01.')));

    const change = await openIssue('Reload nginx on web01', 'Prepare and verify a reviewed nginx reload.', 'delivery::env-change');
    const first = await state(change, 'WAITING_PLAN');
    const id = first.id;
    const transcript = () => rows('SELECT seq, raw_json_line FROM session_messages WHERE session_id=? ORDER BY seq', [id]);
    const prefix = await transcript();
    assert.ok(prefix.length > 0 && prefix.length === first.last_message_seq);
    const [plan] = await records(id, 'approval_requests');
    assert.equal(plan.approval_type, 'PLAN');
    await pendingCard(change, 'Plan', ['### 📋 实施方案审批']);
    assert.equal(jms.inspections.length, 3);
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Plan persisted. Restarting the delivery pod.');
    await stopPod();
    await startPod('detent-pod-2', sharedKeyEnv);
    await award(change, plan, 'dev');
    const coding = await state(change, 'IDLE');
    assert.equal(coding.claude_session_id, first.claude_session_id);
    assert.ok(coding.last_message_seq > first.last_message_seq);
    const preMerge = await transcript();
    for (const reason of ['尚未合并', '未合并的 MR'])
      assert.ok(preMerge.some(row => row.raw_json_line.includes(reason)), 'Missing pre-merge rejection: ' + reason);
    assert.equal((await gitlab.getIssue(hub, change)).state, 'opened');
    const [mr] = await records(id, 'session_merge_requests');
    assert.equal(mr.mr_state, 'opened');
    assert.equal(mr.mr_iid, 1);
    assert.equal(mr.target_project_id, target.id);
    const [worktree] = await records(id, 'session_worktrees');
    assert.equal(worktree.id, mr.worktree_id);
    assert.equal(worktree.branch_name, 'change/issue-' + change);
    assert.equal((await records(id, 'approval_requests')).length, 1);
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);
    console.log('MR opened after restart. Premature execution denied.');

    const sha = await gitlab.mergeMergeRequest(target.id, 1);
    const waiting = await state(change, 'WAITING_TOOL');
    assert.match(waiting.locked_by_pod, /^detent-pod-2\//);
    const [merged] = await records(id, 'session_merge_requests');
    assert.equal(merged.merge_commit_sha, sha);
    assert.equal(merged.mr_state, 'merged');
    assert.equal(merged.merged_by, gitlab.sreUsername);
    assert.notEqual(sha, worktree.last_commit_sha, 'Expected a distinct merge commit');
    const approvals = await records(id, 'approval_requests');
    assert.equal(approvals.length, 2);
    assert.equal(approvals.find(a => a.id === plan.id)?.decided_by, gitlab.devUsername);
    const production = approvals.find(a => a.tool_name === 'jms_run_ansible_job')!;
    await pendingCard(change, 'jms_run_ansible_job', ['生产变更执行审批', sha, 'web01', 'deploy/nginx-reload.yml', mr.mr_web_url]);
    await gitlab.postNote(hub, change, '/status');
    const status = await until('/status reply', async () => (await notes(change)).find(n => n.body.startsWith('⏸️ **等待操作审批**')));
    for (const field of [ansibleRepo + '!1', 'merged @ ' + sha.slice(0, 8), '在上方审批卡点 👍']) assert.ok(status.body.includes(field));
    await rejectDeveloper(change, production);
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);

    await award(change, production, 'sre');
    const final = await done(change);
    assert.deepEqual((await records(id, 'session_worktrees')).map(t => t.status), ['ARCHIVED']);
    assert.equal(final.claude_session_id, first.claude_session_id);
    const [decision] = await rows('SELECT * FROM approval_requests WHERE id=?', [production.id]);
    assert.equal(decision.decided_by, gitlab.sreUsername);
    assert.equal(decision.status, 'APPROVED');
    assert.deepEqual(jms.uploads, [sha]);
    assert.deepEqual(jms.inspections, ['ss -lntp', 'ss -lntp', 'systemctl status nginx', 'systemctl status nginx']);
    assert.deepEqual(jms.playbookRuns, [{ assets: ['web01'], account: 'ops-first', principal: 'shared' }]);
    const audits = await records(id, 'delivery_executions');
    assert.equal(audits.length, 1);
    const [audit] = audits;
    assert.deepEqual(jms.executions, [audit.jumpserver_job_id]);
    assert.equal(audit.approval_id, production.id);
    assert.equal(audit.mr_id, mr.id);
    assert.equal(audit.commit_sha, sha);
    assert.equal(audit.agent_profile, 'env-change');
    assert.equal(audit.status, 'SUCCESS');
    assert.match(audit.output_summary, /nginx reloaded/);
    assert.ok(audit.output_summary.includes('https://oauth2:***@127.0.0.1/repo.git'));
    checkSecrets(audit.output_summary);
    assert.ok(audit.finished_at);
    assert.ok((await notes(change)).some(n => n.body.includes('Reload verified on web01')));
    const history = await transcript();
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    assert.equal(history.length, final.last_message_seq);
    assert.ok(history.length > coding.last_message_seq);
    assert.ok(history.every((row, i) => row.seq === i + 1));
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Stage 15 branch 4 passed: signed multi-account inspection and approved Ansible execution with one AccessKey.');
    console.log('Verified production approval, execution audit, /status, transcript and sandbox cleanup.');
    await stopPod(true);
    if (gitlab.synthetic) {
      await gitlab.removeFile(hub, 'capabilities.json', 'Verify legacy cluster configuration');
      const sockets = [createServer(), createServer()];
      const ports = await Promise.all(sockets.map(socket => listen(socket)));
      await Promise.all(sockets.map(close));
      const sandboxes = ['a', 'b'].map(name => join(tmp, 'sandboxes-' + name));
      await Promise.all(sandboxes.map(dir => mkdir(dir)));
      assert.ok(config.GITLAB_WEBHOOK_SECRET);
      const proxy = await webhookProxy(serve, podPort, { a: ports[0], b: ports[1] }, config.GITLAB_WEBHOOK_SECRET);
      cleanup.push(proxy.close);
      cleanup.push(() => stopPod());
      const cluster = { ...proxy, sandboxes, stop: () => stopPod(true), async start(settings: NodeJS.ProcessEnv = {}) {
        await Promise.all(['a', 'b'].map((name, i) => startPod('detent-pod-' + name, {
          ...sharedKeyEnv, PORT: String(ports[i]), EPHEMERAL_ROOT: sandboxes[i], WATCHDOG_INTERVAL_MS: '0',
          JUMPSERVER_BLOCKED_ASSETS: 'blocked-db-01', JUMPSERVER_BLOCK_FAILED_PIPELINE: 'true', ...settings,
        }, 'delivery', envFile)));
      } };
      await cluster.start();
      await runConcurrency(harness, cluster, web.id);
      await runSecurity(harness, cluster, web.id, target.id, jms, securityReport, iid => issueIds.push(iid));
      await cluster.stop();
      for (const dir of sandboxes) assert.deepEqual(await readdir(dir), []);
    }
    for (const session of await rows('SELECT * FROM issue_sessions WHERE hub_project_id IN (?,?,?,?)', projects.map(p => p.id))) {
      await checkSession(shared, session);
      checkSecrets(await records(session.id, 'delivery_executions'));
    }
    if (failure) throw failure;
  } finally {
    const errors = [];
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (errors.length) throw new AggregateError(errors, 'E2E cleanup failed');
  }
}

main().then(() => {
  if (!process.env.E2E_GITLAB_URL)
    console.log('Offline E2E passed: Stage 15 (8/8 branches), install/upgrade, Issues, MRs, self-service onboarding, concurrency and security/events.');
}).catch(error => { console.error(error); process.exitCode = 1; });
