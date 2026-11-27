import { MergeRequestOrchestrator } from '../../core/src/orchestrator/mr-orchestrator.js';
import { GitLabClient } from '../../core/src/gitlab/client.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createWebhookApp, loadConfig, SessionOrchestrator } from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { transcriptPath } from '../../core/src/claude/transcript-hydrator.js';
import { dispatchWebhook } from '../../core/src/gitlab/webhook.js';
import { WebhookQueue } from '../../core/src/gitlab/webhook-queue.js';
import { bareProjects } from '../../core/tests/bare-projects.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { matchMergeRequestWebhook } from '../src/index.js';

const hub = { id: 1 };
const issue = { iid: 42, title: 'Update config', action: 'open' };
const user = { id: 7, username: 'maintainer' };
const sha = '1234abcd'.repeat(5);
const url = 'https://git/org/project2/-/merge_requests/5';
const merge = {
  object_kind: 'merge_request', project: { id: 2 }, user,
  object_attributes: { iid: 5, action: 'merge', state: 'merged', merge_commit_sha: sha, last_commit: { id: 'different' } },
};

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-mr-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), GITLAB_WEBHOOK_SECRET: 'test' });
  const repo = new InMemoryDetentRepository();
  let noteId = 0;
  const gitlab = {
    ...(await bareProjects(root)), isBotUser: () => false, getIssue: vi.fn(),
    hasApprovalPermission: async () => true, syncIssueStatusLabel: vi.fn(), updateIssueNote: vi.fn(),
    createIssueNote: vi.fn(async (_project: number, _iid: number, _body: string) => ({ id: ++noteId })),
  };
  const branches = { source_branch: 'change-42', target_branch: 'main' };
  gitlab.createMergeRequest.mockResolvedValue({ iid: 5, title: issue.title, web_url: url, state: 'opened', ...branches });
  async function recordTurn(turn: TurnInput) {
    const file = transcriptPath(turn.sandbox.claudeHome, turn.sandbox.workspaceRoot, turn.session.claudeSessionId!);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify({ type: 'assistant', prompt: turn.prompt }) + '\n');
    if (turn.session.permissionMode === 'plan') await turn.gate.invokeExtension('mcp__detent__detent_submit_plan', { plan: 'Prepare the MR.' });
    return 'done';
  }
  const run = vi.fn(recordTurn);
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run });
  const report = vi.fn();
  const clientForMr = Object.assign(new GitLabClient(config, async () => { throw Error('Unexpected GitLab API call'); }), gitlab);
  const mrs = new MergeRequestOrchestrator(config, repo, clientForMr, { run }, { runHubEvent: vi.fn() });
  const queue = new WebhookQueue((event, id) => dispatchWebhook(orchestrator, event, id, mrs), report);
  const app = createWebhookApp(config, gitlab, (id, event) => queue.submit(id, event), matchMergeRequestWebhook);
  onTestFinished(async () => {
    queue.stop();
    await queue.drain();
    await app.close();
    expect(report).not.toHaveBeenCalled();
  });
  const post = (payload: object) => app.inject({
    method: 'POST', url: '/webhooks/gitlab', payload,
    headers: { 'x-gitlab-token': 'test', 'x-gitlab-event-uuid': randomUUID() },
  });
  expect((await post({ object_kind: 'issue', user, project: hub, object_attributes: issue })).statusCode).toBe(202);
  await queue.drain();
  const session = (await repo.getSessionByIssue(hub.id, issue.iid))!;
  expect(session.status).toBe('WAITING_PLAN');

  async function approveAndCreateMr() {
    run.mockImplementationOnce(async turn => {
      await turn.tools.invoke('detent_create_mr', { project: 2, title: issue.title, ...branches });
      return recordTurn(turn);
    });
    await post({ object_kind: 'note', user, project: hub, issue,
      object_attributes: { id: 20, noteable_type: 'Issue', note: '/approve' } });
    await queue.drain();
    const [mr] = await repo.findMergeRequest(2, 5);
    expect(mr).toMatchObject({ sessionId: session.id, mrState: 'opened' });
    return mr;
  }
  const mergeNotes = () => gitlab.createIssueNote.mock.calls.filter(([, , body]) => body.startsWith('✅ 关联 MR'));
  return { post, queue, session, repo, run, approveAndCreateMr, mergeNotes };
}

