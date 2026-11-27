import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SdkClaudeRunner, type TurnInput } from '../src/claude/runner.js';
import { query, createSdkMcpServer } from '@anthropic-ai/claude-code';
import { loadConfig } from '../src/config.js';
import { createWebhookApp, dispatchWebhook } from '../src/gitlab/webhook.js';
import { WebhookQueue } from '../src/gitlab/webhook-queue.js';
import { MergeRequestOrchestrator } from '../src/orchestrator/mr-orchestrator.js';
import { SessionOrchestrator } from '../src/orchestrator/session-orchestrator.js';
import { Watchdog } from '../src/orchestrator/watchdog.js';
import { runHubEvent } from '../src/router/event-policy.js';
import { git } from '../src/workspace/ephemeral-sandbox.js';
import type { LiveMr } from '../src/gitlab/client.js';
import { bareProjects } from './bare-projects.js';
import { InMemoryDetentRepository } from './memory-repository.js';

vi.mock('@anthropic-ai/claude-code', async original => {
  const sdk = await original<typeof import('@anthropic-ai/claude-code')>();
  return { ...sdk, query: vi.fn(), createSdkMcpServer: vi.fn(sdk.createSdkMcpServer) };
});

const bot = { id: 9, username: 'bot', name: 'Bot' };
const user = { id: 7, username: 'dev' };
const opened = { object_kind: 'merge_request', project: { id: 2 }, user, assignees: [bot],
  object_attributes: { state: 'opened', action: 'open', iid: 1, title: 'Review me' } };
