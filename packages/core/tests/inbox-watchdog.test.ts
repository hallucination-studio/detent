import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-code';
import { createDetentApp } from '../src/app.js';
import * as mysql from '../src/db/mysql.js';
import { MySqlDetentRepository } from '../src/db/repository.js';
import { GitLabClient } from '../src/gitlab/client.js';
import { loadConfig } from '../src/config.js';
import { SdkClaudeRunner, type TurnInput } from '../src/claude/runner.js';
import { SessionOrchestrator } from '../src/orchestrator/session-orchestrator.js';
import { StopTurn } from '../src/orchestrator/turn-runtime.js';
import { Watchdog } from '../src/orchestrator/watchdog.js';
import { bareProjects } from './bare-projects.js';
import { InMemoryDetentRepository } from './memory-repository.js';

vi.mock('@anthropic-ai/claude-code', async original => {
  const sdk = await original<typeof import('@anthropic-ai/claude-code')>();
  return { ...sdk, query: vi.fn(({ options }: { options: Options }) => (async function* () {
    yield { type: 'result', subtype: 'success', session_id: options.extraArgs!['session-id'], result: 'ok' };
  })()) };
});

async function setup(root: string) {
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), JEV_API_KEY: 'private-key' });
  const repo = new InMemoryDetentRepository();
  const gitlab = { ...await bareProjects(root), createIssueNote: vi.fn(async () => ({ id: 3 })),
    updateIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn(), getIssue: vi.fn(), hasApprovalPermission: vi.fn() };
  const run = vi.fn<((t: TurnInput) => Promise<string>)>().mockResolvedValue('done');
  const pod = new SessionOrchestrator(config, repo, gitlab, { run });
  const other = new SessionOrchestrator({ ...config, podId: 'other' }, repo, gitlab, { run });
  return { config, repo, gitlab, run, pod, other };
}

