import { expect, it, vi } from 'vitest';
import { loadConfig, loadHubCapabilities, resolveSecretRef, resolveSecretTemplate, resolveHubMcpCapabilities,
  parseHubAgentMarkdown, parseHubWorkflowMarkdown } from '../src/index.js';
import { configuredSecrets, redactGitUrl } from '../src/gitlab/redact.js';

it('loads only named nonblank vault entries and redacts overlapping values longest first', () => {
  const config = loadConfig({ DETENT_SECRET_FOO_1: ' token123 ', DETENT_SECRET_X: 'token', DETENT_SECRET_: 'ignored',
    DETENT_SECRET_lower: 'ignored', DETENT_SECRET_EMPTY: ' ' });
  expect(config.secrets).toEqual({ FOO_1: 'token123', X: 'token' });
  expect(redactGitUrl('token123 token', configuredSecrets(config))).toBe('*** ***');
});

it('resolves exact references, multiple placeholders and distinct missing names without recursive expansion', () => {
  const vault = { A: '$secret:B', B: 'value' };
  expect(resolveSecretRef('$secret:A', vault)).toEqual({ ok: true, value: '$secret:B' });
  expect(resolveSecretRef('literal', vault)).toEqual({ ok: true, value: 'literal' });
  expect(resolveSecretRef('$secret:X', vault)).toEqual({ ok: false, missing: 'DETENT_SECRET_X' });
  expect(resolveSecretTemplate('${secret:A}/${secret:B}/${secret:B}', vault)).toEqual({ ok: true, value: '$secret:B/value/value' });
  expect(resolveSecretTemplate('${secret:X} ${secret:Y} ${secret:X}', vault)).toEqual({ ok: false, missing: ['DETENT_SECRET_X', 'DETENT_SECRET_Y'] });
});

it('distinguishes absent, invalid and typed Hub policy at the specified revision', async () => {
  const getRepositoryFile = vi.fn(async (): Promise<string | null> => null);
  const load = () => loadHubCapabilities({ getRepositoryFile }, 19, 'trunk');
  expect(await load()).toEqual({ present: false, invalid: false, entries: {} });
  expect(getRepositoryFile).toHaveBeenCalledWith(19, 'capabilities.json', 'trunk');
  for (const raw of ['null', '[]', 'broken-credential', '{"case":{"type":"a"},"CASE":{"type":"b"}}', '{"a":{}}']) {
    getRepositoryFile.mockResolvedValueOnce(raw);
    expect(await load()).toEqual({ present: true, invalid: true, entries: {}, error: 'Hub capabilities.json 格式无效' });
  }
  const entry = { sample: { type: 'custom', private_setting: 10 } };
  getRepositoryFile.mockResolvedValueOnce(JSON.stringify(entry));
  expect(await load()).toEqual({ present: true, invalid: false, entries: entry });
  getRepositoryFile.mockRejectedValueOnce(Error('503'));
  await expect(load()).rejects.toThrow('503');
});

it('resolves permitted MCP headers and policies and skips disabled or invalid endpoints before connecting', async () => {
  const sample = { type: 'mcp', url: 'https://test.example/mcp', transport: 'http', headers: { Authorization: 'Bearer ${secret:T}' },
    readonly_tools: ['lookup'], approver_tier: 'prod' };
  const connect = vi.fn().mockResolvedValue({ name: 'good', enabled: true, tools: [] });
  const entries = { good: sample, missing: { ...sample, headers: { Token: '${secret:X}' } }, off: { ...sample, enabled: false },
    ...Object.fromEntries(['ftp://host', 'http://a:b@host', 'http://host?', 'http://host#'].map((url, i) => ['bad' + i, { ...sample, url }])) };
  const packs = await resolveHubMcpCapabilities({ present: true, invalid: false, entries }, { T: 'canary' }, connect);
  expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'good', approverTier: 'prod', toolPolicies: { lookup: 'readonly' },
    transport: { type: 'streamable-http', url: sample.url, headers: { Authorization: 'Bearer canary' } } }), expect.objectContaining({ scoped: true, resolvedHeaders: true }));
  expect(packs.filter(pack => pack.enabled).map(pack => pack.name)).toEqual(['good']);
  expect(packs[1].setupHint).toBe('服务端缺少密钥 DETENT_SECRET_X');
});

it('parses optional account and prefix lists for both generations of Hub workflow', () => {
  const source = "---\nlabel: test\naccount: '  review  '\nallow_prefixes: ['read status', list]\n---\nRules";
  for (const parse of [(text: string) => parseHubWorkflowMarkdown('test.md', text),
    (text: string) => parseHubAgentMarkdown('test', 'agents/test/AGENT.md', text, 'agents')]) {
    expect(parse(source)).toMatchObject({ account: 'review', allowPrefixes: ['read status', 'list'] });
    expect(parse(source.replace("['read status', list]", "[invalid"))).toBeNull();
  }
});

it.each(['same-origin', 'cross-origin'] as const)('closes legacy SSE streams after discovery and dispatch (%s endpoint)', async mode => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let streams = 0, posts = 0, closed = 0;
  const push = (event: string, data: string) => output.enqueue(new TextEncoder().encode('event: ' + event + '\r\ndata: ' + data + '\r\n\r\n'));
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    if (!init?.method) {
      streams++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { output = controller; push('endpoint', mode === 'same-origin' ? '/rpc?session=1' : 'https://elsewhere.test/rpc'); },
        cancel() { closed++; },
      }));
    }
    expect(String(url)).toBe('https://mcp.test/rpc?session=1');
    posts++;
    const { method, id } = JSON.parse(String(init.body));
    if (id) {
      const result = method === 'initialize' ? { protocolVersion: '2024-11-05' } : method === 'tools/list'
        ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } : { structuredContent: { result: 'test-token' } };
      push('message', JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
    return new Response(null, { status: 202 });
  });
  try {
    const [pack] = await resolveHubMcpCapabilities({ present: true, invalid: false, entries: { x: {
      type: 'mcp', transport: 'sse', url: 'https://mcp.test/sse', headers: { Authorization: 'Bearer ${secret:T}' },
    } } }, { T: 'test-token' });
    if (mode === 'same-origin') {
      expect(pack.enabled).toBe(true);
      await expect(pack.tools[0].execute({}, {} as never)).resolves.toEqual({ result: '***' });
      expect(streams).toBe(2);
    } else {
      expect(pack.enabled).toBe(false);
      expect(posts).toBe(0);
    }
    expect(closed).toBe(streams);
  } finally { http.mockRestore(); }
});

it('keeps host environment references literal inside resolved Hub headers', async () => {
  const token = '${HOST_ONLY}';
  const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
    const { id, method } = JSON.parse(String(init?.body));
    return id ? Response.json({ jsonrpc: '2.0', id, result: method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [] } })
      : new Response(null, { status: 202 });
  });
  vi.stubEnv('HOST_ONLY', 'host-credential');
  try {
    const [pack] = await resolveHubMcpCapabilities({ present: true, invalid: false, entries: { service: {
      type: 'mcp', transport: 'http', url: 'https://service.test', headers: { Authorization: 'Bearer ${secret:X}' },
    } } }, { X: token });
    expect(pack.enabled).toBe(true);
    expect(stub).toHaveBeenCalledTimes(3);
  } finally { vi.unstubAllEnvs(); stub.mockRestore(); }
});
