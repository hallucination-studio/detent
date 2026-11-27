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
  const beforeHelp = anthropic.getRequests();
  await post(revision, '/help');
  const help = await until('Hub help', async () => (await notes(revision)).find(n => n.body.includes('### 可用能力')));
  for (const field of ['agent::onboarding', 'delivery::release', '✅ 已就绪', '/abort', '/plan']) assert.ok(help.body.includes(field));
  assert.equal(anthropic.getRequests(), beforeHelp);
  assert.deepEqual(await state(revision, 'WAITING_PLAN'), initial);
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
  const ask = await pendingCard(clarify, 'AskUserQuestion', ['### 💬 需要你的确认', '1. Which service port?', '直接回复你的确认内容即可继续']);
  assert.equal(ask.approval_type, 'ASK_USER');
  await post(clarify, 'Use port 6380');
  const clarified = await state(clarify, 'IDLE');
  await report(clarify, 'Confirmed port 6380');
  assert.equal((await approval(ask.id)).decision_comment, 'Use port 6380');
  await checkSession(h, clarified);

  const planning = await open('Check the service defaults', '');
  const diagnostic = await state(planning, 'IDLE', 0);
  assert.deepEqual(await records(diagnostic.id, 'approval_requests'), []);
  await post(planning, '/plan Review a configuration change');
  await pendingCard(planning, 'Plan', ['Review the configuration and test the change']);
  const requested = await state(planning, 'WAITING_PLAN', diagnostic.last_message_seq);
  assert.equal(requested.claude_session_id, diagnostic.claude_session_id);
  await checkSession(h, requested);

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

export async function onboardPayment(h: Harness, groupPath: string, developer: number, webhookUrl: string) {
  const group = await h.admin.json<{ id: number }>('/groups/' + encodeURIComponent(groupPath));
  const project = await h.admin.json<{ id: number; path_with_namespace: string }>('/projects', 'POST', {
    name: 'payment', path: 'payment', namespace_id: group.id, initialize_with_readme: true, default_branch: 'main',
  });
  const path = '/projects/' + project.id;
  await h.admin.request(path + '/members', 'POST', { user_id: developer, access_level: 30 });
  await h.admin.request(path + '/members', 'POST', { user_id: h.bot.id, access_level: 40 });
  const hooks = () => h.admin.json<{ url: string; note_events: boolean; emoji_events: boolean; merge_requests_events: boolean;
    pipeline_events: boolean; deployment_events: boolean }[]>(path + '/hooks');
  assert.deepEqual(await hooks(), []);
  const iid = await h.openIssue('Connect payment repository', project.path_with_namespace, 'agent::onboarding');
  const plan = await h.pendingCard(iid, 'Plan', [project.path_with_namespace]);
  await h.gitlab.awardThumbsUp(h.hub, iid, plan.gitlab_note_id, 'dev');
  const card = await h.pendingCard(iid, 'detent_onboard_project', [project.path_with_namespace, webhookUrl, 'deployment_events']);
  await h.observeGet('/projects/' + h.hub + '/members/all/' + developer,
    () => h.gitlab.awardThumbsUp(h.hub, iid, card.gitlab_note_id, 'dev'));
  assert.equal((await h.rows('SELECT status FROM approval_requests WHERE id=?', [card.id]))[0].status, 'PENDING');
  assert.deepEqual(await hooks(), []);
  await h.gitlab.awardThumbsUp(h.hub, iid, card.gitlab_note_id, 'sre');
  const session = await h.state(iid, 'DONE');
  const installed = await hooks();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].url, webhookUrl);
  for (const key of ['note_events', 'emoji_events', 'merge_requests_events', 'pipeline_events', 'deployment_events'] as const)
    assert.equal(installed[0][key], true);
  assert.equal((await h.gitlab.getIssue(h.hub, iid)).state, 'closed');
  await checkSession(h, session);
  return project.id;
}
