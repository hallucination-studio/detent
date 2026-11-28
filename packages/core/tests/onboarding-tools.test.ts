import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGitLabOnboardingCapability, createGitLabOnboardingTools, GitLabClient, loadConfig } from '../src/index.js';
import { GitLabError } from '../src/gitlab/client.js';
import { InMemoryDetentRepository } from './memory-repository.js';

const publicUrl = 'https://detent.example.com';
const webhookSecret = 'private-webhook-canary';
const url = publicUrl + '/webhooks/gitlab';
async function setup() {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 3, 'onboard');
  const ctx = { session, repo, workspaceRoot: '/tmp/workspace', permissionMode: 'default' as const, approvalId: 'approval' };
  const projects = [2, 3, 4].map(id => ({ id, path_with_namespace: 'apps/p' + id, default_branch: 'main', http_url_to_repo: '' }));
  const hooks = new Map<number, Record<string, unknown>>();
  const access = new Map([[2, 20], [3, 30], [4, 40]]);
  const http = vi.fn<typeof fetch>(async (resource, init) => {
    const path = new URL(String(resource)).pathname.slice(7);
    if (path === '/user') return Response.json({ id: 8, username: 'bot' });
    if (path === '/groups/apps' || path === '/groups/5') return Response.json({ id: 5, full_path: 'apps' });
    if (path === '/groups/5/projects') return Response.json(projects);
    const id = Number(path.split('/')[2]);
    if (path.endsWith('/members/all/8')) return access.has(id) ? Response.json({ access_level: access.get(id) }) : new Response(null, { status: 404 });
    if (path.includes('/hooks')) {
      if (init?.method === 'GET') return Response.json(hooks.has(id) ? [hooks.get(id)] : []);
      const hook = JSON.parse(String(init?.body));
      expect(hook.token === webhookSecret).toBe(true);
      expect(hook.enable_ssl_verification).toBe(true);
      hooks.set(id, { ...hook, id: 1 });
      return Response.json(hooks.get(id));
    }
    if (path === '/projects' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body));
      const fullPath = 'apps/' + input.path;
      if (projects.some(p => p.path_with_namespace === fullPath)) return new Response(null, { status: 409 });
      const project = { id: 10, path_with_namespace: fullPath, http_url_to_repo: '', default_branch: input.default_branch,
        web_url: 'https://gitlab.example.com/' + fullPath };
      projects.push(project);
      return Response.json(project);
    }
    const project = projects.find(p => p.id === id || p.path_with_namespace === decodeURIComponent(path.slice('/projects/'.length)));
    return project ? Response.json(project) : new Response(null, { status: 404 });
  });
  const gitlab = new GitLabClient(loadConfig({ GITLAB_WEBHOOK_SECRET: webhookSecret }), http);
  const options = { gitlab, publicUrl, webhookSecret };
  const [check, onboard, create] = createGitLabOnboardingTools(options);
  return { ctx, projects, hooks, access, gitlab, check, onboard, create, options, http };
}

it('checks group and project readiness using effective membership and the required events', async () => {
  const { ctx, hooks, access, check } = await setup();
  hooks.set(4, { id: 1, url, note_events: true, emoji_events: true, merge_requests_events: true, pipeline_events: true });
  expect(check.policy).toBe('readonly');
  expect(await check.execute({ group: 'apps' }, ctx)).toMatchObject({ projects: [
    { botAccessLevel: 20, canManageWebhooks: false }, { botAccessLevel: 30, canManageWebhooks: false },
    { projectId: 4, path: 'apps/p4', botAccessLevel: 40, canManageWebhooks: true, webhookConfigured: false, missingEvents: ['deployment_events'] },
  ] });
  access.delete(4);
  expect(await check.execute({ project: 4 }, ctx)).toMatchObject({ projects: [{ botAccessLevel: null, nextStep: expect.stringContaining('@bot') }] });
});

it('refuses the entire group on missing access, including revocation after approval', async () => {
  const { ctx, onboard, access, hooks, projects } = await setup();
  expect(onboard.policy).toBe('always_approve');
  expect(await onboard.guard!({}, ctx)).toMatchObject({ ok: false });
  expect(await onboard.guard!({ group: 'apps' }, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/@bot.*Maintainer.*apps\/p2.*apps\/p3/) });
  access.set(2, 40).set(3, 50);
  expect(await onboard.guard!({ group: 'apps' }, ctx)).toEqual({ ok: true });
  access.set(4, 30);
  await expect(onboard.execute({ group: 'apps' }, ctx)).rejects.toThrow(/Maintainer.*apps\/p4/);
  expect(hooks.size).toBe(0);
  projects.length = 0;
  expect(await onboard.guard!({ group: 'apps' }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('没有') });
});