const note = (body: string, attrs = {}) => ({
  object_kind: 'note', project: { id: 2 }, user, merge_request: { iid: 1, state: 'opened' },
  object_attributes: { id: 5, noteable_type: 'MergeRequest', note: body, action: 'create', ...attrs },
});
const pipeline = (id: number, status = 'failed', sha = 'head') => ({
  object_kind: 'pipeline', project: { id: 2, path_with_namespace: 'org/app' }, user: bot,
  object_attributes: { id, ref: 'feature', status, sha },
});
const emoji = (id: number, name: string, actor = user) => ({
  object_kind: 'emoji', project_id: 2, user: actor, note: { noteable_type: 'MergeRequest' },
  object_attributes: { awardable_type: 'Note', awardable_id: id, action: 'award', name },
});
async function setup(hotHoldTimeoutMs = 0) {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-stage11-'));
  const config = { ...loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), GITLAB_WEBHOOK_SECRET: 'hook',
    JEV_API_KEY: 'test-secret' }), hotHoldTimeoutMs };
  const projects = await bareProjects(root);
  for (const id of [1, 2, 3]) await git(['branch', 'feature', 'main'], path.join(root, id + '.git'), root);
  const repo = new InMemoryDetentRepository();
  const mr: LiveMr = { iid: 1, target_project_id: 2, source_project_id: 2, source_branch: 'feature', target_branch: 'main',
    sha: 'head', assignees: [bot], state: 'opened', title: 'Review me', description: 'Update parser',
    web_url: 'https://git/org/app/-/merge_requests/1', draft: true, has_conflicts: true, detailed_merge_status: 'conflict',
    head_pipeline: { id: 42, status: 'failed', ref: 'feature' } };
  let noteId = 0;
  const create = async () => ({ id: ++noteId });
  const gitlab = { ...projects, getBotIdentity: () => bot, isBotUser: (id?: number, name?: string) => id === bot.id || name === bot.username,
    hasApprovalPermission: vi.fn(async (_project: number, id: number, _level?: number) => id === user.id),
    getMergeRequest: vi.fn(async () => mr), listOpenMergeRequestsByBranch: vi.fn().mockResolvedValue([mr]),
    listMergeRequestDiffs: vi.fn().mockResolvedValue([{ old_path: 'a', new_path: 'a', diff: 'test-secret' + '改'.repeat(40000) }]),
    listMergeRequestDiscussions: vi.fn().mockResolvedValue([{ id: 'thread-a', notes: [{ id: 12, body: 'review test-secret',
      type: 'DiffNote', author: user, system: false, resolvable: true, resolved: false, position: { new_path: 'tracked', new_line: 7 } }] }]),
    listPipelines: vi.fn().mockResolvedValue([mr.head_pipeline]), getPipelineJobs: vi.fn().mockResolvedValue([{ id: 33, name: 'lint', status: 'failed' }]),
    getRepositoryFile: vi.fn().mockResolvedValue(null), createIssue: vi.fn().mockResolvedValue({ iid: 12, title: 'Branch failure' }),
    createCommitComment: vi.fn(), createIssueNote: vi.fn(create), updateIssueNote: vi.fn(), getIssue: vi.fn(),
    syncIssueStatusLabel: vi.fn(), createMergeRequestNote: vi.fn(create), updateMergeRequestNote: vi.fn(),
    createMergeRequestDiscussionNote: vi.fn(create), updateMergeRequestDiscussionNote: vi.fn() };
  const run = vi.fn<(turn: TurnInput) => Promise<string>>().mockResolvedValue('fixed');
  const issueWorker = new SessionOrchestrator(config, repo, gitlab, { run: vi.fn().mockResolvedValue('branch plan') });
  const decide = vi.fn().mockResolvedValue({ action: { type: 'choice', choice: 'run' } });
  const onNotify = vi.fn();
  const worker = new MergeRequestOrchestrator(config, repo, gitlab, { run }, { decision: { provider: 'custom', threshold: 0.9, decide }, onNotify,
    runHubEvent: (event, body, label) => runHubEvent(gitlab, config, event, body, issueWorker, label) });
  const report = vi.fn();
  const queue = new WebhookQueue((event, id) => dispatchWebhook(issueWorker, event, id, worker), report);
  const app = createWebhookApp(config, gitlab, (id, event) => queue.submit(id, event));
  const post = (payload: object, id = randomUUID()) => app.inject({ method: 'POST', url: '/webhooks/gitlab', payload,
    headers: { 'x-gitlab-token': 'hook', 'idempotency-key': id } });
  const drain = async () => { await queue.drain(); await worker.drain(); };
  const send = async (payload: object) => { const res = await post(payload); await drain(); return res; };
  onTestFinished(async () => {
    queue.stop(); await drain(); await app.close(); await rm(root, { recursive: true, force: true });
    expect(report).not.toHaveBeenCalled();
  });
  const session = async () => (await repo.getSessionByMr(mr.target_project_id, mr.iid))!;
  async function link() {
    const hub = await repo.getOrCreateSession(1, 21, 'Linked issue');
    await repo.upsertMergeRequest({ sessionId: hub.id, worktreeId: null, targetProjectId: 2, targetProjectPath: 'org/app',
      mrIid: 1, mrTitle: mr.title, mrState: 'opened', mrWebUrl: mr.web_url, sourceBranch: 'feature', targetBranch: 'main',
      latestPipelineId: null, latestPipelineStatus: null });
    return hub;
  }
  return { root, config, repo, mr, gitlab, run, issueWorker, worker, decide, onNotify, post, drain, send, session, link };
}

