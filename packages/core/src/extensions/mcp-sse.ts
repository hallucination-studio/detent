// Legacy MCP HTTP+SSE keeps the reply stream open while each request is posted.
// A scope uses one stream sequentially for discovery or one tool invocation.
export function createSseClient(url: string, headers: Record<string, string>, timeout: number, http: typeof fetch) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  let endpoint: URL;
  let id = 0;

  async function* events() {
    const response = await http(url, { headers: { ...headers, Accept: 'text/event-stream' }, redirect: 'error', signal });
    if (!response.ok || !response.body) throw Error('MCP SSE connection failed');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    let event = 'message';
    let data: string[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw Error('MCP SSE stream ended');
        pending += chunk.value;
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, '');
          pending = pending.slice(newline + 1);
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (!line) {
            if (data.length) yield { event, data: data.join('\n') };
            event = 'message';
            data = [];
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }

  const stream = events();
  async function post(method: string, params?: object, requestId?: number) {
    const response = await http(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: requestId }) });
    await response.body?.cancel();
    if (!response.ok) throw Error('MCP SSE HTTP error ' + response.status);
  }
  async function rpc(method: string, params?: object) {
    const requestId = ++id;
    await post(method, params, requestId);
    for (;;) {
      const next = await stream.next();
      if (next.done) throw Error('MCP SSE stream ended');
      if (next.value.event !== 'message') continue;
      const reply = JSON.parse(next.value.data);
      if (reply.id !== requestId) continue;
      if (reply.jsonrpc !== '2.0' || !Object.hasOwn(reply, 'result') || reply.error) throw Error('Invalid MCP SSE response');
      return reply.result as unknown;
    }
  }
  return {
    async request(method: string, params?: object) {
      if (!endpoint) {
        const first = await stream.next();
        if (first.done || first.value.event !== 'endpoint') throw Error('Missing MCP SSE endpoint');
        endpoint = new URL(first.value.data, url);
        if (endpoint.origin !== new URL(url).origin || endpoint.username || endpoint.password || endpoint.hash)
          throw Error('Invalid MCP SSE endpoint');
        const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'detent', version: '1.0.0' } });
        if (!initialized || typeof initialized !== 'object' || !('protocolVersion' in initialized) ||
            initialized.protocolVersion !== '2024-11-05') throw Error('Unsupported MCP SSE protocol version');
        await post('notifications/initialized');
      }
      return rpc(method, params);
    },
    async close() {
      controller.abort();
      await stream.return(undefined).catch(() => {});
    },
  };
}
