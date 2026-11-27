import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { openMcpTransport } from '../src/claude/mcp-transport.js';
import { PermissionGate } from '../src/claude/permission-gate.js';
import { SdkClaudeRunner } from '../src/claude/runner.js';
import { SessionOrchestrator } from '../src/orchestrator/session-orchestrator.js';
import { loadConfig } from '../src/config.js';
import { EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { bareProjects } from './bare-projects.js';

it('serves authenticated stateless MCP, validates and normalizes inputs, and closes open connections', async () => {
  const handler = vi.fn(async (input: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(input) }] }));
  const tool = { name: 'ask', description: 'Ask', inputSchema: {
    questions: z.array(z.object({ question: z.string().trim().min(1) })).min(1),
    limit: z.number().int().positive().default(2),
  }, handler };
  const mcp = await openMcpTransport([tool], []);
  const post = (body: object, url = mcp.url, token = mcp.token) => fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const rpc = async (method: string, params?: object) => (await post({ jsonrpc: '2.0', id: 'req', method, params })).json();
  try {
    expect((await post({}, mcp.url, 'wrong')).status).toBe(401);
    expect((await post({}, mcp.url + '/other')).status).toBe(404);
    expect(await rpc('initialize', { protocolVersion: '2025-06-18' })).toMatchObject({
      jsonrpc: '2.0', id: 'req', result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(await rpc('ping')).toMatchObject({ result: {} });
    expect(await rpc('tools/list')).toMatchObject({ result: { tools: [{ name: 'ask', inputSchema: {
      required: ['questions'], properties: {
        questions: { type: 'array', minItems: 1, items: { type: 'object', required: ['question'] } },
        limit: { type: 'integer', exclusiveMinimum: 0 },
      },
    } }] } });
    expect(await rpc('tools/call', { name: 'ask', arguments: { questions: [] } })).toMatchObject({ error: { code: -32602 } });
    expect(handler).not.toHaveBeenCalled();
    const raw = { questions: [{ question: ' Target? ' }] };
    const parsed = { questions: [{ question: 'Target?' }], limit: 2 };
    const meta = { 'claudecode/toolUseId': 'tool-1' };
    expect(await rpc('tools/call', { name: 'ask', arguments: raw, _meta: meta })).toMatchObject({
      result: { content: [{ type: 'text', text: JSON.stringify(parsed) }] },
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith(parsed, { rawInput: raw, _meta: meta });
  } finally {
    await mcp.close();
  }
  await expect(rpc('ping')).rejects.toThrow();
});

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: object };
function streamMessage(model: string, block: Block) {
  const usage = { input_tokens: 10, output_tokens: 5 };
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage };
  const delta = block.type === 'text' ? { type: 'text_delta', text: block.text }
    : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
  return [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use' }, usage },
    { type: 'message_stop' },
  ].map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}

