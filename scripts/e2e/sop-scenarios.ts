import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { E2EGitLabDriver } from './gitlab-driver.js';
import type { RealE2EStackState } from './stack.js';

const run = promisify(execFile);
type Project = Awaited<ReturnType<E2EGitLabDriver['project']>>;
type SessionStatus = 'IDLE' | 'WAITING_PLAN' | 'WAITING_TOOL' | 'DONE';
type Session = RowDataPacket & {
  id: string; status: string; locked_by_pod: string | null; last_message_seq: number;
};
type Context = {
  db: Pool; gitlab: E2EGitLabDriver; stack: RealE2EStackState;
  hub: number; web: Project; api: Project; ansible: Project; botId: number;
  redact(text: string): string; webhookUrl: string; checkRunning(): void; registerProject(id: number): void; timeoutMs: number;
  sopDeadline: number;
};

class UnexpectedParkedState extends Error {}

class Scenario {
  private noteTarget?: { iid: number; mrProject?: number };
  constructor(readonly ctx: Context) {}
  get gl() {
    this.ctx.checkRunning();
    return this.ctx.gitlab;
  }

  async rows<T extends RowDataPacket = RowDataPacket>(sql: string, params: (string | number)[]) {
    this.ctx.checkRunning();
    return (await this.ctx.db.execute<T[]>(sql, params))[0];
  }

  async until<T>(label: string, probe: () => Promise<T | undefined | false>) {
    console.log('  Waiting for ' + label);
    const deadline = Date.now() + this.ctx.timeoutMs;
    do {
      this.ctx.checkRunning();
      const result = await probe();
      if (result) return result;
      await delay(750);
    } while (Date.now() < deadline);
    throw Error('Timed out waiting for ' + label);
  }

  async open(title: string, description: string, label?: string) {
    const iid = await this.gl.openIssue(this.ctx.hub, title, description, label);
    this.trackNotes(iid);
    return iid;
  }

  trackNotes(iid: number, mrProject?: number) {
    this.noteTarget = { iid, mrProject };
  }

  async latestNote() {
    if (!this.noteTarget) return;
    const { iid, mrProject } = this.noteTarget;
    const ref = mrProject === undefined ? 'Issue ' + this.ctx.hub : 'MR ' + mrProject;
    try {
      const notes = mrProject === undefined ? await this.gl.listIssueNotes(this.ctx.hub, iid) : await this.gl.listMrNotes(mrProject, iid);
      const latest = notes.find(n => !n.system && n.author.username === 'detent-bot');
      return 'Latest bot note on ' + ref + '/' + iid + '\n' + (latest ? this.ctx.redact(latest.body) : '(none)');
    } catch (error) {
      return 'Could not read latest bot note on ' + ref + '/' + iid + ': ' + this.ctx.redact(String(error));
    }
  }

