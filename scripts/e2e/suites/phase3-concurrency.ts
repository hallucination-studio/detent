import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import type { Cluster } from './cluster.js';
import type { Harness } from './harness.js';

export async function runConcurrency(h: Harness, cluster: Cluster, web: number) {
  const { gitlab, api, hub, bot, anthropic, until, rows, records } = h;
  const synthetic = gitlab.synthetic!;
  const replies = async (project: number, iid: number, thread: string) =>
    (await gitlab.getDiscussion(project, iid, thread)).notes.filter(n => n.author.username === bot.username);
  const mr = h.trackMr(await gitlab.openExternalMr(api, 'cluster-steering', 'Verify shared steering'));
  await gitlab.assignMr(api, mr.iid, bot.id);
  let worker = await h.mrState(api, mr.iid, 'IDLE', 0);
  const discuss = (body: string) => gitlab.openDiscussion(api, mr.iid, body);
  const activeWorker = async () => {
    const [active] = await rows('SELECT status, locked_by_pod FROM issue_sessions WHERE id=?', [worker.id]);
    assert.equal(active.status, 'CODING');
    assert.match(active.locked_by_pod, /^detent-pod-a\//);
  };

  // The model cannot return its tool call until B has acknowledged and persisted every receipt.
  async function steer(collide: boolean) {
    const receipts = Array.from({ length: collide ? 2 : 1 }, () => 'receipt-' + randomUUID());
    const threads: string[] = [];
    anthropic.beforeNextTool('detent_get_mr_diff', async () => {
      await activeWorker();
      await Promise.all([
        ...receipts.map(async receipt => {
          const { value } = await cluster.pinned('b', e => e.object_attributes?.note === receipt, () => discuss(receipt));
          threads.push(value.id);
        }),
        ...(collide ? [(async () => {
          const status = await discuss('/status');
          await until('status while coding is paused', async () => (await replies(api, mr.iid, status.id)).some(n => n.body.startsWith('⚙️ **执行中** · 正在按已批准方案实施')));
        })()] : []),
      ]);
      await until('all steering rows pending', async () => {
        const inbox = await records(worker.id, 'session_inbox');
        return receipts.every(receipt => inbox.some(r => r.content === receipt && r.status === 'PENDING' && threads.includes(r.discussion_id)));
      });
      await activeWorker();
    });
    const prompt = 'Check the config defaults.';
    const { value } = await cluster.pinned('a', e => e.object_attributes?.note === prompt, () => discuss(prompt));
    worker = await h.mrState(api, mr.iid, 'IDLE', worker.last_message_seq);
    assert.equal(threads.length, receipts.length);
    const expected = 'Applied ' + receipts.sort().join(' ');
    for (const thread of [value.id, ...threads]) {
      const notes = await replies(api, mr.iid, thread);
      assert.equal(notes.length, 1);
      assert.ok(notes[0].body.includes(expected));
      const [item] = (await records(worker.id, 'session_inbox')).filter(r => r.discussion_id === thread);
      assert.ok(item.status === 'CONSUMED' && item.consumed_at);
    }
  }

  await steer(false);
  const planTitle = 'Cluster plan decision';
  const openPlan = () => h.openIssue(planTitle, '', 'delivery::code');
  const { value: first } = await cluster.pinned('a', e => e.object_attributes?.title === planTitle, openPlan);
  const firstCard = await h.pendingCard(first, 'Plan', ['Cluster plan ready.']);
  await cluster.pinned('b', e => e.object_kind === 'emoji', () => gitlab.awardThumbsUp(hub, first, firstCard.gitlab_note_id, 'dev'));
  const resumed = await h.state(first, 'IDLE');
  assert.deepEqual((await records(resumed.id, 'approval_requests')).map(r => r.status), ['APPROVED']);
  assert.equal((await gitlab.listIssueNotes(hub, first)).filter(n => n.body.includes('Cluster plan executed.')).length, 1);
  console.log('C-1 passed: Pod B acknowledged steering under Pod A\'s lease and resumed its plan.');

  // Seed distinct real branches. Main already contains the fixes from the earlier phases.
  await gitlab.upsertFile(web, 'ci/ready.txt', 'broken\n', 'Break readiness', 'storm-ci', 'main');
  const ci = h.trackMr(await gitlab.openMr(web, 'storm-ci', 'Storm CI repair', bot.id));
  const beforeCI = await h.mrState(web, ci.iid, 'IDLE', 0);
  await gitlab.upsertFile(api, 'hello.txt', 'Hello from ' + gitlab.targetProjects.api + ' storm!\n', 'Update storm greeting', 'storm-inline', 'main');
  await gitlab.upsertFile(api, 'test-greeting.sh', 'broken\n', 'Break greeting test', 'storm-inline');
  const inline = h.trackMr(await gitlab.openMr(api, 'storm-inline', 'Storm inline review', bot.id));
  const beforeInline = await h.mrState(api, inline.iid, 'IDLE', 0);
  const external = h.trackMr(await gitlab.openExternalMr(api, 'storm-external', 'Storm external question'));
  const names = ['Storm code change', 'Storm audit inspection', ci, inline, external].map(v =>
    typeof v === 'string' ? v : 'GitLab MR ' + v.target_project_id + '!' + v.iid + ' ·');
  const arrived = new Set<string>();
  anthropic.observeTurns(async system => {
    const name = names.find(n => system.includes(n));
    assert.ok(name);
    arrived.add(name);
    await until('five distinct SDK turns active simultaneously', () => arrived.size === 5);
  });
  let code: number, audit: number, pipeline: number, review, question;
  try {
    [code, audit, pipeline, review, question] = await Promise.all([
      cluster.pinned('a', e => e.object_attributes?.title === names[0], () => h.openIssue(names[0], '', 'delivery::code')).then(r => r.value),
      cluster.pinned('b', e => e.object_attributes?.title === names[1], () => h.openIssue(names[1], '', 'delivery::audit')).then(r => r.value),
      synthetic.failPipeline(web, ci.iid, bot.id),
      gitlab.openDiscussion(api, inline.iid, 'Add a regression test for this greeting.', { ...inline.diff_refs!,
        position_type: 'text', old_path: 'hello.txt', new_path: 'hello.txt', new_line: 1 }),
      gitlab.openDiscussion(api, external.iid, '@' + bot.username + ' Please inspect this contribution'),
    ]);
    await until('storm reached model barrier', () => arrived.size === 5);
  } finally { anthropic.observeTurns(); }
  const plan = await h.pendingCard(code, 'Plan', ['cluster.txt']);
  await gitlab.awardThumbsUp(hub, code, plan.gitlab_note_id, 'dev');
  const sessions = await Promise.all([h.state(code, 'IDLE'), h.state(audit, 'DONE'),
    h.mrState(web, ci.iid, 'IDLE', beforeCI.last_message_seq), h.mrState(api, inline.iid, 'IDLE', beforeInline.last_message_seq),
    h.mrState(api, external.iid, 'IDLE', 0)]);
  assert.equal(new Set(sessions.map(s => s.claude_session_id)).size, 5);
  for (const s of sessions) {
    const history = await rows('SELECT seq,raw_json_line FROM session_messages WHERE session_id=? ORDER BY seq', [s.id]);
    assert.equal(history.length, s.last_message_seq);
    assert.deepEqual(history.map(r => r.seq), Array.from({ length: history.length }, (_, i) => i + 1));
    const ids = history.map(r => JSON.parse(r.raw_json_line).sessionId).filter(Boolean);
    assert.deepEqual([...new Set(ids)], [s.claude_session_id]);
  }
  const [link] = await records(sessions[0].id, 'session_merge_requests');
  assert.equal(link.target_project_id, web);
  assert.equal(await gitlab.getFile(web, 'cluster.txt', link.source_branch), 'cluster ready\n');
  assert.ok((await gitlab.listIssueNotes(hub, code)).some(n => n.body.includes('Review cluster readiness: ' + link.mr_web_url)));
  assert.equal((await gitlab.getIssue(hub, audit)).state, 'closed');
  assert.deepEqual(await records(sessions[1].id, 'session_worktrees'), []);
  assert.ok((await gitlab.listIssueNotes(hub, audit)).some(n => n.body.includes('Diagnostic report: nginx is active on web01.')));
  assert.equal(sessions[2].last_failed_pipeline_id, pipeline);
  const fixed = await gitlab.getMr(web, ci.iid);
  assert.equal(await gitlab.getFile(web, 'ci/ready.txt', fixed.sha), 'ready\n');
  assert.ok((await gitlab.listMrNotes(web, ci.iid)).some(n => n.body.includes('Restored the CI readiness file.')));
  const reviewed = await gitlab.getMr(api, inline.iid);
  assert.equal(await gitlab.getFile(api, 'test-greeting.sh', reviewed.sha), '#!/bin/sh\ntest "$(cat hello.txt)" = "Hello from ' + gitlab.targetProjects.api + ' storm!"\n');
  for (const [project, head, parent, title] of [
    [web, fixed.sha, ci.sha, 'Restored the CI readiness file.'],
    [api, reviewed.sha, inline.sha, 'Added the requested greeting regression test.'],
  ] as const) {
    const commit = await h.admin.json<{ parent_ids: string[]; title: string }>('/projects/' + project + '/repository/commits/' + head);
    assert.deepEqual(commit.parent_ids, [parent]);
    assert.equal(commit.title, title);
  }
  assert.equal(review.notes[0].type, 'DiffNote');
  assert.ok((await replies(api, inline.iid, review.id))[0].body.includes('Added the requested greeting regression test.'));
  assert.equal((await gitlab.getMr(api, external.iid)).sha, external.sha);
  assert.deepEqual((await replies(api, external.iid, question.id)).map(n => n.body.trim()), ['Inspected the external contribution.\n\n' +
    '> 💡 已接管此 MR · 发 `/plan` 可先审方案 · 发 `/help` 查看指令 · 移出 Assignee 即可交回人工']);
  for (const dir of cluster.sandboxes) assert.deepEqual(await readdir(dir), []);
  console.log('C-2 passed: five overlapping SDK turns, five isolated transcripts, two empty sandbox roots.');

  await steer(true);
  const duplicate = 'Please inspect this contribution';
  const { receipt, value: thread } = await cluster.pinned('a', e => e.object_attributes?.note === duplicate, () => discuss(duplicate));
  assert.equal(await cluster.post(receipt.body, 'b', receipt.uuid), 202);
  worker = await h.mrState(api, mr.iid, 'IDLE', worker.last_message_seq);
  assert.equal((await records(worker.id, 'session_inbox')).filter(r => r.discussion_id === thread.id).length, 1);
  assert.equal((await replies(api, mr.iid, thread.id)).length, 1);

  // Hold the selected row until both actual MySQL UPDATEs are waiting. This forces both Pods
  // to act on the same pre-update snapshot irrespective of network or scheduler timing.
  async function contend(table: 'issue_sessions' | 'approval_requests', id: string, act: () => Promise<unknown>) {
    const cx = await h.db.getConnection();
    try {
      await cx.beginTransaction();
      await cx.execute('SELECT id FROM ' + table + ' WHERE id=? FOR UPDATE', [id]);
      await act();
      await until('both Pods waiting on ' + table + ' CAS', async () => {
        const processes = await rows('SHOW FULL PROCESSLIST');
        return processes.filter(p => p.Info?.startsWith('UPDATE ' + table + ' SET') && p.Info.includes(id)).length === 2;
      });
      await cx.commit();
    } finally { await cx.rollback(); cx.release(); }
  }
  const race = await openPlan();
  const card = await h.pendingCard(race, 'Plan', ['Cluster plan ready.']);
  const original = await h.state(race, 'WAITING_PLAN');
  await contend('approval_requests', card.id, () => Promise.all((['thumbsup', 'thumbsdown'] as const).map((name, i) =>
    cluster.pinned(i ? 'b' : 'a', e => e.object_attributes?.name === name,
      () => gitlab.awardIssueEmoji(hub, race, card.gitlab_note_id, i ? 'sre' : 'dev', name)))));
  const decision = await until('one committed decision', async () =>
    (await rows("SELECT * FROM approval_requests WHERE id=? AND status<>'PENDING'", [card.id]))[0]);
  const approved = decision.status === 'APPROVED';
  assert.deepEqual([decision.status, decision.decided_by], approved ? ['APPROVED', gitlab.devUsername] : ['REJECTED', gitlab.sreUsername]);
  await h.state(race, approved ? 'IDLE' : 'WAITING_PLAN', original.last_message_seq);
  const outcomes = (await gitlab.listIssueNotes(hub, race)).filter(n => /Cluster plan executed|Revised cluster plan/.test(n.body));
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0].body.includes(approved ? 'Cluster plan executed' : 'Revised cluster plan'));
  console.log('C-3 passed: live status, coalesced reviews, one approval winner and one replay execution.');

  await cluster.stop();
  const event = randomUUID();
  await h.db.execute("UPDATE issue_sessions SET status='CODING', locked_by_pod='lost/1', lock_expires_at=NOW(3)-INTERVAL 1 MINUTE, recovery_attempts=0 WHERE id=?", [worker.id]);
  await h.db.execute("INSERT INTO session_inbox(session_id,event_id,source_kind,sender_username,content,status) VALUES(?,?,'note',?,'Resume the interrupted review.','PENDING')",
    [worker.id, event, gitlab.devUsername]);
  let winner: RowDataPacket | undefined;
  anthropic.beforeNextTool('detent_get_mr_diff', async () => {
    [winner] = await rows('SELECT locked_by_pod,recovery_attempts FROM issue_sessions WHERE id=?', [worker.id]);
    assert.match(winner.locked_by_pod, /^detent-pod-[ab]\//);
    assert.equal(winner.recovery_attempts, 1);
  });
  await cluster.start({ WATCHDOG_INTERVAL_MS: '15000' });
  await contend('issue_sessions', worker.id, async () => {});
  const recovered = await h.mrState(api, mr.iid, 'IDLE', worker.last_message_seq);
  assert.ok(winner);
  assert.equal(recovered.recovery_attempts, 0);
  assert.deepEqual((await records(worker.id, 'session_inbox')).filter(r => r.event_id === event).map(r => r.status), ['CONSUMED']);
  assert.equal((await gitlab.listMrNotes(api, mr.iid)).filter(n => n.body.includes('Recovered the interrupted review.')).length, 1);
  console.log('C-4 passed: both watchdog CAS updates contended and ' + winner.locked_by_pod.split('/')[0] + ' recovered once.');
}
