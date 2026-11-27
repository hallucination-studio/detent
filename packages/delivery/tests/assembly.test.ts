import { expect, it, vi } from 'vitest';
import { createDetentApp, defineExtensionTool, GitLabClient, loadConfig, SessionOrchestrator, type DetentExtensions } from '@detent/core';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { mockMcpServer } from '../../core/tests/mock-mcp-server.js';
import { createDeliveryApp, loadDeliveryConfig, type JumpServerClient } from '../src/index.js';

// Exercise real app composition and HTTP routing with only the external I/O replaced.
const { pool, createPool } = vi.hoisted(() => {
  const pool = { query: vi.fn().mockResolvedValue([[], []]), execute: vi.fn(), end: vi.fn() };
  return { pool, createPool: vi.fn(() => pool) };
});
vi.mock('@detent/core', async original => {
  const core = await original<typeof import('@detent/core')>();
  return { ...core, createDetentApp: vi.fn(core.createDetentApp) };
});
vi.mock('mysql2/promise', () => ({ default: { createPool } }));

it('dispatches an authenticated extension event with access to the core orchestrator', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/repository/files/')
    ? new Response(null, { status: 404 }) : Response.json({ id: 99, username: 'bot' })));
  const handle = vi.fn(async () => {});
  const matchWebhookEvent = vi.fn<NonNullable<DetentExtensions['matchWebhookEvent']>>(
    event => event.object_kind === 'sample' ? { key: 'sample', handle } : null,
  );
  const onInitSchema = vi.fn<NonNullable<DetentExtensions['onInitSchema']>>(async sharedPool => {
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS approval_requests'));
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS delivery_executions'));
    await sharedPool.query('CREATE TABLE IF NOT EXISTS sample (id INT)');
  });
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), {
    deliveryConfig: loadDeliveryConfig({}), matchWebhookEvent, onInitSchema,
  });
  const post = (payload: object, token = 'test') => app.inject({
    method: 'POST', url: '/webhooks/gitlab', headers: { 'x-gitlab-token': token }, payload,
  });
  const event = { object_kind: 'sample', user: { id: 7, username: 'dev' }, project: { id: 2 }, value: 42 };
  try {
    expect((await post(event, 'wrong')).statusCode).toBe(401);
    expect((await post({ ...event, user: { id: 99 } })).json()).toEqual({ ignored: true });
    expect((await post({ ...event, user: { id: 'invalid' } })).statusCode).toBe(400);
    expect(matchWebhookEvent).not.toHaveBeenCalled();
    expect((await post(event)).statusCode).toBe(202);
    expect(matchWebhookEvent).toHaveBeenCalledWith(event);
    expect((await post({ ...event, object_kind: 'unhandled' })).statusCode).toBe(202);
    pool.query.mockResolvedValue([[], []]);
    const merge = { ...event, object_kind: 'merge_request', object_attributes: { action: 'merge', iid: 8 } };
    expect((await post(merge)).statusCode).toBe(202);
    expect(matchWebhookEvent).not.toHaveBeenCalledWith(merge);
  } finally {
    await app.close();
    vi.unstubAllGlobals();
  }
  expect(handle).toHaveBeenCalledExactlyOnceWith(expect.any(SessionOrchestrator));
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('target_project_id=? AND mr_iid=?'), [2, 8]);
  expect(onInitSchema).toHaveBeenCalledExactlyOnceWith(pool);
  expect(createPool).toHaveBeenCalledOnce();
  expect(pool.end).toHaveBeenCalledOnce();
});

