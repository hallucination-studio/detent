import assert from 'node:assert/strict';
import type { offlineJumpServer } from '../offline-jumpserver.js';
import type { Harness } from './harness.js';

type MatrixHarness = Pick<Harness, 'gitlab' | 'hub' | 'openIssue' | 'state' | 'records' | 'checkSecrets' | 'jev' | 'until' | 'anthropic'>;
const hardDenials = ['rm -rf /', 'systemctl restart kafka', 'cat /etc/shadow', 'uptime; id', 'date > out', 'ss -K'];

// Each comment drives the real SDK to issue these calls. Assertions use separate
// HTTP, Jev, Pod, GitLab and database observations.
export const matrixTurns: Record<string, { asset_ids: string[]; commands: string[] }[]> = {
  'Batch inspect': [{ asset_ids: ['web01', 'web02'], commands: ['hostname'] }],
  'Group inspect': [{ asset_ids: ['web01', 'web02'], commands: ['date'] }],
  'Empty accounts': [{ asset_ids: ['web01', 'web03'], commands: ['uptime'] }],
  'Hard denials': hardDenials.map(command => ({ asset_ids: ['web01'], commands: [command] })),
  'Jev denials': ['hostname -s', 'date -u'].map(command => ({ asset_ids: ['web01'], commands: [command] })),
  'Blocked host': [{ asset_ids: ['web01'], commands: ['uptime'] }],
  'Check clock': [{ asset_ids: ['web01'], commands: ['date'] }],
  'Upstream errors': [400, 403, 500].map(() => ({ asset_ids: ['web01'], commands: ['uptime'] })),
};

