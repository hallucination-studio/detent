import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, SessionOrchestrator, type TurnProfile } from '../src/index.js';
import type { ClaudeRunner } from '../src/claude/runner.js';
import { transcriptPath } from '../src/claude/transcript-hydrator.js';
import { dispatchWebhook } from '../src/gitlab/webhook.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { bareProjects } from './bare-projects.js';

const tool = 'mcp__detent__detent_close_issue';
const input = { summary: '验收通过\r\n### 标题\r/reject' };

async function setup(profile: TurnProfile) {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-close-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'review');
  const gitlab = {
    ...await bareProjects(root), createIssueNote: vi.fn(async () => ({ id: 7 })),
    updateIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn(), closeIssue: vi.fn(),
    getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true),
  };
  const run = vi.fn<ClaudeRunner['run']>();
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
  const pod = new SessionOrchestrator(config, repo, gitlab, { run }, {
    resolveTurnProfile: () => ({ ...profile, enabledExtensionTools: [] }),
  });
  const turn = (permissionMode: 'plan' | 'default') => pod.resumeSession(session.id, 'review', { permissionMode });
  const status = async () => (await repo.getSession(session.id))?.status;
  return { repo, session, gitlab, run, pod, turn, status };
}

it('keeps manual workflows open without advertising or registering the close tool', async () => {
  const { gitlab, run, turn, status } = await setup({ closePolicy: 'manual' });
  run.mockImplementation(async ({ gate, systemPrompt }) => {
    expect(gate.extensionTools.has(tool)).toBe(false);
    expect(systemPrompt).not.toContain('detent_close_issue');
    return 'reviewed';
  });
  await turn('default');
  expect(await status()).toBe('IDLE');
  expect(gitlab.closeIssue).not.toHaveBeenCalled();
});

it.each([true, false])('checkpoints, archives work and publishes the final note before closing (readonly=%s)', async readonly => {
  const { repo, session, gitlab, run, turn, status } = await setup({ readonly, closePolicy: 'auto' });
  for (const project of [2, 3]) {
    const p = await gitlab.getProject(project);
    await repo.upsertWorktree({
      sessionId: session.id, targetProjectId: p.id, targetProjectPath: p.path_with_namespace,
      repoHttpUrl: p.http_url_to_repo, directoryName: 'project' + project, branchName: 'main', baseBranch: 'main',
      lastCommitSha: null, uncommittedDiff: null, status: 'ACTIVE',
    });
  }
  run.mockImplementation(async ({ gate, systemPrompt, sandbox, session }) => {
    expect(systemPrompt).toContain('detent_close_issue');
    expect(await gate.invokeExtension(tool, input)).toEqual({ scheduled: true, ...input });
    expect(gitlab.closeIssue).not.toHaveBeenCalled();
    const file = transcriptPath(sandbox.claudeHome, sandbox.workspaceRoot, session.claudeSessionId!);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"type":"assistant"}\n');
    return 'final report';
  });
  gitlab.closeIssue.mockImplementation(async () => {
    expect(await repo.getSessionMessages(session.id)).toHaveLength(1);
    expect(gitlab.updateIssueNote).toHaveBeenLastCalledWith(1, 42, 7, 'final report');
    for (const project of [2, 3])
      expect(await repo.findWorktree(session.id, project, 'main')).toMatchObject({
        status: 'ARCHIVED', lastCommitSha: expect.any(String),
      });
  });
  await turn(readonly ? 'plan' : 'default');
  expect(await status()).toBe('DONE');
  expect(gitlab.closeIssue).toHaveBeenCalledExactlyOnceWith(1, 42);
  expect(gitlab.syncIssueStatusLabel).toHaveBeenLastCalledWith(1, 42, 'DONE');
});

it('requires an approved plan, resolved approvals and merged MRs before scheduling closure', async () => {
  const { repo, session, gitlab, run, pod, turn, status } = await setup({ closePolicy: 'auto' });
  run.mockImplementationOnce(async ({ gate }) => {
    await expect(gate.invokeExtension(tool, input)).rejects.toThrow('方案尚未批准');
    await gate.invokeExtension('mcp__detent__detent_submit_plan', { plan: 'Finish and verify the work' });
    return 'plan';
  });
  await turn('plan');
  expect(await status()).toBe('WAITING_PLAN');
  expect(gitlab.closeIssue).not.toHaveBeenCalled();
  run.mockImplementationOnce(async ({ gate }) => {
    const pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'detent_create_release', {});
    await expect(gate.invokeExtension(tool, input)).rejects.toThrow('尚有待审批项');
    await repo.resolveApprovalRequest(pending.id, 'REJECTED', 'dev');
    const mr = await repo.upsertMergeRequest({
      sessionId: session.id, targetProjectId: 2, targetProjectPath: 'org/app', mrIid: 3, mrTitle: 'change',
      mrWebUrl: 'https://git/org/app/-/merge_requests/3', sourceBranch: 'change', targetBranch: 'main',
      worktreeId: null, mrState: 'opened', latestPipelineId: null, latestPipelineStatus: null,
    });
    await expect(gate.invokeExtension(tool, input)).rejects.toThrow('尚有未合并的 MR');
    await repo.markMergeRequestMerged(mr.id, 'abc', 'dev');
    await gate.invokeExtension(tool, input);
    return 'verified';
  });
  await pod.handleUserIntent(1, 42, { type: 'APPROVE', userId: 4, username: 'dev' });
  expect(await status()).toBe('DONE');
  expect(gitlab.closeIssue).toHaveBeenCalledExactlyOnceWith(1, 42);
});

