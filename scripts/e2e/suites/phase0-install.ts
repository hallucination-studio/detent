import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util';
import mysql, { type ConnectionOptions, type RowDataPacket } from 'mysql2/promise';
import { checkSession, type Harness } from './harness.js';

const run = promisify(execFile);
type Install = Pick<Harness, 'hub' | 'gitlab' | 'admin' | 'rows' | 'records' | 'state' | 'until' |
  'openIssue' | 'pendingCard' | 'stopPod' | 'checkSecrets' | 'sandbox'>;

export async function checkStartupFailures(h: Install, local: NodeJS.ProcessEnv, iid: number) {
  const existing = await h.state(iid, 'IDLE');
  const resource = await h.gitlab.getIssue(h.hub, iid);
  const notes = await h.gitlab.listIssueNotes(h.hub, iid);
  const keys = ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET', 'MYSQL_PASSWORD', 'ANTHROPIC_API_KEY',
    'JEV_API_KEY', 'JUMPSERVER_READONLY_TOKEN', 'JUMPSERVER_JOB_TOKEN'];
  const secrets = Object.fromEntries(keys.map(key => [key, randomUUID()]));
  const base = { ...local, ...secrets, MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '1' };
  const cases: [NodeJS.ProcessEnv, RegExp][] = [
    [{ GITLAB_WEBHOOK_SECRET: undefined }, /GITLAB_WEBHOOK_SECRET is required/],
    [{ JUMPSERVER_JOB_ACCESS_KEY_ID: secrets.JUMPSERVER_JOB_TOKEN }, /requires both access key ID and secret/],
    [{ WATCHDOG_INTERVAL_MS: '1000' }, /watchdogIntervalMs/],
    [{}, /ECONNREFUSED/],
  ];
  for (const [overrides, reason] of cases) {
    await assert.rejects(run(process.execPath, ['packages/delivery/dist/server.js'], {
      env: { ...base, ...overrides }, timeout: 10000,
    }), (err: Error & { code?: number; stderr?: string; stdout?: string; killed?: boolean }) => {
      assert.ok(typeof err.code === 'number' && err.code > 0 && !err.killed, 'Expected spontaneous startup failure');
      assert.ok(Object.values(secrets).every(secret => !(err.stderr + '\n' + err.stdout).includes(secret)), 'Startup leaked a credential');
      assert.match(err.stderr ?? '', reason);
      return true;
    });
    assert.deepEqual(await h.state(iid, 'IDLE'), existing);
    assert.deepEqual(await h.gitlab.getIssue(h.hub, iid), resource);
    assert.deepEqual(await h.gitlab.listIssueNotes(h.hub, iid), notes);
    await checkSession(h, existing);
  }
}

