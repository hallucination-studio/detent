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
const playbook = 'deploy/nginx-reload.yml';
const inspect = { asset_ids: ['web01'], command: 'systemctl status nginx' };

interface Repos { webRepo: string; apiRepo: string; ansibleRepo: string }

function next(body: Messages, { webRepo, apiRepo, ansibleRepo }: Repos): Text | Use {
  // The CLI also sends small auxiliary requests without the workspace tools.
  if (!body.tools?.length) return text('Delivery request');
  const blocks = body.messages.flatMap(m => typeof m.content === 'string' ? [text(m.content)] : m.content);
  const prefix = 'mcp__detent__';
  const toolName = (name: string) => ['Write', 'Bash'].includes(name) ? name : prefix + name;
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
  const system = contents(body.system ?? '');
  const issue = /Issue #(\d+)\b/.exec(system);
  assert.ok(issue, 'Missing Hub Issue number in the SDK system prompt');
  const merges = blocks.filter((b): b is Text => b.type === 'text' && /合并提交 SHA：[a-f0-9]{40}/.test(b.text));
  const lastMerge = merges.at(-1);
  const turn = lastMerge ? blocks.slice(blocks.indexOf(lastMerge)) : blocks;

  function closeIssue(summary: string, report: string, expectDenied = false) {
    const closed = result('detent_close_issue', turn);
    if (!closed) return use('detent_close_issue', { summary });
    if (expectDenied) {
      assert.equal(closed.is_error, true);
      assert.match(contents(closed.content), /未合并/);
    } else {
      assert.equal(JSON.parse(success(closed)).scheduled, true);
    }
    return text(report);
  }

  const hotfix = system.includes('workflows/hotfix.md');
  if (hotfix || system.includes('workflows/release.md')) {
    const marker = hotfix ? 'CUSTOM_HOTFIX_WORKFLOW: hotfix-' : 'CUSTOM_RELEASE_TAG_PREFIX: rel-';
    assert.ok(system.includes(marker), 'Missing live Hub SOP in the SDK system prompt');
    const tag = hotfix ? 'hotfix-1.0.1' : 'rel-1.0.0';
    const prompt = blocks.find((b): b is Text => b.type === 'text' && b.text.includes(webRepo) && /\b[a-f0-9]{40}\b/.test(b.text));
    const sha = prompt?.text.match(/\b[a-f0-9]{40}\b/)?.[0];
    assert.ok(sha, 'Missing target commit in the Issue prompt');
    const tags = result('detent_list_tags');
    if (!tags) return use('detent_list_tags', { project: webRepo });
    const existing = JSON.parse(success(tags));
    assert.ok(Array.isArray(existing));
    for (const entry of existing) {
      assert.match(entry.commitSha, /^[a-f0-9]{40}$/);
      assert.notEqual(entry.name, tag);
    }
    if (approved < 0) return text('Publish ' + tag + ' for ' + webRepo + ' at ' + sha + ' after approval.');
    const release = result('detent_create_release');
    if (!release) return use('detent_create_release', { project: webRepo, tag_name: tag, commit_sha: sha, tag_only: hotfix,
      release_name: 'Release ' + tag, release_notes: 'Live customized release workflow verified.' });
    const published = JSON.parse(success(release));
    assert.equal(published.tagName, tag);
    assert.equal(published.commitSha, sha);
    assert.equal(published.mode, hotfix ? 'tag' : 'release');
    if (hotfix) return closeIssue('Hotfix tag hotfix-1.0.1 created; requesting closure approval.', 'Hotfix tag approved and verified.');
    assert.ok(published.releaseUrl.endsWith('/' + webRepo + '/-/releases/' + tag));
    return closeIssue('Release rel-1.0.0 published.', 'Release rel-1.0.0 published for ' + webRepo + '.');
  }

  // Replay each repository's tool sequence by matching SDK calls and results in the restored transcript.
  function deliverFile(project: string, branch: string, file: string, content: string, title: string, history: Block[]) {
    const checkout = result('detent_checkout_worktree', history);
    if (!checkout) return use('detent_checkout_worktree', { project, branch_name: branch });
    const directory: string = JSON.parse(success(checkout));
    assert.ok(directory.startsWith(project.split('/').at(-1) + '__'));
    if (project === webRepo && system.includes('workflows/code-delivery.md')) {
      const dir = 'projects/' + directory;
      let shellHistory = history.slice(history.indexOf(checkout) + 1);
      for (const command of ['pwd; ls -la', 'git -C ' + dir + ' status && git -C ' + dir + ' branch --show-current']) {
        const shell = result('Bash', shellHistory);
        if (!shell) return use('Bash', { command, description: 'Inspect the checked-out workspace' });
        assert.ok(success(shell).includes(command.startsWith('pwd') ? 'projects' : branch));
        shellHistory = shellHistory.slice(shellHistory.indexOf(shell) + 1);
      }
    }
    const write = result('Write', history);
    if (!write) {
      const context = system + '\n' + blocks.filter((b): b is Text => b.type === 'text').map(b => b.text).join('\n');
      const cwd = /Working directory: ([^\n]+\/workspace)\s*\n/.exec(context)?.[1];
      assert.ok(cwd, 'Missing workspace in the SDK prompt');
      return use('Write', { file_path: join(cwd, 'projects', directory, file), content });
    }
    assert.ok(success(write).includes(file.split('/').at(-1)!));
    const pushed = result('detent_commit_and_push', history);
    if (!pushed) return use('detent_commit_and_push', { directory_name: directory, commit_message: title });
    const sha: string = JSON.parse(success(pushed));
    assert.match(sha, /^[a-f0-9]{40}$/);
    const mr = result('detent_create_mr', history);
    if (!mr) return use('detent_create_mr', { project, source_branch: branch, target_branch: 'main', title });
    const { targetProjectId, mrIid, mrWebUrl } = JSON.parse(success(mr));
    return { sha, targetProjectId, mrIid, mrWebUrl, after: history.slice(history.indexOf(mr) + 1) };
  }

  if (system.includes('workflows/code-delivery.md')) {
    for (const project of [webRepo, apiRepo])
      assert.ok(blocks.some(b => b.type === 'text' && b.text.includes(project)), 'Missing repository in Issue prompt: ' + project);
    if (approved < 0) return text('Add hello.txt in ' + webRepo + ' and ' + apiRepo + ', then review both MRs.');
    if (merges.length === 2) return closeIssue('Both cross-repo MRs merged and verified.', 'Both cross-repo changes are delivered.');
    if (lastMerge) return closeIssue('Check remaining MR.', 'Waiting for the remaining MR to merge.', true);
    const urls: string[] = [];
    let history = blocks.slice(approved);
    for (const project of [webRepo, apiRepo]) {
      const step = deliverFile(project, 'feat/issue-' + issue[1], 'hello.txt', 'Hello from ' + project + '!\n', 'Add hello.txt', history);
      if ('type' in step) return step;
      urls.push(step.mrWebUrl);
      history = step.after;
    }
    return closeIssue('Check cross-repo delivery.', 'Please review and merge both MRs: ' + urls.join(' '), true);
  }

  const audit = system.includes('workflows/audit.md');
  assert.ok(audit || system.includes('workflows/env-change.md'), 'Missing JumpServer SOP');
  if (approved < 0 && !lastMerge) {
    const assets = result('jms_list_assets');
    if (!assets) return use('jms_list_assets', {});
    assert.match(success(assets), /web01/);
    const status = result('jms_readonly_inspect');
    if (!status) return use('jms_readonly_inspect', audit ? { ...inspect, command: 'ss -lntp' } : inspect);
    assert.match(success(status), /nginx active/);
    if (audit) return closeIssue('Readonly audit complete; nginx active on web01.', 'Diagnostic report: nginx is active on web01.');
    return text(plan);
  }

  assert.ok(blocks.some(b => b.type === 'text' && b.text.includes(plan)), 'Missing restored plan');
  const step = deliverFile(ansibleRepo, 'change/issue-' + issue[1], playbook,
    '- hosts: all\n  tasks:\n    - name: Reload nginx\n      ansible.builtin.service: { name: nginx, state: reloaded }\n',
    'Reload nginx', blocks);
  if ('type' in step) return step;
  const { targetProjectId, mrIid, sha } = step;
  const job = { target_project_id: targetProjectId, mr_iid: mrIid, commit_sha: sha, playbook_path: playbook,
    asset_ids: ['web01'], extra_vars: { service: 'nginx' } };
  const denied = result('jms_run_ansible_job');
  if (!denied) return use('jms_run_ansible_job', job);
  assert.equal(denied.is_error, true);
  assert.match(contents(denied.content), /尚未合并/);
  if (!lastMerge) return closeIssue('Check nginx change.', review, true);

  assert.ok(blocks.some(b => b.type === 'text' && b.text.includes(review)), 'Missing restored MR discussion');
  const mergeSha = /合并提交 SHA：([a-f0-9]{40})/.exec(lastMerge.text)![1];
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
  return closeIssue('Nginx reload verified on web01.', 'Reload verified on web01. The approved job succeeded and nginx is active.');
}

function respond(body: Messages, repos: Repos) {
  const block = next(body, repos);
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

export function createOfflineAnthropic(repos: Repos) {
  let requests = 0;
  return {
    async handle(req: Request) {
      requests++;
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 });
      return respond(await req.json(), repos);
    },
    getRequests: () => requests,
  };
}
