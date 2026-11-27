import { expect, it, vi } from 'vitest';
import { createGitLabOnboardingCapability, createGitLabOnboardingTools, GitLabClient, loadConfig } from '../src/index.js';
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
    if (path === '/groups/apps') return Response.json({ id: 5 });
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
    return Response.json(projects.find(p => p.id === id));
  });
  const gitlab = new GitLabClient(loadConfig({}), http);
  const options = { gitlab, publicUrl, webhookSecret };
  const [check, onboard] = createGitLabOnboardingTools(options);
  return { ctx, projects, hooks, access, gitlab, check, onboard, options };
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
