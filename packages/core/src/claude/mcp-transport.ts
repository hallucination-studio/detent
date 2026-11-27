import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { logError, redactGitUrl, scrubJson } from '../gitlab/redact.js';

type Input = Record<string, unknown>;
export interface McpCallContext {
  rawInput: Input;
  _meta?: Input;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler(input: Input, extra: McpCallContext): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

// Zod 3 has no JSON Schema export. Describe the wire input, before defaults,
// refinements and transforms. The original Zod schema always validates calls.
function inputSchema(field: z.ZodTypeAny): Input {
  const schema: Input = {};
  if (field instanceof z.ZodObject) {
    const fields = Object.entries<z.ZodTypeAny>(field.shape);
    schema.type = 'object';
    schema.properties = Object.fromEntries(fields.map(([key, value]) => [key, inputSchema(value)]));
    schema.required = fields.filter(([, value]) => !value.isOptional()).map(([key]) => key);
    schema.additionalProperties = field._def.unknownKeys === 'passthrough';
  } else if (field instanceof z.ZodString) {
    schema.type = 'string';
    for (const check of field._def.checks) {
      if (check.kind === 'min' || check.kind === 'length') schema.minLength = check.value;
      if (check.kind === 'max' || check.kind === 'length') schema.maxLength = check.value;
      if (check.kind === 'regex' && !check.regex.flags) schema.pattern = check.regex.source;
    }
  } else if (field instanceof z.ZodNumber) {
    schema.type = field.isInt ? 'integer' : 'number';
    for (const check of field._def.checks) {
      if (check.kind === 'min') schema[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
      if (check.kind === 'max') schema[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
    }
  } else if (field instanceof z.ZodArray) {
    schema.type = 'array';
    schema.items = inputSchema(field.element);
    if (field._def.minLength) schema.minItems = field._def.minLength.value;
    if (field._def.maxLength) schema.maxItems = field._def.maxLength.value;
  } else if (field instanceof z.ZodEnum) {
    schema.type = 'string';
    schema.enum = field.options;
  } else if (field instanceof z.ZodBoolean) schema.type = 'boolean';
  else if (field instanceof z.ZodLiteral) schema.const = field.value;
  else if (field instanceof z.ZodRecord) {
    schema.type = 'object';
    schema.additionalProperties = inputSchema(field.valueSchema);
  } else if (field instanceof z.ZodUnion) schema.anyOf = field.options.map(inputSchema);
  else if (field instanceof z.ZodNullable) schema.anyOf = [inputSchema(field.unwrap()), { type: 'null' }];
  else if (field instanceof z.ZodDefault) Object.assign(schema, inputSchema(field.removeDefault()), { default: field._def.defaultValue() });
  else if (field instanceof z.ZodOptional) Object.assign(schema, inputSchema(field.unwrap()));
  else if (field instanceof z.ZodEffects) Object.assign(schema, inputSchema(field.innerType()));
  if (field.description) schema.description = field.description;
  return schema;
}

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(), params: z.record(z.unknown()).optional(),
});
const callSchema = z.object({
  name: z.string(), arguments: z.record(z.unknown()).default({}), _meta: z.record(z.unknown()).optional(),
});

export async function openMcpTransport(tools: McpTool[], secrets: readonly string[]) {
  const token = randomBytes(32).toString('hex');
  const credentials = [token, ...secrets];
  const scrub = (text: string) => redactGitUrl(text, credentials);
  const registry = new Map(tools.map(tool => [tool.name, { ...tool, schema: z.object(tool.inputSchema) }]));
  const catalog = scrubJson({ tools: Array.from(registry.values(), tool => ({
    name: tool.name, description: tool.description, inputSchema: inputSchema(tool.schema),
  })) }, scrub);
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end();
    if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:' + req.socket.localPort)
      return res.writeHead(403).end();
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();

    let id: string | number | null = null;
    const reply = (status: number, payload: object) => res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    const error = (status: number, code: number, message: string) => reply(status, { error: { code, message } });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return error(400, -32700, 'Invalid JSON');
      }
      const request = requestSchema.safeParse(body);
      if (!request.success) return error(400, -32600, 'Invalid JSON-RPC request');
      const { method, params } = request.data;
      if (request.data.id === undefined) return res.writeHead(202).end();
      id = request.data.id;
      switch (method) {
        case 'initialize': {
          const version = params?.protocolVersion;
          return reply(200, { result: {
            protocolVersion: version === '2025-06-18' ? version : '2025-03-26',
            capabilities: { tools: {} }, serverInfo: { name: 'detent', version: '1.0.0' },
          } });
        }
        case 'ping': return reply(200, { result: {} });
        case 'tools/list': return reply(200, { result: catalog });
        case 'tools/call': {
          const call = callSchema.safeParse(params);
          const tool = call.success && registry.get(call.data.name);
          if (!call.success || !tool) return error(200, -32602, 'Invalid tool call or unknown tool');
          const rawInput = call.data.arguments;
          const input = await tool.schema.safeParseAsync(rawInput);
          if (!input.success) return error(200, -32602, scrub(input.error.message));
          try {
            const result = await tool.handler(input.data, { rawInput, _meta: call.data._meta });
            return reply(200, { result });
          } catch (cause) {
            const text = logError('mcp-transport', cause, credentials);
            return reply(200, { result: { isError: true, content: [{ type: 'text', text }] } });
          }
        }
        default: return error(200, -32601, 'Method not found');
      }
    } catch (cause) {
      const detail = logError('mcp-transport', cause, credentials);
      if (!res.headersSent) error(500, -32603, detail);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp',
    token,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
