import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { strToU8, zipSync } from 'fflate';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { loadDeliveryConfig } from '../src/config.js';
import { HttpJumpServerClient } from '../src/jumpserver/client.js';

const base = 'https://jms.test';
const gitlab = { gitlabBaseUrl: 'https://git.test', gitlabToken: 'git-token', jevApiKey: 'jev-key', secrets: { CUSTOM: 'custom/secret' } };
const jobsPath = '/api/v1/ops/jobs/';
const accountsPath = '/api/v1/perms/users/self/assets/';
const scheduleError = { is_periodic: ['Require interval or crontab setting'] };
const credentials = { accessKeyId: 'fixture-key-id', accessKeySecret: 'fixture-key-secret', job: 'fixture-job-token' };
const secrets = [...Object.values(credentials), gitlab.gitlabToken, gitlab.jevApiKey,
  encodeURIComponent(gitlab.secrets.CUSTOM), gitlab.secrets.CUSTOM];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function jumpServerFixture() {
  const runAs: string[] = [];
  const tasks = new Map<string, string[]>();
  const inactive = { username: 'disabled', is_active: false };
  const html404 = () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });

  async function handle(request: Request) {
    const { pathname } = new URL(request.url);
    switch (request.method + ' ' + pathname) {
      case 'GET ' + accountsPath + 'web01/accounts/':
        return Response.json(['@INPUT', inactive, 'ops-first', 'root']);
      case 'GET ' + accountsPath + 'web02/accounts/':
      case 'GET ' + accountsPath + 'web03/accounts/':
        return html404();
      case 'GET ' + accountsPath + 'web02/':
        return Response.json({ permed_accounts: ['@INPUT', inactive, 'ops-second', 'root'] });
      case 'GET ' + accountsPath + 'web03/':
        return Response.json({ permed_accounts: [] });
      case 'POST /api/v1/ops/playbooks/':
        return Response.json({ id: 'playbook' });
      case 'POST ' + jobsPath: {
        const job = await request.json();
        if (job.is_periodic !== false) return Response.json(scheduleError, { status: 400 });
        runAs.push(job.runas);
        if (!job.instant) return Response.json({ id: 'definition', variable: [] });
        const id = 'task-' + (tasks.size + 1);
        tasks.set(id, job.assets);
        return Response.json({ task_id: id });
      }
      case 'POST /api/v1/ops/job-executions/':
        expect(await request.json()).toEqual({ job: 'definition', parameters: { jms_service: 'nginx' } });
        return Response.json({ task_id: 'playbook-task' });
    }

    const [, endpoint, id] = pathname.match(/^\/api\/v1\/ops\/job-execution\/(task-detail|result)\/([^/]+)\/$/) ?? [];
    const assets = tasks.get(id);
    if (request.method === 'GET' && assets) {
      if (endpoint === 'task-detail') return Response.json({ status: 'success', summary: { success: 1 } });
      if (assets.includes('web02')) return html404();
      return Response.json({ result: Object.fromEntries(assets.map(asset => [asset, 'nginx active'])) });
    }
    const log = pathname.match(/^\/api\/v1\/ops\/ansible\/job-execution\/([^/]+)\/log\/$/);
    if (request.method === 'GET' && log && tasks.has(log[1]))
      return Response.json({ data: '\x1b[32mnginx active\x1b[0m\u0000\u0000\u0000' });
    return new Response(null, { status: 404 });
  }
  return { handle, runAs };
}

function setup() {
  const server = jumpServerFixture();
  const config = loadDeliveryConfig({
    JUMPSERVER_BASE_URL: base, JUMPSERVER_READONLY_ACCESS_KEY_ID: credentials.accessKeyId,
    JUMPSERVER_READONLY_ACCESS_KEY_SECRET: credentials.accessKeySecret, JUMPSERVER_JOB_TOKEN: credentials.job,
  });
  const client = new HttpJumpServerClient(config, gitlab);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (new URL(String(url)).origin === gitlab.gitlabBaseUrl) {
      const files = { 'ansible-infra-sha/deploy/nginx-reload.yml': strToU8('state: reloaded') };
      return new Response(Uint8Array.from(zipSync(files)));
    }
    return server.handle(new Request(url, init));
  });
  vi.stubGlobal('fetch', fetch);
  return { client, server, fetch };
}