async function localModel(next: (messages: string) => Block) {
  const model = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    const block: Block = body.stream && body.tools?.length ? next(JSON.stringify(body.messages)) : { type: 'text', text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(streamMessage(body.model, block));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  onTestFinished(() => { model.close(); model.closeAllConnections(); });
  return 'http://127.0.0.1:' + (model.address() as AddressInfo).port;
}

it('runs a tool past 30 seconds through the real Claude CLI with one correlated, redacted step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detent-sdk-http-'));
  const toolId = 'toolu_long';
  const secret = 'fixture-service-key';
  const inputs: string[] = [];
  const baseUrl = await localModel(messages => {
    inputs.push(messages);
    return inputs.length === 1
      ? { type: 'tool_use', name: 'mcp__detent__detent_list_projects', id: toolId, input: { search: 'sample' } }
      : { type: 'text', text: 'Done.' };
  });
  const controller = new AbortController();
  try {
    const config = loadConfig({ ANTHROPIC_BASE_URL: baseUrl, JEV_API_KEY: secret });
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'test');
    session.permissionMode = 'default';
    session.claudeSessionId = randomUUID();
    const sandbox = { workspaceRoot: join(root, 'workspace'), claudeHome: join(root, 'home'), rootDir: root };
    await Promise.all([mkdir(sandbox.workspaceRoot), mkdir(sandbox.claudeHome)]);
    const gitlab = { ...await bareProjects(root), createIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn() };
    gitlab.listProjects.mockImplementation(async () => {
      await delay(31_000);
      return 'matched ' + secret;
    });
    const gate = new PermissionGate({ repo, config, session, controller, workspaceRoot: sandbox.workspaceRoot, gitlab, checkpoint: vi.fn() });
    const permissions = vi.spyOn(gate, 'canUseTool');
    const progress = vi.fn();
    const result = await new SdkClaudeRunner(config).run({
      session, gate, controller, sandbox, resume: false, prompt: 'List sample projects.', systemPrompt: '',
      tools: new WorkspaceTools(new EphemeralSandbox(config, repo, gitlab), sandbox, session.id),
      allowedWorkspaceTools: ['detent_list_projects'], progress,
    });
    expect(result).toBe('Done.');
    expect(gitlab.listProjects).toHaveBeenCalledExactlyOnceWith('sample');
    expect(permissions).toHaveBeenCalledExactlyOnceWith('detent_list_projects', { search: 'sample' });
    expect(inputs.at(-1)).toContain('matched ***');
    expect(new Set(progress.mock.calls.map(([step]) => step.id))).toEqual(new Set([toolId]));
    expect(JSON.stringify(progress.mock.calls)).not.toContain(secret);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.each([
  { name: 'mcp__detent__AskUserQuestion', input: { questions: [{ question: 'Which branch?' }] }, approvalType: 'ASK_USER',
    prompt: 'Ask which branch to use.', answer: 'stable' },
  { name: 'Bash', input: { command: 'printf replay-confirmed', description: 'Print the approved result' }, approvalType: 'TOOL_USE',
    prompt: 'Print the approved result.', answer: '/approve' },
])('suspends $name and replays the decision in a resumed CLI process', async ({ name, input, approvalType, prompt, answer }) => {
  const root = await mkdtemp(join(tmpdir(), 'detent-sdk-resume-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let nextToolId: string | undefined = 'toolu_first';
  const requests: string[] = [];
  const baseUrl = await localModel(messages => {
    requests.push(messages);
    if (!nextToolId) return { type: 'text', text: 'Answer received.' };
    const id = nextToolId;
    nextToolId = undefined;
    return { type: 'tool_use', name, id, input };
  });
  const config = loadConfig({ EPHEMERAL_ROOT: join(root, 'turns'), ANTHROPIC_BASE_URL: baseUrl });
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'test');
  const gitlab = { ...await bareProjects(root), createIssueNote: vi.fn().mockResolvedValue({ id: 1 }), updateIssueNote: vi.fn(),
    syncIssueStatusLabel: vi.fn(), getIssue: vi.fn(), hasApprovalPermission: vi.fn().mockResolvedValue(true) };
  const runner = new SdkClaudeRunner(config);
  const run = vi.spyOn(runner, 'run');
  const pod = new SessionOrchestrator(config, repo, gitlab, runner);
  await pod.resumeSession(session.id, prompt, { permissionMode: 'default' });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_TOOL', lockedByPod: null });
  const card = (await repo.getLatestPendingApproval(session.id))!;
  expect(card).toMatchObject({ approvalType, toolInput: input });
  nextToolId = 'toolu_replay';
  await pod.handleUserIntent(1, 42, {
    type: approvalType === 'ASK_USER' ? 'PROMPT' : 'APPROVE', userId: 7, username: 'dev', comment: answer,
  });
  expect(run.mock.calls.map(([t]) => t.resume)).toEqual([false, true]);
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  expect(await repo.getLatestApproval(session.id)).toMatchObject({ id: card.id, status: 'APPROVED' });
  const blocks = JSON.parse(requests.at(-1)!).flatMap((msg: { content: unknown }) => msg.content);
  const result = blocks.find((b: { type: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === 'toolu_replay');
  expect(result).toBeDefined();
  expect(result.is_error).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain(approvalType === 'ASK_USER' ? 'stable' : 'replay-confirmed');
}, 20_000);
