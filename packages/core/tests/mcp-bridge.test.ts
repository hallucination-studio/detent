import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-code';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  connectMcpCapabilityPack, createDetentApp, GitLabClient, jsonSchemaToZodShape, loadConfig, loadMcpCapabilitiesFile,
  loadMcpCapabilityPacks, parseMcpCapabilitiesConfig, type McpCapabilityConfig, type SessionOrchestrator,
} from '../src/index.js';
import * as mysql from '../src/db/mysql.js';
import * as database from '../src/db/repository.js';
import { bareProjects } from './bare-projects.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { mockMcpServer } from './mock-mcp-server.js';

const sdkTurn = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-code', async original => {
  const sdk = await original<typeof import('@anthropic-ai/claude-code')>();
  return {
    ...sdk,
    createSdkMcpServer: vi.fn(sdk.createSdkMcpServer),
    query: vi.fn(async function* ({ options }: Parameters<typeof sdk.query>[0]) {
      const result = await sdkTurn(options);
      yield { type: 'result', subtype: 'success', session_id: options?.extraArgs?.['session-id'], result };
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const token = 'external-bearer-v3';
const sessionId = 'opaque-mcp-session';
const endpoint = 'https://mcp.example.test/rpc?customer=test';
const initialized = {
  protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' },
};
const inputSchema = {
  type: 'object', properties: { target: { type: 'string', description: 'Target identifier' } }, required: ['target'],
};
const remoteTools = [
  { name: 'read.status', inputSchema },
  { name: 'apply:change', inputSchema, annotations: { readOnlyHint: true } },
  { name: 'ignored', inputSchema },
];

function capability(url = endpoint, overrides: Partial<McpCapabilityConfig> = {}): McpCapabilityConfig {
  return { name: 'remote-pack', transport: { type: 'streamable-http', url }, ...overrides };
}

function writeJson(response: ServerResponse, body: object) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

it('reads and validates capability files and trims the configured filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detent-mcp-config-'));
  try {
    const file = join(root, 'capabilities.json');
    const config = capability(endpoint, {
      name: ' Remote-Pack ', defaultPolicy: 'always_approve', toolPolicies: { 'read.status': 'readonly' },
      approverTier: 'prod', timeoutMs: 500, toolPrefix: 'remote.', allowedTools: ['read.status'],
      transport: { type: 'streamable-http', url: endpoint, headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
    });
    await writeFile(file, JSON.stringify({ capabilities: [config, capability(endpoint, { name: 'other', timeoutMs: 120_000 })] }));
    await expect(loadMcpCapabilitiesFile(file)).resolves.toEqual([
      { ...config, name: 'Remote-Pack' }, expect.objectContaining({ name: 'other', timeoutMs: 120_000 }),
    ]);
    expect(loadConfig({ DETENT_MCP_CAPABILITIES_FILE: ' ' + file + ' ' }).mcpCapabilitiesFile).toBe(file);
    expect(loadConfig({ DETENT_MCP_CAPABILITIES_FILE: '  ' }).mcpCapabilitiesFile).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects invalid JSON, normalized duplicate names, and invalid fields without echoing values', () => {
  expect(() => parseMcpCapabilitiesConfig('{"Authorization":"Bearer ' + token)).toThrow(/^Invalid MCP capability configuration JSON$/);
  expect(() => parseMcpCapabilitiesConfig(JSON.stringify({ capabilities: [capability(), capability(endpoint, { name: ' REMOTE-PACK ' })] })))
    .toThrow(/Duplicate capability name/);
  for (const [field, value] of [
    ['name', ''], ['name', 'some pack'], ['name', '../pack'],
    ['transport.url', 'https://user:' + token + '@mcp.example.test/'], ['transport.url', 'file:///tmp/mcp'],
    ['transport.url', '/mcp'], ['transport.type', 'stdio'],
    ['defaultPolicy', token], ['toolPolicies', { 'read.status': token }], ['approverTier', 'administrator'],
    ['timeoutMs', 499], ['timeoutMs', 120_001], ['timeoutMs', 500.5], ['toolPrefix', '...'],
  ] as const) {
    const [property, nested] = field.split('.');
    const base = capability();
    const config = { ...base, [property]: nested ? { ...base.transport, [nested]: value } : value };
    expect(() => parseMcpCapabilitiesConfig(JSON.stringify({ capabilities: [config] })))
      .toThrow(expect.objectContaining({ message: expect.stringMatching(new RegExp('^Invalid MCP capability configuration at capabilities\\.0\\.' + field + '(?: \\(.*\\))?$')) }));
  }
});

it('converts primitive, enum, array, nested, record and unknown JSON Schema fields to Zod', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    required: ['text', 'ratio', 'count', 'active', 'rows', 'map'],
    properties: {
      text: { type: 'string' }, ratio: { type: 'number' }, count: { type: 'integer' }, active: { type: 'boolean' },
      color: { type: 'string', enum: ['red', 'blue'], description: 'Pick a color' },
      rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      map: { type: 'object' }, union: { type: 'string', anyOf: [{ type: 'string' }, { type: 'number' }] },
      unionType: { type: ['string', 'null'] }, ref: { $ref: '#/definitions/foo' },
    },
  });
  const schema = z.object(shape);
  const input = { text: 'message', ratio: 1.5, count: 1, active: false, rows: [{ id: 2 }], map: { arbitrary: [1, true] } };
  expect(schema.parse(input)).toEqual(input);
  expect(schema.parse({ ...input, union: 4, unionType: null, ref: { any: ['value'] } })).toMatchObject({ union: 4, unionType: null, ref: { any: ['value'] } });
  expect(shape.color.description).toBe('Pick a color');
  for (const invalid of [
    { text: undefined }, { text: 2 }, { color: 'green' }, { count: 1.5 }, { ratio: '1.5' },
    { active: 1 }, { rows: [{}] }, { rows: [{ id: '2' }] }, { rows: {} }, { map: [] },
  ]) expect(schema.safeParse({ ...input, ...invalid }).success).toBe(false);
});

