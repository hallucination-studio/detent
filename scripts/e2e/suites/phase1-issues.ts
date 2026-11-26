import assert from 'node:assert/strict';
import { checkSession, type Harness } from './harness.js';

type Issues = Pick<Harness, 'gitlab' | 'admin' | 'hub' | 'openIssue' | 'pendingCard' | 'state' | 'records' |
  'rows' | 'until' | 'observeGet' | 'startPod' | 'stopPod' | 'anthropic' | 'checkSecrets' | 'sandbox'> & { observeWebhook(act: () => Promise<unknown>): Promise<void> };

export async function runIssueScenarios(h: Issues) {
  const { gitlab, hub, state, pendingCard, until, records, anthropic } = h;
  const open = (title: string, label = 'delivery::code') => h.openIssue(title, '', label);
  const post = (iid: number, body: string) => gitlab.postNote(hub, iid, body);
  const notes = (iid: number) => gitlab.listIssueNotes(hub, iid);
  const approval = async (id: string) => (await h.rows('SELECT * FROM approval_requests WHERE id=?', [id]))[0];
  const report = async (iid: number, body: string) => assert.ok((await notes(iid)).some(n => n.body.includes(body)), body);

  const revision = await open('Revise the public API');
  const first = await pendingCard(revision, 'Plan', ['Plan v1']);
  const initial = await state(revision, 'WAITING_PLAN');
  await post(revision, '/reject Keep API signature unchanged');
  const revised = await state(revision, 'WAITING_PLAN', initial.last_message_seq);
  const second = await pendingCard(revision, 'Plan', ['Plan v2 preserves the API signature']);
  assert.notEqual(second.gitlab_note_id, first.gitlab_note_id);
  assert.equal((await approval(first.id)).status, 'REJECTED');
  await h.observeWebhook(() => gitlab.awardThumbsUp(hub, revision, first.gitlab_note_id, 'dev'));
  // Drain the webhook before testing a negative outcome.
  await h.stopPod();
  assert.equal((await state(revision, 'WAITING_PLAN')).last_message_seq, revised.last_message_seq);
  assert.equal((await approval(second.id)).status, 'PENDING');
  await h.startPod('detent-issue-revisions');
  let coding = false;
  anthropic.beforeNextTool('detent_list_projects', async () => {
    const [s] = await h.rows('SELECT * FROM issue_sessions WHERE id=?', [initial.id]);
    assert.ok(s.status === 'CODING' && s.locked_by_pod);
    coding = true;
  });
  await post(revision, '/approve Add inline comments');
  const implemented = await state(revision, 'IDLE', revised.last_message_seq);
  assert.equal(coding, true);
  assert.equal((await approval(second.id)).decision_comment, 'Add inline comments');
  await report(revision, 'Revised implementation complete.');
  await checkSession(h, implemented);

  const clarify = await open('Select service port');
  await pendingCard(clarify, 'Plan', ['Confirm the deployment port']);
  await post(clarify, '/approve');
  const ask = await pendingCard(clarify, 'AskUserQuestion', ['### 💬 需要你的确认', '1. Which service port?']);
  assert.equal(ask.approval_type, 'ASK_USER');
  await post(clarify, '/approve Use port 6380');
  const clarified = await state(clarify, 'IDLE');
  await report(clarify, 'Confirmed port 6380');
  assert.equal((await approval(ask.id)).decision_comment, 'Use port 6380');
  await checkSession(h, clarified);

  const switched = await open('Switch audit to coding', 'delivery::audit');
  const old = await pendingCard(switched, 'AskUserQuestion', ['Which service port?']);
  const [reporter] = await h.admin.json<{ id: number }[]>('/users?username=' + gitlab.reporterUsername);
  await h.observeGet('/projects/' + hub + '/members/all/' + reporter.id,
    () => gitlab.postNote(hub, switched, '/use delivery::code', 'reporter'));
  assert.ok((await gitlab.getIssue(hub, switched)).labels.includes('delivery::audit'));
  assert.equal((await approval(old.id)).status, 'PENDING');
  await post(switched, '/use delivery::code Please open a fix MR');
  await pendingCard(switched, 'Plan', ['Plan to open a fix MR']);
  const rerouted = await state(switched, 'WAITING_PLAN');
  assert.equal(rerouted.permission_mode, 'plan');
  assert.equal((await approval(old.id)).status, 'EXPIRED');
  assert.deepEqual((await gitlab.getIssue(hub, switched)).labels.filter(l => l.startsWith('delivery::')), ['delivery::code']);
  await checkSession(h, rerouted);

  const natural = await open('Approve in context');
  const plan = await pendingCard(natural, 'Plan', ['Check the service defaults']);
  await post(natural, 'LGTM');
  const idle = await state(natural, 'IDLE');
  assert.equal((await approval(plan.id)).status, 'APPROVED');
  await report(natural, 'Plan executed.');
  await post(natural, '可以');
  const followup = await state(natural, 'IDLE', idle.last_message_seq);
  await report(natural, 'Received the ordinary follow-up.');
  assert.ok((await records(idle.id, 'session_inbox')).some(m => m.content === '可以' && m.status === 'CONSUMED'));
  assert.equal((await records(idle.id, 'approval_requests')).length, 1);
  await checkSession(h, followup);

  const interrupt = await open('Interrupt maintenance');
  await pendingCard(interrupt, 'Plan', ['Maintenance plan ready']);
  const original = await state(interrupt, 'WAITING_PLAN');
  let interrupted = false;
  anthropic.beforeNextTool('detent_list_projects', async () => {
    const [active] = await h.rows('SELECT * FROM issue_sessions WHERE id=?', [original.id]);
    assert.ok(active.status === 'CODING' && active.locked_by_pod);
    await post(interrupt, '/abort');
    await until('abort delivered to active turn', async () => {
      const [s] = await h.rows('SELECT * FROM issue_sessions WHERE id=?', [original.id]);
      return s.stop_requested || s.status === 'IDLE';
    });
    interrupted = true;
  });
  await post(interrupt, '/approve');
  await state(interrupt, 'IDLE');
  await until('abort observed by model fixture', () => interrupted);
  await report(interrupt, '本轮已中止');
  // Finish any retry of the interrupt before sending a new command.
  await h.stopPod();
  await h.startPod('detent-issue-reset');
  const oldRows = await records(original.id, 'session_messages');
  assert.ok(oldRows.length);
  await post(interrupt, '/reset Fresh start');
  const reset = await state(interrupt, 'WAITING_PLAN');
  assert.notEqual(reset.claude_session_id, original.claude_session_id);
  const fresh = await records(reset.id, 'session_messages');
  assert.equal(fresh.length, reset.last_message_seq);
  assert.ok(fresh.length && fresh.every(r => !oldRows.some(o => o.id === r.id)));
  await pendingCard(interrupt, 'Plan', ['Fresh maintenance plan']);
  const trees = await records(reset.id, 'session_worktrees');
  assert.ok(trees.length && trees.every(t => t.status === 'ACTIVE'));
  assert.equal((await gitlab.setIssueState(hub, interrupt, 'close')).state, 'closed');
  await state(interrupt, 'DONE');
  assert.ok((await gitlab.getIssue(hub, interrupt)).labels.includes('claude::done'));
  assert.ok((await records(reset.id, 'session_worktrees')).every(t => t.status === 'ARCHIVED'));
  assert.equal((await gitlab.setIssueState(hub, interrupt, 'reopen')).state, 'opened');
  const reopened = await state(interrupt, 'WAITING_PLAN', reset.last_message_seq);
  assert.equal(reopened.claude_session_id, reset.claude_session_id);
  await pendingCard(interrupt, 'Plan', ['Fresh maintenance plan']);
  assert.ok(!(await gitlab.getIssue(hub, interrupt)).labels.includes('claude::done'));
  await checkSession(h, reopened);
  console.log('Verified I-7 through I-11, including an interrupted SDK turn and manual close/reopen.');
}
