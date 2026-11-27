import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { redactGitUrl } from '../../packages/core/src/gitlab/redact.js';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { liveGitLab } from './live-gitlab.js';
import { runScenario, sopNames, type SopName } from './sop-scenarios.js';
import { loadStackState, type RealE2EStackState } from './stack.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

function selectedSops(): SopName[] {
  const { values } = parseArgs({ options: { sop: { type: 'string', default: 'all' } } });
  if (values.sop === 'all') return sopNames;
  const names = values.sop!.split(',').map(s => s.trim());
  for (const name of names) {
    if (!sopNames.includes(name as SopName)) throw Error('Expected --sop=all or a comma-separated list of sop1 through sop6');
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
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(killGroup, 15000);
      try { await exited; }
      finally { clearTimeout(timer); killGroup(); }
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
    for (const table of ['delivery_executions', 'session_merge_requests', 'approval_requests', 'session_worktrees', 'session_inbox', 'session_messages']) {
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

async function main() {
  const selected = selectedSops();
  const models = await modelConfig();
  let stack: RealE2EStackState;
  try { stack = await loadStackState(); }
  catch { throw Error('Cannot load the real E2E stack state. Run npm run e2e:up first.'); }
  const timeoutMs = Number(process.env.E2E_PHASE_TIMEOUT_MS ?? 150000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Invalid E2E_PHASE_TIMEOUT_MS');
  const sopTimeoutMs = Number(process.env.E2E_SOP_TIMEOUT_MS ?? 300000);
  assert.ok(Number.isSafeInteger(sopTimeoutMs) && sopTimeoutMs > 0 && sopTimeoutMs <= 300000,
    'E2E_SOP_TIMEOUT_MS must be between 1 and 300000');
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
    await run(process.execPath, ['--import', 'tsx', 'scripts/bootstrap.ts', '--env-out', envFile], {
      cwd: root, signal: controller.signal, timeout: 240000, env: {
        ...local, GITLAB_BASE_URL: stack.gitlabUrl, GITLAB_ADMIN_TOKEN: stack.gitlabAdminToken,
        GITLAB_TOKEN: botToken, GITLAB_WEBHOOK_SECRET: hookSecret, DETENT_BOT_USERNAME: 'detent-bot',
        DETENT_PUBLIC_URL: publicUrl, DETENT_HUB_PROJECT: gitlab.hubProjectPath,
        DETENT_TARGET_PROJECTS: Object.values(gitlab.targetProjects).join(','),
      },
    });
    const config = parseEnv(await readFile(envFile, 'utf8'));
    const paths = gitlab.targetProjects;
    const [hub, web, api, ansible] = await Promise.all([gitlab.hubProjectPath, paths.web, paths.api, paths.ansible].map(gitlab.project));
    for (const p of [hub, web, api, ansible]) projectIds.add(p.id);
    assert.equal(hub.id, Number(config.GITLAB_HUB_PROJECT_ID));
    await gitlab.upsertFile(api.id, 'service.conf', 'port=19092\n', 'Seed service port configuration');
    const capabilities = JSON.parse(await gitlab.getFile(hub.id, 'capabilities.json'));
    capabilities.jumpserver.base_url = stack.jumpserverUrl;
    await gitlab.upsertFile(hub.id, 'capabilities.json', JSON.stringify(capabilities, null, 2) + '\n', 'Connect the local JumpServer');
    checkRunning();

    console.log('Starting Delivery on port ' + port);
    await reservation.close();
    const podId = 'delivery-' + hub.id;
    pod = startPod({
      ...local, ...config, ...models, POD_ID: podId, HOST: '0.0.0.0', PORT: String(port),
      EPHEMERAL_ROOT: join(tmp, 'sandboxes'), MYSQL_HOST: stack.mysql.host, MYSQL_PORT: String(stack.mysql.port),
      MYSQL_USER: stack.mysql.user, MYSQL_PASSWORD: stack.mysql.password, MYSQL_DATABASE: stack.mysql.database,
      DETENT_SECRET_JMS_AK_ID: stack.jumpserverAccessKeyId, DETENT_SECRET_JMS_AK_SECRET: stack.jumpserverAccessKeySecret,
      DELIVERY_JOB_POLL_INTERVAL_MS: '1000',
    }, audit);
    const deadline = Date.now() + 60000;
    do {
      checkRunning();
      const health = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (health?.ok && (await health.json()).podId === podId) { ready = true; break; }
      await delay(300);
    } while (Date.now() < deadline);
    assert.ok(ready, 'Delivery Pod did not become healthy within 60s');

    for (const name of selected) {
      checkRunning();
      const start = performance.now();
      console.log('Starting ' + name);
      let result = 'FAILED';
      try {
        await runScenario(name, { db, gitlab, stack, hub: hub.id, web, api, ansible, botId, timeoutMs, sopDeadline: start + sopTimeoutMs,
          redact: text => audit.redact(text), webhookUrl: publicUrl + '/webhooks/gitlab', checkRunning, registerProject: id => projectIds.add(id) });
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
      for (const id of projectIds) {
        await finish('Audit GitLab project ' + id, async () => {
          notes += await gitlab.auditNotes(id, (body, location) => audit.check(body, location));
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