it.each(['application/json', 'text/event-stream'])('uses %s for initialization, pagination and a correlated tool call', async contentType => {
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(contentType === 'application/json' ? 202 : 405).end();
      return;
    }
    const result = rpc.method === 'initialize' ? initialized : rpc.method === 'tools/call'
      ? { content: [{ type: 'text', text: '状态正常' }] }
      : rpc.params?.cursor ? { tools: remoteTools.slice(1) } : { tools: remoteTools.slice(0, 1), nextCursor: 'second-page' };
    if (rpc.method === 'initialize') response.setHeader('Mcp-Session-Id', sessionId);
    const reply = { jsonrpc: '2.0', id: rpc.id, result };
    if (contentType === 'application/json') return writeJson(response, reply);

    response.writeHead(200, { 'Content-Type': contentType + '; charset=UTF-8' });
    response.write(': keepalive\r');
    setImmediate(() => {
      const event = JSON.stringify(reply, null, 2).split('\n').map(line => 'data: ' + line).join('\r\n');
      response.write('\ndata:\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }) +
        '\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: rpc.id, method: 'ping' }) + '\r\n\r\n' + event + '\r\n\r\n');
      // A matching response ends the call even when the server keeps its stream open.
      if (rpc.method !== 'tools/call') response.end();
    });
  });
  try {
    const cfg = capability(server.url, {
      allowedTools: ['read.status', 'apply:change'], toolPrefix: '__My.Pack__',
      toolPolicies: { 'read.status': 'readonly' }, timeoutMs: 1000,
      transport: { type: 'streamable-http', url: server.url, headers: { Authorization: 'Bearer ${MCP_TOKEN}', 'mcp-session-id': 'stale' } },
    });
    const pack = await connectMcpCapabilityPack(cfg, { http: server.http, env: { MCP_TOKEN: token } });
    expect(pack).toMatchObject({ enabled: true, name: 'remote-pack' });
    expect(pack.tools.map(({ name, policy }) => [name, policy])).toEqual([
      ['My_Pack__read_status', 'readonly'], ['My_Pack__apply_change', 'always_approve'],
    ]);
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'bridge');
    await expect(pack.tools[0].execute({ target: 'demo' }, { session, repo, workspaceRoot: '.', permissionMode: 'plan' }))
      .resolves.toEqual([{ type: 'text', text: '状态正常' }]);
    expect(server.requests.map(({ rpc }) => rpc.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call',
    ]);
    const [initialize, notification, firstPage, secondPage, call] = server.requests.map(request => request.rpc);
    expect(initialize.params).toEqual({ protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'detent', version: '1.0.0' } });
    expect(notification).not.toHaveProperty('id');
    expect(firstPage.params).toBeUndefined();
    expect(secondPage.params).toEqual({ cursor: 'second-page' });
    expect(call.params).toEqual({ name: 'read.status', arguments: { target: 'demo' } });
    expect(new Set([initialize.id, firstPage.id, secondPage.id, call.id]).size).toBe(4);
    for (const [index, request] of server.requests.entries()) {
      expect(request).toMatchObject({ method: 'POST', url: '/mcp', rpc: { jsonrpc: '2.0' }, headers: {
        accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: 'Bearer ' + token,
      } });
      expect(request.headers['mcp-session-id']).toBe(index ? sessionId : undefined);
      expect(request.headers['mcp-protocol-version']).toBe(index ? '2025-03-26' : undefined);
    }
  } finally {
    await server.close();
  }
});