it('records a cross-project merge and resumes the approved Claude session once across distinct deliveries', async () => {
  const { post, queue, session, repo, run, approveAndCreateMr, mergeNotes } = await setup();
  const mr = await approveAndCreateMr();
  const worker = await repo.getOrCreateMrSession(2, 5, issue.title);
  const mark = vi.spyOn(repo, 'markMergeRequestMerged');
  const withoutUserId = { ...merge, user: { username: user.username } };
  expect((await post(withoutUserId)).statusCode).toBe(202);
  expect((await post(withoutUserId)).statusCode).toBe(202);
  await queue.drain();
  expect(await repo.findMergeRequest(2, 5)).toMatchObject([{
    id: mr.id, mrState: 'merged', mergeCommitSha: sha, mergedBy: user.username, mergedAt: expect.any(Date),
  }]);
  expect((await repo.getSession(worker.id))?.status).toBe('DONE');
  expect(mark).toHaveBeenCalledExactlyOnceWith(mr.id, sha, user.username);
  expect(mergeNotes()).toEqual([[hub.id, issue.iid,
    `✅ 关联 MR [org/project2!5](<${url}>) 已由 @maintainer 合并 (commit 1234abcd)，正在自动恢复变更会话…`]]);
  expect(run).toHaveBeenCalledTimes(3);
  const [turn] = run.mock.calls[2];
  expect(turn).toMatchObject({
    resume: true, session: { id: session.id, claudeSessionId: session.claudeSessionId },
    systemPrompt: expect.stringContaining('merged @ 1234abcd · Pipeline'),
  });
  expect(turn.systemPrompt).toContain('已获方案审批');
  for (const value of ['org/project2!5', url, 'change-42', 'main', '@maintainer', sha])
    expect(turn.prompt).toContain(value);
});

it('ignores a blank username and uses the stored MR URL when the webhook URL is unsafe', async () => {
  const { post, queue, repo, run, approveAndCreateMr, mergeNotes } = await setup();
  await approveAndCreateMr();
  const blank = await post({ ...merge, user: { ...user, username: '   ' } });
  expect(blank.json()).toEqual({ ignored: true });

  const unsafeUrl = 'https://user:password@git.example/merge_requests/5';
  const accepted = await post({
    ...merge, user: { ...user, username: ' maintainer ' },
    object_attributes: { ...merge.object_attributes, url: unsafeUrl },
  });
  expect(accepted.statusCode).toBe(202);
  await queue.drain();
  expect(await repo.findMergeRequest(2, 5)).toMatchObject([{ mergedBy: 'maintainer' }]);
  expect(mergeNotes()).toEqual([[hub.id, issue.iid, expect.stringContaining(`[org/project2!5](<${url}>)`)]]);
  const [turn] = run.mock.lastCall!;
  expect(turn.prompt).toContain(url);
  expect(turn.prompt).not.toContain(unsafeUrl);
});

