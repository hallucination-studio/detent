import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { imageMirror } from './offline-mcp.js';

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

interface Repos { webRepo: string; apiRepo: string; ansibleRepo: string; securityReport: string }

function next(body: Messages, { webRepo, apiRepo, ansibleRepo, securityReport }: Repos): Text | Use {
  // The CLI also sends small auxiliary requests without the workspace tools.
  if (!body.tools?.length) return text('Delivery request');
  const blocks = body.messages.flatMap(m => typeof m.content === 'string' ? [text(m.content)] : m.content);
  const prefix = 'mcp__detent__';
  const toolName = (name: string) => ['Read', 'Write', 'Bash'].includes(name) ? name : prefix + name;
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
  const sopPath = /^当前(?: Agent|工作流)：(.+)$/m.exec(system)?.[1];
  const issue = /Issue #(\d+)\b/.exec(system);
  const merges = blocks.filter((b): b is Text => b.type === 'text' && /合并提交 SHA：[a-f0-9]{40}/.test(b.text));
  const lastMerge = merges.at(-1);
  const turn = lastMerge ? blocks.slice(blocks.indexOf(lastMerge)) : blocks;

  function workspaceRoot() {
    const context = system + '\n' + blocks.filter((b): b is Text => b.type === 'text').map(b => b.text).join('\n');
    const cwd = /Working directory: ([^\n]+\/workspace)\s*\n/.exec(context)?.[1];
    assert.ok(cwd, 'Missing workspace in the SDK prompt');
    return cwd;
  }

  const mr = /^GitLab MR (\d+)!(\d+) · (.+)$/m.exec(system);
  if (mr) {
    // A resumed session includes old tool calls. Select only the current webhook's prompt and results.
    const trigger = /@[\w-]+: (?:Pipeline #\d+ failed|(?:hello\.txt:1 )?Add a regression test|Please inspect this contribution|请检查新分配的 MR|Check the config defaults|Resume the interrupted review|Anyone free for lunch)|实施方案未获批准|Refactor config loader|实施方案已获批准，请按方案开始实施/;
    const prompt = blocks.filter((b): b is Text => b.type === 'text' && trigger.test(b.text)).at(-1);
    assert.ok(prompt, 'Missing MR event in SDK prompt');
    const event = prompt.text;
    const history = blocks.slice(blocks.indexOf(prompt));
    const current = (name: string) => result(name, history);
    if (mr[3] === 'Verify shared steering' && event.includes('Check the config defaults')) {
      const diff = current('detent_get_mr_diff');
      if (!diff) return use('detent_get_mr_diff', {});
      success(diff);
      const receipts = JSON.stringify(history.slice(history.indexOf(diff))).match(/receipt-[a-f0-9-]+/g);
      assert.ok(receipts?.length, 'Active SDK turn did not receive the inbox context');
      return text('Applied ' + [...new Set(receipts)].sort().join(' '));
    }
    if (event.includes('Anyone free for lunch')) {
      assert.match(system, /casual teammate discussion acknowledge briefly/);
      return text('Enjoy lunch!');
    }
    if (event.includes('实施方案未获批准')) {
      assert.match(event, /Preserve existing defaults/);
      assert.match(system, /当前为方案阶段/);
      return text('Revised loader plan preserves existing defaults.');
    }
    if (event.includes('Please inspect this contribution')) return text('Inspected the external contribution.');

    const directory = /^Active worktree: projects\/(.+)$/m.exec(system)?.[1];
    assert.ok(directory);
    let file: string, content: string, report: string;
    if (system.includes('Read-only fork.')) {
      assert.ok(!body.tools.some(t => t.name === 'Write' || t.name === 'Edit'));
      const diff = current('detent_get_mr_diff');
      if (!diff) return use('detent_get_mr_diff', {});
      assert.match(success(diff), /timeout=0/);
      return text('Suggested fix in config.ini: set timeout=30 to bound stalled requests.');
    }
    if (event.includes('Resume the interrupted review')) {
      const diff = current('detent_get_mr_diff');
      if (!diff) return use('detent_get_mr_diff', {});
      success(diff);
      return text('Recovered the interrupted review.');
    }
    if (event.includes('Check the config defaults')) {
      const threads = current('detent_list_mr_discussions');
      if (!threads) return use('detent_list_mr_discussions', {});
      success(threads);
      assert.match(JSON.stringify(history.slice(history.indexOf(threads))), /@[\w-]+: Also check the config override/);
      return text('Reviewed both the config defaults and the override.');
    }
    if (event.includes('Refactor config loader')) {
      assert.match(system, /当前为方案阶段/);
      return text('Refactor the config loader and verify its defaults.');
    }
    if (event.includes('实施方案已获批准')) {
      const shell = current('Bash');
      if (!shell) return use('Bash', { command: 'printf config-loader-ok | cut -c 1-6', description: 'Check loader output formatting' });
      assert.equal(success(shell).trim(), 'config');
      return text('Approved config loader check returned config.');
    }
    if (mr[3] === 'Resolve conflict on config' && event.includes('请检查新分配的 MR')) {
      const sync = current('detent_sync_target_branch');
      if (!sync) return use('detent_sync_target_branch', {});
      assert.deepEqual(JSON.parse(success(sync)), { merged: false, conflictedFiles: ['conflict.txt'] });
      file = 'conflict.txt';
      const read = current('Read');
      if (!read) return use('Read', { file_path: join(workspaceRoot(), 'projects', directory, file) });
      assert.match(success(read), /<<<<<<<[\s\S]*source setting[\s\S]*=======[\s\S]*target setting/);
      content = 'resolved source and target settings\n';
      report = 'Resolved the conflicting config settings.';
    } else if (event.includes('请检查新分配的 MR')) return text('Accepted the assigned MR.');
    else if (event.includes('Add a regression test')) {
      assert.match(event + '\n' + system, /hello\.txt:1 Add a regression test/);
      const diff = current('detent_get_mr_diff');
      if (!diff) return use('detent_get_mr_diff', {});
      const greeting = /^\+Hello from (.+)!$/m.exec(JSON.parse(success(diff)))?.[1];
      assert.equal(greeting, mr[3] === 'Storm inline review' ? apiRepo + ' storm' : apiRepo);
      const threads = current('detent_list_mr_discussions');
      if (!threads) return use('detent_list_mr_discussions', {});
      assert.ok(JSON.parse(success(threads)).some((t: { notes: { type: string; position?: { new_path: string; new_line: number } }[] }) =>
        t.notes.some(n => n.type === 'DiffNote' && n.position?.new_path === 'hello.txt' && n.position.new_line === 1)));
      file = 'test-greeting.sh';
      content = `#!/bin/sh\ntest "$(cat hello.txt)" = "Hello from ${greeting}!"\n`;
      report = 'Added the requested greeting regression test.';
    } else {
      const pipeline = current('detent_get_pipeline_status');
      if (!pipeline) return use('detent_get_pipeline_status', { project: Number(mr[1]), ref_or_mr_iid: Number(mr[2]) });
      const { jobs, pipeline: failed } = JSON.parse(success(pipeline));
      assert.ok(event.includes('Pipeline #' + failed.id + ' failed'));
      const job = jobs.find((j: { status: string }) => j.status === 'failed');
      assert.ok(job);
      const trace = current('detent_get_pipeline_job_log');
      if (!trace) return use('detent_get_pipeline_job_log', { project: Number(mr[1]), job_id: job.id });
      assert.match(success(trace), /Missing ci\/ready.txt: expected ready/);
      if (mr[3] === 'Verify trace redaction') {
        assert.ok(success(trace).includes('https://oauth2:***@127.0.0.1/repo.git'));
        return text(JSON.parse(success(trace)));
      }
      file = 'ci/ready.txt';
      content = 'ready\n';
      report = 'Restored the CI readiness file.';
      if (mr[3] === 'External contribution') {
        // The receipt is generated by the reviewer while this very tool call is in flight.
        const receipt = /include receipt (steer-[a-f0-9-]+)/.exec(JSON.stringify(history))?.[1];
        assert.ok(receipt, 'PostToolUse did not deliver the reviewer instruction to the active model turn');
        report += ' ' + receipt;
      }
    }
    if (mr[3] === 'Storm CI repair' || mr[3] === 'Storm inline review') {
      const original = current('Read');
      if (!original) return use('Read', { file_path: join(workspaceRoot(), 'projects', directory, file) });
      assert.ok(success(original).includes('broken'));
    }
    const write = current('Write');
    if (!write) return use('Write', { file_path: join(workspaceRoot(), 'projects', directory, file), content });
    success(write);
    const push = current('detent_commit_and_push');
    if (!push) return use('detent_commit_and_push', { directory_name: directory, commit_message: report });
    assert.match(JSON.parse(success(push)), /^[a-f0-9]{40}$/);
    return text(report);
  }
  assert.ok(issue, 'Missing Hub Issue number in the SDK system prompt');

  const userText = body.messages.filter(m => m.role === 'user').flatMap(m =>
    typeof m.content === 'string' ? [m.content] : m.content.flatMap(b => b.type === 'text' ? [b.text] : []));
  const has = (phrase: string) => userText.some(t => t.includes(phrase));
  if (/Stage 15 (?:Hub|workflow|denied) account/.test(system)) {
    const status = result('jms_readonly_inspect');
    if (!status) return use('jms_readonly_inspect', { asset_ids: ['web01'], command: system.includes('workflow account') ? 'kafka-topics.sh --list' : 'uptime' });
    if (system.includes('denied account')) {
      assert.ok(status.is_error);
      assert.match(contents(status.content), /资产 web01 未授权账号 ghost.*可用授权账号：ops-first、root、ops-hub、audit-ro/);
    } else assert.match(success(status), /nginx active/);
    return text('Stage 15 inspection checked.');
  }
  if (system.includes('Verify note redaction')) return text(securityReport);
  if (system.includes('Cluster plan decision')) {
    if (has('实施方案未获批准')) return text('Revised cluster plan.');
    return text(approved < 0 ? 'Cluster plan ready.' : 'Cluster plan executed.');
  }
  if (system.includes('Verify release guard')) {
    if (approved < 0) return text('Check existing release tag.');
    const denied = result('detent_create_release');
    if (!denied) {
      const sha = userText.join(' ').match(/\b[a-f0-9]{40}\b/)?.[0];
      assert.ok(sha);
      return use('detent_create_release', { project: webRepo, tag_name: 'rel-1.0.0', commit_sha: sha });
    }
    assert.ok(denied.is_error && contents(denied.content).includes('目标 Tag 已存在'));
    return text('Existing tag preserved.');
  }
  if (system.includes('Verify standalone runtime')) {
    if (has('Continue from the historical checkpoint')) {
      assert.ok(blocks.some(b => b.type === 'text' && b.text.includes('Standalone turn complete')));
      return text('Resumed the historical checkpoint.');
    }
    if (approved < 0) return text('Standalone plan');
    return text('Standalone turn complete.');
  }
  if (system.includes('Revise the public API')) {
    if (approved >= 0) {
      assert.ok(has('附加说明：Add inline comments'));
      const write = result('Write');
      if (!write) return use('Write', { file_path: join(workspaceRoot(), 'capabilities.json'), content: '{}' });
      assert.ok(write.is_error);
      assert.match(contents(write.content), /不允许文件操作/);
      const listed = result('detent_list_projects');
      if (!listed) return use('detent_list_projects', { search: apiRepo });
      success(listed);
      return text('Revised implementation complete.');
    }
    return text(has('修改意见：Keep API signature unchanged') ? 'Plan v2 preserves the API signature.' : 'Plan v1 changes the API signature.');
  }
  if (system.includes('Select service port') || system.includes('Switch audit to coding')) {
    if (has('Please open a fix MR')) {
      assert.equal(sopPath, 'agents/code-delivery/AGENT.md');
      assert.match(system, /当前为方案阶段/);
      return text('Plan to open a fix MR.');
    }
    if (system.includes('Select service port') && approved < 0) return text('Confirm the deployment port.');
    const question = 'Which service port?';
    const answer = result('AskUserQuestion');
    if (!answer) return use('AskUserQuestion', { questions: [{ question }] });
    assert.deepEqual(JSON.parse(success(answer)), { [question]: 'Use port 6380' });
    return text('Confirmed port 6380.');
  }
  if (system.includes('Approve in context')) {
    if (has('可以')) return text('Received the ordinary follow-up.');
    return text(approved >= 0 ? 'Plan executed.' : 'Check the service defaults.');
  }
  if (system.includes('Interrupt maintenance')) {
    if (has('Fresh start')) {
      assert.ok(!has('实施方案已获批准'));
      return text('Fresh maintenance plan.');
    }
    if (approved >= 0) return use('detent_list_projects', { search: apiRepo });
    const tree = result('detent_checkout_worktree');
    if (!tree) return use('detent_checkout_worktree', { project: apiRepo, branch_name: 'main' });
    success(tree);
    return text('Maintenance plan ready.');
  }

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

  if (system.includes('需求澄清与引导模式（只读）')) {
    assert.equal(sopPath, undefined);
    assert.match(system, /本轮仅允许只读检查/);
    const [ready, unavailable] = system.split('### 未开通');
    for (const label of ['delivery::audit', 'delivery::env-change'])
      assert.ok(unavailable.split('\n').some(line => line.includes(label) && line.includes('待配置 jumpserver')));
    for (const label of ['delivery::code', 'delivery::release', 'agent::image-sync'])
      assert.ok(ready.includes(label));
    assert.ok(!body.tools.some(t => ['Edit', 'Write', 'Bash', toolName('detent_close_issue')].includes(t.name) ||
      t.name.startsWith(prefix + 'harbor-sync__')), 'Triage advertised a restricted tool');
    return text('请提供带 Tag 的完整源镜像地址和目标镜像仓库地址。');
  }

  if (sopPath === 'agents/onboarding/AGENT.md') {
    const project = userText.join(' ').match(/([\w/-]+\/payment)\b/)?.[1];
    assert.ok(project);
    const check = result('detent_check_project_onboarding');
    if (!check) return use('detent_check_project_onboarding', { project });
    const [status] = JSON.parse(success(check)).projects;
    assert.equal(status.botAccessLevel, 40);
    assert.equal(status.webhookConfigured, false);
    if (approved < 0) return text('Connect ' + project + ' to Detent after production approval.');
    const onboard = result('detent_onboard_project');
    if (!onboard) return use('detent_onboard_project', { project });
    assert.deepEqual(JSON.parse(success(onboard)).onboarded, [{ projectId: status.projectId, path: project, action: 'created' }]);
    return closeIssue('Webhook configured.', project + ' is ready.');
  }
  if (sopPath === 'agents/image-sync/AGENT.md') {
    const skillPath = 'agents/image-sync/skills/mirror-to-harbor/SKILL.md';
    const { source_image, target_image } = imageMirror;
    assert.ok(system.includes(skillPath) && system.includes('skills/gitlab-mr-conventions/SKILL.md'));
    assert.ok(!body.tools.some(t => t.name === 'Bash'), 'image-sync advertised Bash');
    function mirrorResult(r: Result) {
      const { authorization, ...outcome } = JSON.parse(success(r));
      assert.ok(authorization === '***', 'The MCP result leaked its authorization header');
      return outcome;
    }
    if (approved < 0) {
      assert.match(system, /当前为方案阶段（只读）/);
      const skill = result('Read');
      if (!skill) return use('Read', { file_path: join(workspaceRoot(), skillPath) });
      assert.match(success(skill), /harbor-sync__check_image_exists/);
      const check = result('harbor-sync__check_image_exists');
      if (!check) return use('harbor-sync__check_image_exists', { target_image });
      assert.deepEqual(mirrorResult(check), { target_image, exists: false });
      return text(`目标 Tag 尚不存在。批准后将 ${source_image} 同步到 ${target_image} 并核对结果。`);
    }

    assert.match(system, /已获方案审批/);
    const sync = result('harbor-sync__sync_image');
    if (!sync) return use('harbor-sync__sync_image', imageMirror);
    assert.deepEqual(mirrorResult(sync), { ...imageMirror, synced: true });
    return closeIssue('已核对同步结果。', `镜像同步完成，目标为 ${target_image}。`);
  }

  const hotfix = sopPath === 'workflows/hotfix.md';
  if (hotfix || sopPath === 'agents/release/AGENT.md') {
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
    if (project === webRepo && sopPath === 'agents/code-delivery/AGENT.md') {
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
    if (!write) return use('Write', { file_path: join(workspaceRoot(), 'projects', directory, file), content });
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

  if (system.includes('Verify production guards')) {
    if (approved < 0) return text('Prepare a reviewed playbook.');
    if (!lastMerge) {
      const step = deliverFile(ansibleRepo, 'guard/issue-' + issue[1], 'deploy/guard.yml', '- hosts: all\n  tasks: []\n', 'Review guard playbook', blocks.slice(approved));
      return 'type' in step ? step : text('Ready for guard review.');
    }
    const linked = result('detent_create_mr');
    assert.ok(linked);
    const { targetProjectId, mrIid } = JSON.parse(success(linked));
    const sha = /合并提交 SHA：([a-f0-9]{40})/.exec(lastMerge.text)![1];
    let history = turn;
    for (const [asset, commit, reason] of [['blocked-db-01', sha, '黑名单'], ['web01', '0'.repeat(40), '提交不一致'],
      ['web01', sha, '最新流水线失败']]) {
      const denied = result('jms_run_ansible_job', history);
      if (!denied) return use('jms_run_ansible_job', { target_project_id: targetProjectId, mr_iid: mrIid,
        commit_sha: commit, playbook_path: 'deploy/guard.yml', asset_ids: [asset] });
      assert.ok(denied.is_error && contents(denied.content).includes(reason), 'Expected guard denial: ' + reason);
      history = history.slice(history.indexOf(denied) + 1);
    }
    return text('All three production requests denied.');
  }
  if (sopPath === 'agents/code-delivery/AGENT.md') {
    if (system.includes('Storm code change')) {
      if (approved < 0) return text('Add cluster.txt for review.');
      const step = deliverFile(webRepo, 'storm/issue-' + issue[1], 'cluster.txt', 'cluster ready\n', 'Add cluster readiness', blocks.slice(approved));
      return 'type' in step ? step : text('Review cluster readiness: ' + step.mrWebUrl);
    }
    if (system.includes('Review CI readiness change')) {
      if (approved < 0) return text('Propose the readiness probe for review.');
      const step = deliverFile(apiRepo, 'ci/readiness-probe', 'probe.txt', 'check readiness\n', 'Add readiness probe', blocks.slice(approved));
      return 'type' in step ? step : text('Readiness probe ready for review: ' + step.mrWebUrl);
    }
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

  const audit = sopPath === 'agents/audit/AGENT.md';
  assert.ok(audit || sopPath === 'agents/env-change/AGENT.md', 'Missing JumpServer SOP');
  if (approved < 0 && !lastMerge) {
    const assets = result('jms_list_assets');
    if (!assets) return use('jms_list_assets', {});
    assert.match(success(assets), /web01/);
    const status = result('jms_readonly_inspect');
    if (!status) return use('jms_readonly_inspect', audit ? { asset_ids: ['web01', 'web02'], command: 'ss -lntp' } : inspect);
    assert.match(success(status), /nginx active/);
    if (audit) {
      const grouped = JSON.parse(success(status));
      assert.equal(grouped.status, 'SUCCESS');
      assert.match(grouped.outputSummary, /web01.*nginx active/s);
      assert.match(grouped.outputSummary, /web02.*nginx active/s);
      return closeIssue('Readonly audit complete; nginx active on web01.', 'Diagnostic report: nginx is active on web01.');
    }
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

function respond(body: Messages, block: Text | Use) {
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
  let observeRequest: ((system: string) => Promise<void>) | undefined;
  let nextTool: { name: string; observe: () => Promise<void> } | undefined;
  let checkPayload: (body: Messages) => void = () => {};
  return {
    async handle(req: Request) {
      requests++;
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 });
      assert.ok(req.headers.get('x-api-key') === 'offline-api-key', 'Model transport did not authenticate the upstream request');
      const body: Messages = await req.json();
      checkPayload(body);
      if (body.tools?.length && observeRequest) await observeRequest(contents(body.system ?? ''));
      const block = next(body, repos);
      if (nextTool && block.type === 'tool_use' && block.name === 'mcp__detent__' + nextTool.name) {
        const { observe } = nextTool;
        nextTool = undefined;
        await observe();
      }
      return respond(body, block);
    },
    observeTurns(observer?: (system: string) => Promise<void>) { observeRequest = observer; },
    beforeNextTool(name: string, observe: () => Promise<void>) {
      assert.equal(nextTool, undefined);
      nextTool = { name, observe };
    },
    checkRequests(check: (body: Messages) => void) { checkPayload = check; },
    getRequests: () => requests,
  };
}
