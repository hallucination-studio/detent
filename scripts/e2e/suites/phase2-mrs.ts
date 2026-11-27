import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { checkSession, type Harness } from './harness.js';
type Mr = Harness['standalone'];

export async function runMrScenarios(h: Harness) {
  const { gitlab, admin, api, hub, bot, standalone, anthropic, until, rows, records, mrState, trackMr } = h;
  const synthetic = gitlab.synthetic;
  const mrPath = (iid: number) => '/projects/' + api + '/merge_requests/' + iid;
  const requests = anthropic.getRequests;
  const tables = ['session_messages', 'session_inbox', 'session_worktrees', 'session_merge_requests', 'approval_requests'];
  const snapshot = (s: RowDataPacket) => Promise.all(tables.map(table => records(s.id, table)));
  const clean = (s: RowDataPacket) => checkSession(h, s);
  async function archived(mr: Mr) {
    const s = await mrState(mr.target_project_id, mr.iid, 'DONE');
    assert.deepEqual((await records(s.id, 'session_worktrees')).map(t => t.status), ['ARCHIVED']);
    await clean(s);
  }
  async function withPolicy(rule: object, exercise: () => Promise<void>) {
    const original = await gitlab.getFile(hub, 'events.json');
    await gitlab.upsertFile(hub, 'events.json', JSON.stringify({ version: 1, rules: [rule] }), 'Exercise MR pipeline policy');
    try { await exercise(); }
    finally { await gitlab.upsertFile(hub, 'events.json', original, 'Restore MR pipeline policy'); }
  }

  // M-6. Wait for the worker to read live ownership for each ignored event, then drain
  // the Pod before comparing counters. A 202 alone only acknowledges queue insertion.
  const beforeOff = await mrState(api, standalone.iid, 'IDLE');
  const baselineInbox = await records(beforeOff.id, 'session_inbox');
  await gitlab.unassignMr(api, standalone.iid);
  assert.deepEqual((await gitlab.getMr(api, standalone.iid)).assignees, []);
  const offCalls = requests();
  let ignoredThread: string | undefined;
  const offHead = (await gitlab.getMr(api, standalone.iid)).sha;
  await h.observeGet(mrPath(standalone.iid), async () => {
    ignoredThread = (await gitlab.openDiscussion(api, standalone.iid, 'Thanks for the review.')).id;
  });
  if (synthetic) await h.observeGet(mrPath(standalone.iid), () => synthetic.failPipeline(api, standalone.iid, bot.id));
  await h.stopPod();
  assert.equal(requests(), offCalls);
  assert.ok(ignoredThread);
  assert.deepEqual((await gitlab.getDiscussion(api, standalone.iid, ignoredThread)).notes.map(n => n.author.username), [gitlab.devUsername]);
  assert.equal((await gitlab.getMr(api, standalone.iid)).sha, offHead);
  assert.deepEqual(await records(beforeOff.id, 'session_inbox'), baselineInbox);
  assert.equal((await mrState(api, standalone.iid, 'IDLE')).last_message_seq, beforeOff.last_message_seq);
  await h.startPod('detent-hands-off');
  await gitlab.closeMr(api, standalone.iid);
  assert.equal((await gitlab.getMr(api, standalone.iid)).state, 'closed');
  await archived(standalone);

  // Create the linked resource through the Issue worker so both close and budget
  // escalation exercise a real session_merge_requests relationship.
  const ciIssue = await h.openIssue('Review CI readiness change', 'Review the readiness probe in ' + gitlab.targetProjects.api, 'delivery::code');
  const ciPlan = await h.pendingCard(ciIssue, 'Plan', ['readiness probe']);
  await gitlab.awardThumbsUp(hub, ciIssue, ciPlan.gitlab_note_id, 'dev');
  const ciHub = await h.state(ciIssue, 'IDLE');
  const links = await records(ciHub.id, 'session_merge_requests');
  assert.equal(links.length, 1);
  const [link] = links;
  assert.equal(link.target_project_id, api);
  const ci = await gitlab.getMr(api, link.mr_iid);
  assert.ok(ci.assignees.some(a => a.id === bot.id));
  await gitlab.openDiscussion(api, ci.iid, 'Please inspect this contribution');
  const ciWorker = await mrState(api, ci.iid, 'IDLE', 0);

  // M-8. Exercise the stale event and the complete budget lifecycle on the linked MR.
  if (synthetic) await withPolicy({ event: 'pipeline', status: 'failed', action: 'run', ownership: 'assigned', maxAutoFixAttempts: 1 }, async () => {
    const staleSha = await gitlab.headSha(api);
    assert.notEqual(staleSha, ci.sha);
    assert.equal(ciWorker.auto_fix_attempts, 0);
    const before = requests();
    const stale = await synthetic.failPipeline(api, ci.iid, bot.id, staleSha);
    await until('stale pipeline persisted on linked MR', async () =>
      (await records(ciHub.id, 'session_merge_requests'))[0].latest_pipeline_id === stale);
    await h.stopPod();
    const ignored = await mrState(api, ci.iid, 'IDLE');
    assert.equal(ignored.auto_fix_attempts, 0);
    assert.equal(ignored.last_failed_pipeline_id, ciWorker.last_failed_pipeline_id);
    assert.equal(ignored.last_message_seq, ciWorker.last_message_seq);
    assert.equal(requests(), before);
    assert.equal((await gitlab.getMr(api, ci.iid)).sha, ci.sha);
    await h.startPod('detent-ci-budget');
    const first = await synthetic.failPipeline(api, ci.iid, bot.id);
    const fixed = await mrState(api, ci.iid, 'IDLE', ignored.last_message_seq);
    assert.equal(fixed.auto_fix_attempts, 1);
    assert.equal(fixed.last_failed_pipeline_id, first);
    assert.ok(requests() > before);
    const head = (await gitlab.getMr(api, ci.iid)).sha;
    assert.notEqual(head, ci.sha);
    assert.equal(await gitlab.getFile(api, 'ci/ready.txt', head), 'ready\n');
    const atCap = requests();
    const second = await synthetic.failPipeline(api, ci.iid, bot.id);
    const escalated = (n: { body: string }) => n.body.includes('Pipeline #' + second + ' failed') && n.body.includes('自动修复次数已用尽');
    await until('escalation on MR and linked Issue', async () =>
      (await gitlab.listMrNotes(api, ci.iid)).some(escalated) && (await gitlab.listIssueNotes(hub, ciIssue)).some(escalated));
    const capped = await mrState(api, ci.iid, 'IDLE');
    assert.equal(capped.auto_fix_attempts, 1);
    assert.equal(capped.last_failed_pipeline_id, second);
    assert.equal(capped.last_message_seq, fixed.last_message_seq);
    assert.equal((await gitlab.getMr(api, ci.iid)).sha, head);
    const success = await synthetic.succeedPipeline(api, ci.iid, bot.id);
    await until('successful pipeline resets CI budget', async () => {
      const [latest] = await records(ciHub.id, 'session_merge_requests');
      const [s] = await rows('SELECT auto_fix_attempts FROM issue_sessions WHERE id=?', [ciWorker.id]);
      return latest.latest_pipeline_id === success && latest.latest_pipeline_status === 'success' && s.auto_fix_attempts === 0;
    });
    assert.equal(requests(), atCap);
    await clean(capped);
    await clean(ciHub);
  });
  await gitlab.closeMr(api, ci.iid);
  await until('human close persisted on linked Issue', async () => (await records(ciHub.id, 'session_merge_requests'))[0].mr_state === 'closed');
  assert.equal((await gitlab.getMr(api, ci.iid)).state, 'closed');
  await archived(ci);
  await clean(ciHub);

  // M-7. Diverge from a shared file revision. Both original parent SHAs must survive resolution.
  await gitlab.upsertFile(api, 'conflict.txt', 'base setting\n', 'Seed shared config');
  await gitlab.upsertFile(api, 'conflict.txt', 'source setting\n', 'Edit source config', 'conflict-branch', 'main');
  await gitlab.upsertFile(api, 'conflict.txt', 'target setting\n', 'Edit target config');
  const main = await gitlab.headSha(api);
  const sourceHead = await admin.json<{ id: string }>('/projects/' + api + '/repository/commits/conflict-branch');
  assert.equal(await gitlab.getFile(api, 'conflict.txt', sourceHead.id), 'source setting\n');
  const conflict = trackMr(await gitlab.openMr(api, 'conflict-branch', 'Resolve conflict on config', bot.id));
  const resolved = await mrState(api, conflict.iid, 'IDLE', 0);
  const head = (await gitlab.getMr(api, conflict.iid)).sha;
  const commit = await admin.json<{ parent_ids: string[] }>('/projects/' + api + '/repository/commits/' + head);
  assert.deepEqual(commit.parent_ids, [sourceHead.id, main]);
  assert.equal((await records(resolved.id, 'session_worktrees'))[0].last_commit_sha, head);
  assert.equal(await gitlab.headSha(api), main);
  assert.equal(await gitlab.getFile(api, 'conflict.txt'), 'target setting\n');
  const merged = await gitlab.mergeMergeRequest(api, conflict.iid);
  assert.equal(await gitlab.headSha(api), merged);
  assert.equal((await gitlab.getMr(api, conflict.iid)).state, 'merged');
  assert.equal(await gitlab.getFile(api, 'conflict.txt'), 'resolved source and target settings\n');
  await archived(conflict);

  // M-9. Exercise the Plan and TOOL_USE cards on an MR with two distinct approval identities.
  const config = trackMr(await gitlab.openExternalMr(api, 'config-loader', 'Review config loader'));
  await gitlab.assignMr(api, config.iid, bot.id);
  const accepted = await mrState(api, config.iid, 'IDLE', 0);
  const discuss = (text: string) => gitlab.openDiscussion(api, config.iid, text);
  const threadNotes = async (id: string) => (await gitlab.getDiscussion(api, config.iid, id)).notes;
  const approvals = () => records(accepted.id, 'approval_requests');
  await discuss('/plan Refactor config loader');
  const planned = await mrState(api, config.iid, 'WAITING_PLAN', accepted.last_message_seq);
  assert.equal(planned.permission_mode, 'plan');
  const [plan] = await approvals();
  assert.equal(plan.approval_type, 'PLAN');
  assert.equal(plan.status, 'PENDING');
  const mrNotes = async () => (await gitlab.listMrDiscussions(api, config.iid)).flatMap(d => d.notes);
  assert.match((await mrNotes()).find(n => n.id === plan.gitlab_note_id)?.body ?? '', /实施方案审批[\s\S]*Refactor the config loader/);
  assert.deepEqual((await gitlab.getMr(api, config.iid)).labels.filter(l => l.startsWith('claude::')), []);
  const status = await discuss('/status');
  await until('MR /status reply', async () => (await threadNotes(status.id)).some(n => n.author.username === bot.username && n.body.includes('⏸️ **等待方案确认**')));
  await gitlab.awardMrThumbsUp(api, config.iid, plan.gitlab_note_id, 'dev');
  await mrState(api, config.iid, 'WAITING_TOOL');
  const tool = (await approvals()).find(a => a.approval_type === 'TOOL_USE');
  assert.ok(tool && tool.tool_name === 'Bash' && tool.status === 'PENDING');
  assert.match((await mrNotes()).find(n => n.id === tool.gitlab_note_id)?.body ?? '', /命令执行审批[\s\S]*printf config-loader-ok/);
  const [reporter] = await admin.json<{ id: number }[]>('/users?username=' + gitlab.reporterUsername);
  await h.observeGet('/projects/' + api + '/members/all/' + reporter.id,
    () => gitlab.awardMrThumbsUp(api, config.iid, tool.gitlab_note_id, 'reporter'));
  assert.equal((await approvals()).find(a => a.id === tool.id)?.status, 'PENDING');
  await gitlab.awardMrThumbsUp(api, config.iid, tool.gitlab_note_id, 'dev');
  const implemented = await mrState(api, config.iid, 'IDLE', planned.last_message_seq);
  assert.deepEqual((await approvals()).map(a => [a.status, a.decided_by]), Array(2).fill(['APPROVED', gitlab.devUsername]));
  assert.ok((await mrNotes()).some(n => n.body.includes('Approved config loader check returned config.')));
  assert.ok(h.jev.requests.includes('printf config-loader-ok | cut -c 1-6'));
  assert.deepEqual((await gitlab.getMr(api, config.iid)).labels.filter(l => l.startsWith('claude::')), []);
  await clean(implemented);

  // M-10. Submit the second discussion while the first is waiting on its first tool.
  // Both receipts must be consumed by that turn and get its full rendered reply.
  let overrideThread: string | undefined;
  anthropic.beforeNextTool('detent_list_mr_discussions', async () => {
    overrideThread = (await discuss('Also check the config override.')).id;
    await until('second review durably queued', async () => (await records(accepted.id, 'session_inbox'))
      .some(r => r.discussion_id === overrideThread && r.status === 'PENDING'));
  });
  const defaults = await discuss('Check the config defaults.');
  const batch = await mrState(api, config.iid, 'IDLE', implemented.last_message_seq);
  assert.ok(overrideThread);
  const replies: string[] = [];
  for (const id of [defaults.id, overrideThread]) {
    const items = (await records(batch.id, 'session_inbox')).filter(r => r.discussion_id === id);
    assert.equal(items.length, 1);
    assert.ok(items[0].status === 'CONSUMED' && items[0].consumed_at);
    const repliesInThread = (await threadNotes(id)).filter(n => n.author.username === bot.username);
    assert.equal(repliesInThread.length, 1);
    const body = repliesInThread[0].body;
    assert.match(body, /Reviewed both the config defaults and the override\./);
    assert.match(body, /<details><summary>🔍 工具调用轨迹（[1-9]\d* 步）[\s\S]*detent_list_mr_discussions[\s\S]*<\/details>/);
    replies.push(body);
  }
  assert.equal(replies[0], replies[1]);
  await clean(batch);

  // M-11. Install each crash atomically while the Pod is down. The replacement
  // receives no webhook. Only the Watchdog can acquire and resume this turn.
  async function crash(attempts: number, content: string) {
    await h.stopPod();
    const event = randomUUID();
    const cx = await h.db.getConnection();
    try {
      await cx.beginTransaction();
      await cx.execute(`UPDATE issue_sessions SET status='CODING', locked_by_pod='crashed-pod/1',
        lock_expires_at=TIMESTAMPADD(SECOND,-60,NOW(3)), recovery_attempts=? WHERE id=?`, [attempts, batch.id]);
      await cx.execute(`INSERT INTO session_inbox(session_id,event_id,source_kind,sender_username,content,status)
        VALUES(?,?,'note',?,?,'PENDING')`, [batch.id, event, gitlab.devUsername, content]);
      await cx.commit();
    } catch (error) { await cx.rollback(); throw error; }
    finally { cx.release(); }
    await h.startPod('detent-watchdog-' + attempts, { WATCHDOG_INTERVAL_MS: '15000', WATCHDOG_MAX_RECOVERIES: '1' });
    return event;
  }
  let claimed = false;
  anthropic.beforeNextTool('detent_get_mr_diff', async () => {
    const [s] = await rows('SELECT locked_by_pod, recovery_attempts FROM issue_sessions WHERE id=?', [batch.id]);
    assert.match(s.locked_by_pod, /^detent-watchdog-0\//);
    assert.equal(s.recovery_attempts, 1);
    claimed = true;
  });
  const recoveredEvent = await crash(0, 'Resume the interrupted review.');
  const recovered = await mrState(api, config.iid, 'IDLE', batch.last_message_seq);
  assert.ok(claimed);
  assert.equal(recovered.recovery_attempts, 0);
  assert.equal((await records(batch.id, 'session_inbox')).find(r => r.event_id === recoveredEvent)?.status, 'CONSUMED');
  assert.ok((await mrNotes()).some(n => n.body.includes('Recovered the interrupted review.')));
  await clean(recovered);
  const beforeExhausted = requests();
  const privateText = 'crash-context-' + randomUUID();
  const expiredEvent = await crash(1, privateText);
  const failed = await mrState(api, config.iid, 'FAILED');
  assert.equal(failed.recovery_attempts, 1);
  assert.equal(failed.last_message_seq, recovered.last_message_seq);
  assert.equal((await records(batch.id, 'session_inbox')).find(r => r.event_id === expiredEvent)?.status, 'EXPIRED');
  assert.equal(requests(), beforeExhausted);
  assert.ok((await mrNotes()).some(n => n.body.includes('自动恢复次数已用尽')));
  assert.ok((await mrNotes()).every(n => !n.body.includes(privateText)));
  await clean(failed);

  // M-14. A casual discussion leaves the assigned branch intact. Reopen the
  // subsequently unassigned MR so only an explicit mention can wake its session.
  const lifecycle = trackMr(await gitlab.openExternalMr(api, 'loader-lifecycle', 'Review loader lifecycle'));
  const iid = lifecycle.iid;
  const commits = () => admin.json<{ id: string }[]>(mrPath(iid) + '/commits?per_page=100');
  await gitlab.assignMr(api, iid, bot.id);
  const assigned = await mrState(api, iid, 'IDLE', 0);
  const originalCommits = (await commits()).map(c => c.id);
  assert.ok(originalCommits.includes(lifecycle.sha));
  const lunch = await gitlab.openDiscussion(api, iid, 'Anyone free for lunch?');
  const chatted = await mrState(api, iid, 'IDLE', assigned.last_message_seq);
  const repliesToLunch = (await gitlab.getDiscussion(api, iid, lunch.id)).notes.filter(n => n.author.username === bot.username);
  assert.equal(repliesToLunch.length, 1);
  assert.equal(repliesToLunch[0].body.trim(), 'Enjoy lunch!');
  assert.equal((await gitlab.getMr(api, iid)).sha, lifecycle.sha);
  assert.deepEqual((await commits()).map(c => c.id), originalCommits);
  await gitlab.openDiscussion(api, iid, '/plan Refactor config loader');
  const firstPlan = await mrState(api, iid, 'WAITING_PLAN', chatted.last_message_seq);
  const [v1] = await records(firstPlan.id, 'approval_requests');
  assert.equal(v1.status, 'PENDING');
  await gitlab.openDiscussion(api, iid, '/reject Preserve existing defaults');
  const revised = await mrState(api, iid, 'WAITING_PLAN', firstPlan.last_message_seq);
  const cards = await records(revised.id, 'approval_requests');
  assert.equal(cards.find(a => a.id === v1.id)?.status, 'REJECTED');
  const v2 = cards.find(a => a.status === 'PENDING' && a.approval_type === 'PLAN');
  assert.ok(v2 && v2.gitlab_note_id !== v1.gitlab_note_id);
  const revisions = (await gitlab.listMrDiscussions(api, iid)).flatMap(d => d.notes);
  assert.match(revisions.find(n => n.id === v2.gitlab_note_id)?.body ?? '', /Revised loader plan preserves existing defaults/);
  await gitlab.unassignMr(api, iid);
  await gitlab.closeMr(api, iid);
  await archived(lifecycle);
  assert.equal((await gitlab.reopenMr(api, iid)).state, 'opened');
  const mentionAgain = await gitlab.openDiscussion(api, iid, '@' + bot.username + ' Please inspect this contribution');
  const awake = await mrState(api, iid, 'IDLE', revised.last_message_seq);
  assert.equal(awake.id, assigned.id);
  assert.equal(awake.claude_session_id, assigned.claude_session_id);
  assert.ok((await gitlab.getDiscussion(api, iid, mentionAgain.id)).notes.some(n =>
    n.author.username === bot.username && n.body.includes('Inspected the external contribution.')));
  await clean(awake);

  if (!synthetic) return;
  // M-12. The semantic decision sees the actual event summary and current MR title.
  await withPolicy({ event: 'pipeline', status: 'failed', action: 'semantic', allowedActions: ['notify', 'run'],
    promptHint: 'Notify on infrastructure flakes and fix code errors.' }, async () => {
    const mr = trackMr(await gitlab.openExternalMr(api, 'classify-ci', 'Infrastructure flake in runner'));
    await gitlab.assignMr(api, mr.iid, bot.id);
    const original = await mrState(api, mr.iid, 'IDLE', 0);
    const before = requests();
    const offset = h.jev.eventDecisions.length;
    const infra = await synthetic.failPipeline(api, mr.iid, bot.id);
    await until('infra flake notification', async () => (await gitlab.listMrNotes(api, mr.iid)).some(n => n.body.includes('Pipeline #' + infra + ' failed')));
    assert.equal(requests(), before);
    assert.equal((await gitlab.getMr(api, mr.iid)).sha, mr.sha);
    const notified = await mrState(api, mr.iid, 'IDLE');
    assert.equal(notified.last_message_seq, original.last_message_seq);
    assert.equal(notified.auto_fix_attempts, 0);
    assert.deepEqual(h.jev.eventDecisions.slice(offset), ['notify']);
    await admin.request(mrPath(mr.iid), 'PUT', { title: 'Code error in readiness check' });
    const code = await synthetic.failPipeline(api, mr.iid, bot.id);
    const fixed = await mrState(api, mr.iid, 'IDLE', original.last_message_seq);
    assert.deepEqual(h.jev.eventDecisions.slice(offset), ['notify', 'run']);
    assert.equal(fixed.last_failed_pipeline_id, code);
    assert.equal(fixed.auto_fix_attempts, 1);
    assert.ok(requests() > before);
    const head = (await gitlab.getMr(api, mr.iid)).sha;
    assert.notEqual(head, mr.sha);
    assert.equal(await gitlab.getFile(api, 'ci/ready.txt', head), 'ready\n');
    await clean(fixed);
  });

  // M-13. Use independent real Git remotes and observe attempted receive-pack requests.
  const targetPushes = synthetic.pushAttempts(api);
  const fork = trackMr(await synthetic.openReadonlyForkMr(api, bot.id));
  const source = fork.source_project_id;
  assert.notEqual(source, api);
  assert.equal(fork.target_project_id, api);
  const member = await admin.json<{ access_level: number }>('/projects/' + source + '/members/all/' + bot.id);
  assert.equal(member.access_level, 20);
  const readonly = await mrState(api, fork.iid, 'IDLE', 0);
  assert.equal(synthetic.pushAttempts(source), 0);
  assert.equal(synthetic.pushAttempts(api), targetPushes);
  const messages = (await records(readonly.id, 'session_messages')).map(row => JSON.parse(row.raw_json_line));
  assert.ok(messages.every(m => !Array.isArray(m.message?.content) ||
    m.message.content.every((b: { is_error?: boolean }) => !b.is_error)), 'Readonly review had a tool error');
  assert.equal((await gitlab.getMr(api, fork.iid)).sha, fork.sha);
  assert.ok((await gitlab.listMrNotes(api, fork.iid)).some(n => n.body.includes('Suggested fix in config.ini: set timeout=30')));
  const [tree] = await records(readonly.id, 'session_worktrees');
  assert.equal(tree.target_project_id, source);
  assert.equal(tree.last_commit_sha, fork.sha);
  assert.ok(!tree.uncommitted_diff);
  await clean(readonly);

  const issue = await h.state(h.isolationIssue, 'IDLE');
  const beforeIssue = await snapshot(issue);
  const resource = await gitlab.getIssue(hub, h.isolationIssue);
  const notes = await gitlab.listIssueNotes(hub, h.isolationIssue);
  // The Welcome Issue occupies #1. Verify help on !1 before exercising the same-numbered working pair.
  const unassigned = trackMr(await gitlab.openExternalMr(hub, 'hub-help'));
  const calls = requests();
  const help = await gitlab.openDiscussion(hub, unassigned.iid, '@' + bot.username + ' 帮助');
  await until('help on unassigned MR', async () => (await gitlab.getDiscussion(hub, unassigned.iid, help.id)).notes
    .some(n => n.author.username === bot.username && n.body.includes('/plan')));
  assert.deepEqual(await rows("SELECT id FROM issue_sessions WHERE session_kind='mr' AND hub_project_id=? AND hub_issue_iid=?", [hub, unassigned.iid]), []);
  assert.equal(requests(), calls);
  const twin = trackMr(await gitlab.openExternalMr(hub, 'hub-isolation'));
  assert.equal(twin.iid, h.isolationIssue);
  const mention = await gitlab.openDiscussion(hub, twin.iid, '@' + bot.username + ' Please inspect this contribution');
  const independent = await mrState(hub, twin.iid, 'IDLE', 0);
  assert.notEqual(independent.id, issue.id);
  const kinds = await rows('SELECT session_kind FROM issue_sessions WHERE hub_project_id=? AND hub_issue_iid=? ORDER BY session_kind', [hub, twin.iid]);
  assert.deepEqual(kinds.map(s => s.session_kind), ['issue', 'mr']);
  assert.ok((await gitlab.getDiscussion(hub, twin.iid, mention.id)).notes.some(n => n.author.username === bot.username && n.body.includes('Inspected the external contribution.')));
  assert.deepEqual(await h.state(h.isolationIssue, 'IDLE'), issue);
  assert.deepEqual(await snapshot(issue), beforeIssue);
  assert.deepEqual(await gitlab.getIssue(hub, h.isolationIssue), resource);
  assert.deepEqual(await gitlab.listIssueNotes(hub, h.isolationIssue), notes);
  await clean(independent);
  await clean(issue);
}

export async function verifyOnboardedMr(h: Harness, project: number) {
  await h.gitlab.upsertFile(project, 'payment.txt', 'ready\n', 'Prepare payment review', 'payment-feature', 'main');
  const mr = h.trackMr(await h.gitlab.openMr(project, 'payment-feature', 'Review payment', h.bot.id));
  const session = await h.mrState(project, mr.iid, 'IDLE');
  const notes = await h.gitlab.listMrNotes(project, mr.iid);
  assert.ok(notes.some(note => note.body.includes('Accepted the assigned MR.') && note.body.includes('已接管此 MR')));
  const before = h.anthropic.getRequests();
  const thread = await h.gitlab.openDiscussion(project, mr.iid, '/help');
  await h.until('MR help in its triggering thread', async () => (await h.gitlab.getDiscussion(project, mr.iid, thread.id))
    .notes.some(n => n.author.username === h.bot.username && ['/plan', '/help', '/status', '/abort', '/reset'].every(cmd => n.body.includes(cmd))));
  assert.equal(h.anthropic.getRequests(), before);
  assert.deepEqual(await h.mrState(project, mr.iid, 'IDLE'), session);
  await checkSession(h, session);
}