it('checks out the assigned source, registers only MR tools, resolves a real shallow merge conflict, and pushes only the source', async () => {
  const { root, config, repo, mr, gitlab, run, send, session } = await setup();
  const seed = path.join(root, 'seed');
  const remote = path.join(root, '2.git');
  for (const branch of ['feature', 'main']) {
    await git(['switch', ...(branch === 'feature' ? ['-c'] : []), branch], seed, root);
    await writeFile(path.join(seed, 'tracked'), branch);
    await git(['commit', '-am', branch], seed, root);
    await git(['push', remote, branch], seed, root);
  }
  const targetBefore = await git(['rev-parse', 'main'], remote, root);
  run.mockImplementationOnce(async t => {
    expect(t.session.permissionMode).toBe('default');
    const [tree] = await repo.listActiveWorktrees(t.session.id);
    expect(tree).toMatchObject({ branchName: 'feature', baseBranch: 'main', status: 'ACTIVE' });
    const dir = path.join(t.sandbox.workspaceRoot, 'projects', tree.directoryName);
    expect(await readdir(t.sandbox.workspaceRoot)).toEqual(['projects']);
    for (const text of ['2!1', mr.title, mr.description!, 'feature -> main', 'draft=true', 'has_conflicts=true', 'lint', 'tracked:7', tree.directoryName])
      expect(t.systemPrompt).toContain(text);
    expect(t.systemPrompt).not.toContain('test-secret');
    const allowed = ['detent_commit_and_push', 'detent_get_pipeline_status', 'detent_get_pipeline_job_log'];
    const extensions = ['detent_get_mr_diff', 'detent_list_mr_discussions', 'detent_sync_target_branch'];
    vi.mocked(query).mockReturnValueOnce((async function* () {
      yield { type: 'result', session_id: t.session.claudeSessionId, subtype: 'success', result: 'ok' };
    })() as ReturnType<typeof query>);
    await new SdkClaudeRunner(config).run(t);
    expect(vi.mocked(createSdkMcpServer).mock.lastCall![0].tools!.map(tool => tool.name)).toEqual([...allowed, ...extensions, 'AskUserQuestion']);
    for (const tool of ['detent_create_mr', 'detent_close_issue', 'detent_checkout_worktree', 'detent_close_worktree', 'detent_list_projects', 'detent_create_release', 'external__run'])
      expect(await t.gate.preflight('mcp__detent__' + tool, {})).toMatchObject({ behavior: 'deny' });
    const invoke = (tool: string) => t.gate.invokeExtension('mcp__detent__' + tool, {});
    const diff = String(await invoke(extensions[0]));
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(32 * 1024);
    expect(diff).toContain('[diff truncated]');
    expect(diff).not.toContain('test-secret');
    expect(await invoke(extensions[1])).toMatchObject([{ id: 'thread-a', notes: [{ body: 'review ***', position: { new_line: 7 } }] }]);
    const push = (directory_name: string) => t.tools.invoke('detent_commit_and_push', { directory_name, commit_message: 'resolve conflict' });
    const sibling = await repo.upsertWorktree({ ...tree, targetProjectId: 3, directoryName: 'other' });
    await expect(push('other')).rejects.toThrow(/MR worktree/);
    await repo.archiveWorktree(sibling.id);
    await git(['switch', '-c', 'unexpected'], dir, root);
    await expect(push(tree.directoryName)).rejects.toThrow(/source branch/);
    await git(['switch', 'feature'], dir, root);
    expect(await invoke(extensions[2])).toEqual({ merged: false, conflictedFiles: ['tracked'] });
    expect(await readFile(path.join(dir, 'tracked'), 'utf8')).toContain('<<<<<<<');
    expect(await t.gate.preflight('Edit', { file_path: path.join(dir, 'tracked') })).toMatchObject({ behavior: 'allow' });
    await writeFile(path.join(dir, 'tracked'), 'resolved');
    await push(tree.directoryName);
    t.progress('提交推送分支');
    return 'CI fixed';
  });
  expect((await send(opened)).statusCode).toBe(202);
  expect((await session()).status).toBe('IDLE');
  expect(await git(['show', 'feature:tracked'], remote, root)).toBe('resolved');
  expect(await git(['rev-parse', 'main'], remote, root)).toBe(targetBefore);
  expect(await git(['rev-parse', 'feature^2'], remote, root)).toBe(targetBefore);
  expect(gitlab.updateMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.any(Number),
    expect.stringMatching(/CI fixed[\s\S]*<details><summary>📎 执行记录（1 步）[\s\S]*提交推送分支[\s\S]*<\/details>/));
  expect(gitlab.syncIssueStatusLabel).not.toHaveBeenCalled();
  expect(await readdir(config.ephemeralRoot)).toEqual([]);
});

it('requires new assignment on updates and target membership on all human triggers', async () => {
  const { gitlab, run, send, session } = await setup();
  const update = { ...opened, object_attributes: { ...opened.object_attributes, action: 'update' } };
  for (const changes of [{ title: { previous: 'a', current: 'b' } }, { labels: {} },
    { assignees: { previous: [bot], current: [] } }, { assignees: { previous: [bot], current: [bot] } }]) {
    expect((await send({ ...update, changes })).json()).toEqual({ ignored: true });
  }
  const add = { ...update, changes: { assignees: { previous: [], current: [bot] } } };
  for (const payload of [opened, add, note('@bot fix')]) await send({ ...payload, user: { id: 3, username: 'reporter' } });
  expect(await session()).toBeNull();
  await send(add);
  expect(run).toHaveBeenCalledOnce();
  expect(gitlab.hasApprovalPermission).toHaveBeenCalledWith(2, 3);
});