it.each(['inspection', 'instant playbook', 'parameterized playbook'])('submits %s with is_periodic=false', async kind => {
  const { client, fetch } = setup();
  if (kind === 'inspection') {
    await client.runShell({ assetIds: ['web01'], commands: ['uptime'] });
  } else {
    await client.runAnsibleJob({
      assetIds: ['web01'], repository: 'ops/ansible-infra', commitSha: 'a'.repeat(40),
      comment: 'approved', playbookPath: 'deploy/nginx-reload.yml',
      extraVars: kind === 'parameterized playbook' ? { service: 'nginx' } : undefined,
    });
  }
  const jobs = fetch.mock.calls.filter(([url]) => String(url) === base + jobsPath);
  expect(jobs).toHaveLength(1);
  const body = JSON.parse(String(jobs[0][1]?.body));
  expect(body.is_periodic).toBe(false);
  expect(body.instant).toBe(kind === 'parameterized playbook' ? undefined : true);
});

it('preserves the HTTP status and redacts the body before truncating either diagnostic', async () => {
  const { client, fetch } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const echoed = secrets.join(' ') + ' https://oauth2:unknown@git.test/repo';
  const safe = JSON.stringify({ ...scheduleError, detail: secrets.map(() => '***').join(' ') + ' https://oauth2:***@git.test/repo', padding: 'x'.repeat(1100) });
  fetch.mockResolvedValueOnce(Response.json(['root'])).mockResolvedValueOnce(
    Response.json({ ...scheduleError, detail: echoed, padding: 'x'.repeat(1100) }, { status: 400 }),
  );
  await expect(client.runShell({ assetIds: ['web01'], commands: ['uptime'] })).rejects.toMatchObject({
    status: 400, message: 'JumpServer HTTP 400: ' + safe.slice(0, 300),
  });
  expect(log.mock.calls).toEqual([['[detent:jumpserver]', 'POST', 'ops/jobs/', 400, safe.slice(0, 1000)]]);
});

it('uses asset detail and the ANSI log after HTML 404s, removing NUL padding from the summary', async () => {
  const { client, server, fetch } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const outcome = await client.runShell({ assetIds: ['web02'], commands: ['uptime'] });
  expect(server.runAs).toEqual(['ops-second']);
  expect(outcome).toMatchObject({ status: 'SUCCESS', outputSummary: '{"success":1}\n\x1b[32mnginx active\x1b[0m' });
  if (!('jobId' in outcome)) throw Error('Expected one inspection job');
  const id = outcome.jobId;
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    accountsPath + 'web02/accounts/', accountsPath + 'web02/', jobsPath,
    '/api/v1/ops/job-execution/task-detail/' + id + '/', '/api/v1/ops/job-execution/result/' + id + '/',
    '/api/v1/ops/ansible/job-execution/' + id + '/log/',
  ]);
  const responses = await Promise.all(fetch.mock.results.map(call => call.value as Promise<Response>));
  for (const probe of [responses[0], responses[4]]) {
    expect(probe.status).toBe(404);
    expect(probe.headers.get('content-type')).toContain('text/html');
  }
  const [url, init] = fetch.mock.calls[5];
  const rawLog = await server.handle(new Request(url, init));
  expect((await rawLog.json()).data).toBe('\x1b[32mnginx active\x1b[0m\u0000\u0000\u0000');
  expect(log).not.toHaveBeenCalled();
});

it('names the asset and API key authorization when permed_accounts is empty', async () => {
  const { client, fetch } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(client.runShell({ assetIds: ['web03'], commands: ['uptime'] })).rejects.toThrow(
    '资产 web03 在 JumpServer 中未给当前 API Key 授权任何登录账号',
  );
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([accountsPath + 'web03/accounts/', accountsPath + 'web03/']);
  expect(log).not.toHaveBeenCalled();
});

