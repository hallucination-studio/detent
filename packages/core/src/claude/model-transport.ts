import { formatHttpError, logError, redactGitUrl, scrubJson } from '../gitlab/redact.js';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

async function readModelError(response: IncomingMessage, status: number, secrets: readonly string[]) {
  const buffer = Buffer.alloc(2048);
  let size = 0;
  let incomplete = false;
  try {
    for await (const chunk of response) {
      size += (chunk as Buffer).copy(buffer, size);
      if (size === buffer.length) { incomplete = true; break; }
    }
  } catch (error) {
    const detail = logError('model-transport', error, secrets, 'Model HTTP ' + status);
    if (!size) return detail;
    incomplete = true;
  }
  const text = new TextDecoder().decode(buffer.subarray(0, size), { stream: incomplete });
  if (!incomplete) return text;

  // The last retained bytes may be only a prefix of a credential.
  let end = text.length;
  for (const secret of secrets) {
    for (let i = Math.max(0, text.length - secret.length); i < end; i++) {
      if (secret.startsWith(text.slice(i))) { end = i; break; }
    }
  }
  return text.slice(0, end) + (end < text.length ? '***…' : '…');
}

// Claude Code runs shell tools with its own environment. Authenticate only the
// upstream Messages request in the parent and stream SSE back to this turn.
export async function openModelTransport(baseUrl: string, apiKey: string, secrets: readonly string[], modelName?: string) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error('Invalid ANTHROPIC_BASE_URL');
  const credentials = [apiKey, ...secrets].filter(Boolean);
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
        if (Object.hasOwn(message, key)) message[key] = scrubJson(message[key], value => redactGitUrl(value, credentials));
      }
      if (modelName !== undefined) message.model = modelName;
      body = JSON.stringify(message);
    } catch (error) {
      const detail = logError('model-transport', error, credentials);
      res.writeHead(400).end('Invalid model request: ' + detail);
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    for (const name of ['anthropic-version', 'anthropic-beta', 'accept']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    function socketError(error: unknown) {
      const detail = logError('model-transport', error, credentials);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end('Model request failed: ' + detail);
    }
    const upstream = send(base.href.replace(/\/$/, '') + path, { method: 'POST', headers }, async response => {
      const status = response.statusCode ?? 502;
      if (status >= 300) {
        const raw = await readModelError(response, status, credentials);
        logError('model-transport', 'Model HTTP ' + status, credentials, raw);
        res.writeHead(status).end(formatHttpError('Model', status, raw, credentials));
        return;
      }
      res.writeHead(status, { 'content-type': response.headers['content-type'] ?? 'application/json' });
      response.on('error', socketError);
      response.pipe(res);
    });
    upstream.on('error', socketError);
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