it.each(['injected', 'http', 'disabled'] as const)('assembles %s tools alongside caller extensions', async mode => {
  const config = loadConfig({ GITLAB_WEBHOOK_SECRET: 'test', DETENT_PUBLIC_URL: 'https://hub.example' });
  const deliveryConfig = loadDeliveryConfig(mode === 'http' ? { JUMPSERVER_BASE_URL: 'https://jms.test' } : {});
  const client: JumpServerClient = {
    listAssets: vi.fn(), runReadonlyInspect: vi.fn(), runAnsibleJob: vi.fn(), getJobResult: vi.fn(),
  };
  const custom = defineExtensionTool({ name: 'custom', description: 'test', policy: 'readonly', schema: {}, execute: vi.fn() });
  const tools = [custom];
  const customPack = { name: 'deploy', enabled: true, tools: [] };
  const app = createDeliveryApp(config, { deliveryConfig, jumpserverClient: mode === 'injected' ? client : undefined,
    tools, capabilities: [customPack] });
  try {
    const extensions = vi.mocked(createDetentApp).mock.lastCall![1]!;
    expect(extensions.tools).toBe(tools);
    const [release, jumpserver, onboarding, deploy] = extensions.capabilities!;
    expect(deploy).toBe(customPack);
    expect(onboarding).toMatchObject({ name: 'gitlab-onboarding', enabled: true, approverTier: 'prod' });
    expect(release).toMatchObject({ name: 'gitlab-release', enabled: true });
    expect(release.tools.map(tool => tool.name)).toEqual(['detent_list_tags', 'detent_create_release']);
    expect(jumpserver).toMatchObject({ name: 'jumpserver', enabled: mode !== 'disabled', setupHint: expect.stringContaining('JUMPSERVER_BASE_URL') });
    expect(jumpserver.tools.map(tool => tool.name)).toEqual(mode === 'disabled' ? [] :
      ['jms_list_assets', 'jms_readonly_inspect', 'jms_run_ansible_job', 'jms_get_job_result']);
  } finally {
    await app.close();
  }
});

it.each(['false', ' 0 '])('disables release tools with %s and lets a caller replace a named pack', async value => {
  const replacement = { name: ' JumpServer ', enabled: true, tools: [] };
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), {
    deliveryConfig: loadDeliveryConfig({ DELIVERY_ENABLE_RELEASE_TOOLS: value }), capabilities: [replacement],
  });
  try {
    const { capabilities } = vi.mocked(createDetentApp).mock.lastCall![1]!;
    expect(capabilities).toEqual([
      { name: 'gitlab-release', enabled: false, tools: [], setupHint: expect.stringContaining('DELIVERY_ENABLE_RELEASE_TOOLS=false') },
      replacement,
      expect.objectContaining({ name: 'gitlab-onboarding', enabled: false }),
    ]);
  } finally {
    await app.close();
  }
});

it.each(['default', 'audit tracker', 'tracker only'] as const)('composes /status with the %s', async mode => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 88, 'check');
  const record = {
    id: 'id', sessionId: session.id, agentProfile: 'EnvChangeAgent', mrId: 'mr', approvalId: 'approval',
    jumpserverJobId: 'job', jumpserverJobUrl: 'https://jms.test/job', commitSha: 'abcde123', playbookPath: 'deploy/run.yml',
    targetAssets: ['web01'], status: 'RUNNING' as const, outputSummary: null, finishedAt: null, createdAt: new Date(),
  };
  const listSessionExecutions = vi.fn(async () => [record]);
  const renderStatusExtra = vi.fn(async () => 'Caller section');
  const tracker = { recordExecution: vi.fn(), hasSessionJob: vi.fn() };
  const injected = mode === 'audit tracker' ? { ...tracker, listSessionExecutions } : tracker;
  const executionTracker = mode === 'default' ? undefined : injected;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 99, username: 'bot' })));
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), { executionTracker, renderStatusExtra });
  const extensions = vi.mocked(createDetentApp).mock.lastCall![1]!;
  pool.query.mockClear();
  pool.execute.mockClear().mockResolvedValue([[record]]);
  try {
    await app.ready();
    const status = await extensions.renderStatusExtra!(session);
    expect(renderStatusExtra).toHaveBeenCalledExactlyOnceWith(session);
    if (mode === 'tracker only') expect(status).toBe('Caller section');
    else expect(status).toMatch(/### 交付执行记录[\s\S]*job[\s\S]*\n\nCaller section$/);
    if (mode === 'audit tracker') expect(listSessionExecutions).toHaveBeenCalledExactlyOnceWith(session.id);
    if (mode === 'default') expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('delivery_executions'), [session.id]);
    else {
      expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('delivery_executions'));
      expect(pool.execute).not.toHaveBeenCalled();
    }
  } finally {
    await app.close();
    vi.unstubAllGlobals();
  }
});