export async function protectedHubInstall(h: Install, local: NodeJS.ProcessEnv, tmp: string, publicUrl: string) {
  const { admin, gitlab } = h;
  const namespace = 'devops';
  const group = await admin.json<{ id: number }>('/groups', 'POST', { name: namespace, path: namespace });
  const root = await admin.json<{ id: number }>('/user');
  await admin.request('/groups/' + group.id + '/members/' + root.id, 'PUT', { access_level: 30 });
  const out = join(tmp, 'protected-hub.env');
  const hubPath = namespace + '/workspace-hub';
  const provision = (credential: NodeJS.ProcessEnv) => run(join(process.cwd(), 'node_modules/.bin/tsx'),
    ['scripts/bootstrap.ts', '--env-out', out], { env: { ...local, GITLAB_BASE_URL: gitlab.baseUrl,
      DETENT_PUBLIC_URL: publicUrl, DETENT_HUB_PROJECT: hubPath, DETENT_TARGET_PROJECTS: namespace + '/business', ...credential } });
  await provision({ GITLAB_ADMIN_TOKEN: gitlab.adminToken });
  const config = parseEnv(await readFile(out, 'utf8'));
  const bot = await admin.json<{ id: number; username: string }>('/user', 'GET', undefined, config.GITLAB_TOKEN);
  const hub = '/projects/' + config.GITLAB_HUB_PROJECT_ID;
  const role = async (project: string, user: number) =>
    (await admin.json<{ access_level: number }>(project + '/members/all/' + user)).access_level;
  assert.equal(await role(hub, root.id), 30);
  assert.equal(await role(hub, bot.id), 50);
  assert.equal(await role('/projects/devops%2Fbusiness', bot.id), 30);
  assert.equal(await admin.lookup('/groups/' + group.id + '/members/all/' + bot.id), null);
  const denied = await admin.request(hub + '/repository/files/README.md', 'PUT', {
    branch: 'main', content: 'unauthorized', commit_message: 'Attempt protected branch write',
  }, gitlab.adminToken, [403]);
  assert.equal(denied.status, 403);

  const templates = 'examples/hub-workspace';
  const log = await run('git', ['log', '--format=%an', 'main'], { cwd: join(tmp, hubPath + '.git') });
  assert.deepEqual([...new Set(log.stdout.trimEnd().split('\n'))], [bot.username], 'All Hub commits must be bot-authored');
  for (const path of await readdir(templates, { recursive: true })) {
    if (path.endsWith('.DS_Store') || !(await stat(join(templates, path))).isFile()) continue;
    assert.equal(await gitlab.getFile(Number(config.GITLAB_HUB_PROJECT_ID), path), await readFile(join(templates, path), 'utf8'), path);
  }

  await admin.request(hub + '/members/' + bot.id, 'PUT', { access_level: 30 });
  await assert.rejects(provision({ GITLAB_TOKEN: config.GITLAB_TOKEN }), /Grant @detent-bot Maintainer \(40\) or Owner \(50\) on the Hub project devops\/workspace-hub/);
  await provision({ GITLAB_ADMIN_TOKEN: gitlab.adminToken });
  assert.equal(await role(hub, bot.id), 50, 'Admin rerun must upgrade an existing Hub membership');
}

