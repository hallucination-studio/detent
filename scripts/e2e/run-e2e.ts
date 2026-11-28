import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { redactGitUrl } from '../../packages/core/src/gitlab/redact.js';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { liveGitLab } from './live-gitlab.js';
import { runScenario, sopNames, withReleaseTopology, type SopName } from './sop-scenarios.js';
import { loadStackState, type RealE2EStackState } from './stack.js';
import { ensureLocalHelmPath } from './toolchain.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

function selectedSops(): SopName[] {
  const { values } = parseArgs({ options: { sop: { type: 'string', default: 'all' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: npm run e2e -- --sop=all|' + sopNames.join(','));
    console.log('sop11 first runs sop10 to deploy the release used by the production rollback.');
    return [];
  }
  if (values.sop === 'all') return sopNames;
  const names = values.sop!.split(',').map(s => s.trim());
  for (const name of names) {
    if (!sopNames.includes(name as SopName)) throw Error('Expected --sop=all or a selection from ' + sopNames.join(','));
  }
  return [...new Set(names as SopName[])];
}

async function modelConfig() {
  const file = join(root, '.env');
  const env = parseEnv(await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw Error('Missing .env. Configure ANTHROPIC_API_KEY and JEV_API_KEY for the real E2E run.');
    throw error;
  }));
  const required = ['ANTHROPIC_API_KEY', 'JEV_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_MODEL', 'JEV_PROVIDER', 'JEV_BASE_URL', 'JEV_MODEL'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw Error('Missing real model configuration in .env: ' + missing.join(', '));
  assert.ok(['bailian', 'typesafe', 'custom'].includes(env.JEV_PROVIDER!.trim().toLowerCase()), 'Enable a real JEV_PROVIDER in .env');
  const keys = [...required, 'CLAUDE_MAX_TURNS', 'JEV_THRESHOLD', 'JEV_TIMEOUT_MS'];
  if (process.env.CLAUDE_MAX_TURNS) env.CLAUDE_MAX_TURNS = process.env.CLAUDE_MAX_TURNS;
  return Object.fromEntries(keys.filter(key => env[key]?.trim()).map(key => [key, env[key]!]));
}

class CredentialAudit {
  private forms = new Set<string>();
  add(...values: string[]) {
    for (const value of values.filter(Boolean)) {
      for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
        Buffer.from(value).toString('base64'), Buffer.from('oauth2:' + value).toString('base64')]) this.forms.add(form);
    }
  }
  check(text: string, location: string) {
    if (/\bglpat-[\w-]{20,}|https?:\/\/oauth2:(?!\*{3}@)[^\s/@]+@/i.test(text)) throw Error('Exposed GitLab credential in ' + location);
    for (const form of this.forms) {
      if (text.includes(form)) throw Error('Credential leak in ' + location);
    }
  }
  redact(text: string) {
    for (const form of this.forms) text = text.replaceAll(form, '[redacted]');
    return redactGitUrl(text).replace(/\bglpat-[\w-]{20,}/gi, '[redacted]');
  }
}

async function reservePort() {
  const server = createServer();
  const override = process.env.E2E_DETENT_PUBLIC_URL;
  const port = Number(process.env.E2E_POD_PORT ?? (override && new URL(override).port) ?? 0);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function startPod(env: NodeJS.ProcessEnv, audit: CredentialAudit) {
  const child = spawn(process.execPath, ['packages/delivery/dist/server.js'], {
    cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => console.log('[delivery] ' + audit.redact(line)));
  }
  return {
    check() {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode)
        throw Error('Delivery Pod exited unexpectedly (' + (child.signalCode ?? child.exitCode) + ')');
    },
    async stop() {
      if (!child.pid) return;
      const pid = child.pid;
      const killGroup = () => {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) {
          const { code } = error as NodeJS.ErrnoException;
          if (code !== 'ESRCH' && code !== 'EPERM') throw error;
        }
      };
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(killGroup, 15000);
      try { await exited; }
      finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) killGroup();
      }
    },
  };
}

