import { MergeRequestOrchestrator } from '../src/orchestrator/mr-orchestrator.js';
import { GitLabClient } from '../src/gitlab/client.js';
import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, appendFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { createWebhookApp, dispatchWebhook } from '../src/gitlab/webhook.js';
import { SessionBusy, SessionOrchestrator } from '../src/orchestrator/session-orchestrator.js';
import { WebhookQueue } from '../src/gitlab/webhook-queue.js';
import { transcriptPath } from '../src/claude/transcript-hydrator.js';
import type { TurnInput } from '../src/claude/runner.js';
import { bareProjects } from './bare-projects.js';
import type { GitLabWebhookPayload } from '../src/types.js';
import type { DetentExtensions } from '../src/extensions.js';

const actor = { id: 7, username: 'dev', name: 'dev' };
const project = { id: 1, path_with_namespace: 'org/hub', http_url_to_repo: 'https://git/hub' };
const issue = {
  id: 123,
  iid: 42,
  title: 'two services',
  description: 'implement',
  state: 'opened' as const,
  action: 'open' as const,
  url: '',
};
const opened = { object_kind: 'issue' as const, project, user: actor, object_attributes: issue };
const note = (body: string, user = actor) => ({
  object_kind: 'note' as const,
  project,
  user,
  issue,
  object_attributes: { id: 7, note: body, noteable_id: 123, noteable_type: 'Issue' as const, url: '' },
});
const emoji = (id: number) => ({
  object_kind: 'emoji' as const,
  project,
  project_id: 1,
  user: actor,
  issue,
  object_attributes: {
    id: 1,
    awardable_type: 'Note' as const,
    awardable_id: id,
    name: 'thumbsup',
    action: 'award' as const,
  },
});
async function mockGitLab(root: string) {
  const notes: string[] = [];
  return {
    ...(await bareProjects(root)),
    notes,
    isBotUser: (id?: number) => id === 99,
    getBotIdentity: () => ({ id: 99, username: 'bot', name: 'Bot' }),
    getIssue: vi.fn(async (_project: number, _iid: number) => ({ ...issue, labels: ['review'] })),
    hasApprovalPermission: async (_: number, user: number) => user === actor.id,
    createIssueNote: async (_: number, __: number, body: string) => ({ id: notes.push(body) }),
    updateIssueNote: async (_: number, __: number, id: number, body: string) => { notes[id - 1] = body; },
    syncIssueStatusLabel: vi.fn(),
  };
}

