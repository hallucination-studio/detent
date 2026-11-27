import { expect, expectTypeOf, it, vi } from 'vitest';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-code';
import { z } from 'zod';
import { PermissionGate } from '../src/claude/permission-gate.js';
import { SdkClaudeRunner } from '../src/claude/runner.js';
import { loadConfig } from '../src/config.js';
import { createDetentApp, defineExtensionTool, SessionBusy } from '../src/index.js';
import type { DetentExtensions, DetentExtensionTool, ToolGovernancePolicy, TurnProfile } from '../src/extensions.js';
import * as mysql from '../src/db/mysql.js';
import { GitLabClient } from '../src/gitlab/client.js';
import type { PermissionMode } from '../src/types.js';
import { EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { InMemoryDetentRepository } from './memory-repository.js';

vi.mock('@anthropic-ai/claude-code', async (original) => {
  const sdk = await original<typeof import('@anthropic-ai/claude-code')>();
  return {
    ...sdk,
    createSdkMcpServer: vi.fn(sdk.createSdkMcpServer),
    query: vi.fn(async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'session', result: 'done' };
    }),
  };
});

const schema = { item: z.string() };
const input = { item: 'sample' };
const toolId = 'mcp__detent__example';
async function setup(mode: PermissionMode, policy: ToolGovernancePolicy, profile?: TurnProfile) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'test');
  session.permissionMode = mode;
  session.claudeSessionId = 'session';
  const guard = vi.fn<NonNullable<DetentExtensionTool<typeof schema>['guard']>>()
    .mockResolvedValue({ ok: true });
  const execute = vi.fn(async ({ item }: z.infer<z.ZodObject<typeof schema>>) => item.toUpperCase());
  const extension = defineExtensionTool({
    name: 'example', schema, description: 'Example tool', policy, execute, guard,
    renderApprovalCard(id, { item }) {
      expectTypeOf(item).toEqualTypeOf<string>();
      return id + ' / ' + item + ' / https://oauth2:test@git/sample';
    },
  });
  const count = defineExtensionTool({
    name: 'count', description: 'Count entries', policy: 'readonly', schema: { entries: z.array(z.number()) },
    async execute({ entries }) {
      expectTypeOf(entries).toEqualTypeOf<number[]>();
      return entries.length;
    },
  });
  const extensionTools = [extension, count, { ...extension, name: 'other' }] satisfies DetentExtensions['tools'];
  const gitlab = {
    createIssueNote: vi.fn(async () => ({ id: 20 })), syncIssueStatusLabel: vi.fn(),
    listProjects: vi.fn(), getProject: vi.fn(), createMergeRequest: vi.fn(), listPipelines: vi.fn(),
    buildAuthenticatedCloneUrl: vi.fn(), getPipelineJobs: vi.fn(), getJobTrace: vi.fn(),
  };
  const config = loadConfig({});
  const controller = new AbortController();
  const ctx = {
    session, repo, gitlab, config, controller, checkpoint: vi.fn(), workspaceRoot: '/workspace',
    extensionTools, profile,
  };
  const gate = new PermissionGate(ctx);
  return { gate, guard, execute, ctx };
}

it.each([
  ['plan', 'readonly', true], ['default', 'readonly', true],
  ['plan', 'coding_auto', false], ['default', 'coding_auto', true],
  ['plan', 'always_approve', false],
] as const)('enforces %s / %s at invocation', async (mode, policy, allowed) => {
  const { gate, execute, ctx, guard } = await setup(mode, policy);
  const invoked = gate.invokeExtension(toolId, input);
  if (allowed) {
    await expect(invoked).resolves.toBe('SAMPLE');
    expect(guard).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(input, {
      session: ctx.session, repo: ctx.repo, workspaceRoot: ctx.workspaceRoot, permissionMode: mode,
    });
  } else {
    await expect(invoked).rejects.toThrow('只读');
    expect(execute).not.toHaveBeenCalled();
  }
  expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
});

it('enforces readonly guards on direct permission checks and invocation', async () => {
  const { gate, guard, execute } = await setup('plan', 'readonly');
  guard.mockResolvedValue({ ok: false, reason: 'ineligible' });
  const denied = { behavior: 'deny', message: 'ineligible' };
  expect(await gate.preflight(toolId, input)).toEqual(denied);
  expect(await gate.canUseTool(toolId, input)).toEqual(denied);
  await expect(gate.invokeExtension(toolId, input)).rejects.toThrow('ineligible');
  expect(guard).toHaveBeenCalledTimes(3);
  expect(execute).not.toHaveBeenCalled();
});