async function auditRows(db: Pool, projects: number[], audit: CredentialAudit) {
  let count = 0;
  if (!projects.length) return count;
  const [sessions] = await db.query<RowDataPacket[]>('SELECT id FROM issue_sessions WHERE hub_project_id IN (?)', [projects]);
  for (const session of sessions) {
    let seq = 0;
    for (;;) {
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT * FROM session_messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT 100', [session.id, seq]);
      if (!rows.length) break;
      for (const row of rows) {
        const location = 'session_messages row ' + row.id;
        audit.check(row.raw_json_line, location);
        audit.check(JSON.stringify(row), location);
        // Scan decoded string fields too, including JSON-escaped Unicode and slashes.
        JSON.parse(row.raw_json_line, (key, value) => {
          audit.check(key, location);
          if (typeof value === 'string') audit.check(value, location);
          return value;
        });
        seq = row.seq;
        count++;
      }
    }
    const [executions] = await db.execute<RowDataPacket[]>('SELECT * FROM delivery_executions WHERE session_id=?', [session.id]);
    for (const row of executions) {
      for (const field of Object.values(row)) {
        audit.check(typeof field === 'string' ? field : JSON.stringify(field), 'delivery_executions row ' + row.id);
      }
      count++;
    }
  }
  return count;
}

async function deleteSessions(db: Pool, projects: number[]) {
  if (!projects.length) return;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const owned = 'SELECT id FROM issue_sessions WHERE hub_project_id IN (?)';
    for (const table of ['delivery_executions', 'session_pipeline_watches', 'session_merge_requests', 'approval_requests', 'session_worktrees', 'session_inbox', 'session_messages']) {
      await conn.query('DELETE FROM ' + table + ' WHERE session_id IN (' + owned + ')', [projects]);
    }
    await conn.query('DELETE FROM issue_sessions WHERE hub_project_id IN (?)', [projects]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

function message(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(message)].join('\n');
  return error instanceof Error ? error.message : String(error);
}

async function seedRepository(gitlab: ReturnType<typeof liveGitLab>, id: number, fixture: string) {
  const dir = join(root, 'scripts/e2e/fixtures', fixture);
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name);
    return { file_path: relative(dir, path), content: await readFile(path, 'utf8') };
  }));
  await gitlab.seedFiles(id, files);
}