it('uses a server-held token for idempotent group installation and projects only safe responses', async () => {
  const { ctx, access, check, onboard, gitlab, hooks } = await setup();
  access.set(2, 40).set(3, 40);
  const input = { group: 'apps' };
  const card = await onboard.renderApprovalCard!(ctx.approvalId, input, ctx);
  for (const field of ['apps/p2', 'apps/p3', 'apps/p4', url, 'deployment_events', '👍', '👎', ctx.approvalId]) expect(card).toContain(field);
  await expect(onboard.execute(input, { ...ctx, approvalId: undefined })).rejects.toThrow('审批单');
  for (const action of ['created', 'updated']) {
    const result = await onboard.execute(input, ctx);
    expect(result).toEqual({ webhookUrl: url, onboarded: [2, 3, 4].map(projectId => ({ projectId, path: 'apps/p' + projectId, action })) });
    expect(hooks.size).toBe(3);
  }
  const status = await check.execute({ project: 4 }, ctx);
  expect(status).toMatchObject({ projects: [{ webhookConfigured: true, missingEvents: [] }] });
  expect(JSON.stringify([card, status, await gitlab.listProjectHooks(4)])).not.toContain(webhookSecret);
});

it('advertises setup guidance for a disabled pack', async () => {
  const { options } = await setup();
  for (const missing of [{ publicUrl: undefined }, { webhookSecret: '' }]) {
    expect(createGitLabOnboardingCapability({ ...options, ...missing })).toMatchObject({
      enabled: false, approverTier: 'prod', tools: [], setupHint: expect.stringMatching(/DETENT_PUBLIC_URL.*GITLAB_WEBHOOK_SECRET/),
    });
  }
});

const target = { group: 5, path: 'new.repo-1' };
it('accepts a single safe project slug and bounded metadata', async () => {
  const { create } = await setup();
  const schema = z.object(create.schema);
  for (const path of ['', '-app', 'app_', 'app..v1', 'sub/app', 'sub\\app', 'app.git', 'app.ATOM', 'x'.repeat(129)])
    expect(schema.safeParse({ ...target, path }).success, path).toBe(false);
  for (const input of [{ path: 'x' }, { ...target, group: 0 }, { ...target, name: ' ' }, { ...target, description: 'x'.repeat(501) }])
    expect(schema.safeParse(input).success).toBe(false);
  expect(schema.parse({ group: ' apps ', path: ' A_2.v-3 ', name: ' App ' })).toEqual({ group: 'apps', path: 'A_2.v-3', name: 'App' });
  expect(schema.parse({ ...target, path: 'a' }).path).toBe('a');
});

it('requires effective group Maintainer access and rechecks it after approval', async () => {
  const { access, create, ctx, gitlab } = await setup();
  for (const level of [null, 30]) {
    if (level !== null) access.set(5, level);
    expect(await create.guard!(target, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/apps.*@bot.*Maintainer.*40/) });
  }
  access.set(5, 40);
  expect(await create.guard!(target, ctx)).toEqual({ ok: true });
  vi.spyOn(gitlab, 'getGroupMemberAccess').mockRejectedValueOnce(new GitLabError(403));
  await expect(create.execute(target, ctx)).rejects.toThrow(/@bot.*Maintainer/);
  for (const status of [403, 404]) {
    vi.spyOn(gitlab, 'getGroup').mockRejectedValueOnce(new GitLabError(status));
    expect(await create.guard!(target, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/核对群组路径.*父群组.*@bot/) });
  }
});

it('denies occupied paths and propagates lookup failures before requesting approval', async () => {
  const { access, create, ctx, gitlab } = await setup();
  access.set(5, 40);
  const existing = { ...target, path: 'p2' };
  expect(await create.guard!(existing, ctx)).toEqual({ ok: false, reason: '仓库 apps/p2 已存在，请直接检出修改或使用 detent_onboard_project 接入。' });
  await expect(create.renderApprovalCard!('id', existing, ctx)).rejects.toThrow(/已存在/);
  vi.spyOn(gitlab, 'getProject').mockRejectedValueOnce(new GitLabError(500));
  expect(await create.guard!(target, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('500') });
  for (const status of [400, 409]) {
    const failure = new GitLabError(status);
    vi.spyOn(gitlab, 'createProject').mockRejectedValueOnce(failure);
    await expect(create.execute(target, ctx)).rejects.toBe(failure);
  }
});