it('handles a mention on an unassigned MR once and ignores reviewer-only, system, edited and closed notes', async () => {
  const { mr, gitlab, run, post, drain, send } = await setup();
  mr.assignees = [];
  await send({ ...note('thanks'), reviewers: [bot] });
  await send(note('quoted `@bot`'));
  for (const payload of [note('@bot', { system: true }), note('@bot', { action: 'update' }),
    { ...note('@bot'), merge_request: { iid: 1, state: 'merged' } }]) {
    expect((await send(payload)).json()).toEqual({ ignored: true });
  }
  mr.state = 'closed';
  await send(note('@bot check'));
  mr.state = 'opened';
  expect(run).not.toHaveBeenCalled();
  const id = randomUUID();
  await post(note('@bot check'), id);
  await post(note('@bot check'), id);
  await drain();
  expect(run.mock.calls.map(([t]) => t.prompt)).toEqual(['@dev: check']);
  await send(note('thanks'));
  expect(run).toHaveBeenCalledOnce();
  expect(mr.assignees).toEqual([]);
  expect(gitlab.createMergeRequest).not.toHaveBeenCalled();
});

it('batches inline review and delivers hot steering to PostToolUse, replying in each discussion', async () => {
  const { repo, config, worker, run, gitlab, session } = await setup();
  const s = await repo.getOrCreateMrSession(2, 1, 'Review');
  await repo.acquireSessionLease(s.id, 'previous', 60);
  const review = async (index: number) => {
    await worker.handleMergeRequestNote({ ...note('change ' + index), object_kind: 'note',
      object_attributes: { ...note('').object_attributes, note: 'change ' + index, type: 'DiffNote', discussion_id: 'review-' + index,
        position: { new_path: 'tracked', new_line: index } } }, 'review/' + index);
  };
  await Promise.all([1, 2, 3].map(review));
  await worker.drain();
  await repo.releaseSessionLease(s.id, 'previous');
  run.mockImplementationOnce(async t => {
    expect(t.prompt).toContain('tracked:1 change 1\n\n@dev: tracked:2 change 2\n\n@dev: tracked:3 change 3');
    await review(4);
    vi.mocked(query).mockReturnValueOnce((async function* () {
      yield { type: 'result', session_id: t.session.claudeSessionId, subtype: 'success', result: 'ok' };
    })() as ReturnType<typeof query>);
    await new SdkClaudeRunner(config).run(t);
    const hook = vi.mocked(query).mock.lastCall![0].options!.hooks!.PostToolUse![0].hooks[0];
    const result = await hook({ hook_event_name: 'PostToolUse', cwd: t.sandbox.workspaceRoot, transcript_path: '',
      session_id: t.session.claudeSessionId!, tool_name: 'Read', tool_input: {}, tool_response: 'ok' }, undefined, { signal: t.controller.signal });
    expect(result).toMatchObject({ hookSpecificOutput: { additionalContext: '@dev: tracked:4 change 4' } });
    t.progress('read review diff');
    return 'review addressed';
  });
  await worker.wakeSession(s, 'inbox');
  expect((await session()).status).toBe('IDLE');
  expect(run).toHaveBeenCalledOnce();
  const body = gitlab.updateMergeRequestDiscussionNote.mock.lastCall?.at(-1);
  expect(body).toMatch(/review addressed[\s\S]*<details>[\s\S]*read review diff[\s\S]*<\/details>/);
  for (const index of [2, 3, 4]) expect(gitlab.createMergeRequestDiscussionNote).toHaveBeenCalledWith(2, 1, 'review-' + index, String(body).split('\n\n> 💡')[0]);
});

