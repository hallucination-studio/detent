import { redactGitUrl, scrubJson } from '../gitlab/redact.js';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

// Claude Code runs shell tools with its own environment. Authenticate only the
// upstream Messages request in the parent and stream SSE back to this turn.
export async function openModelTransport(baseUrl: string, apiKey: string, secrets: readonly string[]) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error('Invalid ANTHROPIC_BASE_URL');
  const server = createServer(async (req, res) => {
    const path = req.url ?? '';
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(path) ||
        req.headers.authorization !== 'Bearer detent-local') {
      res.writeHead(404).end();
      return;
    }
    // The CLI can add file contents and earlier tool results after our turn prompt was redacted.
    // Scrub its assembled Messages payload before sending it to the model.
    let body: string;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const key of ['messages', 'system', 'tools', 'metadata']) {
        if (Object.hasOwn(message, key)) message[key] = scrubJson(message[key], value => redactGitUrl(value, secrets));
      }
      body = JSON.stringify(message);
    } catch {
      res.writeHead(400).end('Invalid model request');
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    for (const name of ['anthropic-version', 'anthropic-beta', 'accept']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(base.href.replace(/\/$/, '') + path, { method: 'POST', headers }, response => {
      // Do not pass through redirects, authentication headers or provider error diagnostics.
      if (!response.statusCode || response.statusCode >= 300) {
        response.resume();
        res.writeHead(response.statusCode ?? 502).end('Model request failed');
        return;
      }
      res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] ?? 'application/json' });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end('Model request failed');
    });
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}
