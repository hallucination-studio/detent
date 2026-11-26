import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex, PassThrough, Readable } from 'node:stream';

type RpcRequest = { jsonrpc: string; method: string; id?: number; params?: Record<string, unknown> };

function streamHttp(server: Server) {
  const peers = new Set<Duplex>();
  let closed = false;
  const http: typeof fetch = (input, init) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new TypeError('fetch failed'));
      return;
    }
    const outgoing = new Request(input, init);
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const client = Duplex.from({ readable: toClient, writable: toServer });
    const peer = Duplex.from({ readable: toServer, writable: toClient });
    peers.add(peer);
    client.once('close', () => peer.destroy());
    peer.once('close', () => {
      peers.delete(peer);
      client.destroy();
    });
    server.emit('connection', peer);
    const headers: Record<string, string> = { connection: 'close' };
    outgoing.headers.forEach((value, name) => { headers[name] = value; });
    const pending = request(outgoing.url, {
      method: outgoing.method, headers, signal: outgoing.signal, createConnection: () => client as Socket,
    }, response => {
      const status = response.statusCode!;
      if ([301, 302, 303, 307, 308].includes(status) && outgoing.redirect === 'error') {
        response.destroy();
        reject(new TypeError('fetch failed'));
        return;
      }
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      if (!body) response.resume();
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(body, { status, headers }));
    });
    pending.on('error', reject);
    pending.end(init?.body);
  });
  return {
    http,
    async close() {
      closed = true;
      for (const peer of peers) peer.destroy();
    },
  };
}

export async function mockMcpServer(handle: (rpc: RpcRequest, response: ServerResponse) => void) {
  const requests: { rpc: RpcRequest; method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      const rpc: RpcRequest = JSON.parse(body);
      requests.push({ rpc, method: request.method, url: request.url, headers: request.headers });
      handle(rpc, response);
    } catch {
      response.destroy();
    }
  });
  return { ...streamHttp(server), url: 'http://127.0.0.1:31337/mcp', requests };
}
