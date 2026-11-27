import { createHmac } from 'node:crypto';
import { query } from '@anthropic-ai/claude-code';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig, type DecisionClient, type PermissionMode } from '@detent/core';
import { SdkClaudeRunner } from '../../core/src/claude/runner.js';
import { PermissionGate, ColdHold } from '../../core/src/claude/permission-gate.js';
import { GitLabClient } from '../../core/src/gitlab/client.js';
import { EphemeralSandbox } from '../../core/src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../../core/src/workspace/mcp-tools.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import {
  createJumpServerTools, HttpJumpServerClient, loadDeliveryConfig, validatePlaybookPath, validateReadonlyInspectCommand,
  type AnsibleJobRequest, type DeliveryConfig, type DeliveryExecutionTracker, type JumpServerClient,
} from '../src/index.js';

vi.mock('@anthropic-ai/claude-code', async original => ({
  ...await original<typeof import('@anthropic-ai/claude-code')>(),
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success', session_id: 'session', result: 'done' };
  }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const base = 'https://jms.test';
const env = {
  JUMPSERVER_BASE_URL: base, JUMPSERVER_READONLY_ACCESS_KEY_ID: 'readonly-key-id',
  JUMPSERVER_READONLY_ACCESS_KEY_SECRET: 'readonly-key-secret', JUMPSERVER_JOB_TOKEN: 'job-bearer-token',
  JUMPSERVER_ORG_ID: 'org', JUMPSERVER_BLOCKED_ASSETS: 'restricted',
};
const sha = 'abcde123'.repeat(5);
const input = {
  target_project_id: 7, mr_iid: 8, commit_sha: sha, playbook_path: 'deploy/run.yml',
  asset_ids: ['web01'], extra_vars: { version: 2 }, reason: '发版',
};
const request: AnsibleJobRequest = {
  assetIds: input.asset_ids, repository: 'ops/site', playbookPath: input.playbook_path, commitSha: sha,
  extraVars: input.extra_vars, comment: 'approved',
};
const submission = { jobId: 'task-123', status: 'PENDING' as const, jobUrl: base + '/ui/#/workbench/ops/executions/task-123' };
const result = { ...submission, status: 'SUCCESS' as const, outputSummary: 'healthy' };
const inspect = { assetIds: ['web01'], commands: ['uptime'], account: 'readonly' };
const asTool = (name: string) => 'mcp__detent__jms_' + name;

it('validates role-specific configuration and parses list, timeout and pipeline settings', () => {
  expect(loadDeliveryConfig({})).toEqual({
    enableReleaseTools: true, prodApprovers: [], prodMinAccessLevel: 40, jumpserverTimeoutMs: 60000, deliveryJobPollIntervalMs: 3000, blockedAssets: [], blockFailedPipeline: true,
    inspectAllowPrefixes: ['systemctl status', 'nginx -t', 'df -h', 'free -m', 'uptime', 'ss -tlnp', 'kubectl get', 'cat /etc/nginx'],
  });
  expect(loadDeliveryConfig({ ...env, JUMPSERVER_TIMEOUT_MS: '4500', JUMPSERVER_READONLY_ACCOUNT: 'audit',
    JUMPSERVER_INSPECT_ALLOW_PREFIXES: 'uptime, df -h, ', JUMPSERVER_BLOCKED_ASSETS: 'db, web, ',
  })).toMatchObject({
    jumpserverBaseUrl: base, jumpserverOrgId: 'org', jumpserverTimeoutMs: 4500, jumpserverReadonlyAccount: 'audit',
    jumpserverReadonlyAuth: { kind: 'signature', accessKeyId: env.JUMPSERVER_READONLY_ACCESS_KEY_ID, accessKeySecret: env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET },
    jumpserverJobAuth: { kind: 'bearer', token: env.JUMPSERVER_JOB_TOKEN }, inspectAllowPrefixes: ['uptime', 'df -h'], blockedAssets: ['db', 'web'],
  });
  expect(loadDeliveryConfig({ JUMPSERVER_READONLY_TOKEN: 'reader', JUMPSERVER_JOB_ACCESS_KEY_ID: 'job-id',
    JUMPSERVER_JOB_ACCESS_KEY_SECRET: 'writer',
  })).toMatchObject({ jumpserverReadonlyAuth: { kind: 'bearer', token: 'reader' },
    jumpserverJobAuth: { kind: 'signature', accessKeyId: 'job-id', accessKeySecret: 'writer' } });
  for (const role of ['READONLY', 'JOB']) for (const half of ['ID', 'SECRET'])
    expect(() => loadDeliveryConfig({ ['JUMPSERVER_' + role + '_ACCESS_KEY_' + half]: 'partial',
      ['JUMPSERVER_' + role + '_TOKEN']: 'fallback' })).toThrow('both access key');
  for (const value of ['false', '0']) expect(loadDeliveryConfig({ JUMPSERVER_BLOCK_FAILED_PIPELINE: value }).blockFailedPipeline).toBe(false);
  expect(() => loadDeliveryConfig({ JUMPSERVER_BASE_URL: 'invalid' })).toThrow();
  expect(() => loadDeliveryConfig({ JUMPSERVER_TIMEOUT_MS: '0' })).toThrow();
  expect(loadDeliveryConfig({ DELIVERY_JOB_POLL_INTERVAL_MS: '0' }).deliveryJobPollIntervalMs).toBe(0);
  expect(() => loadDeliveryConfig({ DELIVERY_JOB_POLL_INTERVAL_MS: '-1' })).toThrow();
});

function http() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const reply = (body: unknown, status = 200) => fetch.mockResolvedValueOnce(Response.json(body, { status }));
  return { fetch, reply };
}

it('signs the exact readonly request-target, date and accept headers, including node and query', async () => {
  const { fetch, reply } = http();
  reply({ results: [{ id: '1', name: 'web', address: '10.0.0.1', other: 'ignored' }] });
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  expect(await client.listAssets({ nodeId: 'node-id', search: 'web prod', limit: 2 })).toEqual([{ id: '1', name: 'web', address: '10.0.0.1' }]);
  const [[url, init]] = fetch.mock.calls;
  const path = '/api/v1/perms/users/self/nodes/node-id/assets/?limit=2&search=web+prod';
  expect(String(url)).toBe(base + path);
  const headers = new Headers(init?.headers);
  const date = headers.get('date')!;
  expect(date).toBe(new Date(date).toUTCString());
  const sig = createHmac('sha256', env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET)
    .update('(request-target): get ' + path + '\naccept: application/json\ndate: ' + date).digest('base64');
  expect(headers.get('authorization')).toBe(`Signature keyId="readonly-key-id",algorithm="hmac-sha256",headers="(request-target) accept date",signature="${sig}"`);
  expect(headers.get('accept')).toBe('application/json');
  expect(headers.get('x-jms-org')).toBe('org');
  expect(init).toMatchObject({ redirect: 'error', method: 'GET', signal: expect.any(AbortSignal) });
});

it('fails before I/O if the required credential is missing, and never changes roles during inspection', async () => {
  const { fetch, reply } = http();
  const config = loadDeliveryConfig(env);
  const jobOnly = new HttpJumpServerClient({ ...config, jumpserverReadonlyAuth: undefined });
  await expect(jobOnly.listAssets({})).rejects.toThrow('readonly');
  await expect(jobOnly.runShell(inspect)).rejects.toThrow('readonly');
  const readOnly = new HttpJumpServerClient({ ...config, jumpserverJobAuth: undefined });
  await expect(readOnly.runAnsibleJob(request)).rejects.toThrow('job');
  await expect(new HttpJumpServerClient(loadDeliveryConfig({ JUMPSERVER_BASE_URL: base })).getJobResult('1')).rejects.toThrow('credentials');
  expect(fetch).not.toHaveBeenCalled();

  reply(['readonly']);
  reply({ id: 'definition', task_id: 'execution' });
  reply({ status: { value: 'success', label: 'Success' }, summary: { ok: ['web01'] } });
  reply({ result: { stdout: 'load average' } });
  expect(await new HttpJumpServerClient(config).runShell(inspect)).toMatchObject({
    jobId: 'execution', status: 'SUCCESS', outputSummary: expect.stringContaining('load average'),
  });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
    instant: true, is_periodic: false, type: 'adhoc', module: 'shell', args: 'uptime', assets: ['web01'], runas: 'readonly', runas_policy: 'skip', timeout: 60,
  });
  reply({ status: 'running', summary: {} });
  await readOnly.getJobResult('execution');
  for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('authorization')).toContain('keyId="readonly-key-id"');
  reply({ status: 'running', summary: {} });
  await new HttpJumpServerClient(config).getJobResult('execution');
  expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get('authorization')).toBe('Bearer ' + env.JUMPSERVER_JOB_TOKEN);
});