it('uses the injected release client and enforces production permissions on caller-selected profiles', async () => {
  const gitlabClient = {
    getProject: vi.fn().mockResolvedValue({ id: 7 }), listTags: vi.fn().mockResolvedValue([]), getCommit: vi.fn(),
    getTag: vi.fn(), listPipelinesBySha: vi.fn(), createTag: vi.fn(), createRelease: vi.fn(),
  };
  const name = 'detent_create_release';
  const profile = { readonly: false, enabledExtensionTools: [name], canApprove: vi.fn(async () => true) };
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), {
    deliveryConfig: loadDeliveryConfig({ DELIVERY_PROD_APPROVERS: 'ops' }), gitlabClient, resolveTurnProfile: () => profile,
  });
  try {
    const extensions = vi.mocked(createDetentApp).mock.lastCall![1]!;
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 88, 'release');
    const tagTool = extensions.capabilities!.find(pack => pack.name === 'gitlab-release')!.tools.find(tool => tool.name === 'detent_list_tags')!;
    await tagTool.execute({ project: 'apps/web' }, { session, repo, workspaceRoot: '.', permissionMode: 'plan' });
    expect(gitlabClient.listTags).toHaveBeenCalledWith(7, undefined);

    const gitlab = { getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true) };
    const current = await extensions.resolveTurnProfile!({ session, repo, gitlab });
    const params = { projectId: 1, userId: 7, username: 'dev', approvalType: 'TOOL_USE' as const, toolName: name };
    expect(await current.canApprove!(params)).toBe(false);
    expect(await current.canApprove!({ ...params, username: 'ops' })).toBe(true);
    profile.canApprove.mockResolvedValue(false);
    expect(await current.canApprove!({ ...params, username: 'ops' })).toBe(false);
  } finally {
    await app.close();
  }
});

it('requires the latest execution to succeed and preserves the caller’s close guard', async () => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'verify');
  const listSessionExecutions = vi.fn().mockResolvedValue([]);
  const canCloseIssue = vi.fn().mockResolvedValue({ ok: true });
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), {
    executionTracker: { recordExecution: vi.fn(), hasSessionJob: vi.fn(), listSessionExecutions },
    resolveTurnProfile: () => ({ closePolicy: 'auto', canCloseIssue }),
  });
  try {
    const extensions = vi.mocked(createDetentApp).mock.lastCall![1]!;
    const profile = await extensions.resolveTurnProfile!({
      session, repo, gitlab: { getIssue: vi.fn(), hasApprovalPermission: vi.fn() },
    });
    const check = () => profile.canCloseIssue!({ session, repo });
    expect(await check()).toEqual({ ok: true });
    for (const status of ['PENDING', 'RUNNING', 'FAILED']) {
      listSessionExecutions.mockResolvedValue([{ status: 'SUCCESS' }, { status }]);
      expect(await check()).toEqual({ ok: false, reason: '最新交付执行记录状态为 ' + status + '，未成功前禁止关闭工单' });
    }
    listSessionExecutions.mockResolvedValue([{ status: 'FAILED' }, { status: 'SUCCESS' }]);
    expect(await check()).toEqual({ ok: true });
    expect(listSessionExecutions).toHaveBeenLastCalledWith(session.id);
    canCloseIssue.mockResolvedValue({ ok: false, reason: 'verification incomplete' });
    expect(await check()).toEqual({ ok: false, reason: 'verification incomplete' });
  } finally {
    await app.close();
  }
});