  state(iid: number, status: SessionStatus | SessionStatus[], afterSeq = 0, mrProject?: number) {
    this.trackNotes(iid, mrProject);
    const expected = Array.isArray(status) ? status : [status];
    const kind = mrProject === undefined ? 'issue' : 'mr';
    const project = mrProject ?? this.ctx.hub;
    const ref = kind + ' ' + project + '/' + iid;
    let heldSince: number | undefined;
    let idleSince: number | undefined;
    let idleSeq: number | undefined;
    let lastState = '';
    return this.until(ref + ' ' + expected.join(' or ') + ' with released lease', async () => {
      const [row] = await this.rows<Session>(
        'SELECT * FROM issue_sessions WHERE session_kind=? AND hub_project_id=? AND hub_issue_iid=?',
        [kind, project, iid]);
      if (!row) {
        idleSince = undefined;
        return;
      }
      const observed = row.status + (row.locked_by_pod ? ' (leased)' : ' (released)');
      if (lastState !== observed) console.log('    ' + ref + ' ' + observed);
      lastState = observed;
      assert.notEqual(row.status, 'FAILED', ref + ' failed');
      const released = row.locked_by_pod === null && row.last_message_seq > afterSeq;
      if (!released || row.status !== 'IDLE' || row.last_message_seq !== idleSeq) idleSince = undefined;
      idleSeq = row.last_message_seq;
      if (!expected.some(s => s === row.status)) {
        assert.notEqual(row.status, 'DONE', ref + ' closed before reaching ' + status);
        if (released && (row.status === 'WAITING_TOOL' || row.status === 'WAITING_PLAN')) {
          const [pending] = await this.rows(
            "SELECT approval_type, tool_name, tool_input FROM approval_requests WHERE session_id=? AND status='PENDING' LIMIT 1", [row.id]);
          const detail = pending
            ? pending.approval_type + ' ' + pending.tool_name + ': ' + this.ctx.redact(JSON.stringify(pending.tool_input)).slice(0, 200)
            : 'no pending approval';
          throw new UnexpectedParkedState('Unexpected parked state ' + row.status + ' (' + detail + ') while waiting for ' + expected.join('|'));
        }
        if (released && row.status === 'IDLE' && expected.length === 1 && expected[0] === 'DONE') {
          const [job] = await this.rows(
            "SELECT id FROM delivery_executions WHERE session_id=? AND (status IN ('PENDING', 'RUNNING') OR callback_pending=1) LIMIT 1",
            [row.id]);
          if (job) idleSince = undefined;
          else {
            idleSince ??= performance.now();
            if (performance.now() - idleSince >= 5000) throw Error(ref + ' stayed IDLE for 5s with no pending execution while waiting for DONE');
          }
        }
        return;
      }
      if (row.status === 'WAITING_TOOL' && row.locked_by_pod !== null) {
        // Allow only CLI teardown and checkpointing, never a human-length hot hold.
        heldSince ??= Date.now();
        assert.ok(Date.now() - heldSince < 15000, ref + ' kept the tool approval lease for 15s');
      }
      if (released) return row;
    });
  }

  async done(iid: number, { failOnIdle = false, afterSeq = 0 } = {}) {
    const session = await this.state(iid, failOnIdle ? ['DONE', 'IDLE'] : 'DONE', afterSeq);
    assert.equal(session.status, 'DONE', 'Issue ' + iid + ' settled in IDLE before closing');
    const issue = await this.gl.getIssue(this.ctx.hub, iid);
    assert.equal(issue.state, 'closed');
    assert.ok(issue.labels.includes('claude::done'), 'Closed Issue lacks claude::done');
    const active = await this.rows("SELECT id FROM session_worktrees WHERE session_id=? AND status <> 'ARCHIVED'", [session.id]);
    assert.equal(active.length, 0, 'Completed Issue retained an active worktree');
    return session;
  }

  async card(session: Session, type: 'PLAN' | 'TOOL_USE', tool?: string) {
    const pending = await this.rows("SELECT * FROM approval_requests WHERE session_id=? AND status='PENDING'", [session.id]);
    assert.equal(pending.length, 1, 'Expected one pending approval');
    const [card] = pending;
    assert.equal(card.approval_type, type);
    if (tool) assert.equal(card.tool_name, tool);
    assert.ok(card.gitlab_note_id > 0, 'Approval has no posted GitLab card');
    return card;
  }

  async approve(iid: number, card: RowDataPacket, actor: 'dev' | 'sre') {
    await this.gl.awardThumbsUp(this.ctx.hub, iid, card.gitlab_note_id, actor);
    await this.until(actor + ' approval of ' + card.tool_name, async () => {
      const [decision] = await this.rows('SELECT status, decided_by FROM approval_requests WHERE id=?', [card.id]);
      if (decision.status === 'PENDING') return;
      assert.equal(decision.status, 'APPROVED');
      assert.equal(decision.decided_by, 'e2e-' + actor);
      return true;
    });
  }

  async approvePlan(iid: number, afterSeq = 0) {
    const session = await this.state(iid, 'WAITING_PLAN', afterSeq);
    await this.approve(iid, await this.card(session, 'PLAN'), 'dev');
    return session;
  }

