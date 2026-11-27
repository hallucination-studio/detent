import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-code';
import { expect, it, onTestFinished, vi } from 'vitest';
import { PermissionGate } from '../src/claude/permission-gate.js';
import { SdkClaudeRunner, type TurnInput } from '../src/claude/runner.js';
import type { SubagentDefinition, TurnProfile } from '../src/extensions.js';
import { defineExtensionTool, GitLabClient, loadConfig, SessionOrchestrator } from '../src/index.js';
import { EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { bareProjects } from './bare-projects.js';
import { InMemoryDetentRepository } from './memory-repository.js';

vi.mock('@anthropic-ai/claude-code', async original => ({
  ...await original<typeof import('@anthropic-ai/claude-code')>(), query: vi.fn(),
}));

const subagents: SubagentDefinition[] = [
  { id: 'audit', description: 'Inspect', prompt: 'Gather evidence.', readonly: true, disableBash: true,
    account: 'observer', allowPrefixes: ['uptime'], enabledExtensionTools: ['inspect'] },
  { id: 'code-delivery', description: 'Implement', prompt: 'Plan and implement.', enabledExtensionTools: ['publish'],
    account: 'publisher', approverTier: 'prod' },
];
const coordinator: TurnProfile = { name: 'coordinator', coordinator: true, subagents, enabledExtensionTools: ['inspect', 'publish'] };

async function fixture(profile?: TurnProfile) {
  const config = loadConfig({});
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'Investigate');
  session.claudeSessionId = 'session';
  const controller = new AbortController();
  const channel = { createNote: vi.fn().mockResolvedValue({ id: 1 }), syncStatusLabel: vi.fn() };
  const sandbox = { rootDir: process.cwd(), claudeHome: process.cwd(), workspaceRoot: process.cwd() };
  const tools = new WorkspaceTools(new EphemeralSandbox(config, repo, new GitLabClient(config)), sandbox, session.id);
  const guard = vi.fn().mockResolvedValue({ ok: true });
  const execute = vi.fn().mockResolvedValue('done');
  const extensionTools = [
    defineExtensionTool({ name: 'inspect', policy: 'readonly', description: 'Inspect', schema: {}, guard, execute }),
    defineExtensionTool({ name: 'publish', policy: 'always_approve', description: 'Publish', schema: {}, guard, execute }),
  ];
  const context = { profile, session, repo, config, controller, channel, workspaceRoot: sandbox.workspaceRoot,
    extensionTools, checkpoint: vi.fn() };
  const gate = new PermissionGate(context);
  const turn: TurnInput = { session, gate, controller, sandbox, tools, subagents: profile?.subagents,
    resume: false, prompt: 'go', systemPrompt: '', progress: vi.fn() };
  return { config, repo, gate, turn, channel, context, guard, execute };
}

it.each([undefined, coordinator])('exposes native Task only for registered definitions', async profile => {
  const { turn, config } = await fixture(profile);
  vi.mocked(query).mockImplementationOnce(() => (async function* () {
    yield { type: 'result', subtype: 'success', session_id: 'session', result: 'done' };
  })() as ReturnType<typeof query>);
  await new SdkClaudeRunner(config).run(turn);
  const options = vi.mocked(query).mock.lastCall![0].options!;
  const check = (target: string) => options.canUseTool!('Task', { subagent_type: target }, { signal: turn.controller.signal });
  expect(options.disallowedTools?.includes('Task')).toBe(!profile);
  expect(await check('audit')).toMatchObject({ behavior: profile ? 'allow' : 'deny' });
  expect(await check('general-purpose')).toMatchObject({ behavior: 'deny' });
  if (profile) expect(JSON.parse(options.extraArgs!.agents!)).toEqual({
    audit: { description: 'Inspect', prompt: 'Gather evidence.' },
    'code-delivery': { description: 'Implement', prompt: 'Plan and implement.' },
  });
  else expect(options.extraArgs).not.toHaveProperty('agents');
});

