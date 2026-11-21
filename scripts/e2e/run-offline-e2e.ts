import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createOfflineAnthropic } from './offline-anthropic.js';
import { offlineGitLab } from './offline-gitlab.js';
import { offlineJumpServer } from './offline-jumpserver.js';

const run = promisify(execFile);
const loopback = '127.0.0.1';
async function listen(server: Server) {
  server.listen(0, loopback);
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
    cleanup.push(() => close(server));
    return 'http://' + loopback + ':' + port;
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
    const gitlab = offlineGitLab(tmp), jms = offlineJumpServer();
    const gitUrl = await serve(gitlab.handle);
    const jmsUrl = await serve(jms.handle);
    const anthropic = createOfflineAnthropic();
    const anthropicUrl = await serve(anthropic.handle);
    const env = process.env;
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
    const podPort = await listen(reservation);
    cleanup.push(async () => { if (reservation.listening) await close(reservation); });
    const publicUrl = 'http://' + loopback + ':' + podPort;
    const sandbox = join(tmp, 'sandboxes'), envFile = join(tmp, '.env');
    const localEnv = { PATH: env.PATH, HOME: tmp, TMPDIR: tmp };
    const provision = (extra: Record<string, string> = {}) => run(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/bootstrap.ts', '--env-out', envFile], {
      env: { ...localEnv, GITLAB_BASE_URL: gitUrl, GITLAB_ADMIN_TOKEN: gitlab.admin, DETENT_PUBLIC_URL: publicUrl,
        DETENT_TARGET_PROJECTS: 'apps/web,ops/ansible-infra', DETENT_HUB_MEMBERS: 'dev:30,sre:40',
        HOST: loopback, PORT: String(podPort), EPHEMERAL_ROOT: sandbox, MYSQL_HOST: host, MYSQL_PORT: String(port),
        MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: database, ANTHROPIC_API_KEY: 'offline-api-key',
        ANTHROPIC_BASE_URL: anthropicUrl, ...extra },
      timeout: 60000,
    });
    await provision();
    const config = parseEnv(await readFile(envFile, 'utf8'));
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal(config.GITLAB_ADMIN_TOKEN, undefined);
    const hub = Number(config.GITLAB_HUB_PROJECT_ID);
    async function gitlabGet(path: string) {
      const res = await fetch(gitUrl + '/api/v4' + path, { headers: { 'PRIVATE-TOKEN': gitlab.admin } });
      assert.equal(res.status, 200, path);
      return res.json();
    }
    const projects: { id: number; path_with_namespace: string }[] = await gitlabGet('/projects');
    assert.equal(projects.length, 3);
    assert.equal(projects.find(p => p.id === hub)?.path_with_namespace, 'ai/workspace-hub');
    const target = projects.find(p => p.path_with_namespace === 'ops/ansible-infra')!;
    const web = projects.find(p => p.path_with_namespace === 'apps/web')!;
    const releasePath = 'workflows/release.md';
    async function hubFile(path: string) {
      const file = await gitlabGet('/projects/' + hub + '/repository/files/' + encodeURIComponent(path) + '?ref=main');
      return Buffer.from(file.content, 'base64').toString();
    }
    const templates = ['CLAUDE.md'];
    for (const name of ['audit', 'code-delivery', 'env-change', 'release'])
      templates.push('workflows/' + name + '.md', '.gitlab/issue_templates/' + name + '.md');
    for (const path of templates)
      assert.equal(await hubFile(path), await readFile(join('examples/hub-workspace', path), 'utf8'), path);

    const savedSop = await hubFile(releasePath) + '\nInclude the change ticket in release notes.\n';
    await gitlab.updateFile(hub, releasePath, savedSop, 'Document team release notes');
    const jmsEnv = { JUMPSERVER_BASE_URL: jmsUrl, JUMPSERVER_READONLY_TOKEN: jms.readonly, JUMPSERVER_JOB_TOKEN: jms.job };
    await provision(jmsEnv);
    const withJms = parseEnv(await readFile(envFile, 'utf8'));
    assert.deepEqual({ ...withJms }, { ...config, ...jmsEnv }, 'Bootstrap changed existing settings or credentials');
    assert.equal(await hubFile(releasePath), savedSop, 'Bootstrap overwrote the customer workflow');
    const labels: { name: string }[] = await gitlabGet('/projects/' + hub + '/labels');
    assert.deepEqual(labels.map(l => l.name).sort(), ['claude::coding', 'claude::failed', 'claude::idle', 'claude::planning',
      'claude::waiting-approval', 'delivery::audit', 'delivery::code', 'delivery::env-change', 'delivery::release']);
    for (const p of projects) {
      const hooks = await gitlabGet('/projects/' + p.id + '/hooks');
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].url, publicUrl + '/webhooks/gitlab');
      assert.equal(hooks[0].pipeline_events, p.id !== hub);
      assert.equal(hooks[0].push_events, false);
    }
    async function startPod(id: string, settings: NodeJS.ProcessEnv) {
      pod = spawn(process.execPath, ['packages/delivery/dist/server.js'], {
        env: { ...localEnv, ...settings, POD_ID: id }, stdio: ['ignore', 'inherit', 'inherit'], detached: true,
      });
      pod.on('error', error => { failure = error; });
      await until(id + ' health check', async () => {
        const res = await fetch(publicUrl + '/healthz').catch(() => undefined);
        return res?.ok && (await res.json()).podId === id;
      });
    }
    await close(reservation);
    const fixtures = () => rows('SELECT id FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid BETWEEN 1 AND 4', [hub]);
    let ownsIssues = false;
    if (external) cleanup.push(async () => {
      if (!ownsIssues) return;
      const cx = await db.getConnection();
      try {
        await cx.beginTransaction();
        for (const fixture of await fixtures()) {
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
    assert.deepEqual(await fixtures(), [], 'Fixture Issues already exist');
    ownsIssues = true;
    async function state(iid: number, status: string) {
      return until('#' + iid + ' ' + status, async () => {
        const [s] = await rows('SELECT * FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid=?', [hub, iid]);
        if (s?.status === 'FAILED') throw Error('Delivery failed: ' + gitlab.issueNotes(iid).at(-1));
        if (s?.status === status && (status === 'WAITING_TOOL' || !s.locked_by_pod)) return s;
      });
    }

    async function rejectDeveloper(iid: number, approval: RowDataPacket) {
      gitlab.membershipChecks.length = 0;
      await gitlab.awardEmoji(iid, approval.gitlab_note_id, 'dev');
      await until('developer RBAC lookup', () => gitlab.membershipChecks.includes(hub + '/2'));
      assert.equal((await rows('SELECT status FROM approval_requests WHERE id=?', [approval.id]))[0].status, 'PENDING');
    }

    anthropic.resetRequests();
    const unlabeled = await gitlab.openIssue(hub, { title: 'Choose a workflow', description: '', labels: [] });
    await state(unlabeled, 'IDLE');
    assert.equal(anthropic.getRequests(), 0);
    const [menu] = gitlab.issueNotes(unlabeled);
    assert.match(menu, /delivery::audit\b/);
    assert.match(menu, /delivery::env-change .*缺少能力包：jumpserver/);
    assert.match(menu, /delivery::release .*已就绪/);
    assert.match(menu, /delivery::code .*已就绪/);
    const missing = await gitlab.openIssue(hub, { title: 'Inspect web01', description: '', labels: ['delivery::env-change'] });
    await state(missing, 'IDLE');
    assert.equal(anthropic.getRequests(), 0);
    const [guidance] = gitlab.issueNotes(missing);
    assert.match(guidance, /jumpserver：.*JUMPSERVER_BASE_URL/);
    const alternatives = guidance.split('\n').find(line => line.includes('已就绪的工作流标签')) ?? '';
    for (const label of ['delivery::release', 'delivery::code']) assert.ok(alternatives.includes(label));
    console.log('Workflow menu and missing-capability guidance posted with zero Anthropic requests.');

    const customReleaseWorkflow = [
      '---', 'label: delivery::release', 'mode: governed', 'requires: [gitlab-release]', 'approver_tier: prod', '---',
      'CUSTOM_RELEASE_TAG_PREFIX: rel-', 'List existing tags, then request approval to publish the pinned commit.', '',
    ].join('\n');
    await gitlab.updateFile(hub, releasePath, customReleaseWorkflow, 'Customize release tag convention');
    const webSha = gitlab.headSha(web.id);
    assert.match(webSha, /^[a-f0-9]{40}$/);
    const release = await gitlab.openIssue(hub, { title: 'Publish the web service', description: 'Release apps/web at ' + webSha,
      labels: ['delivery::release'] });
    const planned = await state(release, 'WAITING_PLAN');
    const [releasePlan] = await rows('SELECT * FROM approval_requests WHERE session_id=? AND approval_type=?', [planned.id, 'PLAN']);
    const planBody = gitlab.notes.get(releasePlan.gitlab_note_id)!.body;
    for (const field of ['rel-1.0.0', webSha]) assert.ok(planBody.includes(field));
    await gitlab.awardEmoji(release, releasePlan.gitlab_note_id, 'dev');
    await state(release, 'WAITING_TOOL');
    const [publish] = await rows('SELECT * FROM approval_requests WHERE session_id=? AND tool_name=?', [planned.id, 'detent_create_release']);
    const releaseCard = gitlab.notes.get(publish.gitlab_note_id)!.body;
    for (const field of ['GitLab 发布审批', 'apps/web', 'rel-1.0.0', webSha]) assert.ok(releaseCard.includes(field));
    await rejectDeveloper(release, publish);
    assert.equal(gitlab.tagCommit(web.id, 'rel-1.0.0'), undefined);
    assert.deepEqual(gitlab.releases.get(web.id), []);
    await gitlab.awardEmoji(release, publish.gitlab_note_id, 'sre');
    await state(release, 'IDLE');
    const [published] = await rows('SELECT status, decided_by FROM approval_requests WHERE id=?', [publish.id]);
    assert.equal(published.status, 'APPROVED');
    assert.equal(published.decided_by, 'sre');
    assert.equal(gitlab.tagCommit(web.id, 'rel-1.0.0'), webSha);
    assert.deepEqual(gitlab.releases.get(web.id), [{ tag_name: 'rel-1.0.0', name: 'Release rel-1.0.0',
      description: 'Live customized release workflow verified.', commit: { id: webSha },
      _links: { self: gitUrl + '/apps/web/-/releases/rel-1.0.0' } }]);
    assert.ok(gitlab.issueNotes(release).some(note => note.includes('Release rel-1.0.0 published for apps/web.')));
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Live Hub release SOP verified on the same pod. Maintainer approved the pinned tag and release.');

    await stopPod();
    await startPod('detent-pod-1', withJms);
    const change = await gitlab.openIssue(hub, { title: 'Reload nginx on web01',
      description: 'Prepare and verify a reviewed nginx reload.', labels: ['delivery::env-change'] });
    assert.deepEqual([unlabeled, missing, release, change], [1, 2, 3, 4]);
    const first = await state(change, 'WAITING_PLAN');
    const id = first.id;
    const records = (table: string) => rows('SELECT * FROM ' + table + ' WHERE session_id=?', [id]);
    const transcript = () => rows('SELECT seq, raw_json_line FROM session_messages WHERE session_id=? ORDER BY seq', [id]);
    const prefix = await transcript();
    assert.ok(prefix.length > 0 && prefix.length === first.last_message_seq);
    const [plan] = await records('approval_requests');
    assert.equal(plan.approval_type, 'PLAN');
    assert.match(gitlab.notes.get(plan.gitlab_note_id)!.body, /Claude 实施方案审批/);
    assert.equal(jms.inspections.length, 1);
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Plan persisted. Restarting the delivery pod.');
    await stopPod();
    await startPod('detent-pod-2', withJms);
    await gitlab.awardEmoji(change, plan.gitlab_note_id, 'dev');
    const coding = await state(change, 'IDLE');
    assert.equal(coding.claude_session_id, first.claude_session_id);
    assert.ok(coding.last_message_seq > first.last_message_seq);
    assert.ok((await transcript()).some(row => row.raw_json_line.includes('尚未合并')), 'Missing pre-merge rejection');
    const [mr] = await records('session_merge_requests');
    assert.equal(mr.mr_state, 'opened');
    assert.equal(mr.mr_iid, 1);
    assert.equal(mr.target_project_id, target.id);
    const [worktree] = await records('session_worktrees');
    assert.equal(worktree.id, mr.worktree_id);
    assert.equal(worktree.branch_name, 'change/issue-' + change);
    assert.equal((await records('approval_requests')).length, 1);
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);
    console.log('MR opened after restart. Premature execution denied.');

    const sha = await gitlab.mergeMergeRequest(target.id, 1);
    const waiting = await state(change, 'WAITING_TOOL');
    assert.match(waiting.locked_by_pod, /^detent-pod-2\//);
    const [merged] = await records('session_merge_requests');
    assert.equal(merged.merge_commit_sha, sha);
    assert.equal(merged.mr_state, 'merged');
    assert.equal(merged.merged_by, 'sre');
    assert.notEqual(sha, worktree.last_commit_sha, 'Expected a distinct merge commit');
    const approvals = await records('approval_requests');
    assert.equal(approvals.length, 2);
    assert.equal(approvals.find(a => a.id === plan.id)?.decided_by, 'dev');
    const production = approvals.find(a => a.tool_name === 'jms_run_ansible_job')!;
    const card = gitlab.notes.get(production.gitlab_note_id)!.body;
    for (const field of ['生产变更执行审批', sha, 'web01', 'deploy/nginx-reload.yml', mr.mr_web_url]) assert.ok(card.includes(field));
    await rejectDeveloper(change, production);
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);

    await gitlab.awardEmoji(change, production.gitlab_note_id, 'sre');
    const final = await state(change, 'IDLE');
    assert.equal(final.claude_session_id, first.claude_session_id);
    const [decision] = await rows('SELECT * FROM approval_requests WHERE id=?', [production.id]);
    assert.equal(decision.decided_by, 'sre');
    assert.equal(decision.status, 'APPROVED');
    assert.deepEqual(jms.uploads, [sha]);
    assert.equal(jms.inspections.length, 2);
    const audits = await records('delivery_executions');
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
    assert.ok(gitlab.issueNotes(change).some(n => n.includes('Reload verified on web01')));
    await gitlab.postNote(change, '/status');
    const status = await until('/status reply', () => gitlab.issueNotes(change).find(n => n.startsWith('IDLE\n')));
    for (const field of ['ops/ansible-infra!1', 'merged @ ' + sha.slice(0, 8), '交付执行记录', 'env-change',
      'deploy/nginx-reload.yml', 'SUCCESS', audit.jumpserver_job_url, production.id]) assert.ok(status.includes(field));
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