it('deduplicates bot CI, checks live SHA and ownership, escalates to both resources, and resets the budget', async () => {
  const { mr, repo, run, gitlab, send, session, link, config } = await setup();
  const hub = await link();
  config.mrMaxAutoFixAttempts = 1;
  await send(pipeline(1, 'failed', 'stale'));
  expect(await session()).toBeNull();
  expect(await repo.findMergeRequest(2, 1)).toMatchObject([{ latestPipelineId: 1, latestPipelineStatus: 'failed' }]);
  await send(pipeline(2));
  await send(pipeline(2));
  expect(run).toHaveBeenCalledOnce();
  expect(await session()).toMatchObject({ status: 'IDLE', autoFixAttempts: 1, lastFailedPipelineId: 2 });
  await send(pipeline(3));
  await send(pipeline(3));
  expect(run).toHaveBeenCalledOnce();
  expect(gitlab.createIssueNote).toHaveBeenCalledExactlyOnceWith(1, hub.hubIssueIid, expect.stringContaining('人工检查'));
  expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.stringContaining('人工检查'));
  expect(await session()).toMatchObject({ autoFixAttempts: 1, lastFailedPipelineId: 3 });
  await send({ ...pipeline(4, 'success'), merge_request: { iid: 1 } });
  expect((await session()).autoFixAttempts).toBe(0);
  await send(pipeline(5));
  await send(note('thanks for looking'));
  expect((await session()).autoFixAttempts).toBe(0);
  mr.assignees = [];
  await send(pipeline(6));
  expect(gitlab.createIssueNote).toHaveBeenLastCalledWith(1, 21, expect.stringContaining('Pipeline #6 failed'));
  expect(run).toHaveBeenCalledTimes(3);
});

it('honors first matching ignore, notify, run and semantic rules, including branch failures without an MR', async () => {
  const { mr, config, gitlab, run, send, decide, onNotify, repo } = await setup();
  mr.assignees = [];
  const policy = (rule: object) => gitlab.getRepositoryFile.mockResolvedValue(JSON.stringify({ version: 1, rules: [
    { event: 'pipeline', ...rule }, { event: 'pipeline', action: 'run' }] }));
  mr.assignees = [bot];
  policy({ action: 'ignore', ownership: 'assigned' });
  await send(pipeline(7));
  expect(run).not.toHaveBeenCalled();
  policy({ action: 'notify', notifyTarget: 'resource' });
  await send(pipeline(8));
  expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ mrIid: 1 }));
  mr.assignees = [];
  policy({ action: 'run', maxAutoFixAttempts: 0 });
  await send(pipeline(9));
  expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.stringContaining('人工检查'));
  policy({ action: 'semantic', allowedActions: ['run'], promptHint: 'Assess CI' });
  await send(pipeline(10));
  expect(decide).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  gitlab.listOpenMergeRequestsByBranch.mockResolvedValue([]);
  const main = { ...pipeline(11), object_attributes: { ...pipeline(11).object_attributes, ref: 'main' } };
  policy({ branch: 'main', action: 'notify', notifyTarget: 'hub_issue', hubIssueLabel: 'ci' });
  await send(main);
  expect(gitlab.createIssue).toHaveBeenCalledWith(config.gitlabHubProjectId, expect.objectContaining({ labels: ['ci'] }));
  policy({ branch: 'main', action: 'run' });
  await send({ ...main, object_attributes: { ...main.object_attributes, id: 12 } });
  expect(await repo.getSessionByIssue(config.gitlabHubProjectId, 12)).toMatchObject({ status: 'WAITING_PLAN' });
  expect(gitlab.getRepositoryFile).toHaveBeenCalledTimes(6);
});

it('checks fork write permission and uses read-only suggestions while retaining the diff and pipeline tools', async () => {
  const { mr, gitlab, repo, send, run, session } = await setup();
  mr.source_project_id = 3;
  run.mockImplementationOnce(async t => {
    const [tree] = await repo.listActiveWorktrees(t.session.id);
    expect(tree.targetProjectId).toBe(3);
    expect(t.systemPrompt).toContain('Read-only fork');
    for (const [name, input] of [['Edit', { file_path: 'a' }], ['detent_commit_and_push', {}], ['mcp__detent__detent_sync_target_branch', {}]] as const)
      expect(await t.gate.preflight(name, input)).toMatchObject({ behavior: 'deny' });
    await expect(t.tools.invoke('detent_commit_and_push', { directory_name: tree.directoryName, commit_message: 'bad' })).rejects.toThrow(/read-only/);
    expect(await t.gate.preflight('mcp__detent__detent_get_mr_diff', {})).toMatchObject({ behavior: 'allow' });
    expect(await t.gate.preflight('detent_get_pipeline_job_log', {})).toMatchObject({ behavior: 'allow' });
    return 'Suggested patch';
  });
  await send(opened);
  expect((await session()).status).toBe('IDLE');
  expect(gitlab.hasApprovalPermission).toHaveBeenCalledWith(3, bot.id, 30);
  expect(gitlab.updateMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.any(Number), expect.stringMatching(/^Suggested patch\n\n> 💡/));
});