it('resumes a cold Bash approval, answers a hot question and reports two MRs and a pipeline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-flow-'));
  try {
    const gitlab = await mockGitLab(root);
    gitlab.createMergeRequest.mockImplementation(async (p, i) => ({
      iid: 1,
      title: i.title,
      web_url: 'https://git/' + p + '/mr/1',
      state: 'opened',
      source_branch: i.source_branch,
      target_branch: i.target_branch,
    }));
    const repo = new InMemoryDetentRepository();
    const config = loadConfig({
      EPHEMERAL_ROOT: path.join(root, 'turns'),
      GITLAB_WEBHOOK_SECRET: 'test',
    });
    const dirs: string[] = [];
    const ids = new Set<string>();
    const runner = {
      run: vi.fn(async (t: TurnInput) => {
        dirs.push(t.sandbox.rootDir);
        const id = t.session.claudeSessionId!;
        ids.add(id);
        const file = transcriptPath(t.sandbox.claudeHome, t.sandbox.workspaceRoot, id);
        await mkdir(path.dirname(file), { recursive: true });
        const log = async (type: string) =>
          appendFile(file, JSON.stringify({ uuid: randomUUID(), type }) + '\n');
        if (t.session.permissionMode === 'plan') {
          expect(t.resume).toBe(false);
          await log('plan');
          return '方案：修改两个服务。';
        }
        expect(t.resume).toBe(true);
        expect(await readFile(file, 'utf8')).toContain('"type":"plan"');
        const paths: string[] = [];
        for (const project of [2, 3])
          paths.push(
            String(await t.tools.invoke('detent_checkout_worktree', { project, branch_name: 'issue/42' })),
          );
        const edited = path.join(t.sandbox.workspaceRoot, 'projects', paths[0], 'work');
        if (dirs.length === 2) {
          await writeFile(edited, 'in progress');
          await log('coding');
        } else expect(await readFile(edited, 'utf8')).toBe('in progress');
        const permission = await t.gate.canUseTool('Bash', { command: 'npm install ioredis' });
        expect(permission.behavior).toBe('allow');
        const question = await t.gate.canUseTool('AskUserQuestion', { questions: [{ question: '目标分支？' }] });
        expect(question).toMatchObject({ behavior: 'allow', updatedInput: { answers: { '目标分支？': 'main' } } });
        for (const [i, dir] of paths.entries()) {
          await writeFile(path.join(t.sandbox.workspaceRoot, 'projects', dir, 'done'), 'yes');
          await t.tools.invoke('detent_commit_and_push', {
            directory_name: dir,
            commit_message: 'implement',
          });
          await t.tools.invoke('detent_create_mr', {
            project: i + 2,
            source_branch: 'issue/42',
            target_branch: 'main',
            title: 'feature',
          });
        }
        await log('done');
        t.progress('完成两个项目');
        return '完成';
      }),
    };
    const errors: unknown[] = [];
    function pod(podId: string, hotHoldTimeoutMs: number) {
      const orch = new SessionOrchestrator({ ...config, podId, hotHoldTimeoutMs }, repo, gitlab, runner);
      const client = Object.assign(new GitLabClient(config, async () => { throw Error('Unexpected GitLab API call'); }), gitlab, {
        listOpenMergeRequestsByBranch: vi.fn().mockResolvedValue([{ iid: 1 }]),
        getMergeRequest: vi.fn().mockResolvedValue({ iid: 1, state: 'opened', assignees: [] }),
        getRepositoryFile: vi.fn().mockResolvedValue(null),
      });
      const mrs = new MergeRequestOrchestrator(config, repo, client, runner, { runHubEvent: vi.fn() });
      return new WebhookQueue((event, id) => dispatchWebhook(orch, event, id, mrs), error => errors.push(error));
    }
    let route = pod('A', 0);
    const app = createWebhookApp(config, gitlab, (id, event) => route.submit(id, event));
    const send = async (e: GitLabWebhookPayload) =>
      app.inject({
        url: '/webhooks/gitlab',
        method: 'POST',
        headers: { 'x-gitlab-token': 'test', 'idempotency-key': randomUUID() },
        payload: e,
      });
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({ ok: true });
    expect(
      (await app.inject({ url: '/webhooks/gitlab', method: 'POST', payload: opened })).statusCode,
    ).toBe(401);
    expect((await send({ ...opened, user: { ...actor, id: 99 } })).statusCode).toBe(200);
    expect(await repo.getSessionByIssue(1, 42)).toBeNull();
    expect((await send(opened)).statusCode).toBe(202);
    await route.drain();
    const s = (await repo.getSessionByIssue(1, 42))!;
    expect(s.status).toBe('WAITING_PLAN');
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
    const plan = (await repo.getLatestPendingApproval(s.id))!;
    expect(plan.toolInput).toEqual({});
    expect(gitlab.notes[plan.gitlabNoteId! - 1]).toContain('方案：修改两个服务。');
    await send(note('/approve', { ...actor, id: 9 }));
    await route.drain();
    expect((await repo.getApproval(plan.id))?.status).toBe('PENDING');
    await send(emoji(plan.gitlabNoteId! + 10));
    await route.drain();
    expect(runner.run).toHaveBeenCalledTimes(1);
    // Approval can arrive while the planning worker is still releasing its lease.
    await repo.acquireSessionLease(s.id, 'planning-worker', 10);
    await send(emoji(plan.gitlabNoteId!));
    await vi.waitFor(async () => expect((await repo.getApproval(plan.id))?.status).toBe('APPROVED'));
    await repo.releaseSessionLease(s.id, 'planning-worker');
    await route.drain();
    expect(await repo.getLatestPendingApproval(s.id)).toMatchObject({ approvalType: 'TOOL_USE' });
    expect(runner.run.mock.calls[1][0].prompt).toBe('实施方案已获批准，请按方案开始实施。');
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
    route = pod('B', 15000);
    await send(note('/approve'));
    await vi.waitFor(async () => {
      expect(await repo.getLatestPendingApproval(s.id)).toMatchObject({ approvalType: 'ASK_USER' });
    }, { timeout: 10000 });
    await send(note('/approve main'));
    await route.drain();
    expect(await repo.getSession(s.id)).toMatchObject({
      status: 'IDLE',
      lockedByPod: null,
      lastMessageSeq: 3,
    });
    expect(ids.size).toBe(1);
    expect(runner.run.mock.calls[2][0].prompt).toContain('工具 Bash，参数 {"command":"npm install ioredis"}');
    expect(new Set(dirs).size).toBe(3);
    expect(await repo.listSessionMergeRequests(s.id)).toHaveLength(2);
    for (const [, input] of gitlab.createMergeRequest.mock.calls) expect(input.assignee_ids).toEqual([99]);
    await send({
      object_kind: 'pipeline',
      project: { ...project, id: 3, web_url: '' },
      object_attributes: { id: 77, ref: 'issue/42', sha: 'abc', status: 'failed' },
    });
    await route.drain();
    expect((await repo.findMergeRequestByBranch(3, 'issue/42'))[0].latestPipelineStatus).toBe('failed');
    expect(gitlab.notes.at(-1)).toContain('Pipeline #77 failed');
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
    expect(errors).toEqual([]);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it('revises plans, ignores superseded cards, resets transcript context and reports status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-revision-'));
  try {
    const gitlab = await mockGitLab(root);
    const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
    const repo = new InMemoryDetentRepository();
    const modes: string[] = [];
    const runner = {
      run: vi.fn(async (t: TurnInput) => {
        const transcript = transcriptPath(
          t.sandbox.claudeHome,
          t.sandbox.workspaceRoot,
          t.session.claudeSessionId!,
        );
        modes.push(t.session.permissionMode);
        await mkdir(path.dirname(transcript), { recursive: true });
        if (t.resume) expect((await readFile(transcript, 'utf8')).length).toBeGreaterThan(0);
        else await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
        await appendFile(transcript, JSON.stringify({ type: 'assistant', uuid: randomUUID() }) + '\n');
        return t.prompt;
      }),
    };
    const pod = new SessionOrchestrator(config, repo, gitlab, runner);
    await pod.handleIssueOpened(opened);
    const first = (await repo.getSessionByIssue(1, 42))!;
    const original = (await repo.getLatestPendingApproval(first.id))!;
    const send = (e: GitLabWebhookPayload) => dispatchWebhook(pod, e);
    await send(note('换一个方案'));
    expect((await repo.getApproval(original.id))?.status).toBe('EXPIRED');
    await send(emoji(original.gitlabNoteId!));
    await send(note('/reject 增加测试步骤'));
    expect(modes).toEqual(['plan', 'plan', 'plan']);
    expect(runner.run.mock.calls[2][0].prompt).toBe('实施方案未获批准，请重新调整方案。\n修改意见：增加测试步骤');
    await send(note('/approve 先修改网关'));
    expect(runner.run.mock.calls[3][0].prompt).toBe('实施方案已获批准，请按方案开始实施。\n附加说明：先修改网关');
    await send(note('/plan 评估下一步'));
    await send(note('/abort'));
    await send(note('/status'));
    expect(gitlab.notes.at(-1)).toContain('IDLE');
    expect(await repo.getLatestPendingApproval(first.id)).toBeNull();
    await send(note('/reset Fresh start'));
    expect(runner.run.mock.calls.at(-1)![0].prompt).toBe('Fresh start');
    expect(modes).toEqual(['plan', 'plan', 'plan', 'default', 'plan', 'plan']);
    const reset = (await repo.getSessionByIssue(1, 42))!;
    expect(reset.id).toBe(first.id);
    expect(reset.claudeSessionId).not.toBe(first.claudeSessionId);
    expect(reset.lastMessageSeq).toBe(1);
    expect(await repo.getSessionMessages(first.id)).toHaveLength(1);
    await pod.handleIssueClosed(1, 42);
    const reopened = { ...opened, object_attributes: { ...issue, action: 'reopen' as const } };
    await send(reopened);
    await send(reopened);
    expect(await repo.getSessionByIssue(1, 42)).toMatchObject({
      id: reset.id, status: 'WAITING_PLAN', permissionMode: 'plan', claudeSessionId: reset.claudeSessionId,
      lastMessageSeq: 2,
    });
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('interrupts a lease using the database clock when the pod reads its DATETIME in a different timezone', async () => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, issue.title);
  await repo.acquireSessionLease(session.id, 'worker', 300);
  const live = (await repo.getSession(session.id))!;
  vi.spyOn(repo, 'getSessionByIssue').mockResolvedValue({ ...live, lockExpiresAt: new Date(Date.now() - 8 * 3600_000) });
  const dir = await mkdtemp(path.join(tmpdir(), 'detent-stop-'));
  try {
    const pod = new SessionOrchestrator(loadConfig({}), repo, await mockGitLab(dir), { run: vi.fn() });
    await expect(pod.handleUserIntent(1, 42, { userId: 7, username: 'dev', type: 'ABORT' })).rejects.toBeInstanceOf(SessionBusy);
    expect(await repo.stopRequested(session.id, 'worker')).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('stops waiting for an approval lease when the original pod resumes coding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-approval-'));
  try {
    const repo = new InMemoryDetentRepository();
    const s = await repo.getOrCreateSession(1, 42, 'test');
    await repo.acquireSessionLease(s.id, 'original-pod', 30);
    await repo.updateSessionState(s.id, { status: 'WAITING_TOOL', permissionMode: 'default' });
    const approval = await repo.createApprovalRequest(s.id, 'TOOL_USE', 'Bash', { command: 'npm install' });
    const runner = { run: vi.fn() };
    const pod = new SessionOrchestrator(loadConfig({}), repo, await mockGitLab(root), runner);
    const acquire = vi.spyOn(repo, 'acquireSessionLease');
    const handling = dispatchWebhook(pod, note('/approve'));
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    expect((await repo.getApproval(approval.id))?.status).toBe('APPROVED');
    await repo.updateSessionState(s.id, { status: 'CODING' });
    await handling;
    expect(acquire).toHaveBeenCalledOnce();
    expect((await repo.getSession(s.id))?.lockedByPod).toBe('original-pod');
    expect(runner.run).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([[1, 333], [300, 15000]])('renews a %is lease every %ims', async (ttl, interval) => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-heartbeat-'));
  try {
    const gitlab = await mockGitLab(root);
    const repo = new InMemoryDetentRepository();
    const s = await repo.getOrCreateSession(1, 42, 'test');
    const renew = vi.spyOn(repo, 'renewSessionLease');
    const stopRequested = vi.spyOn(repo, 'stopRequested');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(repo, 'listActiveWorktrees').mockImplementationOnce(async () => {
      await hold;
      return [];
    });
    const config = { ...loadConfig({}), leaseTtlSeconds: ttl };
    const pod = new SessionOrchestrator(config, repo, gitlab, { run: vi.fn() });
    vi.useFakeTimers();
    const closing = pod.handleIssueClosed(1, 42);
    try {
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(renew).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(renew).toHaveBeenCalledWith(s.id, expect.any(String), ttl);
      expect(stopRequested).toHaveBeenCalledOnce();
    } finally {
      release();
      await closing;
      expect((await repo.getSession(s.id))?.status).toBe('DONE');
    }
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries a busy issue in order while other issues continue', async () => {
  const attempts: string[] = [];
  const report = vi.fn();
  const queue = new WebhookQueue(async (event) => {
    if (!('object_kind' in event) || event.object_kind !== 'note') throw Error('Expected a note');
    const body = event.object_attributes.note;
    attempts.push(body);
    if (attempts.length === 1) throw new SessionBusy();
    if (body === 'two') throw Error('dispatch failed');
  }, report);
  queue.submit('first', note('one'));
  queue.submit('first', note('one'));
  queue.submit('second', note('two'));
  queue.submit('third', note('three'));
  queue.submit('other', { ...note('elsewhere'), issue: { ...issue, iid: 43 } });
  await queue.drain();
  queue.submit('first', note('one'));
  await queue.drain();
  expect(attempts).toEqual(['one', 'elsewhere', 'one', 'two', 'three']);
  expect(report).toHaveBeenCalledOnce();
});

it('interrupts a busy backoff during shutdown', async () => {
  const dispatch = vi.fn().mockRejectedValue(new SessionBusy());
  const report = vi.fn();
  const queue = new WebhookQueue(dispatch, report);
  queue.submit('busy', note('one'));
  const draining = queue.drain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  queue.stop();
  await draining;
  expect(dispatch).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
});

it('reports a busy timeout and releases the event ID for redelivery', async () => {
  const dispatch = vi.fn().mockRejectedValue(new SessionBusy());
  const report = vi.fn();
  const queue = new WebhookQueue(dispatch, report, 20);
  queue.submit('busy', note('one'));
  await queue.drain();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
  dispatch.mockClear().mockResolvedValue(undefined);
  queue.submit('busy', note('one'));
  await queue.drain();
  expect(dispatch).toHaveBeenCalledOnce();
});

it('applies turn profiles and approval hooks across pods and resumes under the existing lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-extension-'));
  try {
    const repo = new InMemoryDetentRepository();
    const gitlab = await mockGitLab(root);
    const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
    const canApprove = vi.fn(async ({ userId }: { userId: number }) => userId === 8);
    const hooks = { onTurnCompleted: vi.fn(), onApprovalResolved: vi.fn() };
    const execute = vi.fn(async () => 'done');
    const extensions: DetentExtensions = {
      hooks, async resolveTurnProfile({ session, repo: repository, gitlab: client }) {
        expect(repository).toBe(repo);
        const issue = await client.getIssue(session.hubProjectId, session.hubIssueIid);
        if (!issue.labels.includes('review')) return {};
        return {
          extraSystemPrompt: 'Follow the issue checklist.', enabledExtensionTools: ['sample'], disableBash: true, canApprove,
        };
      },
      tools: [{ name: 'sample', description: 'sample', schema: {}, policy: 'always_approve' as const, execute }],
    };
    const history: string[] = [];
    const runner = { run: vi.fn(async (t: TurnInput) => {
      const file = transcriptPath(t.sandbox.claudeHome, t.sandbox.workspaceRoot, t.session.claudeSessionId!);
      if (t.resume) history.push(await readFile(file, 'utf8'));
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify({ type: 'assistant', prompt: t.prompt }) + '\n');
      if (t.session.permissionMode === 'default') await t.gate.invokeExtension('mcp__detent__sample', {});
      return t.prompt;
    }) };
    const podA = new SessionOrchestrator(config, repo, gitlab, runner, extensions);
    const podB = new SessionOrchestrator({ ...config, podId: 'pod-B' }, repo, gitlab, runner, extensions);
    await podA.handleIssueOpened(opened);
    expect(gitlab.getIssue).toHaveBeenCalledWith(1, 42);
    const session = (await repo.getSessionByIssue(1, 42))!;
    const plan = (await repo.getLatestPendingApproval(session.id))!;
    const skip = vi.fn(async () => false);
    await podB.resumeSession(session.id, 'external', { permissionMode: 'default', beforeRun: skip });
    expect(skip).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 'WAITING_PLAN', permissionMode: 'plan', lockedByPod: expect.stringContaining('pod-B/'),
    }));
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan', lockedByPod: null });
    expect(runner.run).toHaveBeenCalledTimes(1);
    await expect(podB.resumeSession(session.id, 'external', { permissionMode: 'default' })).rejects.toThrow('approval');
    await dispatchWebhook(podB, note('/approve'));
    expect(await repo.getApproval(plan.id)).toMatchObject({ status: 'PENDING' });
    expect(canApprove).toHaveBeenCalledWith({
      projectId: 1, userId: 7, username: 'dev', approvalType: 'PLAN', toolName: 'Plan',
    });
    const authorized = { ...actor, id: 8, username: 'reviewer' };
    const coding = dispatchWebhook(podB, note('/approve', authorized));
    await vi.waitFor(async () => {
      expect(await repo.getLatestPendingApproval(session.id)).toMatchObject({ toolName: 'sample' });
    });
    await dispatchWebhook(podB, note('/reject'));
    expect(execute).not.toHaveBeenCalled();
    expect(canApprove).toHaveBeenLastCalledWith({
      projectId: 1, userId: 7, username: 'dev', approvalType: 'TOOL_USE', toolName: 'sample',
    });
    await dispatchWebhook(podB, note('/approve', authorized));
    await coding;
    await dispatchWebhook(podB, note('/approve', authorized));
    expect(execute).toHaveBeenCalledOnce();
    expect(hooks.onApprovalResolved).toHaveBeenCalledTimes(2);
    expect(hooks.onApprovalResolved).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: 'sample', status: 'APPROVED', decidedBy: 'reviewer' }),
      expect.objectContaining({ id: session.id }),
    );

    await repo.acquireSessionLease(session.id, 'busy', 30);
    await expect(podA.resumeSession(session.id, 'external', { beforeRun: skip })).rejects.toBeInstanceOf(SessionBusy);
    expect(skip).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledTimes(2);
    await repo.releaseSessionLease(session.id, 'busy');
    await podA.resumeSession(session.id, 'external', { permissionMode: 'plan', beforeRun: async () => true });
    const turn = runner.run.mock.calls[2][0];
    expect(turn).toMatchObject({
      prompt: 'external', resume: true, systemPrompt: expect.stringContaining('Follow the issue checklist.'),
      session: { claudeSessionId: session.claudeSessionId, permissionMode: 'plan' },
    });
    expect(history[1]).toContain('实施方案已获批准');
    expect(hooks.onTurnCompleted).toHaveBeenCalledTimes(3);
    expect(hooks.onTurnCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: session.id, lastMessageSeq: 3, status: 'WAITING_PLAN' }), 'external',
    );
    expect((await repo.getSession(session.id))?.lockedByPod).toBeNull();
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes readonly results directly and includes extension status before approval information', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-readonly-'));
  try {
    const repo = new InMemoryDetentRepository();
    const gitlab = await mockGitLab(root);
    const app = new SessionOrchestrator(loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') }), repo, gitlab,
      { run: async () => 'Inspection complete' }, {
        resolveTurnProfile: () => ({ readonly: true }),
        renderStatusExtra: async s => 'Review for #' + s.hubIssueIid,
      });
    await app.handleIssueOpened(opened);
    const s = (await repo.getSessionByIssue(1, 42))!;
    expect(s.status).toBe('IDLE');
    expect(await repo.getLatestApproval(s.id)).toBeNull();
    expect(gitlab.notes.at(-1)).toContain('Inspection complete');
    await dispatchWebhook(app, note('/status'));
    expect(gitlab.notes.at(-1)).toBe('IDLE\n\nReview for #42\n\n无待审批项');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('renders live Hub help before session creation and preserves pending approvals', async () => {
  const config = loadConfig({});
  const client = new GitLabClient(config);
  const repo = new InMemoryDetentRepository();
  const run = vi.fn();
  const permit = vi.spyOn(client, 'hasApprovalPermission').mockResolvedValue(false);
  const reply = vi.spyOn(client, 'createIssueNote').mockResolvedValue({ id: 99 });
  const agent = (id: string) => ({ id, path: 'agents/' + id + '/AGENT.md', name: 'AGENT.md', type: 'blob' as const });
  vi.spyOn(client, 'listRepositoryTree').mockImplementation(async (_, dir) => dir === 'agents' ? [agent('code'), agent('setup')] : []);
  vi.spyOn(client, 'getRepositoryFile').mockImplementation(async (_, file) =>
    '---\nrequires: [' + (file.includes('/setup/') ? 'missing' : 'gitlab-onboarding') + ']\ndescription: 示例任务\n---\n操作步骤');
  const worker = new SessionOrchestrator(config, repo, client, { run }, {
    capabilities: [{ name: 'gitlab-onboarding', enabled: true, tools: [] }],
  });
  await dispatchWebhook(worker, note('/help'));
  expect(reply).not.toHaveBeenCalled();
  permit.mockResolvedValue(true);
  await dispatchWebhook(worker, note('/help'));
  const guide = reply.mock.calls[0][2];
  for (const field of ['agent::code', '示例任务', '✅ 就绪', 'agent::setup', '⚠️ 缺少能力包: missing', '/approve', '/use <agent>'])
    expect(guide).toContain(field);
  expect(await repo.getSessionByIssue(1, issue.iid)).toBeNull();
  const s = await repo.getOrCreateSession(1, issue.iid, 'pending');
  const pending = await repo.createApprovalRequest(s.id, 'PLAN', 'Plan', {});
  await dispatchWebhook(worker, note('/help'));
  expect(await repo.getSession(s.id)).toEqual(s);
  expect(await repo.getLatestPendingApproval(s.id)).toEqual(pending);
  expect(run).not.toHaveBeenCalled();
});
