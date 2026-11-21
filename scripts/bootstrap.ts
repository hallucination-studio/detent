import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

interface User { id: number; username: string }
interface Project { id: number; path_with_namespace: string; default_branch: string }
const list = (s = '') => s.split(',').map(v => v.trim()).filter(Boolean);

async function templateFiles(root: string, dir = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await templateFiles(root, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function main() {
  const { values } = parseArgs({ options: { 'env-out': { type: 'string' } } });
  const env = process.env;
  const out = resolve(values['env-out'] ?? env.DETENT_ENV_OUT ?? '.env');
  await mkdir(dirname(out), { recursive: true });
  const previous = parseEnv(await readFile(out, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }));
  function serviceUrl(value: string | undefined, key: string) {
    if (!value) throw Error(key + ' is required');
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw Error('Invalid service URL for ' + key);
    return u.href.replace(/\/$/, '');
  }
  const base = serviceUrl(env.GITLAB_BASE_URL, 'GITLAB_BASE_URL');
  const saved = previous.GITLAB_BASE_URL === base ? previous : {};
  const hookUrl = serviceUrl(env.DETENT_PUBLIC_URL ?? 'http://127.0.0.1:3000', 'DETENT_PUBLIC_URL') + '/webhooks/gitlab';
  const ssl = env.DETENT_WEBHOOK_SSL_VERIFY ?? String(hookUrl.startsWith('https:'));
  if (!['true', 'false'].includes(ssl)) throw Error('DETENT_WEBHOOK_SSL_VERIFY must be true or false');
  const secret = env.GITLAB_WEBHOOK_SECRET || saved.GITLAB_WEBHOOK_SECRET || randomBytes(32).toString('hex');
  const username = env.DETENT_BOT_USERNAME ?? 'detent-bot';
  let token = env.GITLAB_TOKEN || saved.GITLAB_TOKEN;
  const admin = env.GITLAB_ADMIN_TOKEN;
  if (!admin && !token) throw Error('Set GITLAB_ADMIN_TOKEN or GITLAB_TOKEN');

  async function request(path: string, method = 'GET', body?: object, credential = admin || token) {
    return fetch(base + '/api/v4' + path, {
      method, headers: { 'PRIVATE-TOKEN': credential!, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  }
  function check(res: Response, path: string) {
    if (!res.ok) throw Error('GitLab HTTP ' + res.status + ' at ' + path.split('?')[0]);
  }
  async function json<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const res = await request(path, method, body);
    check(res, path);
    return res.json();
  }
  async function lookup<T>(path: string): Promise<T | undefined> {
    const res = await request(path);
    if (res.status === 404) return;
    check(res, path);
    return res.json();
  }
  async function all<T>(path: string) {
    const items: T[] = [];
    let page = '1';
    while (page) {
      const res = await request(path + '?per_page=100&page=' + page);
      check(res, path);
      items.push(...await res.json() as T[]);
      page = res.headers.get('x-next-page') ?? '';
    }
    return items;
  }
  const user = async (name: string) => (await json<User[]>('/users?username=' + encodeURIComponent(name)))[0];
  let bot: User | undefined;
  if (token) {
    const res = await request('/user', 'GET', undefined, token);
    if (res.ok) {
      const identity: User = await res.json();
      if ((!admin && !env.DETENT_BOT_USERNAME) || identity.username === username) bot = identity;
      else if (!admin || env.GITLAB_TOKEN) throw Error('Supplied PAT belongs to a different bot username');
    } else if (res.status !== 401 || !admin || env.GITLAB_TOKEN) check(res, '/user');
  }
  if (!bot) {
    token = undefined;
    bot = await user(username) ?? await json<User>('/users', 'POST', {
      username, name: env.DETENT_BOT_NAME ?? 'Detent Bot', email: env.DETENT_BOT_EMAIL ?? 'detent-bot@detent.local',
      force_random_password: true, skip_confirmation: true,
    });
  }

  async function project(ref: string): Promise<Project> {
    const found = await lookup<Project & { empty_repo?: boolean }>('/projects/' + encodeURIComponent(ref));
    if (found) {
      if (found.empty_repo || !found.default_branch) {
        found.default_branch = 'main';
        await json('/projects/' + found.id + '/repository/files/README.md', 'POST', {
          branch: 'main', content: '# ' + found.path_with_namespace + '\n', commit_message: 'Initialize repository',
        });
      }
      return found;
    }
    const parts = ref.split('/');
    if (parts.length < 2 || parts.some(p => !/^[\w-][\w.-]*$/.test(p)))
      throw Error('Missing project. Creation requires a namespace/project path: ' + ref);
    const name = parts.pop()!;
    let parent: number | undefined;
    let groupPath = '';
    for (const path of parts) {
      groupPath = groupPath ? groupPath + '/' + path : path;
      const existing = await lookup<{ id: number }>('/namespaces/' + encodeURIComponent(groupPath));
      const namespace = existing ??
        await json<{ id: number }>('/groups', 'POST', { name: path, path, parent_id: parent });
      parent = namespace.id;
    }
    return json<Project>('/projects', 'POST', {
      name, path: name, namespace_id: parent, initialize_with_readme: true, default_branch: 'main',
    });
  }
  async function member(p: Project, u: User, level: number) {
    const path = '/projects/' + p.id + '/members';
    const effective = await lookup<{ access_level: number }>(path + '/all/' + u.id);
    if (effective && effective.access_level >= level) return;
    const direct = effective && await lookup(path + '/' + u.id);
    await json(direct ? path + '/' + u.id : path, direct ? 'PUT' : 'POST', { user_id: u.id, access_level: level });
  }

  const hub = await project(env.GITLAB_HUB_PROJECT_ID || env.DETENT_HUB_PROJECT || 'ai/workspace-hub');
  const root = '/projects/' + hub.id;
  const templateDir = env.DETENT_HUB_TEMPLATE_DIR ?? fileURLToPath(new URL('../examples/hub-workspace', import.meta.url));
  const files = new Set(await templateFiles(templateDir));
  if (env.DETENT_CLAUDE_MD_FILE) files.add('CLAUDE.md');
  for (const path of [...files].sort()) {
    const file = root + '/repository/files/' + encodeURIComponent(path);
    if (await lookup(file + '?ref=' + encodeURIComponent(hub.default_branch))) continue;
    const source = path === 'CLAUDE.md' && env.DETENT_CLAUDE_MD_FILE ? env.DETENT_CLAUDE_MD_FILE : resolve(templateDir, path);
    const content = await readFile(source, 'base64');
    await json(file, 'POST', { branch: hub.default_branch, content, encoding: 'base64', commit_message: 'Seed ' + path });
  }
  const labels = await all<{ name: string }>(root + '/labels');
  for (const name of ['claude::planning', 'claude::waiting-approval', 'claude::coding', 'claude::idle',
    'claude::failed', 'claude::done', 'delivery::audit', 'delivery::env-change', 'delivery::code', 'delivery::release']) {
    if (!labels.some(l => l.name === name)) await json(root + '/labels', 'POST', { name, color: '#356288' });
  }
  for (const entry of list(env.DETENT_HUB_MEMBERS)) {
    const match = /^([^:]+):(10|15|20|30|40|50)$/.exec(entry);
    if (!match) throw Error('Expected username:access_level in DETENT_HUB_MEMBERS');
    const u = await user(match[1]);
    if (!u) throw Error('Unknown GitLab member ' + match[1]);
    await member(hub, u, Number(match[2]));
  }

  const projects = new Map([[hub.id, hub]]);
  const targets = new Set<number>();
  for (const ref of list(env.DETENT_TARGET_PROJECTS)) {
    const p = await project(ref);
    projects.set(p.id, p);
    targets.add(p.id);
  }
  for (const p of projects.values()) {
    await member(p, bot, 30);
    const path = '/projects/' + p.id + '/hooks';
    const hook = (await all<{ id: number; url: string }>(path)).find(h => h.url === hookUrl);
    await json(hook ? path + '/' + hook.id : path, hook ? 'PUT' : 'POST', {
      url: hookUrl, token: secret, enable_ssl_verification: ssl === 'true', push_events: false,
      issues_events: p.id === hub.id, note_events: p.id === hub.id, emoji_events: p.id === hub.id,
      merge_requests_events: targets.has(p.id), pipeline_events: targets.has(p.id),
    });
  }

  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const defaults = parseEnv(template);
  const output: Record<string, string> = {};
  for (const [, key] of template.matchAll(/^(?:# )?([A-Z][A-Z_0-9]*)=/gm)) {
    const value = env[key] ?? previous[key] ?? defaults[key];
    if (value !== undefined) output[key] = value;
  }
  if (!token) {
    const expiresAt = env.DETENT_BOT_TOKEN_EXPIRES_AT ?? new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);
    const pat = await json<{ token: string }>('/users/' + bot.id + '/personal_access_tokens', 'POST', {
      name: 'Detent', scopes: ['api', 'read_repository', 'write_repository'], expires_at: expiresAt,
    });
    token = pat.token;
  }
  Object.assign(output, { GITLAB_BASE_URL: base, GITLAB_TOKEN: token, GITLAB_WEBHOOK_SECRET: secret,
    GITLAB_HUB_PROJECT_ID: String(hub.id), GITLAB_HUB_DEFAULT_BRANCH: hub.default_branch });
  const lines = Object.entries(output).map(([key, value]) => {
    // Verify the exact dotenv representation, including whitespace, quotes and literal backslashes.
    if (/^[a-zA-Z0-9_./,:@%+=-]*$/.test(value)) return key + '=' + value;
    for (const quote of ["'", '"', '`', '']) {
      if (quote && value.includes(quote)) continue;
      const line = key + '=' + quote + value + quote;
      if (parseEnv(line)[key] === value) return line;
    }
    throw Error('Cannot encode ' + key + ' in a Node environment file');
  });
  const tmp = out + '.' + randomUUID();
  try {
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await rename(tmp, out);
  } finally {
    await rm(tmp, { force: true });
  }
  console.log('Bot @' + bot.username);
  for (const p of projects.values()) console.log(p.path_with_namespace + ' (#' + p.id + ') → ' + hookUrl);
  console.log('Environment written to ' + out);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