it('enforces the live MCP pack production tier for an Agent with standard SOP approvals', async () => {
  const tools = ['inspect', 'mirror'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const server = await mockMcpServer((rpc, response) => {
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(204).end();
      return;
    }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      : { tools };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  vi.stubGlobal('fetch', server.http);
  vi.spyOn(GitLabClient.prototype, 'initBotIdentity').mockResolvedValue();
  vi.spyOn(GitLabClient.prototype, 'getIssue').mockResolvedValue({
    id: 88, iid: 42, title: 'Mirror container image', description: null, labels: ['agent::image-sync'], state: 'opened',
  });
  vi.spyOn(GitLabClient.prototype, 'listRepositoryTree').mockImplementation(async (_project, dir) =>
    dir === 'agents' ? [{ id: 'agent', name: 'AGENT.md', path: 'agents/image-sync/AGENT.md', type: 'blob' }] : [],
  );
  let markdown = '---\nrequires: [harbor-sync]\napprover_tier: standard\n---\nMirror the requested image.';
  vi.spyOn(GitLabClient.prototype, 'getRepositoryFile').mockImplementation(async () => markdown);
  const permission = vi.spyOn(GitLabClient.prototype, 'hasApprovalPermission')
    .mockImplementation(async (_project, access, minimum = 30) => access >= minimum);
  let capture!: (orchestrator: SessionOrchestrator) => void;
  const orchestratorReady = new Promise<SessionOrchestrator>(resolve => { capture = resolve; });
  const app = createDeliveryApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'hook' }), {
    deliveryConfig: loadDeliveryConfig({}),
    mcpCapabilities: [{
      name: 'harbor-sync', approverTier: 'prod', toolPolicies: { inspect: 'readonly' },
      transport: { type: 'streamable-http', url: server.url },
    }],
    matchWebhookEvent: () => ({ key: 'bridge', async handle(orchestrator) { capture(orchestrator); } }),
  });
  try {
    await app.ready();
    expect(server.requests.map(request => request.rpc.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect((await app.inject({
      method: 'POST', url: '/webhooks/gitlab', headers: { 'x-gitlab-token': 'hook' }, payload: { object_kind: 'bridge' },
    })).statusCode).toBe(202);
    const orchestrator = await orchestratorReady;
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'Mirror image');
    let pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'harbor-sync__mirror', {});
    vi.spyOn(orchestrator.repo, 'getSessionByIssue').mockResolvedValue(session);
    vi.spyOn(orchestrator.repo, 'getLatestPendingApproval').mockImplementation(async () => pending);
    const resolve = vi.spyOn(orchestrator.repo, 'resolveApprovalRequest').mockResolvedValue(false);
    const approve = (userId: number) => orchestrator.handleUserIntent(1, 42, { type: 'APPROVE', userId, username: 'user' + userId });

    await approve(30);
    expect(permission).toHaveBeenLastCalledWith(1, 30, 40);
    expect(resolve).not.toHaveBeenCalled();
    await approve(40);
    expect(permission).toHaveBeenLastCalledWith(1, 40, 40);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(pending.id, 'APPROVED', 'user40', undefined);

    // A readonly-policy tool in the pack still receives production approval checks.
    pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'harbor-sync__inspect', {});
    await approve(40);
    expect(resolve).toHaveBeenLastCalledWith(pending.id, 'APPROVED', 'user40', undefined);
    resolve.mockClear();
    permission.mockClear();
    markdown = '---\nrequires: [harbor-sync]\nmode: readonly\n---\nInspect the image.';
    await approve(40);
    markdown = '---\nrequires: []\n---\nPlan a standalone change.';
    await approve(40);
    expect(permission).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();

    pending = await repo.createApprovalRequest(session.id, 'PLAN', 'Plan', {});
    await approve(30);
    expect(permission).toHaveBeenCalledExactlyOnceWith(1, 30);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(pending.id, 'APPROVED', 'user30', undefined);
  } finally {
    await app.close();
    await server.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