it.each([3, 4])('runs the SHA-pinned playbook with native job parameters on v%s', async version => {
  const { fetch, reply } = http();
  const files = { 'site-sha/deploy/run.yml': strToU8('- hosts: all'), 'site-sha/roles/test/tasks/main.yml': strToU8('[]') };
  reply(['@SPEC', 'ops-first', 'root']);
  fetch.mockResolvedValueOnce(new Response(Uint8Array.from(zipSync(files))));
  reply({ id: 'playbook-id' }); reply({ id: 'definition', variable: version === 3 ? undefined : [] }); reply({ task_id: submission.jobId });
  const client = new HttpJumpServerClient(loadDeliveryConfig(env), { gitlabBaseUrl: 'https://git.test', gitlabToken: 'git-token' });
  expect(await client.runAnsibleJob(request)).toEqual(submission);
  const [lookup, archive, upload, job, execution] = fetch.mock.calls;
  expect(String(lookup[0])).toBe(base + '/api/v1/perms/users/self/assets/web01/accounts/');
  expect(String(archive[0])).toBe('https://git.test/api/v4/projects/ops%2Fsite/repository/archive.zip?sha=' + sha);
  expect(archive[1]?.mode).toBe('same-origin');
  expect(new Headers(archive[1]?.headers).get('private-token')).toBe('git-token');
  expect(new Headers(archive[1]?.headers).has('authorization')).toBe(false);
  expect(String(upload[0])).toBe(base + '/api/v1/ops/playbooks/');
  const form = upload[1]?.body as FormData;
  const imported = unzipSync(new Uint8Array(await (form.get('path') as Blob).arrayBuffer()));
  expect(JSON.parse(strFromU8(imported['main.yml']))).toEqual([{ import_playbook: 'site-sha/deploy/run.yml' }]);
  expect(imported['site-sha/roles/test/tasks/main.yml']).toEqual(files['site-sha/roles/test/tasks/main.yml']);
  expect(form.get('scope')).toBe('private');
  expect(String(job[0])).toBe(base + '/api/v1/ops/jobs/');
  expect(JSON.parse(String(job[1]?.body))).toEqual({ name: expect.stringMatching(/^detent-/), type: 'playbook', is_periodic: false, playbook: 'playbook-id', runas: 'ops-first', runas_policy: 'skip', assets: ['web01'], comment: 'approved' });
  expect(String(execution[0])).toBe(base + '/api/v1/ops/job-executions/');
  expect(JSON.parse(String(execution[1]?.body))).toEqual({
    job: 'definition', parameters: version === 3 ? '{"jms_version":2}' : { jms_version: 2 },
  });
  for (const [, init] of [lookup, upload, job, execution]) {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + env.JUMPSERVER_JOB_TOKEN);
    expect(new Headers(init?.headers).has('private-token')).toBe(false);
  }
  fetch.mockResolvedValueOnce(new Response(Uint8Array.from(zipSync(files))));
  await expect(client.runAnsibleJob({ ...request, playbookPath: 'other.yml' })).rejects.toThrow('missing');
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('redacts GitLab and JumpServer credentials when the playbook archive fetch fails', async () => {
  const { fetch, reply } = http();
  const gitlabToken = 'git-token"/+';
  const client = new HttpJumpServerClient(loadDeliveryConfig(env), { gitlabBaseUrl: 'https://git.test', gitlabToken });
  const credentials = [gitlabToken, JSON.stringify(gitlabToken), encodeURIComponent(gitlabToken), env.JUMPSERVER_JOB_TOKEN];
  reply(['ops-first']);
  fetch.mockRejectedValueOnce(Error('Archive fetch failed: ' + credentials.join(' / ')));
  await expect(client.runAnsibleJob(request)).rejects.toMatchObject({ message: 'Archive fetch failed: *** / "***" / *** / ***' });
});

it('scrubs mixed credentials from the structured job result used for the delivery audit', async () => {
  const { reply } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env), {
    gitlabBaseUrl: 'https://git.test', gitlabToken: 'bot-token', jevApiKey: 'jev-token',
  });
  reply({ status: 'success', summary: { message: 'jev-token' } });
  reply({ result: { trace: 'https://oauth2:unknown@git/repo bot-token ' + env.JUMPSERVER_JOB_TOKEN } });
  expect((await client.getJobResult('execution')).outputSummary).toBe(
    '{"message":"***"}\n{"trace":"https://oauth2:***@git/repo *** ***"}',
  );
});