async function main() {
  const selected = selectedSops();
  if (!selected.length) return;
  const models = await modelConfig();
  let stack: RealE2EStackState;
  try { stack = await loadStackState(); }
  catch (cause) { throw Error('Cannot load the real E2E stack state. Run npm run e2e:up first.', { cause }); }
  const timeoutMs = Number(process.env.E2E_PHASE_TIMEOUT_MS ?? 150000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Invalid E2E_PHASE_TIMEOUT_MS');
  const sopTimeoutMs = Number(process.env.E2E_SOP_TIMEOUT_MS ?? 420000);
  assert.ok(Number.isSafeInteger(sopTimeoutMs) && sopTimeoutMs > 0 && sopTimeoutMs <= 600000,
    'E2E_SOP_TIMEOUT_MS must be between 1 and 600000');
  const gitlab = liveGitLab(stack.gitlabUrl, stack.gitlabAdminToken);
  const audit = new CredentialAudit();
  const hookSecret = randomBytes(32).toString('hex');
  audit.add(models.ANTHROPIC_API_KEY, models.JEV_API_KEY, stack.gitlabAdminToken, stack.mysql.password,
    stack.jumpserverAccessKeyId, stack.jumpserverAccessKeySecret, hookSecret);
  const tmp = await mkdtemp(join(tmpdir(), 'detent-real-e2e-'));
  const db = createPool({ ...stack.mysql, connectTimeout: 5000, connectionLimit: 3 });
  const controller = new AbortController();
  const interrupt = () => controller.abort(Error('E2E run interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const errors: unknown[] = [];
  const timings: { sop: SopName; result: string; seconds: string }[] = [];
  const projectIds = new Set<number>();
  let pod: ReturnType<typeof startPod> | undefined;
  let reservation: Awaited<ReturnType<typeof reservePort>> | undefined;
  let ready = false;
  const checkRunning = () => { controller.signal.throwIfAborted(); pod?.check(); };

  try {
    console.log('Provisioning ' + gitlab.hubProjectPath);
    await db.query('SELECT 1').catch(() => { throw Error('Cannot reach stack MySQL. Run npm run e2e:up first.'); });
    const { botId, botToken } = await gitlab.ensureUsers();
    audit.add(...gitlab.credentials);
    checkRunning();
    reservation = await reservePort();
    const { port } = reservation;
    const publicUrl = gitlab.detentPublicUrl(port);
    const envFile = join(tmp, '.env');
    const local = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp };
    const bootstrap = () => run(process.execPath, ['--import', 'tsx', 'scripts/bootstrap.ts', '--env-out', envFile], {
      cwd: root, signal: controller.signal, timeout: 240000, env: {
        ...local, GITLAB_BASE_URL: stack.gitlabUrl, GITLAB_ADMIN_TOKEN: stack.gitlabAdminToken,
        GITLAB_TOKEN: botToken, GITLAB_WEBHOOK_SECRET: hookSecret, DETENT_BOT_USERNAME: 'detent-bot',
        DETENT_PUBLIC_URL: publicUrl, DETENT_HUB_PROJECT: gitlab.hubProjectPath,
        DETENT_TARGET_PROJECTS: Object.values(gitlab.targetProjects).join(','),
      },
    });
    try {
      await bootstrap();
    } catch (error) {
      // A newly granted bot can briefly see a project-file 404. Bootstrap fills only missing resources.
      if (!/GitLab HTTP 404 at \/projects\/\d+\/repository\/files\//.test(message(error))) throw error;
      console.log('Retrying Hub bootstrap after a GitLab file visibility delay');
      await delay(1500, undefined, { signal: controller.signal });
      await bootstrap();
    }
    const config = parseEnv(await readFile(envFile, 'utf8'));
    const paths = gitlab.targetProjects;
    const [hub, web, api, ansible, helm] = await Promise.all([gitlab.hubProjectPath, paths.web, paths.api, paths.ansible, paths.helm].map(gitlab.project));
    for (const p of [hub, web, api, ansible, helm]) projectIds.add(p.id);
    assert.equal(hub.id, Number(config.GITLAB_HUB_PROJECT_ID));
    await gitlab.upsertFile(api.id, 'service.conf', 'port=19092\n', 'Seed service port configuration');
    await Promise.all([
      seedRepository(gitlab, ansible.id, 'ansible-infra'),
      seedRepository(gitlab, helm.id, 'helm-charts'),
    ]);
    const capabilities = JSON.parse(await gitlab.getFile(hub.id, 'capabilities.json'));
    capabilities.jumpserver.base_url = stack.jumpserverUrl;
    await gitlab.upsertFile(hub.id, 'capabilities.json', JSON.stringify(capabilities, null, 2) + '\n', 'Connect the local JumpServer');
    const hubInstructions = await gitlab.getFile(hub.id, 'CLAUDE.md');
    await gitlab.upsertFile(hub.id, 'CLAUDE.md', [
      hubInstructions, '',
      '目标机仅授权 ops 普通账号。/etc/detent-demo 和其中的 app.conf 归 ops:ops 管理。维护此目录及文件时沿用现有属主和权限，以 ops 直接执行，作业不使用 sudo 或 become。',
      '本栈的 JumpServer 作业会掩码名为 key 的模板字段。Playbook 请使用业务含义明确的变量名。',
      '通过 `target-node-01` 访问的 E2E Kubernetes 验证集群仅有控制平面，没有可调度 Pod 的工作节点。',
      '所有发布机共用这个验证集群。执行 helm upgrade --install 时省略 --atomic 和 --wait（--atomic 会隐式等待 Pod）。同一作业用 helm status 检查 release 状态，并核对集群中 Kubernetes 资源的 spec。', '',
    ].join('\n'), 'Document the E2E host permissions and verification cluster');
    checkRunning();

    const helmPath = await ensureLocalHelmPath();
    console.log('Starting Delivery on port ' + port);
    await reservation.close();
    const podId = 'delivery-' + hub.id;
    pod = startPod({
      ...local, ...config, ...models, PATH: helmPath, POD_ID: podId, HOST: '0.0.0.0', PORT: String(port),
      EPHEMERAL_ROOT: join(tmp, 'sandboxes'), MYSQL_HOST: stack.mysql.host, MYSQL_PORT: String(stack.mysql.port),
      MYSQL_USER: stack.mysql.user, MYSQL_PASSWORD: stack.mysql.password, MYSQL_DATABASE: stack.mysql.database,
      DETENT_SECRET_JMS_AK_ID: stack.jumpserverAccessKeyId, DETENT_SECRET_JMS_AK_SECRET: stack.jumpserverAccessKeySecret,
      DELIVERY_JOB_POLL_INTERVAL_MS: '1000',
    }, audit);
    const deadline = Date.now() + 60000;
    let lastHealthError = '';
    do {
      checkRunning();
      const health = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(2000) }).catch(error => {
        lastHealthError = message(error);
        return undefined;
      });
      if (health) lastHealthError = 'HTTP ' + health.status + ', waiting for ' + podId;
      if (health?.ok && (await health.json()).podId === podId) { ready = true; break; }
      await delay(300);
    } while (Date.now() < deadline);
    assert.ok(ready, 'Delivery Pod did not become healthy within 60s: ' + lastHealthError);

    const context = { db, gitlab, stack, hub: hub.id, web, api, ansible, helm, groupPath: gitlab.groupPath, helmPath, botId, timeoutMs,
      redact: (text: string) => audit.redact(text), webhookUrl: publicUrl + '/webhooks/gitlab', checkRunning, registerProject: (id: number) => projectIds.add(id) };
    async function runSop(name: SopName) {
      checkRunning();
      const start = performance.now();
      console.log('Starting ' + name);
      let result = 'FAILED';
      try {
        await runScenario(name, { ...context, sopDeadline: start + sopTimeoutMs });
        checkRunning();
        result = 'passed';
      } catch (error) {
        const summary = name + ' failed: ' + audit.redact(message(error));
        errors.push(Error(summary));
        console.error(summary);
        checkRunning();
      } finally {
        const seconds = ((performance.now() - start) / 1000).toFixed(1);
        timings.push({ sop: name, result, seconds });
        console.log(name + ' ' + result + ' (' + seconds + 's)');
      }
      return result === 'passed';
    }
    for (const name of selected) {
      if (name === 'sop11' && selected.includes('sop10')) continue;
      if (name === 'sop10' || name === 'sop11') {
        await withReleaseTopology(context, async () => {
          const deployed = await runSop('sop10');
          if (selected.includes('sop11')) {
            if (deployed) await runSop('sop11');
            else timings.push({ sop: 'sop11', result: 'skipped (sop10 failed)', seconds: '0' });
          }
        });
      } else await runSop(name);
    }
  } catch (error) { errors.push(error); }
  finally {
    async function finish(label: string, fn: () => Promise<void>) {
      try { await fn(); }
      catch (error) { errors.push(Error(label + ': ' + message(error))); }
    }
    await finish('Stop Pod', async () => { await pod?.stop(); await reservation?.close(); });
    audit.add(...gitlab.credentials);
    await finish('Discover run projects', async () => {
      for (const p of await gitlab.listProjects()) projectIds.add(p.id);
    });
    if (projectIds.size) {
      console.log('Auditing GitLab notes and MySQL records');
      let notes = 0;
      const samples = new Set<string>();
      for (const id of projectIds) {
        await finish('Audit GitLab project ' + id, async () => {
          const [cards] = ready ? await db.query<RowDataPacket[]>(`SELECT a.id, a.gitlab_note_id, a.approval_type, a.tool_name, a.status, a.decided_by
            FROM approval_requests a JOIN issue_sessions s ON s.id=a.session_id WHERE s.hub_project_id=? AND
            a.approval_type IN ('PLAN','TOOL_USE') AND a.status IN ('APPROVED','REJECTED') AND a.gitlab_note_id IS NOT NULL`, [id]) : [[]];
          const expected = new Map(cards.map(card => [Number(card.gitlab_note_id), card]));
          let traces = 0, holds = 0;
          notes += await gitlab.auditNotes(id, (body, location, note) => {
            audit.check(body, location);
            if (note.system || note.author.username !== 'detent-bot') return;
            assert.doesNotMatch(body, /\/(?:private\/)?(?:var|tmp)\/[^\s"`]*\/turn-[\da-f-]{36}\//i, 'Sandbox path in ' + location);
            assert.ok(!body.includes('⏳ 执行中…'), 'Unfinished tool step in ' + location);
            if (body.includes('🔍 工具调用轨迹')) {
              traces++;
              assert.doesNotMatch(body, /↳ `+\[\{"type":"text","text":/, 'Raw MCP result in ' + location);
              if (!samples.has('trace')) {
                samples.add('trace');
                console.log('  Trace sample ' + location + ' · ' + body.split('\n').find(line => line.includes('↳'))?.trim());
              }
              assert.doesNotMatch(body.split('\n')[0], /上方审批卡/, 'Reversed ColdHold direction in ' + location);
            }
            if (body.startsWith('📋 已提交操作审批') || body.startsWith('💬 需要你的确认')) {
              assert.match(body.split('\n')[0], /下方/, 'Approval direction in ' + location);
              holds++;
              if (!samples.has('hold')) {
                samples.add('hold');
                console.log('  ColdHold sample ' + location + ' · ' + body.split('\n')[0]);
              }
            }
            const card = expected.get(note.id);
            if (!card) return;
            const status = card.status === 'APPROVED' ? '✅ **已批准**' : '❌ **已拒绝**';
            assert.ok(body.includes(status + ' · 由 @' + card.decided_by), 'Missing decision on ' + location);
            assert.ok(body.includes('| 项目 | 内容 |') && body.includes('<sub>审批单 `' + card.id + '`</sub>'), 'Approval layout on ' + location);
            console.log('  Card ' + location + ' · ' + card.tool_name + ' · ' + status + ' @' + card.decided_by);
            const role = body.split('\n').find(line => line.startsWith('> 请') && line.includes('/approve'));
            assert.ok(role, 'Missing approver instructions on ' + location);
            if (!samples.has(card.tool_name + role)) {
              samples.add(card.tool_name + role);
              console.log('    ' + body.split('\n')[0] + ' · ' + role + ' · ' + body.split('\n').at(-1));
            }
            expected.delete(note.id);
          });
          assert.equal(expected.size, 0, 'Decided cards missing from GitLab');
          if (traces || holds) console.log('  Project #' + id + ' · ' + traces + ' finalized traces · ' + holds + ' holds point to the following card');
        });
      }
      if (ready) {
        await finish('Audit MySQL', async () => {
          const rows = await auditRows(db, [...projectIds], audit);
          console.log('Inspected ' + notes + ' GitLab notes and ' + rows + ' MySQL rows');
          if (!errors.length) assert.ok(notes > 0 && rows > 0, 'The completed run had no auditable evidence');
        });
        await finish('Delete run sessions', () => deleteSessions(db, [...projectIds]));
      }
    }
    console.log('Removing E2E credentials, group and working directory');
    await finish('Close MySQL', () => db.end());
    await finish('Clean up GitLab', () => gitlab.close());
    await finish('Clean up temporary files', () => rm(tmp, { recursive: true, force: true }));
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (timings.length) console.table(timings);
  }
  if (errors.length) throw Error(audit.redact(errors.map(message).join('\n')));
  controller.signal.throwIfAborted();
  console.log('All selected SOPs passed and the secret audit passed.');
}

main().catch(error => { console.error(message(error)); process.exitCode = 1; });