it.each(['error', 'abort during flush', 'cold hold', 'new blocker'])('discards a scheduled close on %s', async failure => {
  const { gitlab, run, turn, status, repo, session } = await setup({ closePolicy: 'auto' });
  const scheduled = vi.fn();
  run.mockImplementation(async ({ gate, controller }) => {
    scheduled(await gate.invokeExtension(tool, input));
    if (failure === 'error') throw Error('run failed');
    if (failure === 'abort during flush') gitlab.updateIssueNote.mockImplementationOnce(() => controller.abort());
    if (failure === 'cold hold') await gate.canUseTool('AskUserQuestion', { questions: [{ question: '确认？' }] });
    if (failure === 'new blocker') await repo.createApprovalRequest(session.id, 'TOOL_USE', 'detent_create_release', {});
    return 'reviewed';
  });
  await turn('default');
  expect(scheduled).toHaveBeenCalledExactlyOnceWith({ scheduled: true, ...input });
  expect(await status()).toBe(failure === 'cold hold' ? 'WAITING_TOOL' : 'FAILED');
  if (failure === 'error' || failure === 'cold hold') {
    const hint = failure === 'error' ? '可直接补充说明重试，或发送 `/reset` 重置会话。' : '💬 **等待你的确认** · 请直接回复确认内容';
    expect(gitlab.updateIssueNote).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), expect.any(Number), expect.stringContaining(hint));
  }
  expect(gitlab.closeIssue).not.toHaveBeenCalled();
});

it.each(['thumbsup', 'thumbsdown'])('honors %s on a readonly close approval after cold hold', async reaction => {
  const { gitlab, repo, session, run, pod, turn, status } = await setup({ readonly: true, closePolicy: 'approve' });
  run.mockImplementation(async ({ gate }) => {
    await gate.invokeExtension(tool, input);
    return 'reviewed';
  });
  await turn('plan');
  expect(await status()).toBe('WAITING_TOOL');
  expect(gitlab.closeIssue).not.toHaveBeenCalled();
  const card = (await repo.getLatestPendingApproval(session.id))!;
  expect(gitlab.createIssueNote).toHaveBeenCalledWith(1, 42, expect.stringContaining([
    '### ✅ 工单闭环关闭审批', '', '验收通过', '### 标题', '\\/reject', '',
    '> 👍 或 `/approve` 确认关闭 · 👎 或 `/reject <原因>` 拒绝 · <sub>审批单 `' + card.id + '`</sub>',
  ].join('\n')));
  if (reaction === 'thumbsdown') run.mockImplementationOnce(async ({ gate }) => {
    await expect(gate.invokeExtension(tool, input)).rejects.toThrow('拒绝');
    return 'kept open';
  });
  await dispatchWebhook(pod, {
    object_kind: 'emoji', project_id: 1, issue: { iid: 42 }, user: { id: 4, username: 'dev' },
    object_attributes: { awardable_type: 'Note', awardable_id: card.gitlabNoteId!, name: reaction },
  });
  expect(await status()).toBe(reaction === 'thumbsup' ? 'DONE' : 'IDLE');
  expect(gitlab.closeIssue).toHaveBeenCalledTimes(reaction === 'thumbsup' ? 1 : 0);
});

it('preserves DONE when GitLab accepts the close but label synchronization fails', async () => {
  const { run, turn, gitlab, status } = await setup({ readonly: true, closePolicy: 'auto' });
  run.mockImplementation(async ({ gate }) => {
    await gate.invokeExtension(tool, input);
    return 'reviewed';
  });
  gitlab.syncIssueStatusLabel.mockImplementation(async (_project, _iid, status) => {
    if (status === 'DONE') throw Error('label sync failed');
  });
  await expect(turn('plan')).rejects.toThrow('label sync failed');
  expect(await status()).toBe('DONE');
  expect(gitlab.closeIssue).toHaveBeenCalledExactlyOnceWith(1, 42);
});