it('blocks before creating an approval and before a previously approved operation executes', async () => {
  const { gate, guard, execute, ctx } = await setup('default', 'always_approve');
  guard.mockResolvedValueOnce({ ok: false, reason: 'ineligible' });
  await expect(gate.invokeExtension(toolId, input)).rejects.toThrow('ineligible');
  expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
  expect(await ctx.repo.getLatestApproval(ctx.session.id)).toBeNull();

  const result = gate.invokeExtension(toolId, input);
  await vi.waitFor(() => expect(ctx.gitlab.createIssueNote).toHaveBeenCalledOnce());
  const approval = (await ctx.repo.getApprovalByNoteId(ctx.session.id, 20))!;
  expect(ctx.gitlab.createIssueNote).toHaveBeenCalledWith(1, 42, approval.id + ' / sample / https://oauth2:***@git/sample');
  expect(ctx.checkpoint).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  guard.mockResolvedValue({ ok: false, reason: 'state changed' });
  await gate.resolvePendingApproval('APPROVED');
  await expect(result).rejects.toThrow('state changed');
  expect(guard).toHaveBeenCalledTimes(3);
  expect(execute).not.toHaveBeenCalled();
});

it('replays a cold approval for matching input only and consumes it once', async () => {
  const { ctx, execute, guard } = await setup('acceptEdits', 'always_approve');
  const row = await ctx.repo.createApprovalRequest(ctx.session.id, 'TOOL_USE', 'example', input);
  await ctx.repo.resolveApprovalRequest(row.id, 'APPROVED', 'dev');
  const gate = new PermissionGate({ ...ctx, previousDecision: (await ctx.repo.getApproval(row.id))! });
  const mismatch = gate.invokeExtension(toolId, { item: 'changed' });
  await vi.waitFor(() => expect(ctx.gitlab.createIssueNote).toHaveBeenCalledOnce());
  await gate.resolvePendingApproval('REJECTED', 'dev', 'different input');
  await expect(mismatch).rejects.toThrow('different input');
  expect(execute).not.toHaveBeenCalled();
  await expect(gate.invokeExtension(toolId, input)).resolves.toBe('SAMPLE');
  expect(guard).toHaveBeenCalledTimes(2);
  expect(guard).toHaveBeenLastCalledWith(input, expect.objectContaining({ approvalId: row.id }));
  expect(execute).toHaveBeenCalledWith(input, expect.objectContaining({ approvalId: row.id }));
  expect(ctx.gitlab.createIssueNote).toHaveBeenCalledOnce();
  ctx.gitlab.createIssueNote.mockClear();
  const next = gate.invokeExtension(toolId, input);
  await vi.waitFor(() => expect(ctx.gitlab.createIssueNote).toHaveBeenCalledOnce());
  await gate.resolvePendingApproval('REJECTED', 'dev', 'declined');
  await expect(next).rejects.toThrow('declined');
  expect(execute).toHaveBeenCalledOnce();
});

it('registers only enabled extensions with the SDK and disables Bash in both layers', async () => {
  const { gate, ctx, execute, guard } = await setup('default', 'always_approve', {
    enabledExtensionTools: ['example', 'count'], disableBash: true,
  });
  const { config, controller, session, workspaceRoot } = ctx;
  const sandbox = { workspaceRoot, rootDir: '/', claudeHome: '/home' };
  const tools = new WorkspaceTools(new EphemeralSandbox(config, ctx.repo, ctx.gitlab), sandbox, session.id);
  const progress = vi.fn();
  await new SdkClaudeRunner(config).run({
    gate, controller, session, sandbox, tools, resume: false, prompt: 'go', systemPrompt: '', progress,
  });
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  expect(options.disallowedTools).toContain('Bash');
  expect(await gate.canUseTool('Bash', { command: 'git status' })).toMatchObject({ behavior: 'deny' });
  const registered = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0].tools!;
  expect(registered.map(t => t.name)).not.toContain('other');
  await expect(gate.invokeExtension('mcp__detent__other', input)).rejects.toThrow('未启用');
  const handler = registered.find(t => t.name === 'example')!.handler;
  const count = registered.find(t => t.name === 'count')!;
  expect(await count.handler({ entries: [4, 5] }, {})).toMatchObject({ content: [{ type: 'text', text: '2' }] });
  await options.canUseTool!(toolId, input, { signal: controller.signal });
  const response = handler(input, {});
  await vi.waitFor(() => expect(ctx.gitlab.createIssueNote).toHaveBeenCalledOnce());
  const approval = (await ctx.repo.getApprovalByNoteId(session.id, 20))!;
  expect(guard.mock.calls[0][1]).not.toHaveProperty('approvalId');
  await gate.resolvePendingApproval('APPROVED');
  expect(await response).toMatchObject({ content: [{ type: 'text', text: '"SAMPLE"' }] });
  expect(guard).toHaveBeenCalledTimes(2);
  expect(guard).toHaveBeenLastCalledWith(input, expect.objectContaining({ approvalId: approval.id }));
  expect(execute).toHaveBeenCalledWith(input, guard.mock.calls[1][1]);
  expect(execute).toHaveBeenCalledOnce();
  expect(progress.mock.calls.map(([{ name, input, result }]) => [name, input, result])).toEqual([
    ['count', '{"entries":[4,5]}', '⏳ 执行中…'], ['count', '{"entries":[4,5]}', '2'],
    ['example', '{"item":"sample"}', '⏳ 执行中…'], ['example', '{"item":"sample"}', 'SAMPLE'],
  ]);
  expect(new Set(progress.mock.calls.map(([step]) => step.id)).size).toBe(2);
});