it('scopes sequential Task hooks, rejecting overlaps and cleaning up after a failed Task', async () => {
  const { turn, config, execute } = await fixture(coordinator);
  const inspect = () => turn.gate.invokeExtension('mcp__detent__inspect', {});
  vi.mocked(query).mockImplementationOnce(({ options }) => (async function* () {
    const base = { cwd: process.cwd(), transcript_path: '', session_id: 'session', tool_name: 'Task' };
    const signal = { signal: turn.controller.signal };
    const pre = (id: string, agent: string) => options!.hooks!.PreToolUse![0].hooks[0]({
      ...base, hook_event_name: 'PreToolUse', tool_input: { subagent_type: agent },
    }, id, signal);
    await expect(inspect()).rejects.toThrow();
    expect(await pre('first', 'audit')).toEqual({});
    const inspectName = 'mcp__detent__inspect';
    for (const [id, parent] of [['child', 'first'], ['sibling', null]] as const) {
      yield { type: 'assistant', session_id: 'session', parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_use', id, name: inspectName, input: {} }] } };
      const decision = await options!.hooks!.PreToolUse![0].hooks[0]({ ...base, hook_event_name: 'PreToolUse',
        tool_name: inspectName, tool_input: {} }, id, signal);
      if (parent) expect(decision).toEqual({});
      else expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
    await inspect();
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({
      profileName: 'audit', workflow: { account: 'observer', allowPrefixes: ['uptime'] },
    }));
    expect(await pre('second', 'code-delivery')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    yield { type: 'user', session_id: 'session', message: { content: [
      { type: 'tool_result', tool_use_id: 'second', is_error: true, content: 'overlap' },
    ] } };
    await inspect();
    yield { type: 'user', session_id: 'session', message: { content: [
      { type: 'tool_result', tool_use_id: 'first', is_error: true, content: 'cancelled' },
    ] } };
    await expect(inspect()).rejects.toThrow();
    expect(await pre('third', 'audit')).toEqual({});
    await options!.hooks!.PostToolUse![0].hooks[0]({ ...base, hook_event_name: 'PostToolUse',
      tool_input: { subagent_type: 'audit' }, tool_response: 'done' }, 'third', signal);
    await expect(inspect()).rejects.toThrow();
    yield { type: 'result', subtype: 'success', session_id: 'session', result: 'done' };
  })() as ReturnType<typeof query>);
  await new SdkClaudeRunner(config).run(turn);
});

it('keeps delegated writes behind Plan and binds production approvals and guards to the issuing agent', async () => {
  const { gate, turn, repo, guard, execute, channel, context } = await fixture(coordinator);
  const publish = 'mcp__detent__publish';
  gate.setActiveSubagent('code-delivery');
  for (const tool of ['Edit', 'Write', 'detent_commit_and_push', 'detent_create_mr', 'Bash', publish])
    expect(await gate.canUseTool(tool, { file_path: 'hello', command: 'touch hello' })).toMatchObject({ behavior: 'deny' });
  gate.clearActiveSubagent('code-delivery');

  turn.session.permissionMode = 'default';
  const coding = new PermissionGate(context);
  coding.setActiveSubagent('audit');
  for (const tool of ['Edit', 'Write', 'detent_commit_and_push', 'detent_create_mr', 'Bash', publish])
    expect(await coding.canUseTool(tool, { file_path: 'hello', command: 'git status' })).toMatchObject({ behavior: 'deny' });
  await coding.invokeExtension('mcp__detent__inspect', {});
  expect(channel.createNote).not.toHaveBeenCalled();
  expect(guard).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ permissionMode: 'plan', profileName: 'audit',
    workflow: { account: 'observer', allowPrefixes: ['uptime'] } }));
  coding.clearActiveSubagent('audit');
  coding.setActiveSubagent('code-delivery');
  await expect(coding.invokeExtension('mcp__detent__inspect', {})).rejects.toThrow();
  const pending = coding.invokeExtension(publish, {});
  await vi.waitFor(() => expect(channel.createNote).toHaveBeenCalledOnce());
  const card = (await repo.getLatestPendingApproval(turn.session.id))!;
  expect(card).toMatchObject({ approvalType: 'TOOL_USE', toolName: 'publish', toolInput: { __detentCoordinator: { agents: ['code-delivery'], issuer: 'code-delivery' } } });
  expect(execute).toHaveBeenCalledTimes(1);
  await coding.resolvePendingApproval('APPROVED');
  await pending;
  expect(guard).toHaveBeenCalledTimes(3);
  expect(execute).toHaveBeenLastCalledWith({}, expect.objectContaining({ profileName: 'code-delivery', approvalId: card.id,
    workflow: { account: 'publisher' } }));
  const previousDecision = (await repo.getApproval(card.id))!;
  const replay = new PermissionGate({ ...context, previousDecision });
  replay.setActiveSubagent('audit');
  await expect(replay.invokeExtension(publish, {})).rejects.toThrow();
  replay.clearActiveSubagent('audit');
  replay.setActiveSubagent('code-delivery');
  await replay.invokeExtension(publish, {});
  expect(channel.createNote).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenLastCalledWith({}, expect.objectContaining({ profileName: 'code-delivery', approvalId: card.id }));
});

it.each([
  ['Q&A', [], 'IDLE'], ['inspect', ['audit'], 'IDLE'], ['implement', ['code-delivery'], 'WAITING_PLAN'],
  ['investigate then fix', ['audit', 'code-delivery', 'audit'], 'WAITING_PLAN'], ['direct edit', [], 'WAITING_PLAN'],
] as const)('finishes coordinator %s with the corresponding GitLab state and note', async (prompt, tasks, expected) => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-handoff-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
  const gitlab = { ...await bareProjects(root), createIssueNote: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn(), hasApprovalPermission: vi.fn(), getIssue: vi.fn() };
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, prompt);
  const run = vi.fn(async (turn: TurnInput) => {
    expect(turn.subagents).toEqual(subagents);
    for (const id of tasks) {
      expect(turn.gate.setActiveSubagent(id)).toBe(true);
      turn.gate.clearActiveSubagent(id);
    }
    if (prompt === 'direct edit') expect(await turn.gate.canUseTool('Edit', { file_path: 'hello' })).toMatchObject({ behavior: 'deny' });
    return 'Findings';
  });
  await new SessionOrchestrator(config, repo, gitlab, { run }, { resolveTurnProfile: () => coordinator }).resumeSession(session.id, prompt);
  expect(await repo.getSession(session.id)).toMatchObject({ status: expected, permissionMode: 'plan' });
  const note = gitlab.updateIssueNote.mock.lastCall?.[3];
  const approval = await repo.getLatestPendingApproval(session.id);
  if (expected === 'IDLE') {
    expect(approval).toBeNull();
    expect(note).toBe('Findings');
  } else {
    expect(approval).toMatchObject({ approvalType: 'PLAN', toolInput: { __detentCoordinator: { agents: ['code-delivery'] } } });
    expect(note).toContain('实施方案审批');
  }
});