it('keeps secrets out of HTTP/transport errors and inspection output on older result APIs', async () => {
  const { fetch, reply } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  const secrets = [env.JUMPSERVER_JOB_TOKEN, env.JUMPSERVER_READONLY_ACCESS_KEY_ID, env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET].join(' / ');
  reply({ detail: secrets }, 403);
  await expect(client.listAssets({})).rejects.toMatchObject({ message: 'JumpServer HTTP 403: {"detail":"*** / *** / ***"}' });
  fetch.mockRejectedValueOnce(Error('network: ' + secrets));
  await expect(client.listAssets({})).rejects.toThrow('network: *** / *** / ***');
  reply({ status: 'failed', summary: { message: secrets } }); reply({}, 404); reply({ data: secrets });
  const outcome = await client.getJobResult('execution');
  expect(outcome.status).toBe('FAILED');
  for (const value of secrets.split(' / ')) expect(outcome.outputSummary).not.toContain(value);
});

const safeCommands = ['systemctl status nginx', 'nginx -t', 'df -h', 'free -m', 'uptime', 'ss -tlnp',
  'cat /etc/nginx/nginx.conf', 'cat /etc/nginx/a /etc/nginx/b', 'kubectl get pods -n prod -o wide',
  'kubectl get deploy/web -n prod -o yaml', 'kubectl get -n secrets pods'];