  async approveProduction(iid: number, afterSeq: number, tool: string, beforeApproval: () => Promise<void>) {
    const session = await this.state(iid, 'WAITING_TOOL', afterSeq);
    assert.equal(session.locked_by_pod, null, 'Worker is still holding the lease for ' + tool);
    const card = await this.card(session, 'TOOL_USE', tool);
    const notes = () => this.gl.listIssueNotes(this.ctx.hub, iid);
    const existing = new Set((await notes()).map(n => n.id));
    await this.gl.awardThumbsUp(this.ctx.hub, iid, card.gitlab_note_id, 'dev');
    await this.until('production permission denial on Issue #' + iid, async () => (await notes()).find(n =>
      !existing.has(n.id) && !n.system && n.author.username === 'detent-bot' && /生产审批权限|Maintainer/i.test(n.body)));
    const stillPending = await this.card(await this.state(iid, 'WAITING_TOOL'), 'TOOL_USE', tool);
    assert.equal(stillPending.id, card.id);
    await beforeApproval();
    await this.approve(iid, card, 'sre');
    return { card, session };
  }

  async linkedMrs(session: Session, projects: Project[]) {
    const links = await this.rows('SELECT * FROM session_merge_requests WHERE session_id=?', [session.id]);
    assert.deepEqual(links.map(m => m.target_project_id).sort(), projects.map(p => p.id).sort());
    return Promise.all(projects.map(async p => {
      const link = links.find(m => m.target_project_id === p.id)!;
      const mr = await this.gl.getMr(p.id, link.mr_iid);
      assert.equal(mr.state, 'opened');
      assert.equal(mr.source_project_id, p.id);
      assert.equal(mr.target_branch, 'main');
      assert.equal(mr.source_branch, link.source_branch);
      assert.notEqual(mr.sha, await this.gl.headSha(p.id));
      return mr;
    }));
  }

  // Join actual CLI tool_use and successful tool_result blocks by call ID.
  // Prompts, tool definitions and a model's description of a call cannot satisfy this check.
  async shellEvidence(session: Session, evidence: RegExp, afterSeq = 0, afterTime = 0) {
    const messages = await this.rows('SELECT raw_json_line FROM session_messages WHERE session_id=? AND seq>? ORDER BY seq',
      [session.id, afterSeq]);
    const calls = new Set<string>();
    for (const m of messages) {
      const entry = JSON.parse(m.raw_json_line);
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && /^(?:mcp__detent__)?jms_shell$/.test(block.name) &&
            (!afterTime || Date.parse(entry.timestamp) >= afterTime)) calls.add(block.id);
        if (block.type !== 'tool_result' || !calls.has(block.tool_use_id) || block.is_error) continue;
        const texts = typeof block.content === 'string' ? [block.content] :
          (block.content ?? []).map((part: { text?: string }) => part.text ?? '');
        for (const text of texts) {
          // The CLI can prepend its MCP tool label before the serialized result.
          if (/"status"\s*:\s*"SUCCESS"/.test(text) && evidence.test(text)) return;
        }
      }
    }
    throw Error('Missing successful JumpServer inspection with target evidence in session ' + session.id);
  }

  async diagnosis(iid: number, session: Session) {
    const notes = (await this.gl.listIssueNotes(this.ctx.hub, iid)).filter(n => !n.system && n.author.username === 'detent-bot');
    assert.ok(notes.length, 'Missing diagnostic report');
    assert.ok(notes.every(n => !/Model not exist|Request timeout|Claude run failed|本轮执行失败/i.test(n.body)), 'Diagnostic notes contain a system error');
    const evidence = /\b9092\b|demo_kafka/i;
    const reports = notes.map(n => n.body.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, ''));
    assert.ok(reports.every(text => !text.includes('⛔')), 'Diagnostic text contains an error');
    assert.ok(evidence.test(reports[0]), 'Latest diagnostic text lacks target process or port evidence');
    await this.shellEvidence(session, evidence);
  }

  async targetConfig(expected: number) {
    this.ctx.checkRunning();
    const { stdout } = await run('docker', ['exec', this.ctx.stack.targetContainerName, 'cat', '/etc/detent-demo/app.conf'],
      { timeout: 15000 });
    const settings = stdout.split(/\r?\n/).filter(line => /^\s*max_connections\s*=/.test(line));
    assert.deepEqual(settings, ['max_connections=' + expected], 'Unexpected target configuration');
  }
}