it('retries a busy lease before recording a fast-forward merge', async () => {
  const { post, queue, session, repo, run, approveAndCreateMr, mergeNotes } = await setup();
  const mr = await approveAndCreateMr();
  await repo.acquireSessionLease(session.id, 'other-worker', 30);
  const acquire = vi.spyOn(repo, 'acquireSessionLease');
  const mark = vi.spyOn(repo, 'markMergeRequestMerged');
  try {
    expect((await post({ ...merge, object_attributes: {
      iid: 5, action: 'merge', merge_commit_sha: null, last_commit: { id: sha },
    } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    expect(await repo.findMergeRequest(2, 5)).toEqual([mr]);
    expect(mark).not.toHaveBeenCalled();
    expect(mergeNotes()).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    await repo.releaseSessionLease(session.id, 'other-worker');
  }
  await queue.drain();
  expect(mark).toHaveBeenCalledExactlyOnceWith(mr.id, sha, user.username);
  expect(mergeNotes()).toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(3);
  expect(run.mock.calls[2][0]).toMatchObject({ resume: true, prompt: expect.stringContaining(sha) });
});

it.each(['WAITING_PLAN', 'WAITING_TOOL'] as const)('keeps the pending approval intact during %s', async status => {
  const { post, queue, session, repo, run, mergeNotes } = await setup();
  if (status === 'WAITING_TOOL') {
    await repo.resolveApprovalRequest((await repo.getLatestPendingApproval(session.id))!.id, 'APPROVED', user.username);
    await repo.createApprovalRequest(session.id, 'TOOL_USE', 'Bash', { command: 'tool' });
    await repo.updateSessionState(session.id, { status, permissionMode: 'default' });
  }
  const pending = await repo.getLatestPendingApproval(session.id);
  expect(pending?.status).toBe('PENDING');
  await repo.upsertMergeRequest({
    sessionId: session.id, targetProjectId: 2, targetProjectPath: 'org/project2', mrIid: 5,
    mrTitle: issue.title, mrWebUrl: url, worktreeId: null, mrState: 'opened',
    sourceBranch: 'change-42', targetBranch: 'main', latestPipelineId: null, latestPipelineStatus: null,
  });
  const before = (await repo.getSession(session.id))!;
  expect((await post(merge)).statusCode).toBe(202);
  await queue.drain();
  expect(await repo.findMergeRequest(2, 5)).toMatchObject([{ mrState: 'merged', mergedBy: user.username, mergeCommitSha: sha }]);
  expect(await repo.getLatestPendingApproval(session.id)).toEqual(pending);
  expect(await repo.getSession(session.id)).toMatchObject({
    status, permissionMode: before.permissionMode, activeNoteId: before.activeNoteId, lockedByPod: null,
  });
  expect(mergeNotes()).toEqual([[hub.id, issue.iid, expect.stringContaining('会话正在等待审批，审批后将继续')]]);
  expect(run).toHaveBeenCalledOnce();
});

it('ignores other MR actions, inconsistent state and untracked merges', async () => {
  const { post, queue, run, repo, mergeNotes } = await setup();
  for (const [action, state] of [['open', 'opened'], ['update', 'merged'], ['merge', 'opened']]) {
    const response = await post({ ...merge, object_attributes: { ...merge.object_attributes, action, state } });
    expect(response.json()).toEqual({ ignored: true });
  }
  expect((await post({ ...merge, object_attributes: { ...merge.object_attributes, action: 'close', state: 'closed' } })).statusCode).toBe(202);
  const mark = vi.spyOn(repo, 'markMergeRequestMerged');
  expect((await post(merge)).statusCode).toBe(202);
  await queue.drain();
  expect(mark).not.toHaveBeenCalled();
  expect(mergeNotes()).toHaveLength(0);
  expect(run).toHaveBeenCalledOnce();
});

it('records a merge after Issue closure without resuming the session', async () => {
  const { post, queue, session, repo, run, approveAndCreateMr, mergeNotes } = await setup();
  const mr = await approveAndCreateMr();
  await post({ object_kind: 'issue', project: hub, user, object_attributes: { ...issue, action: 'close' } });
  await queue.drain();
  await post(merge);
  await queue.drain();
  expect(await repo.findMergeRequest(2, 5)).toMatchObject([{
    id: mr.id, mrState: 'merged', mergeCommitSha: sha, mergedBy: user.username,
  }]);
  expect((await repo.getSession(session.id))?.status).toBe('DONE');
  expect(mergeNotes()).toHaveLength(0);
  expect(run).toHaveBeenCalledTimes(2);
});
