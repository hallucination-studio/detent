import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

type Text = { type: 'text'; text: string };
type Use = { type: 'tool_use'; id: string; name: string; input: object };
type Result = { type: 'tool_result'; tool_use_id: string; content: string | Text[]; is_error?: boolean };
type Block = Text | Use | Result;
interface Messages {
  model: string; stream?: boolean; tools?: { name: string }[];
  system?: string | Text[]; messages: { role: string; content: string | Block[] }[];
}

const text = (value: string): Text => ({ type: 'text', text: value });
const contents = (value: string | Text[]) => typeof value === 'string' ? value : value.map(b => b.text).join('\n');
const plan = 'Inspect web01, review the nginx reload playbook, then verify service health after execution.';
const review = 'Please review and merge the nginx reload MR.';
const branch = 'change/issue-1', project = 'ops/ansible-infra', playbook = 'deploy/nginx-reload.yml';
const inspect = { asset_ids: ['web01'], command: 'systemctl status nginx' };

function next(body: Messages): Text | Use {
  // The CLI also sends small auxiliary requests without the workspace tools.
  if (!body.tools?.length) return text('Nginx reload');
  const blocks = body.messages.flatMap(m => typeof m.content === 'string' ? [text(m.content)] : m.content);
  const prefix = 'mcp__detent__';
  const toolName = (name: string) => name === 'Write' ? name : prefix + name;
  const use = (name: string, input: object): Use => {
    assert.ok(body.tools?.some(t => t.name === toolName(name)), 'SDK did not advertise ' + toolName(name));
    return { type: 'tool_use', id: 'toolu_' + randomUUID(), name: toolName(name), input };
  };
  function result(name: string, history = blocks) {
    const call = history.find((b): b is Use => b.type === 'tool_use' && b.name === toolName(name));
    if (!call) return;
    const r = history.find((b): b is Result => b.type === 'tool_result' && b.tool_use_id === call.id);
    assert.ok(r, 'Missing SDK result for ' + name);
    return r;
  }
  function success(r: Result) {
    const value = contents(r.content);
    assert.ok(!r.is_error, value);
    return value;
  }
  const approved = blocks.findIndex(b => b.type === 'text' && b.text.includes('实施方案已获批准'));
  const merged = blocks.findIndex(b => b.type === 'text' && /合并提交 SHA：[a-f0-9]{40}/.test(b.text));
  if (approved < 0 && merged < 0) {
    const assets = result('jms_list_assets');
    if (!assets) return use('jms_list_assets', {});
    assert.match(success(assets), /web01/);
    const status = result('jms_readonly_inspect');
    if (!status) return use('jms_readonly_inspect', inspect);
    assert.match(success(status), /nginx active/);
    return text(plan);
  }

  // The first pod's assistant response must have survived hydration by the second pod.
  assert.ok(blocks.some(b => b.type === 'text' && b.text.includes(plan)), 'Missing restored plan');
  const checkout = result('detent_checkout_worktree');
  if (!checkout) return use('detent_checkout_worktree', { project, branch_name: branch });
  const directory: string = JSON.parse(success(checkout));
  assert.match(directory, /^ansible-infra__[\w-]+$/);
  const write = result('Write');
  if (!write) {
    const context = contents(body.system ?? '') + '\n' + blocks.filter((b): b is Text => b.type === 'text').map(b => b.text).join('\n');
    const cwd = /Working directory: ([^\n]+\/workspace)\s*\n/.exec(context)?.[1];
    assert.ok(cwd, 'Missing workspace in the SDK prompt');
    return use('Write', { file_path: join(cwd, 'projects', directory, playbook),
      content: '- hosts: all\n  tasks:\n    - name: Reload nginx\n      ansible.builtin.service: { name: nginx, state: reloaded }\n' });
  }
  assert.match(success(write), /nginx-reload\.yml/);
  const pushed = result('detent_commit_and_push');
  if (!pushed) return use('detent_commit_and_push', { directory_name: directory, commit_message: 'Add nginx reload playbook' });
  const sha: string = JSON.parse(success(pushed));
  assert.match(sha, /^[a-f0-9]{40}$/);
  const mr = result('detent_create_mr');
  if (!mr) return use('detent_create_mr', { project, source_branch: branch, target_branch: 'main', title: 'Reload nginx' });
  const { targetProjectId, mrIid } = JSON.parse(success(mr));
  assert.equal(mrIid, 1);
  const job = { target_project_id: targetProjectId, mr_iid: mrIid, commit_sha: sha, playbook_path: playbook,
    asset_ids: ['web01'], extra_vars: { service: 'nginx' } };
  const denied = result('jms_run_ansible_job');
  if (!denied) return use('jms_run_ansible_job', job);
  assert.equal(denied.is_error, true);
  assert.match(contents(denied.content), /尚未合并/);
  if (merged < 0) return text(review);

  assert.ok(blocks.some(b => b.type === 'text' && b.text.includes(review)), 'Missing restored MR discussion');
  const prompt = blocks[merged] as Text;
  const mergeSha = /合并提交 SHA：([a-f0-9]{40})/.exec(prompt.text)![1];
  const turn = blocks.slice(merged);
  const submitted = result('jms_run_ansible_job', turn);
  if (!submitted) return use('jms_run_ansible_job', { ...job, commit_sha: mergeSha });
  const submission = JSON.parse(success(submitted));
  assert.equal(submission.commitSha, mergeSha);
  const outcome = result('jms_get_job_result', turn);
  if (!outcome) return use('jms_get_job_result', { job_id: submission.jobId });
  assert.match(success(outcome), /nginx reloaded/);
  const verified = result('jms_readonly_inspect', turn);
  if (!verified) return use('jms_readonly_inspect', inspect);
  assert.match(success(verified), /nginx active/);
  return text('Reload verified on web01. The approved job succeeded and nginx is active.');
}

export async function offlineAnthropic(req: Request) {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 });
  const body: Messages = await req.json();
  const block = next(body);
  const reason = block.type === 'text' ? 'end_turn' : 'tool_use';
  const usage = { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const msg = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
    content: [block], stop_reason: reason, stop_sequence: null, usage };
  if (!body.stream) return Response.json(msg);

  const start = block.type === 'text' ? text('') : { ...block, input: {} };
  const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } :
    { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
  const events = [
    { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: start },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}
