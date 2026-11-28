import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { E2EGitLabDriver } from './gitlab-driver.js';
import { resetTargetNode, type RealE2EStackState } from './stack.js';
import { ansibleEntryPoints, checkChart, checkRelease, targetCommand } from './scenario-checks.js';

const run = promisify(execFile);
type Project = Awaited<ReturnType<E2EGitLabDriver['project']>>;
type MR = Awaited<ReturnType<E2EGitLabDriver['getMr']>>;
type SessionStatus = 'IDLE' | 'WAITING_PLAN' | 'WAITING_TOOL' | 'DONE';
type Session = RowDataPacket & {
  id: string; status: string; locked_by_pod: string | null; last_message_seq: number;
};
type Context = {
  db: Pool; gitlab: E2EGitLabDriver; stack: RealE2EStackState;
  hub: number; web: Project; api: Project; ansible: Project; helm: Project; groupPath: string; helmPath: string; botId: number;
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

  async until<T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = this.ctx.timeoutMs) {
    console.log('  Waiting for ' + label);
    const deadline = Date.now() + timeoutMs;
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

  state(iid: number, status: SessionStatus | SessionStatus[], afterSeq = 0, mrProject?: number, discussion?: string) {
    this.trackNotes(iid, mrProject);
    const expected = Array.isArray(status) ? status : [status];
    const kind = mrProject === undefined ? 'issue' : 'mr';
    const project = mrProject ?? this.ctx.hub;
    const ref = kind + ' ' + project + '/' + iid;
    let heldSince: number | undefined;
    let lastState = '';
    return this.until(ref + ' ' + expected.join(' or ') + ' with released lease', async () => {
      const [row] = await this.rows<Session>(
        'SELECT * FROM issue_sessions WHERE session_kind=? AND hub_project_id=? AND hub_issue_iid=?',
        [kind, project, iid]);
      if (!row) return;
      const observed = row.status + (row.locked_by_pod ? ' (leased)' : ' (released)');
      if (lastState !== observed) console.log('    ' + ref + ' ' + observed);
      lastState = observed;
      assert.notEqual(row.status, 'FAILED', ref + ' failed');
      const released = row.locked_by_pod === null && row.last_message_seq > afterSeq;
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
        if (released && row.status === 'IDLE') {
          const [job] = await this.rows(
            "SELECT id FROM delivery_executions WHERE session_id=? AND (status IN ('PENDING', 'RUNNING') OR callback_pending=1) LIMIT 1",
            [row.id]);
          if (!job) throw new UnexpectedParkedState(ref + ' is IDLE with no pending execution while waiting for ' + expected.join('|'));
        }
        return;
      }
      if (row.status === 'WAITING_TOOL' && row.locked_by_pod !== null) {
        // Allow only CLI teardown and checkpointing, never a human-length hot hold.
        heldSince ??= Date.now();
        assert.ok(Date.now() - heldSince < 15000, ref + ' kept the tool approval lease for 15s');
      }
      if (released && discussion) {
        const [consumed] = await this.rows(
          "SELECT id FROM session_inbox WHERE session_id=? AND discussion_id=? AND status='CONSUMED'", [row.id, discussion]);
        if (!consumed) return;
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

  async approveProduction(iid: number, afterSeq: number, tool: string, beforeApproval: (card: RowDataPacket) => Promise<void>) {
    const session = await this.state(iid, 'WAITING_TOOL', afterSeq);
    assert.equal(session.locked_by_pod, null, 'Worker is still holding the lease for ' + tool);
    const card = await this.card(session, 'TOOL_USE', tool);
    const notes = () => this.gl.listIssueNotes(this.ctx.hub, iid);
    const existing = new Set((await notes()).map(n => n.id));
    await this.gl.awardThumbsUp(this.ctx.hub, iid, card.gitlab_note_id, 'dev');
    await this.until('production permission denial on Issue #' + iid, async () => {
      assert.equal((await this.card(session, 'TOOL_USE', tool)).id, card.id, 'Developer bypassed production approval');
      return (await notes()).find(n => !existing.has(n.id) && !n.system && n.author.username === 'detent-bot' && /生产审批权限|Maintainer/i.test(n.body));
    });
    const stillPending = await this.card(await this.state(iid, 'WAITING_TOOL'), 'TOOL_USE', tool);
    assert.equal(stillPending.id, card.id);
    await beforeApproval(stillPending);
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

  async *transcriptBlocks(session: Session, afterSeq = 0) {
    const messages = await this.rows('SELECT raw_json_line FROM session_messages WHERE session_id=? AND seq>? ORDER BY seq',
      [session.id, afterSeq]);
    for (const m of messages) {
      const entry = JSON.parse(m.raw_json_line);
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) yield { role: entry.type, timestamp: entry.timestamp, block };
    }
  }

  async assertDiscoveryBeforePlan(session: Session) {
    const pending = new Set<string>();
    let discovered = false;
    for await (const { role, block } of this.transcriptBlocks(session)) {
      if (role === 'assistant' && block.type === 'tool_use') {
        const tool = block.name.replace(/^mcp__detent__/, '');
        if (tool === 'detent_submit_plan') {
          assert.ok(discovered, 'Plan was submitted before a successful JumpServer node or asset lookup');
          return;
        }
        if ((tool === 'jms_list_nodes' || tool === 'jms_list_assets') && typeof block.id === 'string') pending.add(block.id);
      }
      if (role === 'user' && block.type === 'tool_result' && pending.delete(block.tool_use_id) && !block.is_error) {
        discovered = true;
      }
    }
    throw Error('Missing detent_submit_plan tool call in session ' + session.id);
  }

  async shellEvidence(session: Session, evidence: RegExp, afterSeq = 0, afterTime = 0) {
    const calls = new Set<string>();
    for await (const { block, timestamp } of this.transcriptBlocks(session, afterSeq)) {
      if (block.type === 'tool_use' && /^(?:mcp__detent__)?jms_shell$/.test(block.name) &&
          (!afterTime || Date.parse(timestamp) >= afterTime)) calls.add(block.id);
      if (block.type !== 'tool_result' || !calls.has(block.tool_use_id) || block.is_error) continue;
      const texts = typeof block.content === 'string' ? [block.content] :
        (block.content ?? []).map((part: { text?: string }) => part.text ?? '');
      for (const text of texts) {
        // The CLI can prepend its MCP tool label before the serialized result.
        if (/"status"\s*:\s*"SUCCESS"/.test(text) && evidence.test(text)) return;
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

  async targetConfig(expected: number, timeout?: number) {
    const config = await targetCommand(this.ctx.stack.targetContainerName, 'cat', '/etc/detent-demo/app.conf');
    const lines = config.split(/\r?\n/);
    assert.deepEqual(lines.filter(line => /^\s*max_connections\s*=/.test(line)), ['max_connections=' + expected]);
    assert.deepEqual(lines.filter(line => /^\s*request_timeout\s*=/.test(line)), timeout === undefined ? [] : ['request_timeout=' + timeout]);
  }

  async resetConfig() {
    resetTargetNode();
    await this.targetConfig(128);
  }

  async configPlan(iid: number, { requireAssetDiscovery = false } = {}) {
    const plan = await this.state(iid, 'WAITING_PLAN');
    if (requireAssetDiscovery) await this.assertDiscoveryBeforePlan(plan);
    await this.shellEvidence(plan, /max_connections\s*=\s*128\b/);
    await this.approve(iid, await this.card(plan, 'PLAN'), 'dev');
    return plan;
  }

  async createApprovedProject(iid: number, plan: Session, path: string) {
    const { session } = await this.approveProduction(iid, plan.last_message_seq, 'detent_create_project', async () => {
      assert.equal(await this.gl.lookupProject(path), null);
    });
    const issue = await this.state(iid, 'IDLE', session.last_message_seq);
    const project = await this.gl.lookupProject(path);
    assert.ok(project, 'Approved repository was not created: ' + path);
    this.ctx.registerProject(project.id);
    const hooks = (await this.gl.hooks(project.id)).filter(hook => hook.url === this.ctx.webhookUrl);
    assert.equal(hooks.length, 1);
    assert.ok(hooks[0].merge_requests_events && hooks[0].note_events);
    const [mr] = await this.linkedMrs(issue, [project]);
    return { issue, mr, project };
  }

  async openedMr(iid: number, previous: Session, target: Project) {
    const issue = await this.state(iid, 'IDLE', previous.last_message_seq);
    const [mr] = await this.linkedMrs(issue, [target]);
    return { issue, mr };
  }

  async review(mr: MR, path: string, body: string, preferredLine: RegExp) {
    const id = mr.target_project_id;
    const refs = await this.until('GitLab diff refs for ' + path, async () => {
      const current = await this.gl.getMr(id, mr.iid);
      assert.equal(current.sha, mr.sha, 'MR changed since validation');
      return current.diff_refs?.head_sha === current.sha && current.diff_refs;
    });
    const diff = (await this.gl.mrDiffs(id, mr.iid)).find(d => d.new_path === path);
    assert.ok(diff, 'No reviewable diff in ' + path);
    // Only added lines accept a GitLab text position with new_line and no old_line.
    let line = 0;
    const added: { number: number; text: string }[] = [];
    for (const text of diff.diff.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (line && text.startsWith('+')) added.push({ number: line++, text: text.slice(1) });
      else if (line && text.startsWith(' ')) line++;
    }
    const anchor = added.find(entry => preferredLine.test(entry.text)) ?? added[0];
    assert.ok(anchor, 'No added line to review in ' + path);
    const [prior] = await this.rows(
      "SELECT last_message_seq FROM issue_sessions WHERE session_kind='mr' AND hub_project_id=? AND hub_issue_iid=?", [id, mr.iid]);
    this.trackNotes(mr.iid, id);
    const thread = await this.gl.openDiscussion(id, mr.iid, body, {
      ...refs, position_type: 'text', old_path: diff.old_path, new_path: path, new_line: anchor.number,
    });
    assert.equal(thread.notes[0].type, 'DiffNote');
    await this.state(mr.iid, 'IDLE', prior?.last_message_seq ?? 0, id, thread.id);
    const reviewed = await this.until('new commit in response to review', async () => {
      const current = await this.gl.getMr(id, mr.iid);
      return current.sha !== refs.head_sha && current;
    }, 5000);
    await this.until('bot reply to inline review', async () => (await this.gl.getDiscussion(id, mr.iid, thread.id)).notes
      .some(n => n.author.username === 'detent-bot' && !n.system && n.body.trim().length > 0 && !n.body.startsWith('正在检查 MR')), 5000);
    return reviewed;
  }

  async assertAnsibleApproval(iid: number, card: RowDataPacket) {
    const input = typeof card.tool_input === 'string' ? JSON.parse(card.tool_input) : card.tool_input;
    const { targetAssetId, stagingAssetId, targetAssetName } = this.ctx.stack;
    assert.ok(targetAssetId && stagingAssetId, 'Missing JumpServer asset IDs. Refresh the fixture with npm run e2e:up');
    assert.ok(Array.isArray(input.asset_ids), 'Job approval lacks an asset list');
    assert.ok(!input.asset_ids.includes(stagingAssetId), 'Job approval includes staging-node-01');
    assert.deepEqual(input.asset_ids, [targetAssetId], 'Job approval must select only ' + targetAssetName);
    const note = await this.gl.getIssueNote(this.ctx.hub, iid, card.gitlab_note_id);
    const targets = note.body.split('\n').find(line => /^\|\s*目标资产\s*\|/.test(line));
    assert.ok(targets, 'GitLab approval note ' + note.id + ' lacks its target asset row');
    assert.match(targets, /\btarget-node-01\b(?!-)/);
    assert.match(targets, /\/DEFAULT\/prod\/app\b(?![/-])/);
    assert.match(targets, /\benv:prod\b(?!-)/);
  }

  async executeMerged(iid: number, issue: Session, mr: MR, beforeApproval: () => Promise<void>, evidence: RegExp[], entries?: string[]) {
    this.trackNotes(iid);
    const sha = await this.gl.mergeMergeRequest(mr.target_project_id, mr.iid, mr.sha);
    const { card, session } = await this.approveProduction(iid, issue.last_message_seq, 'jms_job', async pending => {
      if (entries) await this.assertAnsibleApproval(iid, pending);
      assert.equal((await this.rows('SELECT id FROM delivery_executions WHERE session_id=?', [issue.id])).length, 0);
      await beforeApproval();
    });
    const closed = await this.done(iid, { afterSeq: session.last_message_seq });
    const execution = await this.until('acknowledged successful JumpServer execution', async () => {
      const rows = await this.rows('SELECT * FROM delivery_executions WHERE session_id=?', [closed.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'SUCCESS');
      return rows[0].callback_pending === 0 && rows[0];
    });
    assert.equal(execution.approval_id, card.id);
    assert.equal(execution.commit_sha, sha);
    if (entries) assert.ok(entries.includes(execution.playbook_path), 'Job did not execute the role playbook');
    else {
      const input = typeof card.tool_input === 'string' ? JSON.parse(card.tool_input) : card.tool_input;
      assert.ok(input.command?.trim(), 'Expected a remote command job for the chart deployment');
    }
    const [callback] = await this.rows(
      'SELECT source_kind, status, UNIX_TIMESTAMP(consumed_at)*1000 AS consumed_ms FROM session_inbox WHERE session_id=? AND event_id=?',
      [closed.id, 'jms-job:' + execution.jumpserver_job_id]);
    assert.equal(callback?.source_kind, 'system');
    assert.equal(callback.status, 'CONSUMED');
    assert.ok(Number(callback.consumed_ms) > 0);
    for (const pattern of evidence) await this.shellEvidence(closed, pattern, session.last_message_seq, Number(callback.consumed_ms));
  }
}

async function sop1(h: Scenario) {
  const { hub, api } = h.ctx;
  const iid = await h.open('检查 target-node-01 服务状态', '帮我检查一下主机 target-node-01 当前的服务进程、监听端口和磁盘使用情况是否正常，并给出诊断结论。');
  const diagnosis = await h.state(iid, 'IDLE');
  assert.equal((await h.rows("SELECT id FROM approval_requests WHERE session_id=? AND approval_type='PLAN'", [diagnosis.id])).length, 0);
  assert.equal((await h.gl.getIssue(hub, iid)).state, 'opened');
  await h.diagnosis(iid, diagnosis);
  await h.gl.postNote(hub, iid, `请把 ${api.path_with_namespace} 仓库中的服务端口从 19092 改为 9092 并提交一个 MR。`);
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
    `请在 ${web.path_with_namespace} 和 ${api.path_with_namespace} 各新增一份独立的版本记录，内容只写本次版本号 1.0.0。确认现有检查通过后，分别提交 MR。`, 'delivery::code');
  const plan = await h.approvePlan(iid);
  const issue = await h.state(iid, 'IDLE', plan.last_message_seq);
  const [webMr, apiMr] = await h.linkedMrs(issue, [web, api]);
  const versionPaths = new Map<number, string>();
  for (const mr of [webMr, apiMr]) {
    assert.ok(mr.assignees.some(a => a.id === h.ctx.botId && a.username === 'detent-bot'));
    const project = mr.target_project_id;
    const changes = await h.gl.mrDiffs(project, mr.iid);
    const versions = [];
    for (const file of changes.filter(f => f.new_file && !f.deleted_file)) {
      if ((await h.gl.getFile(project, file.new_path, mr.sha)).trim() === '1.0.0') versions.push(file.new_path);
    }
    assert.equal(versions.length, 1, 'Expected one new version record');
    versionPaths.set(project, versions[0]);
    assert.equal(await h.gl.getFile(project, 'check.sh', mr.sha), healthCheck);
    const dir = await mkdtemp(join(tmpdir(), 'detent-health-'));
    try {
      await writeFile(join(dir, 'health.txt'), await h.gl.getFile(project, 'health.txt', mr.sha));
      await run('sh', ['-c', healthCheck], { cwd: dir });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const versionPath = versionPaths.get(api.id)!;
  const changelog = posix.join(posix.dirname(versionPath), 'CHANGELOG.md');
  const reviewed = await h.review(apiMr, versionPath, '请顺便在同目录补充一个 CHANGELOG.md 记录 1.0.0 变更。', /1\.0\.0/);
  assert.ok((await h.gl.getFile(api.id, changelog, reviewed.source_branch)).includes('1.0.0'));

  h.trackNotes(iid);
  await h.gl.mergeMergeRequest(web.id, webMr.iid);
  const firstMerge = await h.state(iid, 'IDLE', issue.last_message_seq);
  const remaining = await h.rows("SELECT target_project_id FROM session_merge_requests WHERE session_id=? AND mr_state='opened'", [issue.id]);
  assert.deepEqual(remaining.map(m => m.target_project_id), [api.id]);
  assert.equal((await h.gl.getIssue(hub, iid)).state, 'opened');
  assert.equal((await h.gl.getMr(api.id, apiMr.iid)).state, 'opened');
  await h.gl.mergeMergeRequest(api.id, apiMr.iid);
  assert.ok((await h.done(iid)).last_message_seq > firstMerge.last_message_seq);
  for (const [project, path] of versionPaths) assert.equal((await h.gl.getFile(project, path)).trim(), '1.0.0');
  assert.ok((await h.gl.getFile(api.id, changelog)).includes('1.0.0'));
}

async function sop4(h: Scenario) {
  const { ansible } = h.ctx;
  await h.resetConfig();
  const legacy = 'legacy/cleanup_logs.yml';
  const original = await h.gl.fileBytes(ansible.id, legacy, 'main');
  const iid = await h.open('调整生产环境 demo-kafka 的连接数和请求超时',
    `请通过 ${ansible.path_with_namespace} 更新生产环境（prod）demo-kafka 主机的 /etc/detent-demo/app.conf，把 max_connections 从 128 提高到 512，并增加 request_timeout=30。请不要影响 staging 环境主机，执行变更并确认两项设置都已生效。`, 'delivery::env-change');
  const plan = await h.configPlan(iid, { requireAssetDiscovery: true });
  const { issue, mr } = await h.openedMr(iid, plan, ansible);
  assert.deepEqual(await h.gl.fileBytes(ansible.id, legacy, mr.sha), original);
  const entries = await ansibleEntryPoints(h.gl, mr, false);
  await h.targetConfig(128);
  await h.executeMerged(iid, issue, mr, async () => {
    assert.deepEqual(await h.gl.fileBytes(ansible.id, legacy, 'main'), original);
    await h.targetConfig(128);
  }, [/max_connections\s*=\s*512\b/, /request_timeout\s*=\s*30\b/], entries);
  await h.targetConfig(512, 30);
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

async function prepareNamespace(h: Scenario, namespace: string) {
  const target = h.ctx.stack.targetContainerName;
  await targetCommand(target, 'kubectl', 'delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=25s');
  await namespaceAbsent(h, namespace);
}

async function namespaceAbsent(h: Scenario, namespace: string) {
  assert.equal(await targetCommand(h.ctx.stack.targetContainerName, 'kubectl', 'get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'), '');
}

const clusterEvidence = /\bdeployed\b|\bdeployment(?:\.apps)?\/|\bREADY\s+UP-TO-DATE\s+AVAILABLE\b/i;

async function sop7(h: Scenario) {
  const { helm, helmPath, stack } = h.ctx;
  const namespace = 'demo-e2e';
  await prepareNamespace(h, namespace);
  const legacy = 'templates/legacy-extra-cm.yaml';
  const original = await h.gl.fileBytes(helm.id, legacy, 'main');
  const iid = await h.open('给 demo-api 挂载生产配置并部署',
    `请更新 ${helm.path_with_namespace}，让 demo-api 挂载新的应用配置 ConfigMap。生产环境需要 APP_ENV=prod 和 LOG_LEVEL=info，请保留单独调整生产配置的能力。通过 target-node-01 部署到集群的 demo-e2e 命名空间，然后核实部署状态。`, 'delivery::code');
  const plan = await h.approvePlan(iid);
  const { issue, mr } = await h.openedMr(iid, plan, helm);
  assert.deepEqual(await h.gl.fileBytes(helm.id, legacy, mr.sha), original);
  await checkChart(h.gl, mr, { namespace, logLevel: 'info' }, helmPath, stack.targetContainerName);
  const productionValues = await h.gl.getFile(mr.target_project_id, 'values-prod.yaml', mr.sha);
  const reviewed = await h.review(mr, 'values-prod.yaml', '生产环境的日志量比较大，请把生产日志级别改为 warn。', /log.?level/i);
  assert.deepEqual(await h.gl.fileBytes(helm.id, legacy, reviewed.sha), original);
  const updated = await h.gl.getFile(helm.id, 'values-prod.yaml', reviewed.sha);
  assert.notEqual(updated, productionValues);
  assert.match(updated, /\bwarn\b/);
  await checkChart(h.gl, reviewed, { namespace, logLevel: 'warn' }, helmPath, stack.targetContainerName);
  await h.executeMerged(iid, issue, reviewed, async () => {
    assert.deepEqual(await h.gl.fileBytes(helm.id, legacy, 'main'), original);
    await namespaceAbsent(h, namespace);
  }, [clusterEvidence, /demo-api|demo-e2e/]);
  await checkRelease(stack.targetContainerName, { namespace, logLevel: 'warn' });
}

async function sop8(h: Scenario) {
  const path = h.ctx.groupPath + '/ops-bootstrap-ansible';
  assert.equal(await h.gl.lookupProject(path), null);
  await h.resetConfig();
  const iid = await h.open('新建主机初始化仓库并调整连接上限',
    `请从零创建 ${path} 作为主机初始化的 Ansible 仓库。我们需要用它把 target-node-01 上 /etc/detent-demo/app.conf 的 max_connections 调整到 256。请执行这次变更并核实结果。`, 'delivery::env-change');
  const plan = await h.configPlan(iid);
  const { issue, mr } = await h.createApprovedProject(iid, plan, path);
  const entries = await ansibleEntryPoints(h.gl, mr, true);
  await h.executeMerged(iid, issue, mr, () => h.targetConfig(128), [/max_connections\s*=\s*256\b/], entries);
  await h.targetConfig(256);
}

async function sop9(h: Scenario) {
  const { groupPath, helmPath, stack } = h.ctx;
  const path = groupPath + '/order-helm-chart';
  const namespace = 'order-e2e';
  assert.equal(await h.gl.lookupProject(path), null);
  await prepareNamespace(h, namespace);
  const iid = await h.open('为 order-service 创建部署仓库并上线',
    `请从零创建 ${path}，用 Helm 管理 order-service。服务使用 busybox:1.36 镜像，在 8080 端口提供 HTTP，生产环境先部署两个副本。请通过 target-node-01 发布到集群的 order-e2e 命名空间并核实部署结果。`, 'delivery::code');
  const plan = await h.approvePlan(iid);
  const { issue, mr, project } = await h.createApprovedProject(iid, plan, path);
  await checkChart(h.gl, mr, { namespace, replicas: 2 }, helmPath, stack.targetContainerName);
  const productionValues = await h.gl.getFile(mr.target_project_id, 'values-prod.yaml', mr.sha);
  const reviewed = await h.review(mr, 'values-prod.yaml', '容量评估更新了，生产环境请调整为三个副本。', /replica/i);
  const updated = await h.gl.getFile(project.id, 'values-prod.yaml', reviewed.sha);
  assert.notEqual(updated, productionValues);
  assert.match(updated, /\b3\b/);
  await checkChart(h.gl, reviewed, { namespace, replicas: 3 }, helmPath, stack.targetContainerName);
  await h.executeMerged(iid, issue, reviewed, () => namespaceAbsent(h, namespace), [clusterEvidence, /order-service|order-e2e/]);
  await checkRelease(stack.targetContainerName, { namespace, replicas: 3 });
}

const scenarios = { sop1, sop2, sop3, sop4, sop5, sop6, sop7, sop8, sop9 };
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
  if (name !== 'sop9') return runBeforeDeadline();

  // Restore outside the timed race: the scenario's deadline must never disable cleanup.
  const skill = 'skills/helm-conventions/SKILL.md';
  const original = await context.gitlab.getFile(context.hub, skill);
  try {
    await context.gitlab.upsertFile(context.hub, skill,
      original + '\n所有业务工作负载的 Deployment metadata.annotations 必须包含 team.detent.io/owner: platform-ops。\n',
      'Require platform ownership on deployments');
    await runBeforeDeadline();
  } finally {
    if (await context.gitlab.getFile(context.hub, skill) !== original) {
      await context.gitlab.upsertFile(context.hub, skill, original, 'Restore original Helm conventions');
    }
  }

  async function runBeforeDeadline() {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(reject, Math.max(0, Math.ceil(context.sopDeadline - performance.now())), expired);
    });
    try {
      scenario.ctx.checkRunning();
      await Promise.race([timeout, scenarios[name](scenario).catch(async error => {
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
}
