import { strToU8, zipSync } from 'fflate';
import { afterEach, expect, it, vi } from 'vitest';
import { offlineJumpServer } from '../../../scripts/e2e/offline-jumpserver.js';
import { loadDeliveryConfig } from '../src/config.js';
import { HttpJumpServerClient } from '../src/jumpserver/client.js';

const base = 'https://jms.test';
const gitlab = { gitlabBaseUrl: 'https://git.test', gitlabToken: 'git-token', jevApiKey: 'jev-key', secrets: { CUSTOM: 'custom/secret' } };
const jobsPath = '/api/v1/ops/jobs/';
const accountsPath = '/api/v1/perms/users/self/assets/';
const scheduleError = { is_periodic: ['Require interval or crontab setting'] };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const server = offlineJumpServer();
  const config = loadDeliveryConfig({
    JUMPSERVER_BASE_URL: base, JUMPSERVER_READONLY_ACCESS_KEY_ID: server.accessKeyId,
    JUMPSERVER_READONLY_ACCESS_KEY_SECRET: server.accessKeySecret, JUMPSERVER_JOB_TOKEN: server.job,
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
    await client.runReadonlyInspect({ assetIds: ['web01'], command: 'uptime' });
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
  const { client, fetch, server } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secrets = [server.accessKeyId, server.accessKeySecret, server.job, gitlab.gitlabToken, gitlab.jevApiKey,
    encodeURIComponent(gitlab.secrets.CUSTOM), gitlab.secrets.CUSTOM];
  const echoed = secrets.join(' ') + ' https://oauth2:unknown@git.test/repo';
  const safe = JSON.stringify({ ...scheduleError, detail: secrets.map(() => '***').join(' ') + ' https://oauth2:***@git.test/repo', padding: 'x'.repeat(1100) });
  fetch.mockResolvedValueOnce(Response.json(['root'])).mockResolvedValueOnce(
    Response.json({ ...scheduleError, detail: echoed, padding: 'x'.repeat(1100) }, { status: 400 }),
  );
  await expect(client.runReadonlyInspect({ assetIds: ['web01'], command: 'uptime' })).rejects.toMatchObject({
    status: 400, message: 'JumpServer HTTP 400: ' + safe.slice(0, 300),
  });
  expect(log.mock.calls).toEqual([['[detent:jumpserver]', 'POST', 'ops/jobs/', 400, safe.slice(0, 1000)]]);
});

it('uses asset detail and the ANSI log after HTML 404s, removing NUL padding from the summary', async () => {
  const { client, server, fetch } = setup();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const outcome = await client.runReadonlyInspect({ assetIds: ['web02'], command: 'uptime' });
  expect(server.runAs).toMatchObject([{ account: 'ops-second' }]);
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
  await expect(client.runReadonlyInspect({ assetIds: ['web03'], command: 'uptime' })).rejects.toThrow(
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
  const server = offlineJumpServer();
  const response = await server.handle(new Request(base + jobsPath, {
    method: 'POST', headers: { Authorization: 'Bearer ' + server.readonly, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'adhoc', instant: true, assets: ['web01'], module: 'shell', args: 'uptime',
      runas: 'root', runas_policy: 'skip', ...fields }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(scheduleError);
  expect(server.runAs).toHaveLength(0);
});