it('creates an approved private main repository and retries webhook installation after a partial failure', async () => {
  const { ctx, gitlab, http, hooks, access, create, options, projects } = await setup();
  access.set(5, 40);
  expect(createGitLabOnboardingCapability(options)).toMatchObject({ approverTier: 'prod',
    tools: expect.arrayContaining([expect.objectContaining({ name: 'detent_create_project', policy: 'always_approve' })]) });
  expect(await create.guard!(target, ctx)).toEqual({ ok: true });
  const card = await create.renderApprovalCard!(ctx.approvalId, target, ctx);
  for (const field of ['### 📁 GitLab 新建仓库审批', '| 目标群组 | `apps` |', '请生产审批人（Maintainer 或指定负责人）', 'apps/new.repo-1', 'main', '私有', 'README.md', url,
    'note_events', 'emoji_events', 'merge_requests_events', 'pipeline_events', 'deployment_events', '/approve', '/reject', ctx.approvalId])
    expect(card).toContain(field);
  await expect(create.execute(target, { ...ctx, approvalId: undefined })).rejects.toThrow('新建仓库缺少审批单。');
  vi.spyOn(gitlab, 'upsertProjectHook').mockRejectedValueOnce(new GitLabError(503));
  const input = { ...target, name: 'New Repo', description: 'New ' + webhookSecret };
  await expect(create.execute(input, ctx)).rejects.toThrow('503');
  const post = http.mock.calls.find(([resource, init]) => String(resource).endsWith('/projects') && init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ namespace_id: 5, path: target.path, name: input.name,
    description: 'New ***', visibility: 'private', default_branch: 'main', initialize_with_readme: true });
  const result = await create.execute(input, ctx);
  expect(projects.filter(p => p.path_with_namespace === 'apps/new.repo-1')).toHaveLength(1);
  expect(result).toEqual({ projectId: 10, path: 'apps/new.repo-1', defaultBranch: 'main',
    webUrl: 'https://gitlab.example.com/apps/new.repo-1', webhookUrl: url, webhookConfigured: true });
  expect(hooks.get(10)).toMatchObject({ url, token: webhookSecret, enable_ssl_verification: true, push_events: false, issues_events: false,
    note_events: true, emoji_events: true, merge_requests_events: true, pipeline_events: true, deployment_events: true });
  expect(JSON.stringify([card, result])).not.toContain(webhookSecret);
});

it('uses the slug as the default name and redacts a token echoed by a failed webhook request', async () => {
  const { ctx, access, create, http } = await setup();
  access.set(5, 50);
  const serve = http.getMockImplementation()!;
  http.mockImplementation((resource, init) => {
    if (String(resource).endsWith('/hooks') && init?.method === 'POST')
      return Promise.resolve(new Response('invalid hook token ' + webhookSecret, { status: 400 }));
    return serve(resource, init);
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(create.execute(target, ctx)).rejects.toThrow('invalid hook token ***');
    expect(log.mock.calls.flat().join(' ')).not.toContain(webhookSecret);
    const post = http.mock.calls.find(([resource, init]) => String(resource).endsWith('/projects') && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: target.path });
  } finally {
    log.mockRestore();
  }
});

it('defaults direct project creation to a private initialized main branch and honors explicit overrides', async () => {
  const { gitlab, http } = await setup();
  const input = { namespace_id: 5, name: 'A', path: 'a' };
  const created = await gitlab.createProject(input);
  expect(created.web_url).toBe('https://gitlab.example.com/apps/a');
  expect(JSON.parse(String(http.mock.lastCall?.[1]?.body))).toEqual({
    ...input, visibility: 'private', initialize_with_readme: true, default_branch: 'main',
  });
  const custom = { ...input, path: 'b', visibility: 'internal' as const, initialize_with_readme: false, default_branch: 'stable' };
  await gitlab.createProject(custom);
  expect(JSON.parse(String(http.mock.lastCall?.[1]?.body))).toEqual(custom);
});