const unsafeCommands = ['nginx -t && rm -rf /', 'uptime; id', 'df -h | sh', 'uptime murphy', 'nginx -t > /tmp/x',
  'uptime\nid', 'uptime\n', 'uptime\r', 'uptime\0', "cat '/etc/nginx'", 'cat "/etc/nginx"', 'cat /etc/nginx/../../etc/shadow',
  'cat /etc/nginx /etc/shadow', 'cat /etc/nginx-old/key', 'cat /etc/nginx ~/key', 'nginx -t -s stop',
  'nginx -t -g daemon', 'nginx -t -p /tmp', 'systemctl status -H remote', 'systemctl status --host=remote',
  'systemctl status --root /tmp', 'rm -rf /', 'systemctl restart nginx', 'ss -tlnp -K', 'df -h --sync',
  'cat /etc/nginx -- -outside', 'kubectl get pods -o go-template-file=/tmp/file', 'kubectl get secret -n prod -o yaml',
  'kubectl get secrets -A', 'kubectl get pods,secrets -n prod', 'kubectl get secret/db-pass',
  'kubectl get secrets.v1', 'kubectl get SeCrEtS.v1.', '', ' '.repeat(513)];
it('validates literal read commands, normalized prefix boundaries and relative YAML paths', () => {
  const { inspectAllowPrefixes } = loadDeliveryConfig({});
  for (const command of safeCommands) expect(validateReadonlyInspectCommand(command, inspectAllowPrefixes), command).toEqual({ ok: true, normalized: command });
  for (const command of unsafeCommands) expect(validateReadonlyInspectCommand(command, inspectAllowPrefixes).ok, command).toBe(false);
  expect(validateReadonlyInspectCommand(' cat\t /etc/nginx/file  ', [' cat  /etc/nginx '])).toEqual({ ok: true, normalized: 'cat /etc/nginx/file' });
  for (const path of ['../evil.yml', '/etc/playbook.yml', 'run.sh', '~/run.yaml', 'dir/../run.yml', 'run.yml\n', 'a;b.yml', ''])
    expect(validatePlaybookPath(path).ok, path).toBe(false);
  expect(validatePlaybookPath('site/reload-nginx.yaml')).toEqual({ ok: true });
});

async function setup(mode: PermissionMode = 'default', config: DeliveryConfig = loadDeliveryConfig(env), tracking = true, decision?: DecisionClient) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'Change');
  session.permissionMode = mode;
  session.claudeSessionId = 'session';
  const records = new Map<string, string>();
  const tracker = {
    recordExecution: vi.fn<DeliveryExecutionTracker['recordExecution']>(async record => { records.set(record.jumpserverJobId, record.sessionId); }),
    hasSessionJob: vi.fn(async (sessionId: string, jobId: string) => records.get(jobId) === sessionId),
    updateExecutionResult: vi.fn<NonNullable<DeliveryExecutionTracker['updateExecutionResult']>>(),
  };
  const client = {
    listAssets: vi.fn<JumpServerClient['listAssets']>().mockResolvedValue([]),
    runShell: vi.fn<JumpServerClient['runShell']>().mockResolvedValue(result),
    runAnsibleJob: vi.fn<JumpServerClient['runAnsibleJob']>().mockResolvedValue(submission),
    getJobResult: vi.fn<JumpServerClient['getJobResult']>().mockResolvedValue(result),
  };
  const tools = createJumpServerTools({ client, config, decision, tracker: tracking ? tracker : undefined });
  const gitlab = { createIssueNote: vi.fn(async (_p: number, _i: number, _card: string) => ({ id: 12 })), syncIssueStatusLabel: vi.fn() };
  const core = loadConfig({});
  const controller = new AbortController();
  const context = { config: core, repo, session, gitlab, checkpoint: vi.fn(), controller, workspaceRoot: '/workspace', extensionTools: tools };
  const gate = new PermissionGate(context);
  async function replay(args: Record<string, unknown>, status: 'APPROVED' | 'REJECTED' = 'APPROVED') {
    const pending = (await repo.getLatestPendingApproval(session.id))!;
    await repo.resolveApprovalRequest(pending.id, status, 'ops', 'declined');
    const previousDecision = (await repo.getApproval(pending.id))!;
    const nextGate = new PermissionGate({ ...context, controller: new AbortController(), previousDecision });
    return { gate: nextGate, result: await nextGate.invokeExtension(asTool('job'), args) };
  }
  const mr = { sessionId: session.id, targetProjectId: 7, mrIid: 8, mrState: 'merged' as const,
    mrWebUrl: 'https://git.test/ops/site/-/merge_requests/8', mrTitle: 'Deploy', targetProjectPath: 'ops/site',
    mergeCommitSha: sha, mergedBy: 'reviewer', worktreeId: null, sourceBranch: 'change', targetBranch: 'main',
    latestPipelineStatus: 'success', latestPipelineId: 1 };
  return { replay, gate, client, session, repo, mr, gitlab, tracker, records, core, tools, controller };
}

