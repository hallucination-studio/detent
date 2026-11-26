import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const imageMirror = {
  source_image: 'docker.io/library/nginx:1.27.4',
  target_image: 'harbor.internal/base/nginx:1.27.4',
};

const target = { target_image: { type: 'string' } };
const tools = [
  { name: 'check_image_exists', description: 'Check if the target image exists.',
    inputSchema: { type: 'object', properties: target, required: ['target_image'] } },
  { name: 'sync_image', description: 'Mirror an image to the internal registry.',
    inputSchema: { type: 'object', properties: { ...target, source_image: { type: 'string' } },
      required: ['source_image', 'target_image'] } },
];

export function offlineMcp() {
  const token = randomUUID();
  const calls: { name: string; arguments: Record<string, string> }[] = [];
  const protocolVersion = '2025-03-26';

  async function handle(req: Request) {
    if (new URL(req.url).pathname !== '/mcp') return new Response(null, { status: 404 });
    const authorization = req.headers.get('authorization');
    if (authorization !== 'Bearer ' + token) return new Response(null, { status: 401 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const { id, jsonrpc, method, params } = await req.json();
    assert.equal(jsonrpc, '2.0');
    const reply = (result: object) => {
      assert.equal(typeof id, 'number');
      return Response.json({ jsonrpc, id, result });
    };
    if (method === 'initialize') {
      assert.equal(params.protocolVersion, protocolVersion);
      return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harbor-sync', version: '1.0.0' } });
    }
    assert.equal(req.headers.get('mcp-protocol-version'), protocolVersion);
    if (method === 'notifications/initialized') {
      assert.equal(id, undefined);
      return new Response(null, { status: 202 });
    }
    if (method === 'tools/list') return reply({ tools });
    if (method === 'tools/call') {
      const checking = params.name === 'check_image_exists';
      assert.ok(checking || params.name === 'sync_image');
      assert.deepEqual(params.arguments, checking ? { target_image: imageMirror.target_image } : imageMirror);
      calls.push(params);
      // Echo the header to exercise redaction at the bridge before the SDK sees the result.
      return reply({ structuredContent: { ...params.arguments, ...(checking ? { exists: false } : { synced: true }), authorization } });
    }
    return Response.json({ jsonrpc, id, error: { code: -32601, message: 'Method not found' } });
  }

  return { handle, token, calls };
}
