import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const maxMessageBytes = 1024 * 1024;
// JumpServer sends 4 KiB log chunks. Keep a bounded prefix for redaction and the 16k summary.
const maxLogChars = 65536;

function maskedFrame(opcode: number, payload: Buffer) {
  const size = payload.length;
  const extended = size < 126 ? 0 : size <= 65535 ? 2 : 8;
  const frame = Buffer.allocUnsafe(6 + extended + size);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extended === 0 ? size : extended === 2 ? 126 : 127);
  if (extended === 2) frame.writeUInt16BE(size, 2);
  if (extended === 8) frame.writeBigUInt64BE(BigInt(size), 2);
  const mask = randomBytes(4);
  mask.copy(frame, 2 + extended);
  for (let i = 0; i < size; i++) frame[6 + extended + i] = payload[i] ^ mask[i % 4];
  return frame;
}

function connect(url: URL, headers: Headers, signal: AbortSignal) {
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + guid).digest('base64');
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Duplex>((resolve, reject) => {
    const req = request(url, { signal, headers: {
      ...Object.fromEntries(headers), Upgrade: 'websocket', Connection: 'Upgrade',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
    } });
    req.on('error', reject);
    req.on('response', res => {
      res.destroy();
      reject(Error('JumpServer WebSocket upgrade returned HTTP ' + res.statusCode));
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.statusCode !== 101 || res.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !res.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
          res.headers['sec-websocket-accept'] !== accept || res.headers['sec-websocket-extensions'] ||
          res.headers['sec-websocket-protocol']) {
        socket.destroy();
        reject(Error('Invalid JumpServer WebSocket upgrade'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

// TCP reads may split any header or payload, or contain several complete frames.
function byteReader(socket: Duplex) {
  const chunks = socket[Symbol.asyncIterator]();
  let buffered: Buffer = Buffer.alloc(0);
  return async (size: number) => {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      if (!buffered.length) {
        const chunk = await chunks.next();
        if (chunk.done) throw Error('JumpServer WebSocket closed before end of log');
        buffered = chunk.value;
      }
      const take = Math.min(remaining, buffered.length);
      parts.push(buffered.subarray(0, take));
      buffered = buffered.subarray(take);
      remaining -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  };
}

async function* textMessages(socket: Duplex) {
  const read = byteReader(socket);
  let fragmented = false;
  let fragments: Buffer[] = [];
  let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (;;) {
    const [first, second] = await read(2);
    const fin = !!(first & 0x80);
    const opcode = first & 15;
    let size = second & 127;
    if ((first & 0x70) || (second & 0x80) || (opcode >= 8 && (!fin || size > 125)))
      throw Error('Invalid JumpServer WebSocket frame');
    if (size === 126 || size === 127) {
      const wide = size === 127;
      size = wide ? Number((await read(8)).readBigUInt64BE()) : (await read(2)).readUInt16BE();
      if (size < (wide ? 65536 : 126)) throw Error('Invalid JumpServer WebSocket payload length');
    }
    if (opcode >= 8) {
      const payload = await read(size);
      if (opcode === 8) {
        if (size === 1) throw Error('Invalid JumpServer WebSocket close frame');
        socket.end(maskedFrame(8, payload));
        throw Error('JumpServer WebSocket closed before end of log');
      }
      if (opcode === 9) socket.write(maskedFrame(10, payload));
      else if (opcode !== 10) throw Error('Unknown JumpServer WebSocket control frame');
      continue;
    }
    if (opcode !== (fragmented ? 0 : 1)) throw Error('Expected JumpServer WebSocket text message');
    total += size;
    if (total > maxMessageBytes) throw Error('JumpServer WebSocket message exceeds size limit');
    fragmented = !fin;
    if (size) fragments.push(await read(size));
    if (fin) {
      yield decoder.decode(Buffer.concat(fragments, total));
      fragments = [];
      total = 0;
    }
  }
}

export async function readTaskLog(url: URL, headers: Headers, task: string, type: 'ansible' | 'celery', signal: AbortSignal) {
  const socket = await connect(url, headers, signal);
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    socket.write(maskedFrame(1, Buffer.from(JSON.stringify({ task, type }))));
    let output = '';
    for await (const text of textMessages(socket)) {
      let entry;
      try { entry = JSON.parse(text); }
      catch { throw Error('Invalid JumpServer WebSocket log JSON'); }
      if (!entry || typeof entry !== 'object' || (entry.task !== undefined && entry.task !== task))
        throw Error('Invalid JumpServer WebSocket task log');
      if (entry.event === 'unavailable') return null;
      if (typeof entry.message === 'string') {
        if (entry.message === 'No permission' || entry.message === 'Task not found')
          throw Error('JumpServer task log: ' + entry.message);
        // The Celery end marker is five NUL bytes.
        output += entry.message.replaceAll('\0', '');
        if (output.length > maxLogChars) return { output: output.slice(0, maxLogChars), truncated: true };
      }
      if (entry.event === 'end') return { output, truncated: false };
    }
    throw Error('JumpServer WebSocket closed before end of log');
  } finally {
    if (!socket.destroyed && !socket.writableFinished) {
      await new Promise<void>(resolve => {
        socket.once('close', resolve);
        socket.once('finish', resolve);
        if (!socket.writableEnded) socket.end(maskedFrame(8, Buffer.alloc(0)));
      });
    }
    socket.destroy();
    signal.removeEventListener('abort', abort);
    signal.throwIfAborted();
  }
}
