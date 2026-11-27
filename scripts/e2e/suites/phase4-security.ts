import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { offlineJumpServer } from '../offline-jumpserver.js';
import type { Cluster } from './cluster.js';
import type { Harness } from './harness.js';

export async function runSecurity(h: Harness, cluster: Cluster, web: number, ansible: number,
  jms: ReturnType<typeof offlineJumpServer>, securityReport: string, trackIssue: (iid: number) => void) {
  const { gitlab, hub, api, admin, bot, until, records, rows, anthropic } = h;
  const requests = anthropic.getRequests;
  const synthetic = gitlab.synthetic!;
  const notes = (iid: number) => gitlab.listIssueNotes(hub, iid);
  const gate = await h.openIssue('Cluster plan decision', '', 'delivery::code');
  const card = await h.pendingCard(gate, 'Plan', ['Cluster plan ready']);
  const issue = await h.state(gate, 'WAITING_PLAN');
  const mr = h.trackMr(await gitlab.openExternalMr(api, 'security-trace', 'Verify trace redaction'));
  await gitlab.assignMr(api, mr.iid, bot.id);
  const worker = await h.mrState(api, mr.iid, 'IDLE', 0);
  const snapshot = async () => Promise.all([
    gitlab.getIssue(hub, gate), gitlab.getMr(api, mr.iid),
    rows('SELECT * FROM issue_sessions WHERE id IN (?,?) ORDER BY id', [issue.id, worker.id]),
    ...[issue.id, worker.id].flatMap(id => ['approval_requests', 'session_messages', 'session_inbox',
      'session_worktrees', 'session_merge_requests', 'delivery_executions'].map(table => records(id, table))),
  ]);
  const original = await snapshot();
  const before = requests();
  for (const token of [null, 'incorrect-token'])
    assert.equal(await cluster.post(JSON.stringify({ object_kind: 'build', build_status: 'failed' }), 'a', randomUUID(), token), 401);
  const [reporter] = await admin.json<{ id: number }[]>('/users?username=' + gitlab.reporterUsername);
  for (const command of ['/abort', '/reset', '/use audit'])
    await h.observeGet('/projects/' + hub + '/members/all/' + reporter.id, () => gitlab.postNote(hub, gate, command, 'reporter'));
  for (const command of ['@' + bot.username + ' Please inspect this contribution', '/plan Refactor config loader'])
    await h.observeGet('/projects/' + api + '/members/all/' + reporter.id, () => gitlab.openDiscussion(api, mr.iid, command, undefined, 'reporter'));
  const outsider = { id: 99999, username: 'non-member' };
  assert.equal(await admin.lookup('/projects/' + hub + '/members/all/' + outsider.id), null);
  assert.equal(await admin.lookup('/projects/' + api + '/members/all/' + outsider.id), null);
  for (const [i, note] of ['/abort', '/reset', '/use audit', '@' + bot.username + ' Please inspect this contribution', '/plan Refactor config loader'].entries()) {
    const isIssue = i < 3;
    const event = { object_kind: 'note', user: outsider, project: { id: isIssue ? hub : api },
      ...(isIssue ? { issue: { iid: gate } } : { merge_request: mr }), object_attributes: {
        action: 'create', noteable_type: isIssue ? 'Issue' : 'MergeRequest', note, id: 100000 + i,
      } };
    assert.equal(await cluster.post(JSON.stringify(event), 'b'), 202);
  }
  await cluster.stop();
  assert.deepEqual(await snapshot(), original);
  assert.equal(requests(), before);
  assert.equal((await rows('SELECT status FROM approval_requests WHERE id=?', [card.id]))[0].status, 'PENDING');
  console.log('S-1 passed: both invalid tokens returned 401 and both unauthorized roles left state and branches intact.');
  await cluster.start();

  synthetic.checkNoteWrites(bot.id, body => {
    assert.doesNotMatch(body, /^\s*\/(?:close|merge|label)\b/m);
    h.checkSecrets(body);
  });
  const redaction = await h.openIssue('Verify note redaction', '', 'delivery::code');
  const safe = ['\\/close', '\\/merge', '\\/label ~claude::done', 'https://oauth2:***@127.0.0.1/repo.git', '***', '***', '***'].join('\n');
  const redactedCard = await h.pendingCard(redaction, 'Plan', [safe]);
  const redactedIssue = await h.state(redaction, 'WAITING_PLAN');
  await synthetic.failPipeline(api, mr.iid, bot.id, undefined, 'Missing ci/ready.txt: expected ready\n' + securityReport);
  const traced = await h.mrState(api, mr.iid, 'IDLE', worker.last_message_seq);
  const reports = [...await notes(redaction), ...(await gitlab.listMrDiscussions(api, mr.iid)).flatMap(t => t.notes)];
  assert.ok(reports.find(n => n.id === redactedCard.gitlab_note_id)?.body.includes(safe));
  assert.ok((await gitlab.listMrNotes(api, mr.iid)).some(n => n.body.includes(safe)));
  for (const note of reports) {
    assert.doesNotMatch(note.body, /^\s*\/(?:close|merge|label)\b/m);
    h.checkSecrets(note.body);
  }
  for (const s of [redactedIssue, traced]) {
    const history = await records(s.id, 'session_messages');
    assert.ok(history.some(r => r.raw_json_line.includes('oauth2:***@127.0.0.1')));
    h.checkSecrets(history);
    h.checkSecrets(await records(s.id, 'delivery_executions'));
  }
  assert.equal((await gitlab.getIssue(hub, redaction)).state, 'opened');
  assert.ok(!(await gitlab.getIssue(hub, redaction)).labels.includes('claude::done'));
  assert.equal((await gitlab.getMr(api, mr.iid)).state, 'opened');
  console.log('Stage 15 branch 8 passed: sandbox write refused, vault excluded from SDK child env and scrubbed from notes, tool traces and MySQL.');
  console.log('S-2 passed: model output and job trace were redacted in GitLab and the persisted SDK transcripts.');

  const policy = await gitlab.getFile(hub, 'events.json');
  const setRules = (rules: object[]) => gitlab.upsertFile(hub, 'events.json', JSON.stringify({ version: 1, rules }), 'Exercise event policy');
  try {
    await setRules([{ event: 'pipeline', status: 'failed', action: 'notify', notifyTarget: 'resource' }]);
    const change = await h.openIssue('Verify production guards', '', 'delivery::env-change');
    const plan = await h.pendingCard(change, 'Plan', ['reviewed playbook']);
    await gitlab.awardThumbsUp(hub, change, plan.gitlab_note_id, 'dev');
    const reviewing = await h.state(change, 'IDLE');
    const [link] = await records(reviewing.id, 'session_merge_requests');
    assert.equal(link.target_project_id, ansible);
    const failed = await synthetic.failPipeline(ansible, link.mr_iid, bot.id);
    await until('failed pipeline on reviewed MR', async () => (await records(reviewing.id, 'session_merge_requests'))
      .some(r => r.id === link.id && r.latest_pipeline_status === 'failed' && r.latest_pipeline_id === failed));
    const calls = jms.getCalls();
    const sha = await gitlab.mergeMergeRequest(ansible, link.mr_iid);
    const denied = await h.state(change, 'IDLE', reviewing.last_message_seq);
    assert.equal((await records(denied.id, 'session_merge_requests'))[0].merge_commit_sha, sha);
    assert.equal(jms.getCalls(), calls);
    assert.deepEqual((await records(denied.id, 'approval_requests')).map(r => r.id), [plan.id]);
    assert.deepEqual(await records(denied.id, 'delivery_executions'), []);
    assert.ok((await notes(change)).some(n => n.body.includes('All three production requests denied.')));

    const tag = 'rel-1.0.0';
    const existing = await gitlab.getTagCommit(web, tag);
    assert.ok(existing);
    const release = await h.openIssue('Verify release guard', 'Publish ' + gitlab.targetProjects.web + ' at ' + existing, 'delivery::release');
    const releasePlan = await h.pendingCard(release, 'Plan', ['existing release tag']);
    await gitlab.awardThumbsUp(hub, release, releasePlan.gitlab_note_id, 'dev');
    const refused = await h.state(release, 'IDLE');
    assert.deepEqual((await records(refused.id, 'approval_requests')).map(r => r.id), [releasePlan.id]);
    assert.ok((await notes(release)).some(n => n.body.includes('Existing tag preserved.')));
    assert.equal(await gitlab.getTagCommit(web, tag), existing);
    console.log('S-3 passed: three production guard denials and the existing-tag denial issued zero tool approvals.');

    const count = requests();
    const label = 'e2e::tag';
    await gitlab.ensureLabel(hub, label);
    await setRules([{ event: 'build', status: 'failed', action: 'notify', notifyTarget: 'commit' },
      { event: 'tag_push', action: 'notify', notifyTarget: 'hub_issue', hubIssueLabel: label }]);
    const project = { id: web, path_with_namespace: gitlab.targetProjects.web };
    const head = await gitlab.headSha(web);
    const statuses = await Promise.all([
      cluster.post(JSON.stringify({ object_kind: 'build', project, sha: head, build_status: 'failed',
        build_name: 'verify offline-jev-key', user: bot }), 'a'),
      cluster.post(JSON.stringify({ object_kind: 'tag_push', project, after: head, ref: 'refs/tags/e2e-alert',
        user_id: reporter.id, user_username: gitlab.reporterUsername }), 'b'),
    ]);
    assert.deepEqual(statuses, [202, 202]);
    const comments = await until('redacted commit comment', async () => {
      const list = await admin.json<{ note: string }[]>('/projects/' + web + '/repository/commits/' + head + '/comments');
      return list.length ? list : undefined;
    });
    assert.deepEqual(comments, [{ note: 'build · failed · ' + project.path_with_namespace + ' · verify ***' }]);
    const alerts = await until('labeled tag alert', async () => {
      const list = await admin.json<{ iid: number; labels: string[]; description: string }[]>('/projects/' + hub + '/issues?search=tag_push');
      return list.length ? list : undefined;
    });
    assert.equal(alerts.length, 1);
    trackIssue(alerts[0].iid);
    assert.ok(alerts[0].labels.includes(label));
    assert.ok(alerts[0].description.includes('tag_push · ' + project.path_with_namespace + ' · e2e-alert'));
    assert.equal(requests(), count);
    console.log('S-4 passed: failed build posted one commit comment and tag push opened one labeled Hub alert.');
  } finally { await gitlab.upsertFile(hub, 'events.json', policy, 'Restore Hub event policy'); }
}