it.each(['2024-11-05', '2025-06-18'])('uses the negotiated MCP protocol version %s on subsequent requests', async protocolVersion => {
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    const reply = { jsonrpc: '2.0', id: rpc.id };
    if (rpc.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', sessionId);
      return writeJson(response, { ...reply, result: { ...initialized, protocolVersion } });
    }
    writeJson(response, { ...reply, result: { tools: [remoteTools[0]] } });
  });
  try {
    const pack = await connectMcpCapabilityPack(capability(server.url), { http: server.http });
    expect(pack).toMatchObject({ enabled: true, tools: [{ name: 'remote-pack__read_status' }] });
    expect(server.requests[0].rpc.params?.protocolVersion).toBe('2025-03-26');
    expect(server.requests.map(({ rpc, headers }) => [rpc.method, headers['mcp-protocol-version'], headers['mcp-session-id']]))
      .toEqual([
        ['initialize', undefined, undefined],
        ['notifications/initialized', protocolVersion, sessionId],
        ['tools/list', protocolVersion, sessionId],
      ]);
  } finally {
    await server.close();
  }
});

it('rejects an unsupported MCP protocol version before sending any subsequent requests', async () => {
  const server = await mockMcpServer((rpc, response) => {
    writeJson(response, { jsonrpc: '2.0', id: rpc.id, result: { ...initialized, protocolVersion: '2099-01-01' } });
  });
  try {
    await expect(connectMcpCapabilityPack(capability(server.url), { http: server.http }))
      .resolves.toMatchObject({ enabled: false, tools: [] });
    expect(server.requests.map(({ rpc }) => rpc.method)).toEqual(['initialize']);
  } finally {
    await server.close();
  }
});

it('reinitializes an expired session for the next call without replaying the failed call', async () => {
  let handshakes = 0;
  let calls = 0;
  const server = await mockMcpServer((rpc, response) => {
    const reply = { jsonrpc: '2.0', id: rpc.id };
    if (rpc.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'renewable-session-' + ++handshakes);
      return writeJson(response, { ...reply, result: initialized });
    }
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    if (rpc.method === 'tools/list') return writeJson(response, { ...reply, result: { tools: [remoteTools[0]] } });
    if (++calls === 1) {
      response.writeHead(404).end();
      return;
    }
    writeJson(response, { ...reply, result: { structuredContent: { session: 'renewable-session-' + handshakes } } });
  });
  try {
    const pack = await connectMcpCapabilityPack(capability(server.url), { http: server.http });
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'bridge');
    const execute = () => pack.tools[0].execute({ target: 'demo' }, { session, repo, workspaceRoot: '.', permissionMode: 'default' });
    await expect(execute()).rejects.toThrow(/^MCP HTTP error 404$/);
    expect(calls).toBe(1);
    await expect(execute()).resolves.toEqual({ session: '***' });
    expect(server.requests.filter(({ rpc }) => rpc.method === 'initialize').map(({ headers }) => headers['mcp-session-id']))
      .toEqual([undefined, undefined]);
    expect(server.requests.filter(({ rpc }) => rpc.method === 'tools/call').map(({ headers }) => headers['mcp-session-id']))
      .toEqual(['renewable-session-1', 'renewable-session-2']);
  } finally {
    await server.close();
  }
});