export async function brownfieldOnboarding(h: Install, local: NodeJS.ProcessEnv, tmp: string, publicUrl: string) {
  const { admin, gitlab } = h;
  const group = await admin.json<{ id: number }>('/namespaces/apps');
  const bot = await admin.json<{ id: number }>('/users', 'POST', { username: 'brownfield-bot' });
  await admin.request('/groups/' + group.id + '/members', 'POST', { user_id: bot.id, access_level: 40 });
  const { token } = await admin.json<{ token: string }>('/users/' + bot.id + '/personal_access_tokens', 'POST', {
    scopes: ['api', 'read_repository', 'write_repository'], expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  });
  assert.equal((await admin.request('/users', 'POST', {}, token, [403])).status, 403);
  const create = (path: string, initialize: boolean) => admin.json<{ id: number }>('/projects', 'POST', {
    path, name: path, namespace_id: group.id, initialize_with_readme: initialize, default_branch: 'main',
  });
  const hub = await create('existing-hub', true);
  const empty = await create('uninitialized', false);
  await create('existing-web', true);
  await create('existing-api', true);
  const discovery = await admin.json<{ id: number }>('/groups', 'POST', { path: 'discovery', name: 'discovery' });
  const discovered = await admin.json<{ id: number }>('/projects', 'POST', { namespace_id: discovery.id, path: 'service', name: 'service', initialize_with_readme: true });
  await admin.request('/groups/' + discovery.id + '/members', 'POST', { user_id: bot.id, access_level: 40 });
  await admin.request('/projects/' + discovered.id + '/members', 'POST', { user_id: bot.id, access_level: 40 });
  const targets = ['apps/uninitialized', 'apps/existing-web', 'apps/existing-api'];
  for (const ref of [String(hub.id), ...targets]) {
    const project = await admin.json<{ id: number }>('/projects/' + encodeURIComponent(ref));
    await admin.request('/projects/' + project.id + '/members', 'POST', { user_id: bot.id, access_level: 40 });
  }
  const uninitialized = await admin.json<{ empty_repo: boolean; default_branch: string | null }>('/projects/' + empty.id);
  assert.equal(uninitialized.empty_repo, true);
  assert.equal(uninitialized.default_branch, null);
  const out = join(tmp, 'brownfield.env');
  const provision = async () => {
    const result = await run(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/bootstrap.ts', '--env-out', out], {
      env: { ...local, GITLAB_BASE_URL: gitlab.baseUrl, GITLAB_TOKEN: token, GITLAB_HUB_PROJECT_ID: String(hub.id),
        DETENT_PUBLIC_URL: publicUrl, DETENT_TARGET_GROUPS: 'discovery', DETENT_TARGET_PROJECTS: targets.join(',') }, timeout: 90000,
    });
    const config = parseEnv(await readFile(out, 'utf8'));
    assert.ok(config.GITLAB_TOKEN === token, 'Bootstrap must reuse the existing bot PAT');
    assert.equal(config.GITLAB_ADMIN_TOKEN, undefined);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.ok(config.GITLAB_WEBHOOK_SECRET);
    assert.ok([token, config.GITLAB_WEBHOOK_SECRET].every(s => !(result.stdout + result.stderr).includes(s)));
    return config;
  };
  await gitlab.upsertFile(hub.id, 'README.md', 'Team handbook\n', 'Customize Hub home page');
  const config = await provision();
  assert.equal(await gitlab.getFile(hub.id, 'README.md'), 'Team handbook\n');
  assert.equal(await gitlab.getFile(empty.id, 'README.md', 'main'), '# apps/uninitialized\n');
  const template = '.gitlab/issue_templates/code-delivery.md';
  assert.equal(await gitlab.getFile(hub.id, template), await readFile(join('examples/hub-workspace', template), 'utf8'));
  const labels = await admin.json<{ name: string }[]>('/projects/' + hub.id + '/labels');
  assert.ok(labels.some(l => l.name === 'delivery::code') && labels.some(l => l.name === 'claude::planning'));
  await gitlab.upsertFile(hub.id, template, 'Team-specific issue form\n', 'Customize team form');
  const head = await gitlab.headSha(hub.id);
  targets.push('apps/worker');
  assert.equal(await admin.lookup('/projects/apps%2Fworker'), null);
  assert.ok(isDeepStrictEqual(await provision(), config), 'Incremental bootstrap changed the environment');
  assert.equal(await gitlab.headSha(hub.id), head);
  for (const ref of [String(hub.id), ...targets, String(discovered.id)]) {
    const path = '/projects/' + encodeURIComponent(ref);
    const hooks = await admin.json<{ url: string; issues_events: boolean; merge_requests_events: boolean }[]>(path + '/hooks');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].url, publicUrl + '/webhooks/gitlab');
    assert.equal(hooks[0].issues_events, ref === String(hub.id));
    assert.equal(hooks[0].merge_requests_events, ref !== String(hub.id));
    assert.ok((await admin.json<{ access_level: number }>(path + '/members/all/' + bot.id)).access_level >= 30);
  }
  assert.deepEqual(await h.rows('SELECT id FROM issue_sessions WHERE hub_project_id=?', [hub.id]), []);
  assert.deepEqual(await readdir(h.sandbox), []);
}