it.each([0, 10000])('binds MR emoji decisions to the approval note and handles tool approval with hot hold %i', async timeout => {
  const { run, gitlab, repo, post, send, drain, session } = await setup(timeout);
  const input = { questions: [{ question: 'Which file?' }] };
  let outcome;
  run.mockImplementation(async t => {
    outcome = await t.gate.canUseTool('AskUserQuestion', input);
    return 'Answered';
  });
  await post(opened);
  await vi.waitFor(async () => expect(await session()).toMatchObject({ status: 'WAITING_TOOL' }));
  if (!timeout) await drain();
  const s = await session();
  const card = (await repo.getLatestPendingApproval(s.id))!;
  expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.stringContaining('Which file?'));
  // A guessed card, a removal, and a reporter's vote cannot resolve this request.
  await post(emoji(card.gitlabNoteId! + 1, 'thumbsup'));
  await post(emoji(card.gitlabNoteId!, 'thumbsup', { id: 3, username: 'reporter' }));
  await post({ ...emoji(card.gitlabNoteId!, 'thumbsup'), object_attributes: { ...emoji(card.gitlabNoteId!, 'thumbsup').object_attributes, action: 'revoke' } });
  expect(await repo.getLatestPendingApproval(s.id)).toMatchObject({ id: card.id });
  await send(emoji(card.gitlabNoteId!, timeout ? 'thumbsup' : 'thumbsdown'));
  expect(await repo.getApproval(card.id)).toMatchObject({ status: timeout ? 'APPROVED' : 'REJECTED', decidedBy: user.username });
  expect(outcome).toMatchObject({ behavior: timeout ? 'allow' : 'deny' });
  expect(run).toHaveBeenCalledTimes(timeout ? 1 : 2);
  expect((await session()).status).toBe('IDLE');
  expect(gitlab.syncIssueStatusLabel).not.toHaveBeenCalled();
});

it('accepts an authorized plain-text MR answer to the pending question and resumes in the discussion', async () => {
  const { gitlab, repo, run, send, session } = await setup();
  const questions = [{ question: 'Target branch?' }];
  run.mockImplementationOnce(async turn => {
    await turn.gate.canUseTool('AskUserQuestion', { questions });
    return 'question';
  }).mockImplementationOnce(async turn => {
    expect(await turn.gate.canUseTool('AskUserQuestion', { questions })).toMatchObject({
      behavior: 'allow', updatedInput: { answers: { 'Target branch?': 'main' } },
    });
    return '已确认 main';
  });
  await send(opened);
  const s = await session();
  const pending = (await repo.getLatestPendingApproval(s.id))!;
  await send(note('/status', { discussion_id: 'answer' }));
  expect(gitlab.createMergeRequestDiscussionNote).toHaveBeenCalledWith(2, 1, 'answer', expect.stringContaining('💬 **等待你的确认**'));
  await send(note('main', { discussion_id: 'answer' }));
  expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'APPROVED', decisionComment: 'main' });
  expect((await session()).status).toBe('IDLE');
  expect(gitlab.updateMergeRequestDiscussionNote).toHaveBeenCalledWith(2, 1, 'answer', expect.any(Number), '已确认 main');
});