it('disables packs with missing credentials or an unreachable endpoint and preserves their approval tier', async () => {
  const http = vi.fn<typeof fetch>();
  const config = capability(endpoint, {
    approverTier: 'prod', transport: { type: 'streamable-http', url: endpoint, headers: {
      Authorization: 'Bearer ${MISSING_TOKEN}', 'X-Proof': '${EMPTY_PROOF}/${MISSING_TOKEN}/${PRESENT_KEY}',
    } },
  });
  const options = { http, env: { EMPTY_PROOF: '', PRESENT_KEY: token } };
  await expect(connectMcpCapabilityPack(config, options)).resolves.toEqual({
    enabled: false, name: 'remote-pack', approverTier: 'prod', tools: [], setupHint: '缺少外部 MCP 环境变量：MISSING_TOKEN、EMPTY_PROOF',
  });
  await expect(connectMcpCapabilityPack({ ...config, setupHint: 'Configure ' + token }, options))
    .resolves.toMatchObject({ enabled: false, setupHint: 'Configure ***' });
  expect(http).not.toHaveBeenCalled();
  const offline = await mockMcpServer(() => {});
  await offline.close();
  await expect(connectMcpCapabilityPack(capability(offline.url, { approverTier: 'prod', timeoutMs: 500 }), { http: offline.http }))
    .resolves.toEqual({
      enabled: false, name: 'remote-pack', approverTier: 'prod', tools: [], setupHint: '外部 MCP 服务不可达或初始化失败（remote-pack）',
    });
});

it('times out an open event stream and refuses HTTP redirects carrying authorization', async () => {
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'initialize') {
      response.writeHead(307, { Location: '/redirected' }).end();
    }
  });
  try {
    const pack = await connectMcpCapabilityPack(capability(server.url, {
      timeoutMs: 500, transport: { type: 'streamable-http', url: server.url, headers: { Authorization: 'Bearer ' + token } },
    }), { http: server.http });
    expect(pack).toMatchObject({ enabled: false, tools: [] });
    expect(server.requests.map(request => request.url)).toEqual(['/mcp']);
  } finally {
    await server.close();
  }

  const hanging = await mockMcpServer((_rpc, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': still waiting\n\n');
  });
  try {
    await expect(connectMcpCapabilityPack(capability(hanging.url, { timeoutMs: 500 }), { http: hanging.http }))
      .resolves.toMatchObject({ enabled: false, tools: [] });
    expect(hanging.requests).toHaveLength(1);
  } finally {
    await hanging.close();
  }
});

it.each(['repeated cursor', 'unbounded pagination'])('fails closed on %s', async mode => {
  let pages = 0;
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    const result = rpc.method === 'initialize' ? initialized : {
      tools: [remoteTools[0]], nextCursor: mode === 'repeated cursor' ? 'never advances' : String(++pages),
    };
    writeJson(response, { jsonrpc: '2.0', id: rpc.id, result });
  });
  try {
    await expect(connectMcpCapabilityPack(capability(server.url), { http: server.http }))
      .resolves.toMatchObject({ enabled: false, tools: [] });
    expect(server.requests.filter(request => request.rpc.method === 'tools/list')).toHaveLength(mode === 'repeated cursor' ? 2 : 20);
  } finally {
    await server.close();
  }
});

it('rejects unusable or colliding tool names and blocks conflicts with explicitly registered tools', async () => {
  const longest = 't'.repeat(61);
  const tools = ['a.b', 'a:b', '...', longest, longest + 't'].map(name => ({ name, inputSchema }));
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(200).end();
      return;
    }
    writeJson(response, { jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? initialized : { tools } });
  });
  try {
    const opts = { http: server.http };
    const cfg = capability(server.url, { toolPrefix: 'p', defaultPolicy: 'coding_auto' });
    for (const allowedTools of [['a.b', 'a:b'], ['...'], [longest + 't']])
      await expect(connectMcpCapabilityPack({ ...cfg, allowedTools }, opts)).resolves.toMatchObject({ enabled: false, tools: [] });
    await expect(connectMcpCapabilityPack({ ...cfg, allowedTools: [longest] }, opts)).resolves.toMatchObject({
      enabled: true, tools: [{ name: 'p__' + longest, policy: 'coding_auto' }],
    });
    const a = { ...cfg, allowedTools: ['a.b'] };
    const b = { ...cfg, name: 'other', allowedTools: ['a:b'] };
    const [first, second, independent] = await loadMcpCapabilityPacks([a, b, { ...b, name: 'separate', toolPrefix: 'other' }], opts);
    for (const pack of [first, second]) expect(pack).toMatchObject({ enabled: false, tools: [], setupHint: expect.stringContaining('名称冲突') });
    expect(independent).toMatchObject({ enabled: true, tools: [{ name: 'other__a_b' }] });
    await expect(loadMcpCapabilityPacks([a], { ...opts, reservedToolNames: new Set(['p__a_b']) }))
      .resolves.toMatchObject([{ enabled: false, tools: [] }]);
  } finally {
    await server.close();
  }
});

