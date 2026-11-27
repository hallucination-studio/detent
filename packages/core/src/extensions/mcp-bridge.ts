import { createSseClient } from './mcp-sse.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { defineExtensionTool, type DetentCapabilityPack, type ToolGovernancePolicy } from '../extensions.js';
import { escapeTableCell } from '../gitlab/note-streamer.js';
import { formatHttpError, logError, redactGitUrl, scrubJson } from '../gitlab/redact.js';
import { normalizeHubValue } from '../workflows/hub-frontmatter.js';
import type { WorkflowApproverTier } from '../workflows/hub-workflows.js';
import { isHubPathSegment } from '../workspace/hub-paths.js';

export interface McpCapabilityConfig {
  name: string;
  setupHint?: string;
  transport: {
    type: 'streamable-http' | 'sse';
    url: string;
    headers?: Record<string, string>;
  };
  defaultPolicy?: ToolGovernancePolicy;
  toolPolicies?: Record<string, ToolGovernancePolicy>;
  approverTier?: WorkflowApproverTier;
  allowedTools?: readonly string[];
  toolPrefix?: string;
  timeoutMs?: number;
}

const preferredProtocolVersion = '2025-03-26';
const supportedProtocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const sensitiveHeader = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)$/i;
const policySchema = z.enum(['readonly', 'coding_auto', 'always_approve']);
const capabilitySchema = z.object({
  name: z.string().trim().refine(isHubPathSegment, 'Expected a capability identifier'),
  setupHint: z.string().optional(),
  transport: z.object({
    type: z.enum(['streamable-http', 'sse']),
    url: z.string().trim().refine(value => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    }, 'Expected an HTTP(S) URL without credentials'),
    headers: z.record(z.string()).optional(),
  }).strict(),
  defaultPolicy: policySchema.optional(),
  toolPolicies: z.record(policySchema).optional(),
  approverTier: z.enum(['standard', 'prod']).optional(),
  allowedTools: z.array(z.string()).optional(),
  toolPrefix: z.string().refine(value => !!sanitizeIdentifier(value), 'Expected a usable tool prefix').optional(),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
}).strict();

const configSchema = z.object({
  capabilities: z.array(capabilitySchema).superRefine((configs, ctx) => {
    const names = new Set<string>();
    for (const [index, config] of configs.entries()) {
      const name = normalizeHubValue(config.name);
      if (names.has(name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'Duplicate capability name' });
      names.add(name);
    }
  }),
}).strict();

function validateConfig(value: unknown): McpCapabilityConfig[] {
  const parsed = configSchema.safeParse(value);
  if (parsed.success) return parsed.data.capabilities;
  // Zod's default messages can echo supplied values and keys.
  const issue = parsed.error.issues[0];
  const field = issue.path.slice(0, issue.path[2] === 'transport' ? 4 : 3).join('.');
  const detail = issue.code === 'custom' ? ' (' + issue.message + ')' : '';
  throw Error('Invalid MCP capability configuration' + (field ? ' at ' + field : '') + detail);
}

function parseJson(text: string, errorMessage: string, secrets?: Set<string>): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    logError('mcp-bridge', error, secrets && [...secrets], errorMessage);
    throw Error(errorMessage);
  }
}

export function parseMcpCapabilitiesConfig(raw: string): McpCapabilityConfig[] {
  return validateConfig(parseJson(raw, 'Invalid MCP capability configuration JSON'));
}

export async function loadMcpCapabilitiesFile(filePath: string): Promise<McpCapabilityConfig[]> {
  return parseMcpCapabilitiesConfig(await readFile(filePath, 'utf8'));
}

function sanitizeIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
}

function scrubSecrets(text: string, secrets: Set<string>) {
  text = redactGitUrl(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '***');
  return text;
}

function resolveHeaders(templates: Record<string, string>, env: NodeJS.ProcessEnv, expand = true) {
  const missing = new Set<string>();
  const secrets = new Set<string>();
  const addSecret = (value: string) => {
    if (value) secrets.add(value);
    if (value.trim()) secrets.add(value.trim());
  };
  const headers = Object.fromEntries(Object.entries(templates).map(([name, template]) => {
    const value = expand ? template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, variable: string) => {
      const secret = Object.hasOwn(env, variable) ? env[variable] : undefined;
      if (!secret) {
        missing.add(variable);
        return placeholder;
      }
      addSecret(secret);
      return secret;
    }) : template;
    if (sensitiveHeader.test(name)) {
      addSecret(value);
      const bearer = /^Bearer\s+(.+)$/i.exec(value.trim());
      if (bearer) addSecret(bearer[1]);
    }
    return [name, value];
  }));
  return { headers, missing, secrets };
}