it('logs an unexpected 404 on the asset detail fallback', async () => {
  const { client } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(client.listAssetAccounts('missing')).rejects.toMatchObject({ status: 404 });
  expect(log.mock.calls).toEqual([['[detent:jumpserver]', 'GET', 'perms/users/self/assets/missing/', 404, '']]);
});

it.each([{}, { is_periodic: true }, { is_periodic: 'false' }])('rejects unscheduled jobs in the offline API for %j', async fields => {
  const server = jumpServerFixture();
  const response = await server.handle(new Request(base + jobsPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'adhoc', instant: true, assets: ['web01'], module: 'shell', args: 'uptime',
      runas: 'root', runas_policy: 'skip', ...fields }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(scheduleError);
  expect(server.runAs).toHaveLength(0);
});

it('reuses the resolved account across shell jobs and refreshes the detail lookup after 60 seconds', async () => {
  const { client, fetch } = setup();
  const request = { assetIds: ['web02'], commands: ['uptime'] };
  const lookups = () => fetch.mock.calls.map(([url]) => new URL(String(url)).pathname).filter(path => path.startsWith(accountsPath));
  const start = Date.now();
  const now = vi.spyOn(Date, 'now').mockReturnValue(start);
  await client.runShell(request);
  now.mockReturnValue(start + 59999);
  await client.runShell(request);
  expect(lookups()).toEqual([accountsPath + 'web02/accounts/', accountsPath + 'web02/']);
  now.mockReturnValue(start + 60000);
  await client.runShell(request);
  expect(lookups()).toEqual([accountsPath + 'web02/accounts/', accountsPath + 'web02/', accountsPath + 'web02/']);
});

it.each([4500, 60000])('caps each HTTP request separately from the %d ms overall shell budget', async budget => {
  const { fetch } = setup();
  const client = new HttpJumpServerClient(loadDeliveryConfig({ JUMPSERVER_BASE_URL: base, JUMPSERVER_READONLY_TOKEN: 'reader',
    JUMPSERVER_TIMEOUT_MS: String(budget) }), gitlab);
  const timeouts = vi.spyOn(AbortSignal, 'timeout');
  fetch.mockResolvedValueOnce(Response.json(['ops'])).mockResolvedValueOnce(Response.json({ task_id: 'job' }))
    .mockResolvedValueOnce(Response.json({ status: 'success', summary: {} })).mockResolvedValueOnce(Response.json({ result: {} }));
  await client.runShell({ assetIds: ['web01'], commands: ['uptime'] });
  expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([budget, ...Array(4).fill(Math.min(budget, 15000))]);
});

it('logs transport, malformed JSON and invalid responses without exposing credentials', async () => {
  const { client, fetch } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const echoed = secrets.join(' ');
  fetch.mockRejectedValueOnce(Error('transport ' + echoed));
  await expect(client.listAssets({})).rejects.toMatchObject({ message: 'transport ' + secrets.map(() => '***').join(' ') });
  fetch.mockResolvedValueOnce(new Response('invalid-' + echoed));
  await expect(client.listAssets({})).rejects.toMatchObject({ message: 'Invalid JumpServer JSON' });
  fetch.mockResolvedValueOnce(Response.json({ status: echoed, summary: {} }));
  const result = client.getJobResult('job');
  await expect(result).rejects.toThrow('Invalid JumpServer response');
  expect(log).toHaveBeenCalledTimes(3);
  for (const secret of secrets) {
    await expect(result).rejects.not.toThrow(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  }
});

function serverFrame(opcode: number, text: string, fin = true) {
  const data = Buffer.from(text);
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = header.length === 2 ? data.length : header.length === 4 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(data.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

async function wsFixture(onFrame: (socket: Duplex, opcode: number, text: string) => void) {
  const paths: string[] = [];
  const upgrades: IncomingMessage[] = [];
  const clientFrames: { masked: boolean; opcode: number; text: string }[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url?.includes('/task-detail/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'success', summary: { success: 1 } }));
    } else res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>Not Found</html>');
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push(req);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept, '', ''].join('\r\n'));
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 2) {
        const masked = !!(input[1] & 128);
        const opcode = input[0] & 15;
        let size = input[1] & 127;
        const header = size === 127 ? 10 : size === 126 ? 4 : 2;
        if (input.length < header) return;
        if (header === 10) size = Number(input.readBigUInt64BE(2));
        if (header === 4) size = input.readUInt16BE(2);
        const start = header + (masked ? 4 : 0);
        if (input.length < start + size) return;
        const payload = input.subarray(start, start + size);
        if (masked) for (let i = 0; i < size; i++) payload[i] ^= input[header + i % 4];
        input = input.subarray(start + size);
        const text = payload.toString();
        clientFrames.push({ masked, opcode, text });
        if (opcode === 8) socket.end();
        else onFrame(socket, opcode, text);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { paths, upgrades, clientFrames, client: (env: NodeJS.ProcessEnv) =>
    new HttpJumpServerClient(loadDeliveryConfig({ ...env, JUMPSERVER_BASE_URL: url }), gitlab) };
}

it('signs v4 log upgrades, reads fragmented Ansible output after HTML 404s and remembers the WS endpoint', async () => {
  const job = 'job-id';
  const data = JSON.stringify({ task: job, message: 'target-node-01 ' + secrets.join(' ') + ' custom/' });
  const fixture = await wsFixture((socket, opcode) => {
    if (opcode === 1) {
      const first = serverFrame(1, data.slice(0, 3), false);
      socket.write(first.subarray(0, 1));
      socket.write(Buffer.concat([first.subarray(1), serverFrame(9, 'still here'), serverFrame(0, data.slice(3))]));
    } else if (opcode === 10) {
      socket.write(Buffer.concat([
        serverFrame(1, JSON.stringify({ task: job, message: 'secret\0\0\0\0\0' })),
        serverFrame(1, JSON.stringify({ event: 'end', task: job })),
      ]));
    }
  });
  const client = fixture.client({ JUMPSERVER_JOB_ACCESS_KEY_ID: credentials.accessKeyId,
    JUMPSERVER_JOB_ACCESS_KEY_SECRET: credentials.accessKeySecret, JUMPSERVER_READONLY_TOKEN: credentials.job, JUMPSERVER_ORG_ID: 'test-org' });
  for (let i = 0; i < 2; i++) {
    const result = await client.getJobResult(job);
    expect(result.outputSummary).toBe('{"success":1}\ntarget-node-01 ' + secrets.map(() => '***').join(' ') + ' ***');
  }
  const detail = '/api/v1/ops/job-execution/task-detail/job-id/';
  expect(fixture.paths).toEqual([detail, '/api/v1/ops/job-execution/result/job-id/', '/api/v1/ops/ansible/job-execution/job-id/log/', detail]);
  expect(fixture.upgrades).toHaveLength(2);
  for (const { method, url, headers } of fixture.upgrades) {
    expect([method, url, headers.accept, headers['x-jms-org']]).toEqual(['GET', '/ws/ops/tasks/log/', 'application/json', 'test-org']);
    expect(new Date(headers.date!).toUTCString()).toBe(headers.date);
    const signature = createHmac('sha256', credentials.accessKeySecret)
      .update('(request-target): get /ws/ops/tasks/log/\naccept: application/json\ndate: ' + headers.date).digest('base64');
    expect(headers.authorization).toBe('Signature keyId="' + credentials.accessKeyId +
      '",algorithm="hmac-sha256",headers="(request-target) accept date",signature="' + signature + '"');
  }
  expect(fixture.clientFrames.filter(f => f.opcode !== 8)).toEqual(Array(2).fill([
    { masked: true, opcode: 1, text: JSON.stringify({ task: job, type: 'ansible' }) },
    { masked: true, opcode: 10, text: 'still here' },
  ]).flat());
});

it('retries unavailable Ansible logs over a fresh Bearer connection and caps a 64-bit Celery frame after redaction', async () => {
  const types: string[] = [];
  const fixture = await wsFixture((socket, _opcode, text) => {
    const { task, type } = JSON.parse(text);
    types.push(type);
    if (type === 'ansible') socket.write(serverFrame(1, JSON.stringify({ task, event: 'unavailable' })));
    else {
      // Redaction contracts 65k of raw output to under the summary limit. The cap splits the final secret.
      const repeated = credentials.accessKeySecret.repeat(Math.floor(65536 / credentials.accessKeySecret.length) + 1);
      socket.write(serverFrame(1, JSON.stringify({ task, message: 'celery ' + repeated })));
    }
  });
  const result = await fixture.client({ JUMPSERVER_JOB_TOKEN: credentials.accessKeySecret,
    JUMPSERVER_READONLY_TOKEN: 'fixture' }).getJobResult('job');
  expect(types).toEqual(['ansible', 'celery']);
  expect(fixture.upgrades.map(req => req.headers.authorization)).toEqual(Array(2).fill('Bearer ' + credentials.accessKeySecret));
  expect(result.outputSummary).toMatch(/^\{"success":1\}\ncelery \*+…$/);
  expect(result.outputSummary.length).toBeLessThanOrEqual(16000);
});

it('rejects an early WebSocket close and only retries on unavailable', async () => {
  const fixture = await wsFixture(socket => socket.write(serverFrame(8, '')));
  await expect(fixture.client({ JUMPSERVER_JOB_TOKEN: 'test' }).getJobResult('job')).rejects.toThrow('closed before end');
  expect(fixture.upgrades).toHaveLength(1);
});

it('aborts an upgraded WebSocket when the task log stalls', async () => {
  let closed = false;
  const fixture = await wsFixture(socket => {
    socket.on('end', () => { closed = true; socket.end(); });
  });
  await expect(fixture.client({ JUMPSERVER_JOB_TOKEN: 'test', JUMPSERVER_TIMEOUT_MS: '500' }).getJobResult('job'))
    .rejects.toThrow(/timed out|timeout/i);
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(fixture.upgrades).toHaveLength(1);
});

it('normalizes permitted v3/v4 assets and applies all exact labels before limiting results', async () => {
  const { client, fetch } = setup();
  const nodePath = '/DEFAULT/Production/' + gitlab.secrets.CUSTOM;
  fetch.mockResolvedValueOnce(Response.json({ results: [
    { id: 'favorite', value: 'Favorites', full_value: '/Favorites' },
    { id: 'empty', value: 'Empty', full_value: '  ' },
    { id: 'apps', value: 'Applications', full_value: nodePath, assets_amount: 4 },
    { id: credentials.job, name: gitlab.gitlabToken, full_value: '/Departments' },
  ] }));
  expect(await client.listNodes({ search: 'proDUCtion', limit: 1 })).toEqual([
    { id: 'apps', name: 'Applications', fullPath: '/DEFAULT/Production/***', assetsAmount: 4 },
  ]);
  expect(await client.listNodes({ search: 'APPLICATIONS' })).toHaveLength(1);
  expect(await client.listNodes()).toHaveLength(2);
  expect((await client.listNodes())[1]).toEqual({ id: '***', name: '***', fullPath: '/Departments', assetsAmount: 0 });

  const common = { name: gitlab.gitlabToken, address: '10.0.0.1', nodes: ['apps'] };
  const rows = [
    { ...common, id: 'disabled', labels: ['env:prod', 'tier:core'], is_active: false },
    { ...common, id: 'prefix', labels: ['env:production', 'tier:core'] },
    { ...common, id: 'single', labels: ['env:prod'] },
    { ...common, id: 'v4', labels: [{ name: 'env', value: 'Prod' }, { name: 'Tier', value: 'core' }],
      nodes: [{ id: 'apps', value: 'apps' }], platform: { name: 'Linux' }, comment: '  ' + credentials.job + '  ' },
    { ...common, id: 'v3', labels: ['Env:Prod', 'tier:Core'], platform: 'Linux', comment: '  ', nodes_display: ['/Other'] },
    { ...common, id: 'more', labels: ['Env:Prod', 'tier:Core'] },
  ];
  fetch.mockResolvedValueOnce(Response.json({ results: rows }));
  expect(await client.listAssets({ nodeId: 'apps', labels: ['ENV:prod', 'tier:CORE'], limit: 2 })).toEqual([
    { id: 'v4', name: '***', address: common.address, nodes: ['/DEFAULT/Production/***'], platform: 'Linux',
      comment: '***', labels: ['env:Prod', 'Tier:core'], isActive: true },
    { id: 'v3', name: '***', address: common.address, nodes: ['/DEFAULT/Production/***', '/Other'], platform: 'Linux',
      labels: ['Env:Prod', 'tier:Core'], isActive: true },
  ]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    base + '/api/v1/perms/users/self/nodes/', base + '/api/v1/perms/users/self/nodes/apps/assets/?limit=200',
  ]);
  for (const [, init] of fetch.mock.calls)
    expect(new Headers(init?.headers).get('authorization')).toContain('keyId="' + credentials.accessKeyId + '"');
});

it('uses inline asset paths when the nodes endpoint is absent, and distinguishes detail 404 from other errors', async () => {
  const { client, fetch } = setup();
  const raw = { id: 'web', name: 'web', address: gitlab.gitlabToken, nodes: [
    { id: 'n1', full_value: '/DEFAULT/A', value: 'A' }, { value: 'B' }, { name: 'C' }, 'D',
  ], nodes_display: ['A', '/DEFAULT/E'], labels: [gitlab.secrets.CUSTOM] };
  fetch.mockResolvedValueOnce(Response.json([raw, { ...raw, id: 'old', is_active: false }]))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const expected = { id: 'web', name: 'web', address: '***', nodes: ['/DEFAULT/A', 'B', 'C', 'D', '/DEFAULT/E'], labels: ['***'] };
  expect(await client.listAssets({})).toEqual([{ ...expected, isActive: true }]);
  fetch.mockResolvedValueOnce(Response.json({ ...raw, is_active: false }));
  expect(await client.getAsset('old/web', 'readonly')).toEqual({ ...expected, isActive: false });
  expect(String(fetch.mock.lastCall?.[0])).toBe(base + accountsPath + 'old%2Fweb/');
  fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await client.getAsset('absent')).toBeNull();
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(client.getAsset('forbidden')).rejects.toMatchObject({ status: 403 });
});

it('shares concurrent tree lookups per principal and refreshes them after expiry', async () => {
  const { client, fetch } = setup();
  const raw = { id: 'host', name: 'host', address: '10.0.0.1', nodes: [{ id: 'branch', name: 'inline' }] };
  let revision = 1;
  fetch.mockImplementation(async (url, init) => {
    if (String(url) === base + accountsPath + 'host/') return Response.json(raw);
    expect(String(url)).toBe(base + '/api/v1/perms/users/self/nodes/');
    const job = new Headers(init?.headers).get('authorization') === 'Bearer ' + credentials.job;
    return Response.json([{ id: 'branch', full_value: (job ? '/jobs/' : '/inspect/') + revision }]);
  });
  await client.listNodes();
  const [first, second] = await Promise.all([client.getAsset('host'), client.getAsset('host')]);
  expect(first?.nodes).toEqual(['/jobs/1']);
  expect(second).toEqual(first);
  expect((await client.getAsset('host', 'readonly'))?.nodes).toEqual(['/inspect/1']);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/nodes/'))).toHaveLength(2);
  revision++;
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
  expect((await client.getAsset('host'))?.nodes).toEqual(['/jobs/2']);
});

it('finds authorized nodes on later pages before applying the search and limit', async () => {
  const { client, fetch } = setup();
  const path = '/api/v1/perms/users/self/nodes/';
  fetch.mockResolvedValueOnce(Response.json({
    results: [{ id: 'skip', full_value: '/other' }], next: path + '?offset=1',
  })).mockResolvedValueOnce(Response.json({ results: [{ id: 'found', full_value: '/DEFAULT/apps' }], next: null }));
  expect(await client.listNodes({ search: 'apps', limit: 1 })).toEqual([
    { id: 'found', fullPath: '/DEFAULT/apps', name: '/DEFAULT/apps', assetsAmount: 0 },
  ]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([base + path, base + path + '?offset=1']);
});