it('redacts header values and Git URL credentials from tool metadata, results, errors, and approval cards', async () => {
  const literalBearer = 'literal-bearer-v3';
  const apiKey = 'literal-api-key-v3';
  const interpolation = 'custom-header-secret';
  const numericToken = 86219154;
  const gitUrl = 'https://oauth2:git-private@git.example/project';
  const gitSafe = 'https://oauth2:***@git.example/project';
  const echo = [token, literalBearer, apiKey, interpolation, sessionId, gitUrl].join(' ');
  const safeEcho = ['***', '***', '***', '***', '***', gitSafe].join(' ');
  const tool = { name: 'publish', description: echo, inputSchema: {
    type: 'object', properties: { target: { type: 'string', description: echo } }, required: ['target'],
  } };
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    const reply = { jsonrpc: '2.0', id: rpc.id };
    if (rpc.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', sessionId);
      return writeJson(response, { ...reply, result: initialized });
    }
    if (rpc.method === 'tools/list') return writeJson(response, { ...reply, result: { tools: [tool] } });
    const target = (rpc.params?.arguments as { target: string }).target;
    if (target === 'rpc-error') return writeJson(response, { ...reply, error: { code: -32000, message: echo, data: token } });
    if (target === 'invalid-rpc') return writeJson(response, { ...reply, id: String(rpc.id), result: { echo } });
    if (target === 'ambiguous-rpc') return writeJson(response, { ...reply, result: {}, error: { code: 1, message: echo } });
    const content = [{ type: 'text', text: echo }, { type: 'resource', resource: { uri: gitUrl, text: token } }];
    const result = target === 'structured'
      ? { structuredContent: { key: [echo, { [apiKey]: token }], numericToken, count: 3 }, content }
      : { content, isError: target === 'tool-error' };
    writeJson(response, { ...reply, result });
  });
  try {
    const http: typeof fetch = (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.params?.arguments?.target === 'transport-error') return Promise.reject(Error('transport: ' + echo));
      return server.http(url, init);
    };
    const pack = await connectMcpCapabilityPack(capability(server.url, { transport: {
      type: 'streamable-http', url: server.url, headers: {
        Authorization: 'Bearer ${MCP_TOKEN}', 'Proxy-Authorization': 'bEaReR ' + literalBearer,
        'X-Api-Key': apiKey, 'X-Other': 'prefix-${MCP_CUSTOM}', 'X-Auth-Token': String(numericToken),
      },
    } }), { http, env: { MCP_TOKEN: token, MCP_CUSTOM: interpolation } });
    expect(pack.enabled).toBe(true);
    const [wrapped] = pack.tools;
    expect(wrapped.description).toBe(safeEcho);
    expect(wrapped.schema.target.description).toBe(safeEcho);
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'bridge');
    const ctx = { session, repo, workspaceRoot: '.', permissionMode: 'default' as const };
    const execute = (target: string) => wrapped.execute({ target }, ctx);
    await expect(execute('structured')).resolves.toEqual({ key: [safeEcho, { '***': '***' }], numericToken: '***', count: 3 });
    await expect(execute('text')).resolves.toEqual([
      { type: 'text', text: safeEcho }, { type: 'resource', resource: { uri: gitSafe, text: '***' } },
    ]);
    await expect(execute('tool-error')).rejects.toThrow(safeEcho);
    await expect(execute('rpc-error')).rejects.toThrow('MCP JSON-RPC error -32000: ' + safeEcho);
    await expect(execute('transport-error')).rejects.toThrow('transport: ' + safeEcho);
    for (const target of ['invalid-rpc', 'ambiguous-rpc']) await expect(execute(target)).rejects.toThrow(/^Invalid MCP JSON-RPC response$/);
    const card = await wrapped.renderApprovalCard!('approval-8', { target: echo + 'x'.repeat(5000), [apiKey]: token }, ctx);
    for (const value of [token, literalBearer, apiKey, interpolation, sessionId, 'git-private']) expect(card).not.toContain(value);
    for (const value of ['approval-8', 'remote-pack', 'publish', safeEcho, '…']) expect(card).toContain(value);
    expect(card.length).toBeLessThan(4300);
  } finally {
    await server.close();
  }
});