it('handles MR plan, reject, approve, abort, status and reset without touching the same-numbered Hub issue', async () => {
  const { mr, gitlab, repo, run, send, session } = await setup();
  mr.target_project_id = mr.source_project_id = 1;
  const hubIssue = await repo.getOrCreateSession(1, 1, 'independent');
  const command = (body: string) => send({ ...note(body, { discussion_id: 'conversation' }), project: { id: 1 } });
  await send({ ...opened, project: { id: 1 } });
  const s = await session();
  expect(s.id).not.toBe(hubIssue.id);
  await command('/plan investigate');
  expect((await session()).status).toBe('WAITING_PLAN');
  await command('/reject add tests');
  expect(run.mock.lastCall![0].prompt).toContain('add tests');
  await command('/approve');
  expect((await session()).permissionMode).toBe('default');
  await command('/abort');
  await command('/status');
  expect(gitlab.createMergeRequestDiscussionNote).toHaveBeenCalledWith(1, 1, 'conversation', expect.stringContaining('💤 **待命**'));
  await command('/reset');
  expect(await session()).toMatchObject({ status: 'IDLE', permissionMode: 'default', id: s.id });
  expect((await session()).claudeSessionId).not.toBe(s.claudeSessionId);
  expect(await repo.getSession(hubIssue.id)).toEqual(hubIssue);
});

it.each(['close', 'merge'])('stops an active turn, expires approvals and archives its source worktree on %s', async action => {
  const { repo, run, send, post, session, link, gitlab } = await setup();
  await link();
  run.mockImplementationOnce(async t => new Promise((_resolve, reject) => {
    t.controller.signal.addEventListener('abort', () => reject(t.controller.signal.reason), { once: true });
  }));
  await post(opened);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const s = await session();
  const pending = await repo.createApprovalRequest(s.id, 'TOOL_USE', 'Bash', {});
  await send({ ...opened, object_attributes: { ...opened.object_attributes, action, state: action === 'close' ? 'closed' : 'merged' } });
  expect(await session()).toMatchObject({ status: 'DONE', lockedByPod: null });
  expect(await repo.findWorktree(s.id, 2, 'feature')).toMatchObject({ status: 'ARCHIVED' });
  expect((await repo.getApproval(pending.id))?.status).toBe('EXPIRED');
  await send({ ...note('/status'), merge_request: { iid: 1, state: action === 'close' ? 'closed' : 'merged' } });
  expect(gitlab.createMergeRequestNote).toHaveBeenLastCalledWith(2, 1, '✅ **已完成**');
  expect(run).toHaveBeenCalledOnce();
  if (action === 'close') {
    expect(await repo.findMergeRequest(2, 1)).toMatchObject([{ mrState: 'closed' }]);
    await send({ ...opened, object_attributes: { ...opened.object_attributes, action: 'reopen' } });
    expect(await repo.findWorktree(s.id, 2, 'feature')).toMatchObject({ status: 'ACTIVE' });
    expect((await session()).status).toBe('IDLE');
  }
});

it('recovers an expired MR lease, wakes a stranded inbox and respects pending approvals on watchdog scans', async () => {
  const { repo, run, issueWorker, worker } = await setup();
  const watchdog = new Watchdog(issueWorker, error => { throw error; }, worker);
  const s = await repo.getOrCreateMrSession(2, 1, 'Stranded');
  await repo.acquireSessionLease(s.id, 'old-pod', -1);
  await watchdog.scan();
  expect(run.mock.calls[0][0].prompt).toContain('中断');
  expect(await repo.getSession(s.id)).toMatchObject({ recoveryAttempts: 0, status: 'IDLE' });
  await repo.enqueueSessionInbox({ sessionId: s.id, sourceKind: 'note', content: 'Resume here', eventId: 'missed' });
  await watchdog.scan();
  expect(run.mock.lastCall![0].prompt).toContain('Resume here');
  await repo.updateSessionState(s.id, { status: 'WAITING_PLAN' });
  await repo.enqueueSessionInbox({ sessionId: s.id, sourceKind: 'pipeline', content: 'CI', eventId: 'waiting' });
  await watchdog.scan();
  expect(run).toHaveBeenCalledTimes(2);
});