type Scrub = (text: string) => string;

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function jsonSchemaToZodShape(schema: unknown, scrub: Scrub = redactGitUrl): z.ZodRawShape {
  const fields = jsonObject(schema);
  const properties = jsonObject(fields?.properties) ?? {};
  const required = new Set(Array.isArray(fields?.required) ? fields.required : []);
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    if (scrub(name) !== name) throw Error('MCP tool schema contains sensitive data');
    const field = jsonSchemaToZod(value, scrub);
    return [name, required.has(name) ? field : field.optional()];
  }));
}

function jsonSchemaToZod(value: unknown, scrub: Scrub): z.ZodTypeAny {
  const schema = jsonObject(value);
  let field: z.ZodTypeAny = z.unknown();
  if (schema && !['anyOf', 'oneOf', 'allOf'].some(key => Object.hasOwn(schema, key))) {
    switch (schema.type) {
      case 'string': {
        field = z.string();
        const values: unknown = schema.enum;
        if (Array.isArray(values) && values.length && values.every((item): item is string => typeof item === 'string')) {
          if (values.some(item => scrub(item) !== item)) throw Error('MCP tool schema contains sensitive data');
          const [first, ...rest] = values;
          field = z.enum([first, ...rest]);
        }
        break;
      }
      case 'number': field = z.number(); break;
      case 'integer': field = z.number().int(); break;
      case 'boolean': field = z.boolean(); break;
      case 'array': field = z.array(jsonSchemaToZod(schema.items, scrub)); break;
      case 'object': field = jsonObject(schema.properties)
        ? z.object(jsonSchemaToZodShape(schema, scrub))
        : z.record(z.unknown()); break;
    }
  }
  return typeof schema?.description === 'string' ? field.describe(scrub(schema.description)) : field;
}

function matchesReply(value: unknown, id: number): value is Record<string, unknown> {
  const message = jsonObject(value);
  return message?.id === id && !Object.hasOwn(message, 'method');
}

async function readEventStream(body: ReadableStream<Uint8Array>, id: number, secrets: Set<string>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let skipLineFeed = false;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw Error('MCP event stream ended before its response');
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      pending += (skipLineFeed ? chunk.replace(/^\n/, '') : chunk).replace(/\r\n?/g, '\n');
      skipLineFeed = chunk.endsWith('\r');
      let offset = 0;
      for (const newline of pending.matchAll(/\n/g)) {
        const line = pending.slice(offset, newline.index);
        offset = newline.index + 1;
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (line || !data.length) continue;
        const payload = data.join('\n');
        data = [];
        if (!payload.trim()) continue;
        const message = parseJson(payload, 'Invalid MCP event stream JSON', secrets);
        const messages: unknown[] = Array.isArray(message) ? message : [message];
        const reply = messages.find(item => matchesReply(item, id));
        if (reply) return reply;
      }
      pending = pending.slice(offset);
    }
  } finally {
    void reader.cancel().catch(error => logError('mcp-bridge', error, [...secrets]));
  }
}

async function checkHttp(response: Response, secrets: Set<string>) {
  if (response.ok) return;
  const context = 'MCP HTTP error ' + response.status;
  const body = await response.text().catch(error => logError('mcp-bridge', error, [...secrets], context));
  logError('mcp-bridge', context, [...secrets], body);
  throw Error(body.trim() ? formatHttpError('MCP', response.status, body, [...secrets]) : context);
}

