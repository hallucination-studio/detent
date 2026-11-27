import assert from 'node:assert/strict';
import type { Harness } from './harness.js';
import type { offlineJumpServer } from '../offline-jumpserver.js';

export const kafkaTitle = '帮我看下 dev 环境 kafka 工作的正常吗';
export const kafkaCommands = [
  'ps -ef | grep -i kafka | grep -v grep',
  'ss -lntp',
  '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list',
] as const;

export async function runKafkaSession(h: Pick<Harness, 'gitlab' | 'hub' | 'openIssue' | 'state' | 'pendingCard' | 'records' | 'jev'>,
  service: ReturnType<typeof offlineJumpServer>, project: number) {
  const { gitlab, hub } = h;
  const start = service.runAs.length, decisions = h.jev.requests.length;
  const previousConfig = 'bootstrap.servers=localhost:19092\n';
  const iid = await h.openIssue(kafkaTitle, '', '');
  const audit = await h.state(iid, 'IDLE', 0);
  const notes = () => gitlab.listIssueNotes(hub, iid);
  const report = (await notes()).find(n => n.body.includes('🔍 工具调用轨迹'))?.body ?? '';
  for (const field of ['Read', 'agents/audit/AGENT.md', 'jms_list_assets', 'jms_readonly_inspect', ...kafkaCommands])
    assert.ok(report.includes(field), 'Missing audit trace field ' + field);
  assert.doesNotMatch(report, /\bTask\b|实施方案审批/);
  assert.match(report.split('<details>')[0], /kafka\.Kafka.*9092.*dev-orders/s);
  assert.deepEqual(service.runAs.slice(start).map(r => r.command), kafkaCommands);
  assert.deepEqual(h.jev.requests.slice(decisions), [kafkaCommands[0], kafkaCommands[2]]);
  assert.deepEqual(await h.records(audit.id, 'approval_requests'), []);
  assert.deepEqual((await gitlab.getIssue(hub, iid)).labels, ['claude::idle']);

  await gitlab.postNote(hub, iid, '请修复 ' + gitlab.targetProjects.api + ' 中的 Kafka 配置并开 MR。');
  const card = await h.pendingCard(iid, 'Plan', ['实施方案审批', 'Read', 'agents/code-delivery/AGENT.md', 'detent_submit_plan', 'kafka.properties']);
  assert.deepEqual(await h.records(audit.id, 'session_merge_requests'), []);
  assert.equal(await gitlab.getFile(project, 'kafka.properties'), previousConfig);
  await gitlab.awardThumbsUp(hub, iid, card.gitlab_note_id, 'dev');
  const delivered = await h.state(iid, 'IDLE', audit.last_message_seq);
  assert.equal(delivered.claude_session_id, audit.claude_session_id);
  assert.deepEqual((await gitlab.getIssue(hub, iid)).labels, ['claude::idle']);
  const links = await h.records(audit.id, 'session_merge_requests');
  assert.equal(links.length, 1);
  assert.equal(links[0].target_project_id, project);
  const mr = await gitlab.getMr(project, links[0].mr_iid);
  assert.equal(mr.state, 'opened');
  assert.equal(await gitlab.getFile(project, 'kafka.properties', mr.source_branch), 'bootstrap.servers=localhost:9092\n');
  console.log('Single-Issue unified session passed: audit evidence → IDLE → code-delivery Plan → approved config MR.');
}