it('retains the target parent across a cold fork merge and pushes the resolved tree only to the fork', async () => {
  const { root, mr, gitlab, repo, send, run, session } = await setup();
  mr.source_project_id = 3;
  gitlab.hasApprovalPermission.mockResolvedValue(true);
  const seed = path.join(root, 'seed');
  await writeFile(path.join(seed, 'tracked'), 'target');
  await git(['commit', '-am', 'target change'], seed, root);
  await git(['push', path.join(root, '2.git'), 'main'], seed, root);
  const parent = await git(['rev-parse', 'HEAD'], seed, root);
  await git(['switch', '-c', 'feature', 'HEAD^'], seed, root);
  await writeFile(path.join(seed, 'fork-change'), 'source');
  await git(['add', 'fork-change'], seed, root);
  await git(['commit', '-m', 'fork change'], seed, root);
  await git(['push', path.join(root, '3.git'), 'feature'], seed, root);
  const question = { questions: [{ question: 'Proceed after sync?' }] };
  run.mockImplementationOnce(async t => {
    expect(await t.gate.invokeExtension('mcp__detent__detent_sync_target_branch', {})).toEqual({ merged: true });
    await t.gate.canUseTool('AskUserQuestion', question);
    return 'unreachable';
  });
  await send(opened);
  expect((await session()).status).toBe('WAITING_TOOL');
  run.mockImplementationOnce(async t => {
    expect(await t.gate.canUseTool('AskUserQuestion', question)).toMatchObject({ behavior: 'allow' });
    const [tree] = await repo.listActiveWorktrees(t.session.id);
    await t.tools.invoke('detent_commit_and_push', { directory_name: tree.directoryName, commit_message: 'sync target' });
    return 'synced';
  });
  await send(note('/approve proceed'));
  expect((await session()).status, JSON.stringify(gitlab.updateMergeRequestNote.mock.calls)).toBe('IDLE');
  expect(await git(['show', 'feature:tracked'], path.join(root, '3.git'), root)).toBe('target');
  expect(await git(['rev-parse', 'feature^2'], path.join(root, '3.git'), root)).toBe(parent);
  expect(await git(['rev-parse', 'main'], path.join(root, '2.git'), root)).toBe(parent);
});

it('keeps pending plan approval during CI and revises it on human feedback in the thread', async () => {
  const { run, repo, send, session, gitlab } = await setup();
  await send(opened);
  await send(note('/plan investigate'));
  const s = await session();
  const first = (await repo.getLatestPendingApproval(s.id))!;
  await send(pipeline(3));
  expect(await repo.getLatestPendingApproval(s.id)).toEqual(first);
  await send(note('Check the parser too', { discussion_id: 'feedback' }));
  expect(await repo.getApproval(first.id)).toMatchObject({ status: 'EXPIRED' });
  expect(run.mock.lastCall![0].prompt).toContain('Check the parser too');
  expect(run.mock.lastCall![0].session.permissionMode).toBe('plan');
  expect(gitlab.updateMergeRequestDiscussionNote).toHaveBeenCalledWith(2, 1, 'feedback', expect.any(Number), expect.stringContaining('方案审批'));
});

it('answers targeted help in place before takeover and keeps the takeover footer on the first note only', async () => {
  const { mr, gitlab, run, send, session } = await setup();
  mr.assignees = [];
  await send(note('/help'));
  await send({ ...note('@bot /help'), user: { id: 1, username: 'guest' } });
  expect(gitlab.createMergeRequestNote).not.toHaveBeenCalled();
  for (const command of ['@bot 帮助', '@bot help', '@bot /help']) {
    await send(note(command, { discussion_id: 'thread' }));
    expect(gitlab.createMergeRequestDiscussionNote).toHaveBeenLastCalledWith(2, 1, 'thread', expect.stringContaining('/reset'));
  }
  mr.assignees = [bot];
  await send(note('/help'));
  expect(gitlab.createMergeRequestNote).toHaveBeenCalledWith(2, 1, expect.stringContaining('移出 Assignee'));
  expect(await session()).toBeNull();
  expect(run).not.toHaveBeenCalled();
  await send(opened);
  expect(gitlab.updateMergeRequestNote).toHaveBeenLastCalledWith(2, 1, expect.any(Number), expect.stringContaining('已接管此 MR'));
  await send(note('/reset'));
  expect(gitlab.updateMergeRequestNote).toHaveBeenLastCalledWith(2, 1, expect.any(Number), 'fixed');
});
