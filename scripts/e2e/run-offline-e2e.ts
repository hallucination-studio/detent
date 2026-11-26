import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createOfflineAnthropic } from './offline-anthropic.js';
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
  let pod: ChildProcess | undefined;
  const interrupt = () => { failure = Error('E2E interrupted'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  async function until<T>(label: string, probe: () => Promise<T> | T) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (pod && (pod.exitCode !== null || pod.signalCode !== null)) throw Error('Delivery exited while waiting for ' + label);
      const value = await probe();
      if (value) return value;
      await delay(150);
    }
    throw Error('Timed out waiting for ' + label);
  }

  // Serve the same HTTP Request/Response contract for JSON, SSE, multipart, and binary Git traffic.
  async function serve(handler: (req: Request) => Promise<Response>) {
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
    const port = await listen(server);
    return { baseUrl: 'http://' + loopback + ':' + port, close: () => close(server) };
  }

  async function stopPod() {
    const child = pod;
    pod = undefined;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    // A failed run can still be holding an SDK approval. Terminate its process group on timeout.
    const kill = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 4000);
    try { await stopped; } finally { clearTimeout(kill); }
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
    const anthropic = createOfflineAnthropic({ webRepo, apiRepo, ansibleRepo });
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
      name: 'harbor-sync', approverTier: 'prod', toolPolicies: { check_image_exists: 'readonly' },
      transport: { type: 'streamable-http', url: mcpServer.baseUrl + '/mcp', headers: { Authorization: 'Bearer ${HARBOR_SYNC_TOKEN}' } },
    }] }));
    const external = env.E2E_MYSQL_HOST;
    const host = external || loopback;
    assert.ok([loopback, 'localhost', '::1'].includes(host), 'E2E_MYSQL_HOST must be local');
    const user = external ? env.E2E_MYSQL_USER ?? 'root' : 'detent';
    const password = external ? env.E2E_MYSQL_PASSWORD ?? '' : randomUUID();
    const database = external ? env.E2E_MYSQL_DATABASE ?? 'detent' : 'detent';
    let port = Number(env.E2E_MYSQL_PORT ?? 3306);
    if (!external) {
      const name = 'detent-e2e-' + randomUUID();
      await run('docker', ['run', '--pull=never', '--rm', '-d', '--name', name, '-p', loopback + '::3306',
        '-e', 'MYSQL_RANDOM_ROOT_PASSWORD=yes', '-e', 'MYSQL_DATABASE=detent', '-e', 'MYSQL_USER=detent',
        '-e', 'MYSQL_PASSWORD', 'mysql:8.0'], { env: { ...env, MYSQL_PASSWORD: password } });
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
    const localEnv = { PATH: env.PATH, HOME: tmp, TMPDIR: tmp };
    const provision = (extra: Record<string, string> = {}) => run(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/bootstrap.ts', '--env-out', envFile], {
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
    const config = parseEnv(await readFile(envFile, 'utf8'));
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal(config.GITLAB_ADMIN_TOKEN, undefined);
    assert.equal(config.DETENT_MCP_CAPABILITIES_FILE, capabilitiesFile);
    assert.equal(config.JEV_ROUTING_THRESHOLD, '0.8');
    const hub = Number(config.GITLAB_HUB_PROJECT_ID);
    const admin = gitlabApi(gitlab.baseUrl, gitlab.adminToken);
    if (env.E2E_GITLAB_URL) cleanup.push(() => admin.request('/personal_access_tokens/self', 'DELETE', undefined, config.GITLAB_TOKEN));
    const project = (path: string) => admin.json<{ id: number; path_with_namespace: string }>('/projects/' + encodeURIComponent(path));
    const projects = await Promise.all([gitlab.hubProjectPath, webRepo, apiRepo, ansibleRepo].map(project));
    const [hubProject, web, api, target] = projects;
    assert.equal(hubProject.id, hub);
    assert.equal(new Set(projects.map(p => p.id)).size, 4);
    const releasePath = 'agents/release/AGENT.md';
    const imagePath = 'agents/image-sync/AGENT.md';
    const hubFile = (path: string) => gitlab.getFile(hub, path);
    const templates = ['CLAUDE.md', imagePath, 'agents/image-sync/skills/mirror-to-harbor/SKILL.md', 'skills/gitlab-mr-conventions/SKILL.md'];
    for (const name of ['audit', 'code-delivery', 'env-change', 'release'])
      templates.push('agents/' + name + '/AGENT.md', '.gitlab/issue_templates/' + name + '.md');
    for (const path of templates)
      assert.equal(await hubFile(path), await readFile(join('examples/hub-workspace', path), 'utf8'), path);

    const savedSop = await hubFile(releasePath) + '\nInclude the change ticket in release notes.\n';
    await gitlab.upsertFile(hub, releasePath, savedSop, 'Document team release notes');
    const hubHead = await gitlab.headSha(hub);
    const jmsEnv = { JUMPSERVER_BASE_URL: jmsServer.baseUrl, JUMPSERVER_READONLY_TOKEN: jms.readonly, JUMPSERVER_JOB_TOKEN: jms.job };
    await provision(jmsEnv);
    const withJms = parseEnv(await readFile(envFile, 'utf8'));
    assert.deepEqual({ ...withJms }, { ...config, ...jmsEnv }, 'Bootstrap changed existing settings or credentials');
    assert.equal(await hubFile(releasePath), savedSop, 'Bootstrap overwrote the customer Agent');
    assert.equal(await gitlab.headSha(hub), hubHead, 'Bootstrap changed the Hub repository on its second run');
    const labels = await admin.json<{ name: string }[]>('/projects/' + hub + '/labels?per_page=100');
    for (const name of ['agent::image-sync', 'claude::coding', 'claude::done', 'claude::failed', 'claude::idle', 'claude::planning',
      'claude::waiting-approval', 'delivery::audit', 'delivery::code', 'delivery::env-change', 'delivery::release'])
      assert.ok(labels.some(label => label.name === name), 'Missing Hub label ' + name);
    for (const p of projects) {
      const hooks = await admin.json<{ url: string; issues_events: boolean; note_events: boolean; emoji_events: boolean;
        merge_requests_events: boolean; pipeline_events: boolean; push_events: boolean }[]>('/projects/' + p.id + '/hooks');
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].url, publicUrl + '/webhooks/gitlab');
      assert.equal(hooks[0].issues_events, p.id === hub);
      assert.equal(hooks[0].note_events, p.id === hub);
      assert.equal(hooks[0].emoji_events, p.id === hub);
      assert.equal(hooks[0].merge_requests_events, p.id !== hub);
      assert.equal(hooks[0].pipeline_events, p.id !== hub);
      assert.equal(hooks[0].push_events, false);
    }
    async function startPod(id: string, settings: NodeJS.ProcessEnv) {
      assert.equal(settings.ANTHROPIC_BASE_URL, mock.baseUrl, 'Claude Code requires the loopback mock');
      pod = spawn(process.execPath, ['packages/delivery/dist/server.js'], {
        env: { ...localEnv, ...settings, POD_ID: id, JEV_PROVIDER: 'bailian',
          JEV_BASE_URL: jevServer.baseUrl + '/compatible-mode/v1/systemone', JEV_API_KEY: 'offline-jev-key', HARBOR_SYNC_TOKEN: mcp.token },
        stdio: ['ignore', 'inherit', 'inherit'], detached: true,
      });
      pod.on('error', error => { failure = error; });
      await until(id + ' health check', async () => {
        const res = await fetch('http://' + loopback + ':' + podPort + '/healthz').catch(() => undefined);
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
    if (external) cleanup.push(async () => {
      if (!issueIds.length) return;
      const cx = await db.getConnection();
      try {
        await cx.beginTransaction();
        const [owned] = await cx.query<RowDataPacket[]>('SELECT id FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid IN (?)', [hub, issueIds]);
        for (const fixture of owned) {
          for (const table of ['delivery_executions', 'approval_requests', 'session_merge_requests', 'session_worktrees', 'session_messages'])
            await cx.query('DELETE FROM ' + table + ' WHERE session_id=?', [fixture.id]);
          await cx.query('DELETE FROM issue_sessions WHERE id=?', [fixture.id]);
        }
        await cx.commit();
      } catch (error) {
        await cx.rollback();
        throw error;
      } finally { cx.release(); }
    });
    cleanup.push(stopPod);
    const noJms = Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('JUMPSERVER_')));
    await startPod('detent-pod-nojms', noJms);
    assert.deepEqual(await rows('SELECT id FROM issue_sessions WHERE hub_project_id=? LIMIT 1', [hub]), [], 'Hub already has sessions');
    const notes = (iid: number) => gitlab.listIssueNotes(hub, iid);
    const award = (iid: number, approval: RowDataPacket, actor: 'dev' | 'sre') =>
      gitlab.awardThumbsUp(hub, iid, approval.gitlab_note_id, actor);
    const records = (session: string, table: string) => rows('SELECT * FROM ' + table + ' WHERE session_id=?', [session]);
    async function state(iid: number, status: string, afterSeq = -1) {
      return until('#' + iid + ' ' + status, async () => {
        const [s] = await rows('SELECT * FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid=?', [hub, iid]);
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
      const checks = gitlab.membershipChecks;
      if (checks) checks.length = 0;
      await award(iid, approval, 'dev');
      if (checks) await until('developer RBAC lookup', () => checks.includes(hub + '/2'));
      else await delay(1500);
      assert.equal((await rows('SELECT status FROM approval_requests WHERE id=?', [approval.id]))[0].status, 'PENDING');
    }

    const missing = await openIssue('Inspect web01', '', 'delivery::env-change');
    await state(missing, 'IDLE');
    assert.equal((await gitlab.getIssue(hub, missing)).state, 'opened');
    assert.equal(anthropic.getRequests(), 0);
    const guidance = (await notes(missing)).map(n => n.body).join('\n');
    assert.match(guidance, /agents\/env-change\/AGENT\.md/);
    assert.match(guidance, /jumpserver：.*JUMPSERVER_BASE_URL/);
    const alternatives = guidance.split('\n').find(line => line.includes('已就绪的Agent标签')) ?? '';
    for (const label of ['delivery::release', 'delivery::code', 'agent::image-sync']) assert.ok(alternatives.includes(label));
    assert.deepEqual(jev.routingRequests, []);
    console.log('Missing-capability guidance posted with zero Anthropic requests.');

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
    await until('triage /status reply', async () => (await notes(mirror)).some(n => n.body.startsWith('IDLE\n')));
    const { source_image, target_image } = imageMirror;
    const clarification = `请将 ${source_image} 同步到 ${target_image}。`;
    await gitlab.postNote(hub, mirror, clarification);
    const mirrorPlan = await pendingCard(mirror, 'Plan', ['🧭 已由 Jev 自动路由', '0.96', '实施方案审批',
      source_image, target_image, 'harbor-sync__check_image_exists']);
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
    assert.ok(reviewNote.body.includes('Jev 放行'));
    assert.ok(jev.requests.includes('pwd; ls -la') && jev.requests.some(command => command.startsWith('git -C ')));
    assert.ok(!(await records(review.id, 'approval_requests')).some(a => a.tool_name === 'Bash'));
    const firstMr = mrs.find(m => m.target_project_id === web.id)!;
    const secondMr = mrs.find(m => m.target_project_id === api.id)!;
    await gitlab.mergeMergeRequest(firstMr.target_project_id, firstMr.mr_iid);
    const waitingForMerge = await state(code, 'IDLE', review.last_message_seq);
    assert.ok((await notes(code)).some(n => n.body.includes('Waiting for the remaining MR to merge.')));
    assert.equal((await records(review.id, 'session_merge_requests')).filter(m => m.mr_state === 'opened').length, 1);
    assert.equal((await gitlab.getIssue(hub, code)).state, 'opened');
    await gitlab.mergeMergeRequest(secondMr.target_project_id, secondMr.mr_iid);
    assert.ok((await done(code)).last_message_seq > waitingForMerge.last_message_seq);
    const trees = await records(review.id, 'session_worktrees');
    assert.equal(trees.length, 2);
    assert.ok(trees.every(t => t.status === 'ARCHIVED' && t.branch_name === 'feat/issue-' + code));
    for (const p of [web, api]) assert.equal(await gitlab.getFile(p.id, 'hello.txt'), 'Hello from ' + p.path_with_namespace + '!\n');
    console.log('Cross-repo Issue closed after both human merges.');

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
    await startPod('detent-pod-1', withJms);
    const inspection = await openIssue('Diagnose nginx on web01', '', 'delivery::audit');
    const inspected = await done(inspection);
    assert.deepEqual(await records(inspected.id, 'approval_requests'), []);
    assert.deepEqual(jms.inspections, ['ss -lntp']);
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
    assert.equal(jms.inspections.length, 2);
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Plan persisted. Restarting the delivery pod.');
    await stopPod();
    await startPod('detent-pod-2', withJms);
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
    const status = await until('/status reply', async () => (await notes(change)).find(n => n.body.startsWith('WAITING_TOOL\n')));
    for (const field of [ansibleRepo + '!1', 'merged @ ' + sha.slice(0, 8), production.id]) assert.ok(status.body.includes(field));
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
    assert.deepEqual(jms.inspections, ['ss -lntp', 'systemctl status nginx', 'systemctl status nginx']);
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
    assert.ok(audit.finished_at);
    assert.ok((await notes(change)).some(n => n.body.includes('Reload verified on web01')));
    const history = await transcript();
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    assert.equal(history.length, final.last_message_seq);
    assert.ok(history.length > coding.last_message_seq);
    assert.ok(history.every((row, i) => row.seq === i + 1));
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Verified production approval, execution audit, /status, transcript and sandbox cleanup.');
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

main().catch(error => { console.error(error); process.exitCode = 1; });