it('correlates SDK permissions, MCP handlers, hooks and streamed errors without an inbox', async () => {
  const { ctx, execute, guard } = await setup('default', 'readonly');
  const { session, controller, config } = ctx;
  const gate = new PermissionGate({ ...ctx, workspaceRoot: process.cwd() });
  config.additionalSecrets = ['private-value'];
  const sandbox = { workspaceRoot: ctx.workspaceRoot, rootDir: '/turn', claudeHome: '/home' };
  const tools = new WorkspaceTools(new EphemeralSandbox(config, ctx.repo, ctx.gitlab), sandbox, session.id);
  const progress = vi.fn();
  vi.mocked(query).mockImplementationOnce(({ options }) => (async function* () {
    const signal = { signal: controller.signal };
    const hookInput = { cwd: ctx.workspaceRoot, transcript_path: '', session_id: 'session' };
    const before = (id: string, name: string, input: unknown) => options!.hooks!.PreToolUse![0].hooks[0]({
      ...hookInput, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input,
    }, id, signal);
    const after = (id: string, name: string, input: unknown, output: unknown) => options!.hooks!.PostToolUse![0].hooks[0]({
      ...hookInput, hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_response: output,
    }, id, signal);
    const file = { file_path: 'CLAUDE.md' };
    for (const id of ['first', 'second']) {
      await before(id, 'Read', file);
      await options!.canUseTool!('Read', file, signal);
    }
    await after('second', 'Read', file, { text: 'successful private-value' });
    const denied = { file_path: '/outside' };
    await before('denied', 'Read', denied);
    await options!.canUseTool!('Read', denied, signal);
    yield { type: 'assistant', session_id: 'session', message: { content: [
      { type: 'tool_use', id: 'invalid', name: 'Glob', input: { pattern: 'private-value' } },
    ] } };
    yield { type: 'user', session_id: 'session', message: { content: ['first', 'denied', 'invalid'].map(tool_use_id => ({
      type: 'tool_result', tool_use_id, is_error: true, content: 'failed private-value',
    })) } };
    const handler = vi.mocked(createSdkMcpServer).mock.lastCall![0].tools!.find(t => t.name === 'example')!.handler;
    for (const id of ['success', 'error', 'blocked']) {
      await before(id, toolId, input);
      const meta = { _meta: { 'claudecode/toolUseId': id } };
      if (id === 'success') {
        await handler(input, meta);
        await after(id, toolId, input, 'SDK private-value');
      } else {
        if (id === 'error') execute.mockRejectedValueOnce(Error('error private-value'));
        else guard.mockResolvedValueOnce({ ok: false, reason: 'denied private-value' });
        await expect(handler(input, meta)).rejects.toThrow('***');
      }
    }
    yield { type: 'result', subtype: 'success', session_id: 'session', result: 'finished' };
  })() as ReturnType<typeof query>);
  await new SdkClaudeRunner(config).run({ gate, controller, session, sandbox, tools, resume: false,
    prompt: '', systemPrompt: '', progress });
  const steps = new Map(progress.mock.calls.map(([step]) => [step.id, step]));
  expect([...steps.values()].map(s => [s.id, s.name, s.result])).toEqual([
    ['first', 'Read', '❌ failed ***'], ['second', 'Read', '{"text":"successful ***"}'],
    ['denied', 'Read', '⛔ 已拦截：此模式或路径不允许文件操作'], ['invalid', 'Glob', '❌ failed ***'],
    ['success', 'example', 'SDK ***'], ['error', 'example', '❌ error ***'], ['blocked', 'example', '⛔ 已拦截：denied ***'],
  ]);
  expect(steps.get('invalid').input).toBe('{"pattern":"***"}');
  expect(progress.mock.calls[0][0]).toMatchObject({ id: 'first', result: '⏳ 执行中…' });
  expect(JSON.stringify(progress.mock.calls)).not.toContain('private-value');
});

