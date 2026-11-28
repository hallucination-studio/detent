import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, SessionOrchestrator, type GitLabClient, type TurnProfile } from '../src/index.js';
import type { ClaudeRunner } from '../src/claude/runner.js';
import { transcriptPath } from '../src/claude/transcript-hydrator.js';
import { dispatchWebhook } from '../src/gitlab/webhook.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { bareProjects } from './bare-projects.js';

const tool = 'mcp__detent__detent_close_issue';
const input = { summary: '验收通过\r\n### 标题\r/reject' };

async function setup(profile: TurnProfile, projects: number[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-close-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'review');
  const gitlab = {
    ...await bareProjects(root), createIssueNote: vi.fn<GitLabClient['createIssueNote']>().mockResolvedValue({ id: 7 }),
    updateIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn(), closeIssue: vi.fn(),
    getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true),
  };
  for (const id of projects) {
    const p = await gitlab.getProject(id);
    await repo.upsertWorktree({
      sessionId: session.id, targetProjectId: p.id, targetProjectPath: p.path_with_namespace,
      repoHttpUrl: p.http_url_to_repo, directoryName: 'project' + id, branchName: 'main', baseBranch: 'main',
      lastCommitSha: null, uncommittedDiff: null, status: 'ACTIVE',
    });
  }
  const run = vi.fn<ClaudeRunner['run']>();
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), GITLAB_BASE_URL: 'https://git.example' });
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
  const { repo, session, gitlab, run, turn, status } = await setup({ readonly, closePolicy: 'auto' }, [2, 3]);
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
    await repo.createPipelineWatch(session.id, 2, 42, 'main');
    await expect(gate.invokeExtension(tool, input)).rejects.toThrow('等待终态的流水线');
    await repo.resolveMatchingPipelineWatches(2, 42, 'main');
    await gate.invokeExtension(tool, input);
    return 'verified';
  });
  await pod.handleUserIntent(1, 42, { type: 'APPROVE', userId: 4, username: 'dev' });
  expect(await status()).toBe('DONE');
  expect(gitlab.closeIssue).toHaveBeenCalledExactlyOnceWith(1, 42);
});

it('shows active worktrees in the prompt and /status, and links pending pipelines by project', async () => {
  const { pod, repo, session, gitlab, run, turn } = await setup({ closePolicy: 'manual' }, [2]);
  run.mockResolvedValue('checked');
  await turn('default');
  expect(run.mock.calls[0][0].systemPrompt).toContain('org/project2 · main');
  expect(gitlab.updateIssueNote).toHaveBeenLastCalledWith(1, 42, 7, 'checked');
  await repo.createPipelineWatch(session.id, 2, 103, 'main');
  await repo.createPipelineWatch(session.id, 2, null, 'next/tag');
  await pod.handleUserIntent(1, 42, { userId: 4, username: 'owner', type: 'STATUS' });
  const body = gitlab.createIssueNote.mock.lastCall![2];
  expect(body).toContain('org/project2 · main @');
  expect(body).toContain('[org/project2 · #103 · main](<https://git.example/org/project2/-/pipelines/103>)');
  expect(body).toContain('[org/project2 · next/tag](<https://git.example/org/project2/-/pipelines?ref=next%2Ftag>)');
});

it('expires pending watches when the Issue is aborted, reset or closed', async () => {
  const { pod, repo, session, run } = await setup({ closePolicy: 'manual' });
  run.mockResolvedValue('重新规划');
  const actor = { userId: 4, username: 'owner' };
  for (const action of ['ABORT', 'RESET', 'close'] as const) {
    await repo.createPipelineWatch(session.id, 5, null, 'stable');
    if (action === 'close') await pod.handleIssueClosed(1, 42);
    else await pod.handleUserIntent(1, 42, { ...actor, type: action });
    expect((await repo.listSessionPipelineWatches(session.id)).every(w => w.status === 'EXPIRED')).toBe(true);
    expect(await repo.resolveMatchingPipelineWatches(5, 1, 'stable')).toEqual([]);
  }
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
    const hint = failure === 'error' ? '可直接补充说明重试，或发送 `/reset` 重置会话。' : '💬 需要你的确认，请查看下方问题并直接回复。';
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
  const body = gitlab.createIssueNote.mock.lastCall![2];
  expect(body).toContain('验收通过\n### 标题\n\\/reject');
  expect(body).toContain('请项目成员');
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