it('delivers busy comments through PostToolUse and starts a final follow-up under the same lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-inbox-'));
  try {
    const { config, repo, run, pod, other } = await setup(root);
    const s = await repo.getOrCreateSession(1, 5, 'review');
    const note = (id: string, comment: string) => other.handleUserIntent(1, 5, { type: 'PROMPT', userId: 1, username: 'dev', comment }, id);
    const sdk = new SdkClaudeRunner(config);
    const owners: (string | null)[] = [];
    let hotOutput: unknown;
    let emptyOutput: unknown;
    run.mockImplementation(async t => {
      owners.push((await repo.getSession(s.id))!.lockedByPod);
      if (owners.length === 1) {
        await Promise.all([note('hot', 'private-key'), note('hot', 'duplicate')]);
        await sdk.run(t);
        const hook = vi.mocked(query).mock.lastCall![0].options!.hooks!.PostToolUse![0].hooks[0];
        const input = { hook_event_name: 'PostToolUse' as const, cwd: t.sandbox.workspaceRoot, transcript_path: '',
          session_id: t.session.claudeSessionId!, tool_name: 'Read', tool_input: {}, tool_response: 'ok' };
        hotOutput = await hook(input, undefined, { signal: t.controller.signal });
        emptyOutput = await hook(input, undefined, { signal: t.controller.signal });
        await note('late', 'last private-key');
      }
      return 'finished';
    });
    await pod.resumeSession(s.id, 'go', { permissionMode: 'default' });
    expect(hotOutput).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '@dev: ***' } });
    expect(emptyOutput).toEqual({});
    expect(run.mock.calls.map(([t]) => t.prompt)).toEqual(['go', '@dev: last ***']);
    expect(owners).toEqual([expect.any(String), owners[0]]);
    expect(await repo.getSession(s.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the SDK transport open for in-flight control replies when a turn is interrupted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-interrupt-'));
  try {
    const { config, repo, run, pod } = await setup(root);
    const session = await repo.getOrCreateSession(1, 5, 'interrupt');
    const interrupt = vi.fn(async () => {});
    let transportAborted: boolean | undefined;
    run.mockImplementation(async turn => {
      const messages = Object.assign((async function* () {
        turn.controller.abort(new StopTurn());
        transportAborted = vi.mocked(query).mock.lastCall![0].options!.abortController!.signal.aborted;
      })(), { interrupt, setModel: vi.fn(), setPermissionMode: vi.fn(), supportedCommands: vi.fn(),
        supportedModels: vi.fn(), mcpServerStatus: vi.fn() });
      vi.mocked(query).mockReturnValueOnce(messages);
      return new SdkClaudeRunner(config).run(turn);
    });
    await pod.resumeSession(session.id, 'start');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(transportAborted).toBe(false);
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('recovers an expired turn once across pods, reports exhaustion and wakes stranded inboxes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-watchdog-'));
  try {
    const { repo, gitlab, run, pod, other } = await setup(root);
    const [recover, exhaust, inbox, waiting] = await Promise.all([1, 2, 3, 4].map(i => repo.getOrCreateSession(1, i, 'session')));
    for (const s of [recover, exhaust]) await repo.acquireSessionLease(s.id, 'old', -1);
    await repo.updateSessionState(exhaust.id, { recoveryAttempts: 1 });
    await repo.updateSessionState(inbox.id, { status: 'IDLE', permissionMode: 'default' });
    await repo.updateSessionState(waiting.id, { status: 'WAITING_TOOL' });
    for (const s of [inbox, waiting, exhaust]) await repo.enqueueSessionInbox({ sessionId: s.id, eventId: 'e', sourceKind: 'note', content: 'follow up' });
    const report = vi.fn();
    const counts: number[] = [];
    run.mockImplementation(async t => {
      counts.push((await repo.getSession(t.session.id))!.recoveryAttempts);
      return 'ok';
    });
    await Promise.all([new Watchdog(pod, report).scan(), new Watchdog(other, report).scan()]);
    expect(report).not.toHaveBeenCalled();
    expect(run.mock.calls.map(([t]) => t.session.id).sort()).toEqual([recover.id, inbox.id].sort());
    expect(counts.sort()).toEqual([0, 1]);
    expect(run.mock.calls.find(([t]) => t.session.id === inbox.id)?.[0].prompt).toContain('follow up');
    expect(await repo.getSession(recover.id)).toMatchObject({ status: 'IDLE', recoveryAttempts: 0, lockedByPod: null });
    expect(await repo.getSession(exhaust.id)).toMatchObject({ status: 'FAILED', recoveryAttempts: 1 });
    expect(gitlab.createIssueNote.mock.calls).toContainEqual([1, 2, expect.stringContaining('恢复')]);
    expect(await repo.drainSessionInbox(exhaust.id)).toHaveLength(0);
    expect(await repo.drainSessionInbox(waiting.id)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('enforces the watchdog floor, disabled mode, defaults and recovery limits', () => {
  expect(loadConfig({})).toMatchObject({ watchdogIntervalMs: 30000, watchdogMaxRecoveries: 1, mrMaxAutoFixAttempts: 3 });
  for (const blank of ['', '  ']) {
    expect(loadConfig({ WATCHDOG_INTERVAL_MS: blank, WATCHDOG_MAX_RECOVERIES: blank, MR_MAX_AUTO_FIX_ATTEMPTS: blank }))
      .toMatchObject({ watchdogIntervalMs: 30000, watchdogMaxRecoveries: 1, mrMaxAutoFixAttempts: 3 });
  }
  for (const interval of ['0', '15000']) expect(loadConfig({ WATCHDOG_INTERVAL_MS: interval }).watchdogIntervalMs).toBe(Number(interval));
  for (const interval of ['-1', '14', '14999']) expect(() => loadConfig({ WATCHDOG_INTERVAL_MS: interval })).toThrow();
  expect(() => loadConfig({ WATCHDOG_MAX_RECOVERIES: '6' })).toThrow();
  expect(() => loadConfig({ MR_MAX_AUTO_FIX_ATTEMPTS: '11' })).toThrow();
});

it('revises a plan when a comment arrives during publication of its approval card', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-late-plan-'));
  try {
    const { repo, gitlab, run, pod, other } = await setup(root);
    const session = await repo.getOrCreateSession(1, 5, 'plan');
    run.mockImplementation(async ({ gate, prompt }) => {
      await gate.invokeExtension('mcp__detent__detent_submit_plan', { plan: prompt });
      return 'Waiting for review';
    });
    let firstCard: string | undefined;
    gitlab.updateIssueNote.mockImplementationOnce(async () => {
      firstCard = (await repo.getLatestPendingApproval(session.id))!.id;
      await other.handleUserIntent(1, 5, { type: 'PROMPT', comment: 'add tests', username: 'dev', userId: 7 }, 'late');
    });
    await pod.resumeSession(session.id, 'initial');
    expect(run.mock.calls.map(([t]) => t.prompt)).toEqual(['initial', '@dev: add tests']);
    expect((await repo.getApproval(firstCard!))?.status).toBe('EXPIRED');
    expect((await repo.getLatestPendingApproval(session.id))?.id).not.toBe(firstCard);
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', lockedByPod: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('starts and stops one low-frequency timer, including when disabled', async () => {
  const repo = new InMemoryDetentRepository();
  const scan = vi.spyOn(repo, 'listExpiredActiveSessions');
  const config = loadConfig({ WATCHDOG_INTERVAL_MS: '0' });
  const watchdog = new Watchdog({ config, repo, wakeSession: vi.fn() }, vi.fn());
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.useFakeTimers();
  try {
    watchdog.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(scan).not.toHaveBeenCalled();
    config.watchdogIntervalMs = 15000;
    watchdog.start();
    watchdog.start();
    await vi.advanceTimersByTimeAsync(15749);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledOnce();
    await watchdog.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(scan).toHaveBeenCalledOnce();
  } finally {
    await watchdog.stop();
    vi.useRealTimers();
    random.mockRestore();
  }
});

it('dispatches an HTTP note into the inbox before the opening webhook releases its queue', async () => {
  const config = loadConfig({ GITLAB_WEBHOOK_SECRET: 'test', WATCHDOG_INTERVAL_MS: '0' });
  const repo = new InMemoryDetentRepository();
  const schema = vi.spyOn(mysql, 'initMySqlSchema').mockResolvedValue();
  const identity = vi.spyOn(GitLabClient.prototype, 'initBotIdentity').mockResolvedValue();
  const lookup = vi.spyOn(MySqlDetentRepository.prototype, 'getSessionByIssue').mockImplementation(repo.getSessionByIssue.bind(repo));
  const inbox = vi.spyOn(MySqlDetentRepository.prototype, 'enqueueSessionInbox').mockImplementation(repo.enqueueSessionInbox.bind(repo));
  const lease = vi.spyOn(MySqlDetentRepository.prototype, 'acquireSessionLease').mockImplementation(repo.acquireSessionLease.bind(repo));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const opened = vi.spyOn(SessionOrchestrator.prototype, 'handleIssueOpened').mockImplementation(async () => {
    const s = await repo.getOrCreateSession(1, 8, 'test');
    await repo.acquireSessionLease(s.id, 'opening-turn', 30);
    await hold;
    await repo.releaseSessionLease(s.id, 'opening-turn');
  });
  const app = createDetentApp(config);
  const post = (payload: object) => app.inject({ method: 'POST', url: '/webhooks/gitlab',
    headers: { 'x-gitlab-token': 'test' }, payload: { user: { id: 1, username: 'dev' }, project: { id: 1 }, ...payload } });
  try {
    expect((await post({ object_kind: 'issue', object_attributes: { iid: 8, title: 'test', action: 'open' } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect((await post({ object_kind: 'note', issue: { iid: 8 }, object_attributes: { id: 4, noteable_type: 'Issue', note: 'new input' } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(inbox).toHaveBeenCalledOnce());
    const s = (await repo.getSessionByIssue(1, 8))!;
    expect(s.lockedByPod).toBe('opening-turn');
    expect(await repo.drainSessionInbox(s.id)).toMatchObject([{ content: 'new input', senderUsername: 'dev' }]);
  } finally {
    release();
    await app.close();
    for (const mock of [schema, identity, lookup, inbox, lease, opened]) mock.mockRestore();
  }
});