it.each(['plan', 'default'] as const)('gates readonly inspection and lists assets in %s mode', async mode => {
  const { client, gate, gitlab, tools } = await setup(mode);
  await gate.invokeExtension(asTool('list_assets'), { node_id: 'node', search: 'web', limit: 3 });
  expect(client.listAssets).toHaveBeenCalledExactlyOnceWith({ nodeId: 'node', search: 'web', limit: 3 });
  for (const command of safeCommands) await gate.invokeExtension(asTool('shell'), { asset_ids: ['web01'], commands: [command] });
  expect(client.runShell).toHaveBeenCalledTimes(safeCommands.length);
  for (const command of unsafeCommands) {
    const args = { asset_ids: ['web01'], commands: [command] };
    expect(await gate.canUseTool(asTool('shell'), args), command).toMatchObject({ behavior: 'deny' });
    await expect(gate.invokeExtension(asTool('shell'), args)).rejects.toThrow();
  }
  await expect(gate.invokeExtension(asTool('shell'), { asset_ids: ['RESTRICTED'], commands: ['uptime'] })).rejects.toThrow('黑名单');
  expect(client.runShell).toHaveBeenCalledTimes(safeCommands.length);
  await gate.invokeExtension(asTool('shell'), { asset_ids: ['web01'], commands: ['  systemctl\t status  nginx '] });
  expect(client.runShell).toHaveBeenLastCalledWith({ assetIds: ['web01'], account: undefined, commands: ['systemctl status nginx'] });
  const schema = z.object(tools.find(tool => tool.name === 'jms_shell')!.schema);
  expect(schema.safeParse({ asset_ids: ['web01'], commands: ['uptime\n'] }).success).toBe(false);
  expect(gitlab.createIssueNote).not.toHaveBeenCalled();
});

it('denies jobs in plan mode before looking up the MR', async () => {
  const { gate, client, gitlab, repo } = await setup('plan');
  const list = vi.spyOn(repo, 'listSessionMergeRequests');
  await expect(gate.invokeExtension(asTool('job'), input)).rejects.toThrow('detent_submit_plan');
  expect(list).not.toHaveBeenCalled(); expect(gitlab.createIssueNote).not.toHaveBeenCalled(); expect(client.runAnsibleJob).not.toHaveBeenCalled();
});

it.each([
  ['other session', { sessionId: 'other' }, {}, '不属于'],
  ['untracked', {}, { target_project_id: 9 }, '不属于'],
  ['opened', { mrState: 'opened' }, {}, '尚未合并'],
  ['sha mismatch', {}, { commit_sha: 'another' }, 'SHA'],
  ['missing sha', { mergeCommitSha: null }, {}, 'SHA'],
  ['failed pipeline', { latestPipelineStatus: 'failed' }, {}, '流水线'],
  ['blocked asset', {}, { asset_ids: ['Restricted'] }, '黑名单'],
  ...['../evil.yml', '/etc/playbook.yml', 'run.sh'].map(path => [path, {}, { playbook_path: path }, 'Playbook'] as const),
] as const)('hard-denies %s before posting a card or contacting JumpServer', async (_case, change, args, reason) => {
  const { gate, repo, mr, gitlab, session, client } = await setup();
  await repo.upsertMergeRequest({ ...mr, ...change });
  await expect(gate.invokeExtension(asTool('job'), { ...input, ...args })).rejects.toThrow(reason);
  expect(await repo.getLatestApproval(session.id)).toBeNull();
  expect(gitlab.createIssueNote).not.toHaveBeenCalled();
  expect(client.runAnsibleJob).not.toHaveBeenCalled();
});