async function sop1(h: Scenario) {
  const { hub, api } = h.ctx;
  const iid = await h.open('检查 target-node-01 服务状态', '帮我检查一下主机 target-node-01 当前的服务进程、监听端口和磁盘使用情况是否正常，并给出诊断结论。');
  const diagnosis = await h.state(iid, 'IDLE');
  assert.equal((await h.rows("SELECT id FROM approval_requests WHERE session_id=? AND approval_type='PLAN'", [diagnosis.id])).length, 0);
  assert.equal((await h.gl.getIssue(hub, iid)).state, 'opened');
  await h.diagnosis(iid, diagnosis);
  await h.gl.postNote(hub, iid, `请把 ${api.path_with_namespace} 仓库中的 service.conf 端口配置从 19092 改为 9092 并提交一个 MR。`);
  const plan = await h.approvePlan(iid, diagnosis.last_message_seq);
  assert.equal(plan.id, diagnosis.id);
  assert.equal(plan.claude_session_id, diagnosis.claude_session_id);
  const delivery = await h.state(iid, 'IDLE', plan.last_message_seq);
  const [mr] = await h.linkedMrs(delivery, [api]);
  assert.equal(await h.gl.getFile(api.id, 'service.conf'), 'port=19092\n');
  assert.equal((await h.gl.getFile(api.id, 'service.conf', mr.source_branch)).trim(), 'port=9092');
}

async function sop2(h: Scenario) {
  const iid = await h.open('巡检 target-node-01', '巡检主机 target-node-01 的系统负载、监听端口和运行进程，确认无异常后完成巡检报告。', 'delivery::audit');
  const session = await h.done(iid, { failOnIdle: true });
  assert.equal((await h.rows('SELECT id FROM approval_requests WHERE session_id=?', [session.id])).length, 0);
  await h.diagnosis(iid, session);
}

const healthCheck = '#!/bin/sh\nset -eu\ntest "$(cat health.txt)" = healthy\n';