async function readReply(response: Response, id: number, secrets: Set<string>) {
  await checkHttp(response, secrets);
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let message: unknown;
  if (type === 'application/json') {
    message = parseJson(await response.text(), 'Invalid MCP response JSON', secrets);
  } else if (type === 'text/event-stream' && response.body) {
    message = await readEventStream(response.body, id, secrets);
  } else {
    void response.body?.cancel().catch(error => logError('mcp-bridge', error, [...secrets]));
    throw Error('Unsupported MCP response content type');
  }
  if (!matchesReply(message, id) || message.jsonrpc !== '2.0' ||
      Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw Error('Invalid MCP JSON-RPC response');
  if (Object.hasOwn(message, 'error')) {
    const error = jsonObject(message.error);
    if (!error || !Number.isInteger(error.code) || typeof error.message !== 'string') throw Error('Invalid MCP JSON-RPC error');
    throw Error(`MCP JSON-RPC error ${error.code}: ${error.message}`);
  }
  return message.result;
}

interface McpSession {
  protocolVersion: string;
  sessionId?: string;
}

function createClient(url: string, resolvedHeaders: Record<string, string>, timeoutMs: number, http: typeof fetch, secrets: Set<string>) {
  let nextId = 0;
  let initialized: Promise<McpSession> | undefined;
  const baseHeaders = new Headers(resolvedHeaders);
  baseHeaders.set('Content-Type', 'application/json');
  baseHeaders.set('Accept', 'application/json, text/event-stream');
  baseHeaders.delete('Mcp-Session-Id');
  baseHeaders.delete('MCP-Protocol-Version');

  function post(message: { id?: number; method: string; params?: object }, session?: McpSession) {
    const headers = new Headers(baseHeaders);
    if (session) {
      headers.set('MCP-Protocol-Version', session.protocolVersion);
      if (session.sessionId) headers.set('Mcp-Session-Id', session.sessionId);
    }
    return http(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
  }

  async function initializeSession() {
    const id = ++nextId;
    const response = await post({
      id, method: 'initialize', params: { protocolVersion: preferredProtocolVersion, capabilities: {}, clientInfo: { name: 'detent', version: '1.0.0' } },
    });
    const result = await readReply(response, id, secrets);
    const protocolVersion = jsonObject(result)?.protocolVersion;
    if (typeof protocolVersion !== 'string' || !supportedProtocolVersions.has(protocolVersion)) {
      throw Error('Unsupported MCP protocol version');
    }
    const sessionId = response.headers.get('mcp-session-id') ?? undefined;
    if (sessionId !== undefined) {
      if (!/^[\x21-\x7e]+$/.test(sessionId)) throw Error('Invalid MCP session ID');
      secrets.add(sessionId);
    }
    const session = { protocolVersion, sessionId };
    try {
      const notification = await post({ method: 'notifications/initialized' }, session);
      await checkHttp(notification, secrets);
      await notification.body?.cancel();
    } catch (error) {
      logError('mcp-bridge', error, [...secrets]);
      // The notification is best-effort. Tool discovery still verifies the connection.
    }
    return session;
  }

  function initialize() {
    return initialized ??= initializeSession().catch(error => {
      initialized = undefined;
      throw error;
    });
  }

  return {
    async close() {
      const session = await initialized;
      if (!session?.sessionId) return;
      const headers = new Headers(baseHeaders);
      headers.set('Mcp-Session-Id', session.sessionId);
      headers.set('MCP-Protocol-Version', session.protocolVersion);
      const response = await http(url, { method: 'DELETE', redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
      await checkHttp(response, secrets);
      await response.body?.cancel();
    },
    async request(method: string, params?: object) {
      const current = initialize();
      const session = await current;
      const id = ++nextId;
      const response = await post({ id, method, params }, session);
      // Reopen an expired session for later requests. Surface this failure without replaying a tool call.
      if (response.status === 404 && session.sessionId && initialized === current) initialized = undefined;
      return readReply(response, id, secrets);
    },
  };
}

const toolListSchema = z.object({
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
  })),
  nextCursor: z.string().optional(),
});

const toolResultSchema = z.object({
  structuredContent: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
});

async function listTools(client: ReturnType<typeof createClient>) {
  const tools: z.infer<typeof toolListSchema>['tools'] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = toolListSchema.parse(await client.request('tools/list', cursor === undefined ? undefined : { cursor }));
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) return tools;
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw Error('MCP tool pagination did not complete');
}

interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  http?: typeof fetch;
  resolvedHeaders?: boolean;
  secrets?: readonly string[];
  scoped?: boolean;
}