it.each(['missing', 'malformed', 'invalid'] as const)('fails onReady when the static capabilities file is %s', async state => {
  const root = await mkdtemp(join(tmpdir(), 'detent-mcp-startup-'));
  const file = join(root, 'capabilities.json');
  const initialize = vi.spyOn(mysql, 'initMySqlSchema').mockResolvedValue();
  const app = createDetentApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'hook', DETENT_MCP_CAPABILITIES_FILE: file }));
  try {
    if (state !== 'missing') await writeFile(file, state === 'malformed' ? '{' : '{"capabilities":[{}]}');
    await expect(app.ready()).rejects.toThrow(state === 'missing' ? 'ENOENT' : 'Invalid MCP capability configuration');
    expect(initialize).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('wires onReady packs into profile resolution and permits an MCP mutation only after Coding approval', async () => {
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    const result = rpc.method === 'initialize' ? initialized : rpc.method === 'tools/list' ? { tools: remoteTools } :
      { structuredContent: { status: 'ok', echoed: token } };
    writeJson(response, { jsonrpc: '2.0', id: rpc.id, result });
  });
  const root = await mkdtemp(join(tmpdir(), 'detent-mcp-turn-'));
  const repo = new InMemoryDetentRepository();
  const git = await bareProjects(root);
  vi.spyOn(mysql, 'initMySqlSchema').mockResolvedValue();
  vi.spyOn(database, 'MySqlDetentRepository').mockImplementation(function () {
    return repo as unknown as database.MySqlDetentRepository;
  });
  vi.spyOn(GitLabClient.prototype, 'initBotIdentity').mockResolvedValue();
  vi.spyOn(GitLabClient.prototype, 'getRepositoryFile').mockResolvedValue(null);
  vi.spyOn(GitLabClient.prototype, 'getProject').mockImplementation(git.getProject);
  vi.spyOn(GitLabClient.prototype, 'buildAuthenticatedCloneUrl').mockImplementation(git.buildAuthenticatedCloneUrl);
  vi.spyOn(GitLabClient.prototype, 'hasApprovalPermission').mockImplementation(async (_project, user) => user === 40);
  vi.spyOn(GitLabClient.prototype, 'syncIssueStatusLabel').mockResolvedValue();
  const notes: string[] = [];
  vi.spyOn(GitLabClient.prototype, 'createIssueNote').mockImplementation(async (_project, _issue, body) => ({ id: notes.push(body) }));
  vi.spyOn(GitLabClient.prototype, 'updateIssueNote').mockImplementation(async (_project, _issue, id, body) => { notes[id - 1] = body; });
  vi.stubGlobal('fetch', server.http);
  vi.stubEnv('MCP_TOKEN', token);
  vi.stubEnv('UNCONFIGURED_MCP_TOKEN', undefined);
  const configFile = join(root, 'capabilities.json');
  const filePack = capability(server.url, {
    toolPolicies: { 'read.status': 'readonly' }, allowedTools: ['read.status', 'apply:change'],
    transport: { type: 'streamable-http', url: server.url, headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
  });
  await writeFile(configFile, JSON.stringify({ capabilities: [
    filePack, capability(server.url + '/shadow', { name: 'shadow' }),
  ] }));
  const ephemerals = join(root, 'turns');
  const config = loadConfig({
    DETENT_MCP_CAPABILITIES_FILE: configFile, GITLAB_WEBHOOK_SECRET: 'hook', EPHEMERAL_ROOT: ephemerals,
    HOT_HOLD_TIMEOUT_MS: '2500',
  });
  const explicit = { name: ' SHADOW ', enabled: true, tools: [] };
  let capture!: (orchestrator: SessionOrchestrator) => void;
  const orchestratorReady = new Promise<SessionOrchestrator>(resolve => { capture = resolve; });
  const readName = 'remote-pack__read_status';
  const writeName = 'remote-pack__apply_change';
  const app = createDetentApp(config, {
    capabilities: [explicit],
    mcpCapabilities: [
      capability(server.url, { name: 'inline', allowedTools: [] }),
      capability(server.url, { name: 'offline', transport: {
        type: 'streamable-http', url: server.url, headers: { 'X-Api-Key': '${UNCONFIGURED_MCP_TOKEN}' },
      } }),
    ],
    matchWebhookEvent: () => ({ key: 'bridge', async handle(orchestrator) { capture(orchestrator); } }),
    resolveTurnProfile({ capabilities }) {
      expect(capabilities).toMatchObject([
        explicit, { name: 'remote-pack', enabled: true }, { name: 'inline', enabled: true },
        { name: 'offline', enabled: false, tools: [] },
      ]);
      return { enabledExtensionTools: capabilities![1].tools.map(tool => tool.name) };
    },
  });
  const calls = () => server.requests.filter(request => request.rpc.method === 'tools/call');
  sdkTurn.mockImplementation(async (options: NonNullable<Parameters<typeof query>[0]['options']>) => {
    expect(options.env).not.toHaveProperty('MCP_TOKEN');
    expect(Object.values(options.env!)).not.toContain(token);
    const handlers = vi.mocked(createSdkMcpServer).mock.lastCall![0].tools!;
    const readonly = handlers.find(tool => tool.name === readName)!;
    const mutation = handlers.find(tool => tool.name === writeName)!;
    const result = { content: [{ type: 'text', text: '{"status":"ok","echoed":"***"}' }] };
    if (options.permissionMode === 'plan') {
      await expect(readonly.handler({ target: 'item' }, {})).resolves.toEqual(result);
      await expect(mutation.handler({ target: 'item' }, {})).rejects.toThrow('detent_submit_plan');
      return 'Plan complete';
    }
    await expect(mutation.handler({ target: 'item' }, {})).resolves.toEqual(result);
    return 'Approved change applied';
  });
  try {
    await app.ready();
    expect(server.requests.map(request => request.url)).not.toContain('/mcp/shadow');
    const captureResponse = await app.inject({
      method: 'POST', url: '/webhooks/gitlab', headers: { 'x-gitlab-token': 'hook' }, payload: { object_kind: 'bridge' },
    });
    expect(captureResponse.statusCode).toBe(202);
    const orchestrator = await orchestratorReady;
    const session = await repo.getOrCreateSession(1, 42, 'Bridge test');
    const actor = { userId: 40, username: 'maintainer' };
    await orchestrator.handleUserIntent(1, 42, { type: 'PLAN', ...actor });
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN' });
    expect(await repo.getLatestPendingApproval(session.id)).toMatchObject({ approvalType: 'PLAN' });
    expect(calls().map(request => request.rpc.params?.name)).toEqual(['read.status']);

    const coding = orchestrator.handleUserIntent(1, 42, { type: 'APPROVE', ...actor });
    try {
      await vi.waitFor(async () => expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_TOOL' }));
      const approval = (await repo.getLatestPendingApproval(session.id))!;
      expect(approval).toMatchObject({ approvalType: 'TOOL_USE', toolName: writeName, toolInput: { target: 'item' } });
      const card = notes[approval.gitlabNoteId! - 1];
      for (const text of [approval.id, 'remote-pack', 'apply:change', '"target": "item"']) expect(card).toContain(text);
      expect(calls()).toHaveLength(1);
      await orchestrator.handleUserIntent(1, 42, { type: 'APPROVE', ...actor, targetNoteId: approval.gitlabNoteId! });
    } finally {
      await coding;
    }
    expect(calls().map(request => request.rpc.params)).toEqual([
      { name: 'read.status', arguments: { target: 'item' } }, { name: 'apply:change', arguments: { target: 'item' } },
    ]);
    expect(calls().map(request => request.headers.authorization)).toEqual(['Bearer ' + token, 'Bearer ' + token]);
    expect(notes.join('\n')).not.toContain(token);
    expect(notes.join('\n')).toContain('Approved change applied');
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });
    expect(await repo.getLatestApproval(session.id)).toMatchObject({ status: 'APPROVED', toolName: writeName });
    expect(await readdir(ephemerals)).toEqual([]);
  } finally {
    await app.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