it('expires a request if its custom card fails to render', async () => {
  const { gate, ctx, execute } = await setup('default', 'always_approve');
  ctx.extensionTools[0].renderApprovalCard = () => { throw Error('card unavailable'); };
  await expect(gate.invokeExtension(toolId, input)).rejects.toThrow('card unavailable');
  expect(await ctx.repo.getLatestApproval(ctx.session.id)).toMatchObject({ status: 'EXPIRED' });
  expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it('accepts extension webhooks while work is pending and retries busy handlers in queue order', async () => {
  const schemaInit = vi.spyOn(mysql, 'initMySqlSchema').mockResolvedValue();
  const identity = vi.spyOn(GitLabClient.prototype, 'initBotIdentity').mockResolvedValue();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const attempts: string[] = [];
  const handle = vi.fn(async () => {
    attempts.push('first');
    await hold;
    if (attempts.length === 1) throw new SessionBusy();
  });
  const app = createDetentApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), {
    matchWebhookEvent(event) {
      if (event.object_kind !== 'sample') return null;
      return { key: 'sample/42', handle: event.value === 'first' ? handle : async () => { attempts.push('second'); } };
    },
  });
  const post = (id: string, value: string) => app.inject({
    method: 'POST', url: '/webhooks/gitlab',
    headers: { 'x-gitlab-token': 'test', 'idempotency-key': id }, payload: { object_kind: 'sample', value },
  });
  try {
    expect((await post('1', 'first')).statusCode).toBe(202);
    expect((await post('1', 'first')).statusCode).toBe(202);
    expect((await post('2', 'second')).statusCode).toBe(202);
    expect(attempts).toEqual(['first']);
    release();
    await vi.waitFor(() => expect(attempts).toEqual(['first', 'first', 'second']));
    expect((await post('1', 'first')).statusCode).toBe(202);
  } finally {
    release();
    await app.close();
    schemaInit.mockRestore();
    identity.mockRestore();
  }
  expect(handle).toHaveBeenCalledTimes(2);
});

it.each(['plan', 'default'] as const)('uses the default SDK mode and locks readonly tools in %s sessions', async mode => {
  const { gate, execute, ctx } = await setup(mode, 'readonly', { name: 'Reviewer', readonly: true });
  const { config, controller, session, workspaceRoot } = ctx;
  await gate.invokeExtension(toolId, input);
  expect(execute).toHaveBeenCalledWith(input, expect.objectContaining({ profileName: 'Reviewer' }));
  const sandbox = { workspaceRoot, rootDir: '/turn-test', claudeHome: '/home' };
  const tools = new WorkspaceTools(new EphemeralSandbox(config, ctx.repo, ctx.gitlab), sandbox, session.id);
  const progress = vi.fn();
  await new SdkClaudeRunner(config).run({ gate, controller, session, sandbox, tools, resume: false,
    prompt: 'inspect', systemPrompt: '', progress });
  const options = vi.mocked(query).mock.lastCall![0].options!;
  const command = 'git -C ' + workspaceRoot + '/projects/app status ' + workspaceRoot + ' ' + 'x'.repeat(100);
  expect(await options.canUseTool!('Bash', { command }, { signal: controller.signal })).toMatchObject({ behavior: 'deny' });
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bash', input: JSON.stringify({ command }), result: expect.stringMatching(/^⛔ 已拦截：/) }));
  expect(options).toMatchObject({
    permissionMode: 'default', disallowedTools: expect.arrayContaining(['Edit', 'Write']),
  });
  for (const policy of ['coding_auto', 'always_approve'] as const) {
    const { gate } = await setup('default', policy, { readonly: true });
    expect(await gate.preflight(toolId, input)).toMatchObject({ behavior: 'deny' });
  }
  expect(await gate.preflight('Bash', { command: 'git status' })).toMatchObject({ behavior: 'allow' });
  expect(await gate.preflight('Bash', { command: 'npm test' })).toMatchObject({ behavior: 'deny' });
});
