import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

interface User { id: number; username: string }
interface Project { id: number; path_with_namespace: string; default_branch: string | null; web_url: string }
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
  const { values } = parseArgs({ options: { 'env-out': { type: 'string' }, 'welcome-issue': { type: 'boolean' } } });
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
  const publicUrl = serviceUrl(env.DETENT_PUBLIC_URL ?? saved.DETENT_PUBLIC_URL ?? 'http://127.0.0.1:3000', 'DETENT_PUBLIC_URL')
    .replace(/\/webhooks\/gitlab$/, '');
  const hookUrl = publicUrl + '/webhooks/gitlab';
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
  async function json<T>(path: string, method = 'GET', body?: object, credential?: string): Promise<T> {
    const res = await request(path, method, body, credential);
    check(res, path);
    return res.json();
  }
  async function lookup<T>(path: string, credential?: string): Promise<T | undefined> {
    const res = await request(path, 'GET', undefined, credential);
    if (res.status === 404) return;
    check(res, path);
    return res.json();
  }
  async function all<T>(path: string, credential?: string) {
    const items: T[] = [];
    let page = '1';
    while (page) {
      const res = await request(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page, 'GET', undefined, credential);
      check(res, path);
      items.push(...await res.json() as T[]);
      page = res.headers.get('x-next-page') ?? '';
    }
    return items;
  }
  const user = async (name: string) => (await json<User[]>('/users?username=' + encodeURIComponent(name)))[0];
  const groupIds = new Set<number>();
  for (const ref of list(env.DETENT_TARGET_GROUPS)) {
    const group = await json<{ id: number }>('/groups/' + encodeURIComponent(ref));
    groupIds.add(group.id);
  }
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
    bot = await user(username) ?? await json<User>('/users', 'POST', {
      username, name: env.DETENT_BOT_NAME ?? 'Detent Bot', email: env.DETENT_BOT_EMAIL ?? 'detent-bot@detent.local',
      force_random_password: true, skip_confirmation: true,
    });
    const expiresAt = env.DETENT_BOT_TOKEN_EXPIRES_AT ?? new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);
    const pat = await json<{ token: string }>('/users/' + bot.id + '/personal_access_tokens', 'POST', {
      name: 'Detent', scopes: ['api', 'read_repository', 'write_repository'], expires_at: expiresAt,
    });
    token = pat.token;
  }

  async function project(ref: string, initializeWithReadme: boolean): Promise<{ project: Project; created: boolean }> {
    const found = await lookup<Project & { empty_repo?: boolean }>('/projects/' + encodeURIComponent(ref));
    if (found) {
      if (initializeWithReadme && (found.empty_repo || !found.default_branch)) {
        found.default_branch = 'main';
        await json('/projects/' + found.id + '/repository/files/README.md', 'POST', {
          branch: 'main', content: '# ' + found.path_with_namespace + '\n', commit_message: 'Initialize repository',
        });
      }
      return { project: found, created: false };
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
    const created = await json<Project>('/projects', 'POST', {
      name, path: name, namespace_id: parent, initialize_with_readme: initializeWithReadme, ...(initializeWithReadme && { default_branch: 'main' }),
    });
    return { project: created, created: true };
  }
  async function member(resource: string, u: User, level: number) {
    const path = resource + '/members';
    const effective = await lookup<{ access_level: number }>(path + '/all/' + u.id);
    if (effective && effective.access_level >= level) return;
    const direct = effective && await lookup(path + '/' + u.id);
    await json(direct ? path + '/' + u.id : path, direct ? 'PUT' : 'POST', { user_id: u.id, access_level: level });
  }

  const { project: hub, created } = await project(env.GITLAB_HUB_PROJECT_ID || env.DETENT_HUB_PROJECT || 'ai/workspace-hub', false);
  const root = '/projects/' + hub.id;
  hub.default_branch ||= 'main';
  if (admin) {
    await member(root, bot, 50);
  } else {
    const access = await lookup<{ access_level: number }>(root + '/members/all/' + bot.id, token);
    if (!access || access.access_level < 40)
      throw Error('Grant @' + bot.username + ' Maintainer (40) or Owner (50) on the Hub project ' + hub.path_with_namespace + ' first');
  }
  const templateDir = env.DETENT_HUB_TEMPLATE_DIR ?? fileURLToPath(new URL('../examples/hub-workspace', import.meta.url));
  const files = new Set(await templateFiles(templateDir));
  if (env.DETENT_CLAUDE_MD_FILE) files.add('CLAUDE.md');
  for (const path of [...files].sort()) {
    const file = root + '/repository/files/' + encodeURIComponent(path);
    const exists = await lookup(file + '?ref=' + encodeURIComponent(hub.default_branch), token);
    if (exists && !(created && path === 'README.md')) continue;
    const source = path === 'CLAUDE.md' && env.DETENT_CLAUDE_MD_FILE ? env.DETENT_CLAUDE_MD_FILE : resolve(templateDir, path);
    const content = await readFile(source, 'base64');
    await json(file, exists ? 'PUT' : 'POST', { branch: hub.default_branch, content, encoding: 'base64', commit_message: 'Seed ' + path }, token);
  }
  const labels = await all<{ name: string }>(root + '/labels', token);
  const palette: Record<string, string> = {
    'claude::planning': '#428BCA', 'claude::waiting-approval': '#E67E22', 'claude::coding': '#1F75CB',
    'claude::idle': '#7F8C8D', 'claude::failed': '#D9534F', 'claude::done': '#1AAA55',
  };
  for (const name of [...Object.keys(palette), 'delivery::audit', 'delivery::env-change', 'delivery::code', 'delivery::release', 'agent::image-sync', 'agent::onboarding']) {
    if (!labels.some(l => l.name === name)) await json(root + '/labels', 'POST', { name, color: palette[name] ?? '#6B4FBB' }, token);
  }
  for (const entry of list(env.DETENT_HUB_MEMBERS)) {
    const match = /^([^:]+):(10|15|20|30|40|50)$/.exec(entry);
    if (!match) throw Error('Expected username:access_level in DETENT_HUB_MEMBERS');
    const u = await user(match[1]);
    if (!u) throw Error('Unknown GitLab member ' + match[1]);
    await member(root, u, Number(match[2]));
  }

  const projects = new Map([[hub.id, hub]]);
  const targets = new Set<number>();
  function addTarget(p: Project) {
    projects.set(p.id, p);
    targets.add(p.id);
  }
  for (const ref of list(env.DETENT_TARGET_PROJECTS)) addTarget((await project(ref, true)).project);
  for (const id of groupIds) {
    const path = '/groups/' + id;
    await member(path, bot, 40);
    for (const p of await all<Project>(path + '/projects?include_subgroups=true&archived=false'))
      addTarget(p);
  }
  for (const p of projects.values()) {
    const isHub = p.id === hub.id;
    if (!isHub) await member('/projects/' + p.id, bot, 30);
    const credential = isHub ? token : admin || token;
    const path = '/projects/' + p.id + '/hooks';
    const hook = (await all<{ id: number; url: string }>(path, credential)).find(h => h.url === hookUrl);
    await json(hook ? path + '/' + hook.id : path, hook ? 'PUT' : 'POST', {
      url: hookUrl, token: secret, enable_ssl_verification: ssl === 'true', push_events: false,
      issues_events: isHub, note_events: true, emoji_events: true,
      merge_requests_events: targets.has(p.id), pipeline_events: targets.has(p.id), deployment_events: targets.has(p.id),
    }, credential);
  }

  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const defaults = parseEnv(template);
  const output: Record<string, string> = {};
  for (const [, key] of template.matchAll(/^(?:# )?([A-Z][A-Z_0-9]*)=/gm)) {
    const value = key === 'DETENT_PUBLIC_URL' ? publicUrl : env[key] ?? previous[key] ?? defaults[key];
    if (value !== undefined) output[key] = value;
  }
  for (const [key, value] of Object.entries({ ...previous, ...env })) {
    if (/^DETENT_SECRET_[A-Z0-9_]+$/.test(key) && value?.trim()) output[key] = value;
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
  if (values['welcome-issue'] || env.DETENT_WELCOME_ISSUE === 'true') {
    const path = root + '/issues';
    if ((await json<unknown[]>(path + '?per_page=1', 'GET', undefined, token)).length === 0) {
      const names = [...projects.values()].filter(p => targets.has(p.id)).map(p => '- `' + p.path_with_namespace + '`');
      const description = [
        '你好，我是 @' + bot.username + '！在 [Hub 工单入口](' + hub.web_url + '/-/issues/new) 新建 Issue，选择模板，写下目标仓库和任务。',
        ['| 场景 | 模板或标签 | 适用说明 |', '| --- | --- | --- |',
          '| 巡检 | `audit` | 排查主机、进程或端口，获取诊断证据 |',
          '| 代码交付 | `code-delivery` | 修改一个或多个仓库，提交 MR 评审 |',
          '| 环境变更 | `env-change` | 调参、部署或回退指定环境 |',
          '| 发布 | `release` | 锁定提交打 Tag，按需逐环境发布 |',
          '| 仓库接入 | `onboarding` | 检查权限，接入已有项目或新建仓库 |'].join('\n'),
        '在任务工单中发送 `/help` 请求帮助，使用 `/status` 查看进度。在审批卡上点 👍 同意或 👎 拒绝。',
        '需要评审代码时，把目标项目的 MR 分配给 @' + bot.username + '。',
        '**已接入的目标项目**\n' + (names.join('\n') || '尚未配置目标项目。'),
      ].join('\n\n');
      check(await request(path, 'POST', { title: '🎉 Detent 已就绪 — 1 分钟上手与接入自检', description }, token), path);
    }
  }
  console.log('Bot @' + bot.username);
  for (const p of projects.values()) console.log(p.path_with_namespace + ' (#' + p.id + ') → ' + hookUrl);
  console.log('Environment written to ' + out);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