export async function standaloneAndUpgrade(h: Install & {
  startPod(id: string, overrides?: NodeJS.ProcessEnv, service?: 'core' | 'delivery'): Promise<void>;
  checkWelcome(): Promise<void>;
  sql: ConnectionOptions; adminSql: ConnectionOptions;
}) {
  await h.startPod('standalone-core', {}, 'core');
  assert.deepEqual(await h.rows('SELECT id FROM issue_sessions WHERE hub_project_id=? LIMIT 1', [h.hub]), [], 'Hub already has sessions');
  await h.checkWelcome();
  const iid = await h.openIssue('Verify standalone runtime', '', 'delivery::code');
  const plan = await h.pendingCard(iid, 'Plan', ['Standalone plan']);
  await h.gitlab.awardThumbsUp(h.hub, iid, plan.gitlab_note_id, 'dev');
  const original = await h.state(iid, 'IDLE', 0);
  assert.ok((await h.gitlab.listIssueNotes(h.hub, iid)).some(n => n.body.includes('Standalone turn complete')));
  await checkSession(h, original);
  await h.stopPod();

  const database = 'detent_upgrade_v5';
  const admin = await mysql.createConnection(h.adminSql);
  try {
    // Fail on a pre-existing database so cleanup only removes a fixture owned by this run.
    await admin.query('CREATE DATABASE detent_upgrade_v5 CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    try {
      if (h.adminSql.user !== h.sql.user)
        await admin.query("GRANT ALL ON detent_upgrade_v5.* TO 'detent'@'%'");
      const db = await mysql.createConnection({ ...h.sql, database });
      try {
        const rows = async (sql: string, params: (string | number)[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0];
        const records = (id: string, table: string) => rows('SELECT * FROM ' + table + ' WHERE session_id=?', [id]);
        await db.query(`CREATE TABLE issue_sessions (
          id CHAR(36) PRIMARY KEY, hub_project_id BIGINT NOT NULL, hub_issue_iid BIGINT NOT NULL,
          issue_title VARCHAR(512) NOT NULL, claude_session_id VARCHAR(128), last_message_seq INT NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'PLANNING', permission_mode VARCHAR(32) NOT NULL DEFAULT 'plan',
          active_note_id BIGINT, stop_requested BOOLEAN NOT NULL DEFAULT FALSE, locked_by_pod VARCHAR(192),
          lock_expires_at DATETIME(3), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          UNIQUE(hub_project_id,hub_issue_iid)) ENGINE=InnoDB`);
        await db.query(`CREATE TABLE session_messages (id BIGINT AUTO_INCREMENT PRIMARY KEY,
          session_id CHAR(36) NOT NULL, FOREIGN KEY(session_id) REFERENCES issue_sessions(id),
          seq INT NOT NULL, message_uuid VARCHAR(64), message_type VARCHAR(64) NOT NULL, raw_json_line MEDIUMTEXT NOT NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(session_id,seq)) ENGINE=InnoDB`);
        const columns = (await rows('SHOW COLUMNS FROM issue_sessions')).map(c => c.Field as string);
        await db.query('INSERT INTO issue_sessions SET ?', [Object.fromEntries(columns.map(key => [key, original[key]]))]);
        const history = await h.rows('SELECT * FROM session_messages WHERE session_id=? ORDER BY seq', [original.id]);
        assert.ok(history.length > 0);
        for (const message of history) await db.query('INSERT INTO session_messages SET ?', [message]);
        await h.startPod('upgrade-delivery', { MYSQL_DATABASE: database });
        try {
          const indexes = await rows('SHOW INDEX FROM issue_sessions');
          assert.ok(indexes.every(i => i.Key_name !== 'hub_project_id'));
          assert.deepEqual(indexes.filter(i => i.Key_name === 'session_resource' && i.Non_unique === 0)
            .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(i => i.Column_name), ['session_kind', 'hub_project_id', 'hub_issue_iid']);
          const [migrated] = await rows('SELECT * FROM issue_sessions WHERE id=?', [original.id]);
          assert.deepEqual(migrated, original);
          assert.deepEqual(await records(original.id, 'session_inbox'), []);
          await h.gitlab.postNote(h.hub, iid, 'Continue from the historical checkpoint');
          const resumed = await h.until('legacy SDK transcript resumed', async () => {
            const [s] = await rows('SELECT * FROM issue_sessions WHERE id=?', [original.id]);
            assert.notEqual(s.status, 'FAILED');
            if (s.status === 'IDLE' && !s.locked_by_pod && s.last_message_seq > history.length) return s;
          });
          assert.equal(resumed.claude_session_id, original.claude_session_id);
          assert.deepEqual((await rows('SELECT * FROM session_messages ORDER BY seq')).slice(0, history.length), history);
          assert.ok((await h.gitlab.listIssueNotes(h.hub, iid)).some(n => n.body.includes('Resumed the historical checkpoint')));
          await checkSession({ ...h, records }, resumed);
        } finally { await h.stopPod(); }
      } finally { await db.end(); }
    } finally { await admin.query('DROP DATABASE detent_upgrade_v5'); }
  } finally { await admin.end(); }
  console.log('Verified standalone Core, native env-file startup and V5 transcript recovery on MySQL 8.0.');
  return iid;
}