async function connect(cfg: McpCapabilityConfig, options: ConnectOptions): Promise<DetentCapabilityPack> {
  const { http = fetch } = options;
  const templates = cfg.transport.headers ?? {};
  const { headers, missing, secrets } = options.resolvedHeaders
    ? resolveHeaders(templates, {}, false)
    : resolveHeaders(templates, options.env ?? process.env);
  if (options.resolvedHeaders) for (const value of Object.values(headers)) if (value) secrets.add(value);
  for (const value of options.secrets ?? []) if (value) secrets.add(value);
  const scrub = (text: string) => scrubSecrets(text, secrets);
  const pack = { name: cfg.name, approverTier: cfg.approverTier };
  const disabled = (hint: string): DetentCapabilityPack => ({ ...pack, enabled: false, setupHint: scrub(cfg.setupHint ?? hint), tools: [] });
  if (missing.size) return disabled('缺少外部 MCP 环境变量：' + [...missing].join('、'));

  try {
    const open = () => cfg.transport.type === 'sse'
      ? createSseClient(cfg.transport.url, headers, cfg.timeoutMs ?? 30_000, http)
      : createClient(cfg.transport.url, headers, cfg.timeoutMs ?? 30_000, http, secrets);
    const shared = options.scoped || cfg.transport.type === 'sse' ? undefined : open();
    async function withClient<T>(operation: (client: ReturnType<typeof open>) => Promise<T>) {
      const client = shared ?? open();
      try { return await operation(client); }
      finally { if (!shared) await client.close().catch(error => logError('mcp-bridge', error, [...secrets])); }
    }
    const allowed = cfg.allowedTools && new Set(cfg.allowedTools);
    const prefix = sanitizeIdentifier(cfg.toolPrefix ?? cfg.name);
    const seen = new Set<string>();
    const tools = (await withClient(listTools)).filter(remote => !allowed || allowed.has(remote.name)).map(remote => {
      const toolName = sanitizeIdentifier(remote.name);
      const name = prefix + '__' + toolName;
      if (!prefix || !toolName || name.length > 64 || seen.has(name) || scrub(name) !== name || scrub(remote.name) !== remote.name)
        throw Error('Invalid or duplicate MCP tool name');
      seen.add(name);
      const override = cfg.toolPolicies && Object.hasOwn(cfg.toolPolicies, remote.name) ? cfg.toolPolicies[remote.name] : undefined;
      const policy = override ?? cfg.defaultPolicy ?? 'always_approve';
      return defineExtensionTool({
        name, policy, description: scrub(remote.description?.trim() || `调用 ${cfg.name} 扩展服务`),
        schema: jsonSchemaToZodShape(remote.inputSchema, scrub),
        ...(policy === 'always_approve' && {
          renderApprovalCard(approvalId, input) {
            const json = JSON.stringify(scrubJson(input, scrub), null, 2);
            const preview = json.length > 4000 ? json.slice(0, 4000) + '\n…' : json;
            return [
              '### 🛡️ 外部 MCP 工具执行审批',
              '**审批单** ' + escapeTableCell(scrub(approvalId), 'code'),
              '**能力包** ' + escapeTableCell(scrub(cfg.name), 'code'),
              '**工具** ' + escapeTableCell(scrub(remote.name), 'code'),
              preview.replace(/^/gm, '    '),
              '> 👍 或 `/approve` 放行 · 👎 或 `/reject <原因>` 拒绝',
            ].join('\n\n');
          },
        }),
        async execute(input) {
          try {
            const result = toolResultSchema.parse(await withClient(client => client.request('tools/call', { name: remote.name, arguments: input })));
            if (result.isError) {
              const text = result.content?.map(jsonObject)
                .flatMap(item => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n');
              throw Error(text || 'MCP tool reported an error');
            }
            return scrubJson(result.structuredContent ?? result.content ?? [], scrub);
          } catch (error) {
            throw Error(logError('mcp-bridge', error, [...secrets]));
          }
        },
      });
    });
    return { ...pack, enabled: true, setupHint: cfg.setupHint === undefined ? undefined : scrub(cfg.setupHint), tools };
  } catch (error) {
    logError('mcp-bridge', error, [...secrets]);
    return disabled('外部 MCP 服务不可达或初始化失败（' + cfg.name + '）');
  }
}

export async function connectMcpCapabilityPack(cfg: McpCapabilityConfig, options: ConnectOptions = {}): Promise<DetentCapabilityPack> {
  const [config] = validateConfig({ capabilities: [cfg] });
  return connect(config, options);
}

export async function loadMcpCapabilityPacks(
  configs: readonly McpCapabilityConfig[], options: ConnectOptions & { reservedToolNames?: ReadonlySet<string> } = {},
): Promise<DetentCapabilityPack[]> {
  const packs = await Promise.all(validateConfig({ capabilities: configs }).map(cfg => connect(cfg, options)));
  const names = new Set(options.reservedToolNames);
  const collisions = new Set<string>();
  for (const pack of packs) {
    for (const tool of pack.tools) {
      if (names.has(tool.name)) collisions.add(tool.name);
      names.add(tool.name);
    }
  }
  return packs.map(pack => pack.tools.some(tool => collisions.has(tool.name)) ? {
    ...pack, enabled: false, tools: [], setupHint: pack.setupHint ?? '外部 MCP 工具名称冲突（' + pack.name + '）',
  } : pack);
}