export async function runJumpServerMatrix(h: MatrixHarness, jms: ReturnType<typeof offlineJumpServer>,
  baseUrl: string, template: string, stderr: string[]) {
  const { gitlab, hub, jev } = h;
  const api = baseUrl + '/api/v1/ops/jobs/';
  for (const fields of [{}, { is_periodic: true, interval: 1 }, { is_periodic: 'false', crontab: '* * * * *' }]) {
    const res = await fetch(api, { method: 'POST', headers: { Authorization: 'Bearer ' + jms.readonly, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'adhoc', ...fields }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { is_periodic: ['Require interval or crontab setting'] });
  }
  const original = await gitlab.getFile(hub, 'capabilities.json');
  const doc = JSON.parse(template);
  const settings = doc.jumpserver;
  settings.base_url = baseUrl;
  const publish = () => gitlab.upsertFile(hub, 'capabilities.json', JSON.stringify(doc), 'Update live inspection policy');
  settings.default_account = 'root';
  try {
    await publish();
    let index = jms.runAs.length;
    const beforeDiagnostics = jev.requests.length;
    const iid = await h.openIssue('JumpServer contract', 'Batch inspect', 'delivery::audit');
    let session = await h.state(iid, 'IDLE', 0);
    const notes = () => gitlab.listIssueNotes(hub, iid);
    async function turn(prompt: string) {
      const old = new Set((await notes()).map(n => n.id));
      await gitlab.postNote(hub, iid, prompt);
      session = await h.state(iid, 'IDLE', session.last_message_seq);
      const note = (await notes()).find(n => !old.has(n.id) && n.body.includes('🔍 工具调用轨迹'));
      assert.ok(note, 'Missing tool trace for ' + prompt);
      return note.body;
    }
    assert.deepEqual(jms.runAs.slice(index), [{ assets: ['web01', 'web02'], account: 'root', principal: 'shared', command: 'hostname' }]);
    index = jms.runAs.length;
    settings.default_account = '';
    await publish();
    const grouped = await turn('Group inspect');
    assert.deepEqual(jms.runAs.slice(index).map(r => [r.assets, r.account]), [[['web01'], 'ops-first'], [['web02'], 'ops-second']]);
    assert.deepEqual(jev.requests.slice(beforeDiagnostics), ['hostname', 'date']);
    assert.match(grouped, /ops-first[\s\S]*ops-second/);
    assert.doesNotMatch(grouped, /\u0000|\\u0000/);
    assert.ok(jms.paths.some(p => p.includes('ansible/job-execution/') && p.endsWith('/log/')));
    const beforeEmpty = jms.paths.length;
    assert.match(await turn('Empty accounts'), /资产 web03 在 JumpServer 中未给当前 API Key 授权任何登录账号/);
    assert.ok(jms.paths.slice(beforeEmpty).every(p => p.startsWith('GET ')));
    const calls = jms.getCalls(), decisions = jev.requests.length;
    const denied = await turn('Hard denials');
    assert.equal(denied.split('<details>').at(-1)!.match(/硬性安全限制/g)?.length, hardDenials.length);
    assert.equal(jms.getCalls(), calls);
    assert.equal(jev.requests.length, decisions);
    const semantic = await turn('Jev denials');
    for (const metric of ['choice=state_mutating, noul=0.79, impact=0.76', 'choice=pure_readonly, noul=0.79, impact=1.4'])
      assert.ok(semantic.includes(metric));
    assert.equal(jms.getCalls(), calls);
    assert.deepEqual(jev.requests.slice(decisions), ['hostname -s', 'date -u']);
    settings.blocked_assets = ['web01'];
    settings.inspect_allow_prefixes.push('date');
    await publish();
    assert.match(await turn('Blocked host'), /黑名单/);
    assert.equal(jms.getCalls(), calls);
    settings.enabled = false;
    await publish();
    const requests = h.anthropic.getRequests();
    await gitlab.postNote(hub, iid, 'Check disabled inspection');
    await h.until('disabled capability note', async () => (await notes()).some(n => n.body.includes('Hub capabilities.json 已禁用此能力')));
    assert.equal(h.anthropic.getRequests(), requests);
    assert.equal(jms.getCalls(), calls);
    settings.enabled = true;
    settings.blocked_assets = [];
    await publish();
    jms.slowShell(true);
    try {
      const started = performance.now();
      const clock = await turn('Check clock');
      assert.ok(performance.now() - started >= 30_000);
      assert.match(clock, /nginx active/);
    } finally { jms.slowShell(false); }
    assert.equal(jms.runAs.at(-1)?.command, 'date');
    assert.equal(jev.requests.length, decisions + 2);

    const startLog = stderr.length;
    jms.jobErrors.push(400, 403, 500);
    const trace = (await turn('Upstream errors')).split('<details>').at(-1)!;
    const history = await h.records(session.id, 'session_messages');
    for (const status of [400, 403, 500]) {
      const raw = JSON.stringify({ detail: 'fixture ' + status + ' credential ***' });
      assert.ok(stderr.slice(startLog).some(line => line.includes('POST ops/jobs/ ' + status + ' ' + raw)));
      assert.ok(trace.includes('JumpServer HTTP ' + status + ': ' + raw));
      assert.ok(history.some(row => row.raw_json_line.includes('JumpServer HTTP ' + status)));
    }
    h.checkSecrets(stderr);
    h.checkSecrets(await notes());
    h.checkSecrets(history);
    console.log('J-1/J-2/J-3/J-4/J-5/J-6/J-7/J-9/J-10 inspection contracts, denials, redaction and live policy checks passed.');
  } finally {
    await gitlab.upsertFile(hub, 'capabilities.json', original, 'Restore inspection policy');
  }
}

export async function verifyFailedPlaybook(h: Pick<Harness, 'hub' | 'gitlab' | 'records' | 'state' | 'pendingCard' | 'openIssue' | 'until'>,
  jms: ReturnType<typeof offlineJumpServer>) {
  const { gitlab, hub } = h;
  const iid = await h.openIssue('Verify failed playbook', '', 'delivery::env-change');
  const plan = await h.pendingCard(iid, 'Plan', ['审批']);
  await gitlab.awardThumbsUp(hub, iid, plan.gitlab_note_id, 'dev');
  const coding = await h.state(iid, 'IDLE');
  const [mr] = await h.records(coding.id, 'session_merge_requests');
  const sha = await gitlab.mergeMergeRequest(mr.target_project_id, mr.mr_iid);
  const mixed = await h.pendingCard(iid, 'jms_job', [sha, 'web01', 'web02']);
  const baseline = jms.paths.length;
  await gitlab.awardThumbsUp(hub, iid, mixed.gitlab_note_id, 'sre');
  const single = await h.until('second production approval', async () => (await h.records(coding.id, 'approval_requests'))
    .find(a => a.id !== mixed.id && a.tool_name === 'jms_job' && a.status === 'PENDING' && a.gitlab_note_id));
  const lookups = jms.paths.slice(baseline);
  assert.deepEqual(lookups, ['GET /api/v1/perms/users/self/assets/web01/accounts/',
    'GET /api/v1/perms/users/self/assets/web02/accounts/', 'GET /api/v1/perms/users/self/assets/web02/']);
  await h.state(iid, 'WAITING_TOOL');
  jms.holdPlaybooks(true);
  await gitlab.awardThumbsUp(hub, iid, single.gitlab_note_id, 'sre');
  const submitted = await h.state(iid, 'IDLE', coding.last_message_seq);
  assert.equal((await h.records(coding.id, 'delivery_executions'))[0].status, 'PENDING');
  jms.holdPlaybooks(false);
  await h.state(iid, 'IDLE', submitted.last_message_seq);
  const audits = await h.records(coding.id, 'delivery_executions');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'FAILED');
  const callbacks = (await h.records(coding.id, 'session_inbox')).filter(r => r.event_id === 'jms-job:' + audits[0].jumpserver_job_id);
  assert.deepEqual(callbacks.map(r => [r.source_kind, r.status]), [['system', 'CONSUMED']]);
  assert.equal(audits[0].approval_id, single.id);
  assert.match(audits[0].output_summary, /service check failed on web02/);
  assert.ok(!audits[0].output_summary.includes('\u0000'));
  assert.ok((await gitlab.listIssueNotes(hub, iid)).some(n => n.body.includes('最新交付执行记录状态为 FAILED')));
  assert.equal((await gitlab.getIssue(hub, iid)).state, 'opened');
  console.log('J-3/J-4 passed: mixed-account playbook refused before upload, failed execution audited and auto-close denied.');
}