async function sop3(h: Scenario) {
  const { hub, web, api } = h.ctx;
  for (const project of [web, api]) {
    await h.gl.upsertFile(project.id, 'health.txt', 'healthy\n', 'Record expected health status');
    await h.gl.upsertFile(project.id, 'check.sh', healthCheck, 'Add repository health check');
    await h.gl.upsertFile(project.id, 'README.md', '# ' + project.path_with_namespace + '\n\nRun the repository check with `sh check.sh`.\n', 'Document the health check');
  }
  const iid = await h.open('同步两个服务的版本号',
    `请在 ${web.path_with_namespace} 和 ${api.path_with_namespace} 仓库根目录各加一个 VERSION 文件，内容是 1.0.0。确认现有检查通过后，分别提交 MR。`, 'delivery::code');
  const plan = await h.approvePlan(iid);
  const issue = await h.state(iid, 'IDLE', plan.last_message_seq);
  const [webMr, apiMr] = await h.linkedMrs(issue, [web, api]);
  for (const mr of [webMr, apiMr]) {
    assert.ok(mr.assignees.some(a => a.id === h.ctx.botId && a.username === 'detent-bot'));
    const project = mr.target_project_id;
    assert.equal((await h.gl.getFile(project, 'VERSION', mr.sha)).trim(), '1.0.0');
    assert.equal(await h.gl.getFile(project, 'check.sh', mr.sha), healthCheck);
    const dir = await mkdtemp(join(tmpdir(), 'detent-health-'));
    try {
      await writeFile(join(dir, 'health.txt'), await h.gl.getFile(project, 'health.txt', mr.sha));
      await run('sh', ['-c', healthCheck], { cwd: dir });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const beforeReview = await h.until('GitLab diff refs for VERSION', async () => {
    const mr = await h.gl.getMr(api.id, apiMr.iid);
    return mr.diff_refs?.head_sha === mr.sha && mr.diff_refs;
  });
  const [priorWorker] = await h.rows(
    "SELECT last_message_seq FROM issue_sessions WHERE session_kind='mr' AND hub_project_id=? AND hub_issue_iid=?",
    [api.id, apiMr.iid]);
  h.trackNotes(apiMr.iid, api.id);
  const thread = await h.gl.openDiscussion(api.id, apiMr.iid, '请顺便在同目录补充一个 CHANGELOG.md 记录 1.0.0 变更。', {
    ...beforeReview, position_type: 'text', old_path: 'VERSION', new_path: 'VERSION', new_line: 1,
  });
  assert.equal(thread.notes[0].type, 'DiffNote');
  await h.until('new commit on the reviewed branch', async () => (await h.gl.getMr(api.id, apiMr.iid)).sha !== beforeReview.head_sha);
  await h.state(apiMr.iid, 'IDLE', priorWorker?.last_message_seq ?? 0, api.id);
  await h.until('bot reply to inline review', async () => (await h.gl.getDiscussion(api.id, apiMr.iid, thread.id)).notes
    .some(n => n.author.username === 'detent-bot' && !n.system && n.body.trim().length > 0));
  const reviewed = await h.gl.getMr(api.id, apiMr.iid);
  assert.notEqual(reviewed.sha, beforeReview.head_sha);
  assert.ok((await h.gl.getFile(api.id, 'CHANGELOG.md', reviewed.source_branch)).includes('1.0.0'));

  h.trackNotes(iid);
  await h.gl.mergeMergeRequest(web.id, webMr.iid);
  const firstMerge = await h.state(iid, 'IDLE', issue.last_message_seq);
  const remaining = await h.rows("SELECT target_project_id FROM session_merge_requests WHERE session_id=? AND mr_state='opened'", [issue.id]);
  assert.deepEqual(remaining.map(m => m.target_project_id), [api.id]);
  assert.equal((await h.gl.getIssue(hub, iid)).state, 'opened');
  assert.equal((await h.gl.getMr(api.id, apiMr.iid)).state, 'opened');
  await h.gl.mergeMergeRequest(api.id, apiMr.iid);
  assert.ok((await h.done(iid)).last_message_seq > firstMerge.last_message_seq);
  for (const p of [web, api]) assert.equal((await h.gl.getFile(p.id, 'VERSION')).trim(), '1.0.0');
  assert.ok((await h.gl.getFile(api.id, 'CHANGELOG.md')).includes('1.0.0'));
}

async function sop4(h: Scenario) {
  const { ansible } = h.ctx;
  await run('docker', ['exec', h.ctx.stack.targetContainerName, 'detent-target', 'reset-config'], { timeout: 15000 });
  await h.targetConfig(128);
  const iid = await h.open('调整 target-node-01 的连接数上限',
    `请通过 ${ansible.path_with_namespace} 仓库编写 Ansible Playbook，将主机 target-node-01 上 /etc/detent-demo/app.conf 中的 max_connections 从 128 调整为 512，执行后验证配置已生效。`, 'delivery::env-change');
  const plan = await h.state(iid, 'WAITING_PLAN');
  await h.shellEvidence(plan, /\b128\b/);
  await h.approve(iid, await h.card(plan, 'PLAN'), 'dev');
  const issue = await h.state(iid, 'IDLE', plan.last_message_seq);
  const [mr] = await h.linkedMrs(issue, [ansible]);
  const changes = await h.gl.mrDiffs(ansible.id, mr.iid);
  const playbooks = changes.filter(f => !f.deleted_file && /\.ya?ml$/i.test(f.new_path)).map(f => f.new_path);
  assert.ok(playbooks.length, 'Ansible MR has no changed playbook');
  await h.targetConfig(128);
  const sha = await h.gl.mergeMergeRequest(ansible.id, mr.iid);
  const { card, session } = await h.approveProduction(iid, issue.last_message_seq, 'jms_job', async () => {
    assert.equal((await h.rows('SELECT id FROM delivery_executions WHERE session_id=?', [issue.id])).length, 0);
    await h.targetConfig(128);
  });
  const closed = await h.done(iid, { afterSeq: session.last_message_seq });
  const execution = await h.until('acknowledged successful JumpServer execution', async () => {
    const rows = await h.rows('SELECT * FROM delivery_executions WHERE session_id=?', [closed.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'SUCCESS');
    return rows[0].callback_pending === 0 && rows[0];
  });
  assert.equal(execution.approval_id, card.id);
  assert.equal(execution.commit_sha, sha);
  assert.ok(playbooks.includes(execution.playbook_path));
  const [callback] = await h.rows('SELECT source_kind, status, UNIX_TIMESTAMP(consumed_at)*1000 AS consumed_ms FROM session_inbox WHERE session_id=? AND event_id=?', [closed.id, 'jms-job:' + execution.jumpserver_job_id]);
  assert.equal(callback?.source_kind, 'system');
  assert.equal(callback.status, 'CONSUMED');
  assert.ok(Number(callback.consumed_ms) > 0);
  await h.shellEvidence(closed, /\b512\b/, session.last_message_seq, Number(callback.consumed_ms));
  await h.targetConfig(512);
}

async function sop5(h: Scenario) {
  const { web } = h.ctx;
  const sha = await h.gl.headSha(web.id);
  const tag = 'v1.0.0';
  const iid = await h.open('发布 Web 正式版', `请为 ${web.path_with_namespace} 仓库当前 main 分支最新提交发布 v1.0.0 正式版本和 Release。`, 'delivery::release');
  const plan = await h.approvePlan(iid);
  const { session } = await h.approveProduction(iid, plan.last_message_seq, 'detent_create_release', async () => {
    assert.equal(await h.gl.getTag(web.id, tag), null);
    assert.equal(await h.gl.getRelease(web.id, tag), null);
  });
  await h.done(iid, { afterSeq: session.last_message_seq });
  assert.equal(await h.gl.headSha(web.id), sha);
  assert.equal((await h.gl.getTag(web.id, tag))?.commit.id, sha);
  const release = await h.gl.getRelease(web.id, tag);
  assert.equal(release?.tag_name, tag);
  assert.equal(release.commit.id, sha);
}

async function sop6(h: Scenario) {
  const payment = await h.gl.createPayment(h.ctx.botId);
  h.ctx.registerProject(payment.id);
  assert.equal((await h.gl.hooks(payment.id)).length, 0);
  const iid = await h.open('接入支付仓库的 MR 评审', `请检查并将 ${payment.path_with_namespace} 仓库接入 Detent MR 协作。`, 'agent::onboarding');
  const plan = await h.approvePlan(iid);
  const { session } = await h.approveProduction(iid, plan.last_message_seq, 'detent_onboard_project', async () => {
    assert.equal((await h.gl.hooks(payment.id)).length, 0);
  });
  await h.done(iid, { afterSeq: session.last_message_seq });
  const hooks = (await h.gl.hooks(payment.id)).filter(hook => hook.url === h.ctx.webhookUrl);
  assert.equal(hooks.length, 1);
  assert.ok(hooks[0].merge_requests_events && hooks[0].note_events);
  await h.gl.upsertFile(payment.id, 'README.md', '# Payment\n\nProcesses payment requests.\n', 'Describe the payment service', 'docs/overview', 'main');
  const mr = await h.gl.openMr(payment.id, 'docs/overview', '补充支付服务说明，请帮忙评审', h.ctx.botId);
  assert.ok(mr.assignees.some(a => a.id === h.ctx.botId));
  const worker = await h.state(mr.iid, 'IDLE', 0, payment.id);
  const review = (await h.gl.listMrNotes(payment.id, mr.iid)).find(n =>
    n.id === worker.active_note_id && n.author.username === 'detent-bot' && !n.system);
  assert.ok(review?.body.trim() && !review.body.startsWith('正在检查 MR'), 'Missing completed MR review');
}

const scenarios = { sop1, sop2, sop3, sop4, sop5, sop6 };
export type SopName = keyof typeof scenarios;
export const sopNames = Object.keys(scenarios) as SopName[];
export async function runScenario(name: SopName, context: Context) {
  const expired = Error(name + ' exceeded its SOP deadline');
  const scenario = new Scenario({
    ...context,
    checkRunning() {
      if (performance.now() >= context.sopDeadline) throw expired;
      context.checkRunning();
    },
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(reject, Math.max(0, Math.ceil(context.sopDeadline - performance.now())), expired);
  });
  try {
    scenario.ctx.checkRunning();
    await Promise.race([timeout, scenarios[name](scenario).catch(async error => {
      if (error instanceof UnexpectedParkedState) throw error;
      scenario.ctx.checkRunning();
      const note = await scenario.latestNote();
      if (!note) throw error;
      throw Error((error instanceof Error ? error.message : String(error)) + '\n' + note, { cause: error });
    })]);
    scenario.ctx.checkRunning();
  } finally {
    clearTimeout(timer);
  }
}