it.each([true, false])('binds the approved execution and result to this session (block failed pipeline = %s)', async blockFailedPipeline => {
  const { gate, replay, client, repo, mr, gitlab, session, tracker } = await setup('default', { ...loadDeliveryConfig(env), blockFailedPipeline });
  const row = await repo.upsertMergeRequest({ ...mr, latestPipelineStatus: blockFailedPipeline ? 'success' : 'failed' });
  const list = vi.spyOn(repo, 'listSessionMergeRequests');
  const args = { ...input, reason: '上线 | 验证\r/approve\n/close ' + env.JUMPSERVER_JOB_TOKEN, extra_vars: { ...input.extra_vars, note: env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET } };
  await expect(gate.invokeExtension(asTool('job'), args)).rejects.toBeInstanceOf(ColdHold);
  expect(session.status).toBe('WAITING_TOOL');
  const approval = (await repo.getLatestPendingApproval(session.id))!;
  const card = gitlab.createIssueNote.mock.calls[0][2];
  for (const value of [approval.id, 'web01', input.playbook_path, 'ops/site!8', mr.mrWebUrl, 'reviewer', sha, 'version', '上线', '/approve', '/reject'])
    expect(card).toContain(value);
  expect(card).toContain('| 变更原因 | 上线 \\| 验证 /approve /close *** |');
  expect(card).not.toMatch(/^\s*\//m);
  for (const value of [env.JUMPSERVER_JOB_TOKEN, env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET]) expect(card).not.toContain(value);
  expect(client.runAnsibleJob).not.toHaveBeenCalled();
  const resumed = await replay(args);
  expect(resumed.result).toEqual({
    ...submission, mrId: row.id, approvalId: approval.id, commitSha: sha, approved: true, asyncCallback: true,
    nextAction: '任务已获批并在 JumpServer 后台异步执行。请简要告知用户任务链接后直接结束本轮，切勿轮询等待；任务到达终态后系统将自动回调唤醒本会话进行后续核验。',
  });
  expect(list).toHaveBeenCalledTimes(4);
  expect(client.runAnsibleJob).toHaveBeenCalledExactlyOnceWith({ ...request, extraVars: args.extra_vars, comment: expect.stringContaining(approval.id) });
  expect(tracker.recordExecution).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id, mrId: row.id, approvalId: approval.id, agentProfile: 'unified', jumpserverJobId: submission.jobId, jumpserverJobUrl: submission.jobUrl,
    playbookPath: request.playbookPath, commitSha: sha, targetAssets: input.asset_ids, status: submission.status,
  });
  expect(client.getJobResult).not.toHaveBeenCalled();
  expect(await resumed.gate.invokeExtension(asTool('job_status'), { job_id: submission.jobId })).toEqual(result);
  expect(client.getJobResult).toHaveBeenCalledExactlyOnceWith(submission.jobId);
  expect(tracker.updateExecutionResult).toHaveBeenCalledExactlyOnceWith(session.id, submission.jobId, 'SUCCESS', result.outputSummary);
});

it.each(['reject', 'pipeline changes', 'merge changes at dispatch'])('aborts submission when %s', async scenario => {
  const { gate, replay, client, repo, mr, tracker } = await setup();
  const row = await repo.upsertMergeRequest(mr);
  await expect(gate.invokeExtension(asTool('job'), input)).rejects.toBeInstanceOf(ColdHold);
  if (scenario === 'pipeline changes') await repo.updateMergeRequestPipeline(row.id, 2, 'failed');
  if (scenario === 'merge changes at dispatch') vi.spyOn(repo, 'listSessionMergeRequests').mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
  await expect(replay(input, scenario === 'reject' ? 'REJECTED' : 'APPROVED')).rejects.toThrow(scenario === 'reject' ? 'declined' : scenario === 'pipeline changes' ? '流水线' : '不属于');
  expect(client.runAnsibleJob).not.toHaveBeenCalled();
  expect(tracker.recordExecution).not.toHaveBeenCalled();
});

it('reports the submitted job when tracking fails without resubmitting or exposing the storage error', async () => {
  const { gate, replay, repo, mr, tracker, client } = await setup();
  await repo.upsertMergeRequest(mr);
  tracker.recordExecution.mockRejectedValueOnce(Error(env.JUMPSERVER_JOB_TOKEN));
  await expect(gate.invokeExtension(asTool('job'), input)).rejects.toBeInstanceOf(ColdHold);
  const run = replay(input);
  await expect(run).rejects.toThrow(submission.jobUrl);
  await expect(run).rejects.not.toThrow(env.JUMPSERVER_JOB_TOKEN);
  expect(client.runAnsibleJob).toHaveBeenCalledOnce();
});

it.each([true, false])('refuses results without evidence of session ownership (tracker = %s)', async tracking => {
  const { gate, client, tracker, records } = await setup('plan', loadDeliveryConfig(env), tracking);
  records.set(submission.jobId, 'other-session');
  await expect(gate.invokeExtension(asTool('job_status'), { job_id: submission.jobId })).rejects.toThrow(tracking ? '不属于' : '未配置');
  expect(client.getJobResult).not.toHaveBeenCalled();
  expect(tracker.updateExecutionResult).not.toHaveBeenCalled();
});

