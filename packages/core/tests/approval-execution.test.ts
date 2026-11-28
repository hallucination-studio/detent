import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { defineExtensionTool, loadConfig, SessionOrchestrator, type DetentExtensionTool } from '../src/index.js';
import type { ClaudeRunner } from '../src/claude/runner.js';
import { bareProjects } from './bare-projects.js';
import { InMemoryDetentRepository } from './memory-repository.js';

const input = { target: 'org/app' };
const vote = { type: 'APPROVE', username: 'owner', userId: 7, targetNoteId: 10 } as const;
const secret = 'fixture-private-value';

async function fixture(mode: 'handoff' | 'resume') {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-direct-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ DETENT_SECRET_API: secret, EPHEMERAL_ROOT: path.join(root, 'turns') });
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'apply');
  const gitlab = { ...await bareProjects(root), getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true),
    getIssueNote: vi.fn(async () => ({ id: 10, body: 'original ' + secret })), updateIssueNote: vi.fn(),
    syncIssueStatusLabel: vi.fn(), createIssueNote: vi.fn(async () => ({ id: 11 })) };
  const guard = vi.fn<NonNullable<DetentExtensionTool['guard']>>().mockResolvedValue({ ok: true });
  const execute = vi.fn<DetentExtensionTool['execute']>().mockResolvedValue({ job: 123, detail: secret });
  const tool = defineExtensionTool({ name: 'apply', description: '应用配置', schema: { target: z.string() },
    policy: 'always_approve', directExecuteOnApproval: mode, guard, execute });
  const canApprove = vi.fn(async () => true);
  const run = vi.fn<ClaudeRunner['run']>().mockResolvedValue('verified');
  const app = new SessionOrchestrator(config, repo, gitlab, { run }, {
    capabilities: [{ name: 'operations', enabled: true, tools: [tool] }],
    resolveTurnProfile: () => ({ enabledExtensionTools: ['apply'], canApprove }),
  });
  async function pending(args: Record<string, unknown> = input, type: 'TOOL_USE' | 'PLAN' = 'TOOL_USE') {
    const plan = type === 'PLAN';
    const row = await repo.createApprovalRequest(session.id, type, plan ? 'Plan' : 'apply', args);
    await repo.updateApprovalNoteId(row.id, vote.targetNoteId);
    await repo.updateSessionState(session.id, { permissionMode: plan ? 'plan' : 'default', status: plan ? 'WAITING_PLAN' : 'WAITING_TOOL' });
    return row;
  }
  const approve = () => app.handleUserIntent(1, 2, vote);
  return { repo, session, gitlab, guard, execute, canApprove, run, app, pending, approve };
}

it('submits a handoff once across concurrent votes and resumes only for the early callback', async () => {
  const f = await fixture('handoff');
  const row = await f.pending();
  f.execute.mockImplementationOnce(async () => {
    await f.app.deliverSystemEvent(f.session.id, 'end:123', 'job complete');
    return { job: 123 };
  });
  await Promise.all([f.approve(), f.approve()]);
  expect(f.execute).toHaveBeenCalledExactlyOnceWith(input, expect.objectContaining({ workspaceRoot: '', approvalId: row.id, approvedBy: 'owner' }));
  expect(f.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: expect.stringContaining('job complete') }));
  expect(await f.repo.getSession(f.session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  expect(f.gitlab.updateIssueNote).toHaveBeenCalledWith(1, 2, 10, expect.stringContaining('original ***\n\n> ✅ **已批准** · 由 @owner'));
});

it('resumes with the redacted result and requires a fresh approval for the same inputs', async () => {
  const f = await fixture('resume');
  await f.pending();
  f.run.mockImplementationOnce(async ({ gate }) => {
    await gate.invokeExtension('mcp__detent__apply', input);
    return 'replayed';
  });
  await f.approve();
  expect(f.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: expect.stringContaining('"job":123,"detail":"***"') }));
  expect(f.execute).toHaveBeenCalledOnce();
  expect(await f.repo.getLatestPendingApproval(f.session.id)).toMatchObject({ toolName: 'apply', toolInput: input });
});

it.each(['guard', 'permission', 'schema'])('fails closed when the live %s check fails', async failure => {
  const f = await fixture('handoff');
  await f.pending(failure === 'schema' ? { target: 5 } : input);
  if (failure === 'guard') f.guard.mockResolvedValue({ ok: false, reason: 'target unavailable' });
  if (failure === 'permission') f.canApprove.mockResolvedValueOnce(true).mockResolvedValue(false);
  await f.approve();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.repo.getSession(f.session.id)).toMatchObject({ status: 'FAILED', lockedByPod: null });
});

it('writes the voter and redacted rejection reason back to the original Plan card', async () => {
  const f = await fixture('resume');
  await f.pending({}, 'PLAN');
  await f.app.handleUserIntent(1, 2, { ...vote, type: 'REJECT', comment: 'fix ' + secret });
  expect(f.gitlab.updateIssueNote).toHaveBeenCalledWith(1, 2, 10, expect.stringContaining('original ***\n\n> ❌ **已拒绝** · 由 @owner 拒绝（fix ***）'));
});
