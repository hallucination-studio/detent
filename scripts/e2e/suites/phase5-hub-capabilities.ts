import assert from 'node:assert/strict';
import type { offlineJumpServer } from '../offline-jumpserver.js';
import type { Harness } from './harness.js';

export async function runHubCapabilities(h: Pick<Harness, 'gitlab' | 'hub' | 'state' | 'records' | 'openIssue' | 'until' | 'anthropic' | 'checkSecrets'>,
  service: ReturnType<typeof offlineJumpServer>, baseUrl: string, template: string) {
  const { gitlab, hub, anthropic } = h;
  const update = (content: string) => gitlab.upsertFile(hub, 'capabilities.json', content, 'Update Hub capabilities');
  const workflow = 'agents/audit/AGENT.md';
  const initial = await gitlab.getFile(hub, workflow);
  const changeAgent = (text: string) => gitlab.upsertFile(hub, workflow, text, 'Configure audit inspection');
  const before = anthropic.getRequests();
  const blocked = await h.openIssue('Stage 15 readiness', '', 'delivery::audit');
  await h.state(blocked, 'IDLE');
  const notes = (iid: number) => gitlab.listIssueNotes(hub, iid);
  async function help() {
    const seen = new Set((await notes(blocked)).map(n => n.id));
    await gitlab.postNote(hub, blocked, '/help');
    const note = await h.until('fresh /help capability status', async () => (await notes(blocked)).find(n => !seen.has(n.id) && n.body.includes('### 可用能力')));
    h.checkSecrets(note);
    return note.body.split('\n').find(line => line.includes('delivery::audit'));
  }
  assert.match((await notes(blocked)).map(n => n.body).join('\n'), /capabilities.json 配置 jumpserver.base_url/);
  assert.match((await help())!, /⚪ 未开通.*capabilities.json.*jumpserver.base_url/);
  await update('{');
  assert.match((await help())!, /⚪ 未开通.*capabilities.json 格式无效/);
  const document = JSON.parse(template);
  document.jumpserver.base_url = baseUrl;
  await update(JSON.stringify(document));
  assert.match((await help())!, /服务端缺少密钥 DETENT_SECRET_JMS_AK_ID、DETENT_SECRET_JMS_AK_SECRET/);
  document.jumpserver.auth = { token: '$secret:JMS_AUDIT_TOKEN' };
  document.jumpserver.default_account = 'ops-hub';
  await update(JSON.stringify(document));
  assert.match((await help())!, /✅ 已就绪/);
  assert.equal(anthropic.getRequests(), before);
  console.log('Stage 15 branches 1–3 passed: empty URL, missing named secrets and live Hub readiness.');

  async function inspect(title: string) {
    const iid = await h.openIssue(title, '', 'delivery::audit');
    const session = await h.state(iid, 'IDLE', 0);
    const written = await notes(iid);
    assert.ok(written.some(n => n.body.includes('Stage 15 inspection checked')));
    h.checkSecrets(written);
    h.checkSecrets(await h.records(session.id, 'session_messages'));
  }
  const baseline = service.runAs.length;
  await inspect('Stage 15 Hub account');
  assert.deepEqual(service.runAs.slice(baseline), [{ assets: ['web01'], principal: 'readonly', account: 'ops-hub', command: 'uptime' }]);
  try {
    await changeAgent(initial.replace('mode: readonly', "mode: readonly\naccount: audit-ro\nallow_prefixes: ['kafka-topics.sh']"));
    await inspect('Stage 15 workflow account');
    assert.deepEqual(service.runAs.slice(baseline + 1), [{ assets: ['web01'], principal: 'readonly', account: 'audit-ro', command: 'kafka-topics.sh --list' }]);
    await changeAgent(initial.replace('mode: readonly', 'mode: readonly\naccount: ghost'));
    await inspect('Stage 15 denied account');
    assert.equal(service.runAs.length, baseline + 2);
    console.log('Stage 15 branches 5–6 passed: Hub/Agent account selection, workflow prefix and unauthorized account denial.');
  } finally {
    await changeAgent(initial);
    await gitlab.removeFile(hub, 'capabilities.json', 'Verify legacy Hub fallback');
  }
}