it('excludes every JumpServer environment variable from the Claude SDK child environment', async () => {
  for (const [name, value] of Object.entries({ ...env, JUMPSERVER_JOB_ACCESS_KEY_SECRET: 'job-secret', JUMPSERVER_FUTURE_SETTING: 'unknown' }))
    vi.stubEnv(name, value);
  const { core, session, gate, repo, controller } = await setup('plan');
  const sandbox = { workspaceRoot: '/workspace', rootDir: '/turn', claudeHome: '/turn/home' };
  const tools = new WorkspaceTools(new EphemeralSandbox(core, repo, new GitLabClient(core)), sandbox, session.id);
  await new SdkClaudeRunner(core).run({ gate, session, controller, sandbox, tools, prompt: 'test', systemPrompt: '', progress: vi.fn(), resume: false });
  const child = vi.mocked(query).mock.lastCall![0].options!.env!;
  expect(Object.keys(child).filter(key => key.startsWith('JUMPSERVER_'))).toEqual([]);
  for (const value of [env.JUMPSERVER_JOB_TOKEN, env.JUMPSERVER_READONLY_ACCESS_KEY_SECRET, env.JUMPSERVER_READONLY_ACCESS_KEY_ID])
    expect(Object.values(child)).not.toContain(value);
});

it('evaluates eligible remote diagnostics once, preserves quoted arguments and checks assets', async () => {
  const decide = vi.fn<DecisionClient['decide']>().mockResolvedValue({
    effect: { type: 'choice', choice: 'pure_readonly' }, zero_side_effect: { type: 'noul', noul: 0.96 }, impact: { type: 'score', score: 0.6 },
  });
  const { gate, client } = await setup('plan', loadDeliveryConfig(env), true, { provider: 'custom', threshold: 0.9, decide });
  const tool = asTool('shell');
  await gate.invokeExtension(tool, { asset_ids: ['web01'], commands: ['uptime'] });
  for (const command of [
    'systemctl restart nginx', 'rm -rf /tmp/x', 'sudo uptime', 'cat /etc/shadow', 'kubectl get secrets',
    'curl -X POST http://127.0.0.1/', 'curl -sI https://evil.example/', 'curl -sI http://localhost@evil.example/',
    "curl http://localhost/ '|' uptime https://evil.example/", 'cat /etc/nginx/.env', 'cat /etc//shadow',
    'ps aux | tee log', 'nginx -t -g daemon', 'kubectl get pods -o go-template-file=x', 'ss -K',
    'df --sync', 'sed -i s/a/b/ f', 'find . -exec ls', "awk 'system(cmd)'",
  ]) expect(await gate.canUseTool(tool, { asset_ids: ['web01'], commands: [command] }), command).toMatchObject({ behavior: 'deny' });
  expect(decide).not.toHaveBeenCalled();
  await gate.invokeExtension(tool, { asset_ids: ['web01'], commands: ['ss -lntp'] });
  expect(decide).not.toHaveBeenCalled();
  for (const command of ['journalctl -u nginx -n 20', 'ps aux | grep nginx',
    "ps aux | grep 'two  words'", 'curl -sI http://127.0.0.1/healthz']) {
    await gate.invokeExtension(tool, { asset_ids: ['web01'], commands: [command] });
    expect(decide.mock.lastCall?.[0]).toEqual({ surface: 'remote_jumpserver_readonly_inspect', command });
    expect(client.runShell).toHaveBeenLastCalledWith({ assetIds: ['web01'], account: undefined, commands: [command] });
  }
  expect(decide).toHaveBeenCalledTimes(4);
  await expect(gate.invokeExtension(tool, { asset_ids: ['restricted'], commands: ['ss -lntp'] })).rejects.toThrow('黑名单');
  for (const [choice, noul, score] of [['state_mutating', 1, 0], ['pure_readonly', 0.74, 0], ['pure_readonly', 1, 1.4]] as const) {
    decide.mockResolvedValueOnce({ effect: { type: 'choice', choice }, zero_side_effect: { type: 'noul', noul }, impact: { type: 'score', score } });
    await expect(gate.invokeExtension(tool, { asset_ids: ['web01'], commands: ['date'] })).rejects.toThrow(`Jev: choice=${choice}, noul=${noul}, impact=${score}`);
  }
  decide.mockResolvedValueOnce({ effect: { type: 'choice', choice: 'pure_readonly' }, zero_side_effect: { type: 'noul', noul: 0.75 }, impact: { type: 'score', score: 1.35 } });
  await gate.invokeExtension(tool, { asset_ids: ['web01'], commands: ['date'] });
  decide.mockRejectedValueOnce(Error('provider timeout'));
  await expect(gate.invokeExtension(tool, { asset_ids: ['web01'], commands: ['date'] })).rejects.toThrow('provider timeout');
  expect(client.runShell).toHaveBeenCalledTimes(7);
});

