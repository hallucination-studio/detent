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
import { offlineAnthropic } from './offline-anthropic.js';
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
    const anthropicUrl = await serve(offlineAnthropic);
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
    const provision = () => run(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/bootstrap.ts', '--env-out', envFile], {
      env: { ...localEnv, GITLAB_BASE_URL: gitUrl, GITLAB_ADMIN_TOKEN: gitlab.admin, DETENT_PUBLIC_URL: publicUrl,
        DETENT_TARGET_PROJECTS: 'ops/ansible-infra', DETENT_HUB_MEMBERS: 'dev:30,sre:40',
        HOST: loopback, PORT: String(podPort), EPHEMERAL_ROOT: sandbox, MYSQL_HOST: host, MYSQL_PORT: String(port),
        MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: database, ANTHROPIC_API_KEY: 'offline-api-key',
        ANTHROPIC_BASE_URL: anthropicUrl, JUMPSERVER_BASE_URL: jmsUrl, JUMPSERVER_READONLY_TOKEN: jms.readonly,
        JUMPSERVER_JOB_TOKEN: jms.job },
      timeout: 60000,
    });
    await provision();
    const config = parseEnv(await readFile(envFile, 'utf8'));
    await provision();
    assert.deepEqual(parseEnv(await readFile(envFile, 'utf8')), config, 'Bootstrap rotated credentials on rerun');
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal(config.GITLAB_ADMIN_TOKEN, undefined);
    const hub = Number(config.GITLAB_HUB_PROJECT_ID);
    async function gitlabGet(path: string) {
      const res = await fetch(gitUrl + '/api/v4' + path, { headers: { 'PRIVATE-TOKEN': gitlab.admin } });
      assert.equal(res.status, 200, path);
      return res.json();
    }
    const projects: { id: number; path_with_namespace: string }[] = await gitlabGet('/projects');
    assert.equal(projects.length, 2);
    assert.equal(projects.find(p => p.id === hub)?.path_with_namespace, 'ai/workspace-hub');
    const target = projects.find(p => p.path_with_namespace === 'ops/ansible-infra')!;
    const file = await gitlabGet('/projects/' + hub + '/repository/files/CLAUDE.md?ref=main');
    assert.deepEqual(Buffer.from(file.content, 'base64'), await readFile('examples/hub-workspace/CLAUDE.md'));
    const labels: { name: string }[] = await gitlabGet('/projects/' + hub + '/labels');
    assert.deepEqual(labels.map(l => l.name).sort(), ['claude::coding', 'claude::failed', 'claude::idle', 'claude::planning',
      'claude::waiting-approval', 'delivery::audit', 'delivery::code', 'delivery::env-change']);
    for (const p of projects) {
      const hooks = await gitlabGet('/projects/' + p.id + '/hooks');
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].url, publicUrl + '/webhooks/gitlab');
      assert.equal(hooks[0].pipeline_events, p.id === target.id);
      assert.equal(hooks[0].push_events, false);
    }
    async function startPod(id: string) {
      pod = spawn(process.execPath, ['--env-file=' + envFile, 'packages/delivery/dist/server.js'], {
        env: { ...localEnv, POD_ID: id }, stdio: ['ignore', 'inherit', 'inherit'], detached: true,
      });
      pod.on('error', error => { failure = error; });
      await until(id + ' health check', async () => {
        const res = await fetch(publicUrl + '/healthz').catch(() => undefined);
        return res?.ok && (await res.json()).podId === id;
      });
    }
    await close(reservation);
    const session = async () => (await rows('SELECT * FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid=1', [hub]))[0];
    let ownsIssue = false;
    if (external) cleanup.push(async () => {
      const fixture = ownsIssue && await session();
      if (!fixture) return;
      const cx = await db.getConnection();
      try {
        await cx.beginTransaction();
        for (const table of ['delivery_executions', 'approval_requests', 'session_merge_requests', 'session_worktrees', 'session_messages'])
          await cx.query('DELETE FROM ' + table + ' WHERE session_id=?', [fixture.id]);
        await cx.query('DELETE FROM issue_sessions WHERE id=?', [fixture.id]);
        await cx.commit();
      } catch (error) {
        await cx.rollback();
        throw error;
      } finally { cx.release(); }
    });
    cleanup.push(stopPod);
    await startPod('detent-pod-1');
    assert.ok(!await session(), 'Fixture issue already exists');
    async function state(status: string, released = true) {
      return until(status, async () => {
        const s = await session();
        if (s?.status === 'FAILED') throw Error('Delivery failed: ' + [...gitlab.notes.values()].at(-1));
        if (s?.status === status && (!released || !s.locked_by_pod)) return s;
      });
    }
    ownsIssue = true;
    await gitlab.openIssue(hub);
    const first = await state('WAITING_PLAN');
    const id = first.id;
    const records = (table: string) => rows('SELECT * FROM ' + table + ' WHERE session_id=?', [id]);
    const transcript = () => rows('SELECT seq, raw_json_line FROM session_messages WHERE session_id=? ORDER BY seq', [id]);
    const prefix = await transcript();
    assert.ok(prefix.length > 0 && prefix.length === first.last_message_seq);
    const [plan] = await records('approval_requests');
    assert.equal(plan.approval_type, 'PLAN');
    assert.match(gitlab.notes.get(plan.gitlab_note_id)!, /Claude 实施方案审批/);
    assert.equal(jms.inspections.length, 1);
    assert.deepEqual(await readdir(sandbox), []);
    console.log('Plan persisted. Restarting the delivery pod.');
    await stopPod();
    await startPod('detent-pod-2');
    await gitlab.awardEmoji(plan.gitlab_note_id, 'dev');
    const coding = await state('IDLE');
    assert.equal(coding.claude_session_id, first.claude_session_id);
    assert.ok(coding.last_message_seq > first.last_message_seq);
    assert.ok((await transcript()).some(row => row.raw_json_line.includes('尚未合并')), 'Missing pre-merge rejection');
    const [mr] = await records('session_merge_requests');
    assert.equal(mr.mr_state, 'opened');
    assert.equal(mr.mr_iid, 1);
    assert.equal(mr.target_project_id, target.id);
    const [worktree] = await records('session_worktrees');
    assert.equal(worktree.id, mr.worktree_id);
    assert.equal(worktree.branch_name, 'change/issue-1');
    assert.equal((await records('approval_requests')).length, 1);
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);
    console.log('MR opened after restart. Premature execution denied.');

    const sha = await gitlab.mergeMergeRequest(target.id, 1);
    const waiting = await state('WAITING_TOOL', false);
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
    const card = gitlab.notes.get(production.gitlab_note_id)!;
    for (const field of ['生产变更执行审批', sha, 'web01', 'deploy/nginx-reload.yml', mr.mr_web_url]) assert.ok(card.includes(field));
    gitlab.membershipChecks.length = 0;
    await gitlab.awardEmoji(production.gitlab_note_id, 'dev');
    await until('developer RBAC lookup', () => gitlab.membershipChecks.includes(hub + '/2'));
    assert.equal((await rows('SELECT status FROM approval_requests WHERE id=?', [production.id]))[0].status, 'PENDING');
    assert.deepEqual(jms.uploads, []);
    assert.deepEqual(jms.executions, []);

    await gitlab.awardEmoji(production.gitlab_note_id, 'sre');
    const final = await state('IDLE');
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
    assert.equal(audit.status, 'SUCCESS');
    assert.match(audit.output_summary, /nginx reloaded/);
    assert.ok(audit.finished_at);
    assert.ok([...gitlab.notes.values()].some(n => n.includes('Reload verified on web01')));
    await gitlab.postNote('/status');
    const status = await until('/status reply', () => [...gitlab.notes.values()].find(n => n.startsWith('IDLE\n')));
    for (const field of ['ops/ansible-infra!1', 'merged @ ' + sha.slice(0, 8), '交付执行记录', 'EnvChangeAgent',
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