it('lists real, active accounts in server order and falls back to asset detail only on 404', async () => {
  const { reply, fetch } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  reply({ results: ['@SPEC', { username: '@INPUT', alias: 'input' }, { username: 'disabled', is_active: false },
    { username: ' ops ' }, 'root', 'ops', { name: 'backup' }, { alias: 'worker' }] });
  expect(await client.listAssetAccounts('host/id')).toEqual(['ops', 'root', 'backup', 'worker']);
  expect(String(fetch.mock.calls[0][0])).toBe(base + '/api/v1/perms/users/self/assets/host%2Fid/accounts/');
  reply({}, 404);
  reply({ permed_accounts: ['@USER', 'ubuntu'] });
  expect(await client.listAssetAccounts('host')).toEqual(['ubuntu']);
  expect(await client.listAssetAccounts('host')).toEqual(['ubuntu']);
  expect(fetch).toHaveBeenCalledTimes(3);
  reply({ accounts: ['ops'] });
  expect(await client.listAssetAccounts('host', { kind: 'bearer', token: 'other' })).toEqual(['ops']);
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
  try {
    reply({ accounts: ['rotated'] });
    expect(await client.listAssetAccounts('host')).toEqual(['rotated']);
    reply({}, 403);
    await expect(client.listAssetAccounts('unavailable')).rejects.toThrow('403');
  } finally { now.mockRestore(); }
  expect(fetch.mock.calls.slice(2).map(([url]) => String(url))).toEqual(
    ['host', 'host', 'host', 'unavailable'].map(id => base + '/api/v1/perms/users/self/assets/' + id + '/'));
});

it('rejects unauthorized explicit accounts before any job is submitted', async () => {
  const { reply, fetch } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  for (const call of [() => client.runShell({ ...inspect, account: 'ghost' }),
    () => client.runAnsibleJob({ ...request, account: 'ghost' })]) {
    reply(['@INPUT', 'ops-hub', 'audit-ro']);
    await expect(call()).rejects.toThrow('资产 web01 未授权账号 ghost；可用授权账号：ops-hub、audit-ro');
  }
  expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

it('groups inspection by the first active real account and reports every group’s terminal status', async () => {
  const { reply, fetch } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  reply(['@SPEC', { username: 'inactive', is_active: false }, 'ops-first', 'root']);
  reply(['@INPUT', 'ops-second', 'root']);
  reply(['ops-first']);
  for (const [id, status] of [['first', 'success'], ['second', 'failed']]) {
    reply({ task_id: id });
    reply({ status, summary: {} });
    reply({ result: { stdout: id + '-output' } });
  }
  const grouped = await client.runShell({ assetIds: ['a', 'b', 'c'], commands: ['uptime', 'df -h'] });
  const jobs = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));
  expect(jobs).toEqual([
    expect.objectContaining({ assets: ['a', 'c'], runas: 'ops-first', runas_policy: 'skip' }),
    expect.objectContaining({ assets: ['b'], runas: 'ops-second', runas_policy: 'skip' }),
  ]);
  for (const job of jobs) expect(job.args).toMatch(/set \+e[\s\S]*uptime[\s\S]*df -h/);
  expect(grouped).toMatchObject({ status: 'FAILED', groups: [
    { assetIds: ['a', 'c'], account: 'ops-first', jobId: 'first', status: 'SUCCESS' },
    { assetIds: ['b'], account: 'ops-second', jobId: 'second', status: 'FAILED' },
  ], outputSummary: expect.stringMatching(/first-output[\s\S]*second-output/) });
});

it('requires a common account for playbooks and rejects empty authorizations before submitting any group', async () => {
  const { reply, fetch } = http();
  const client = new HttpJumpServerClient(loadDeliveryConfig(env));
  const assetIds = ['web01', 'web02'];
  reply(['@SPEC', 'ops-first', 'root']);
  reply(['@INPUT', 'ops-second', 'root']);
  await expect(client.runAnsibleJob({ ...request, assetIds })).rejects.toThrow(/共同的 account.*分组执行/);
  for (const account of [undefined, 'root']) {
    const client = new HttpJumpServerClient(loadDeliveryConfig(env));
    for (const invoke of [() => client.runShell({ ...inspect, account, assetIds }),
      () => client.runAnsibleJob({ ...request, account, assetIds })]) {
      reply(['root']);
      reply(['@USER', '@ANON', { username: 'root', is_active: false }]);
      await expect(invoke()).rejects.toThrow('资产 web02 在 JumpServer 中未给当前 API Key 授权任何登录账号');
    }
  }
  expect(fetch.mock.calls.every(([url, init]) => String(url).endsWith('/accounts/') && init?.method === 'GET')).toBe(true);
});
