import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { defineExtensionTool, SessionOrchestrator, type DetentCapabilityPack, type TurnProfileResolver } from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { createDeliveryTurnProfileResolver, createJumpServerTools, loadDeliveryConfig, type AgentProfileName } from '../src/index.js';
import { deliveryFixture, issue, opened } from './delivery-fixture.js';

function workflowTree(files: Record<string, string>) {
  return {
    listRepositoryTree: vi.fn(async () => Object.keys(files).map(name => ({ id: name, name, path: 'workflows/' + name, type: 'blob' as const }))),
    getRepositoryFile: vi.fn(async (_project: number, path: string) => files[path.slice('workflows/'.length)] ?? null),
  };
}

async function resolve(labels: string[], env = {}, capabilities?: DetentCapabilityPack[], files: Record<string, string> = {}) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, issue.iid, issue.title);
  const gitlab = {
    ...workflowTree(files),
    getIssue: vi.fn(async () => ({ ...issue, labels })),
    hasApprovalPermission: vi.fn(async (_project: number, level: number, minimum = 30) => level >= minimum),
  } satisfies Parameters<TurnProfileResolver>[0]['gitlab'];
  const resolveProfile = createDeliveryTurnProfileResolver(loadDeliveryConfig(env), { hubDefaultBranch: 'stable', capabilities });
  const currentProfile = () => resolveProfile({ session, repo, gitlab });
  const profile = await currentProfile();
  expect(gitlab.getIssue).toHaveBeenCalledWith(1, issue.iid);
  return { profile, gitlab, currentProfile };
}

const routes: [string[], AgentProfileName][] = [
  [[], 'EnvChangeAgent'], [['unknown'], 'EnvChangeAgent'], [['Delivery::Env-Change'], 'EnvChangeAgent'],
  [[' Delivery::Audit '], 'ReadonlyAuditAgent'], [['delivery::code'], 'CodeDeliveryAgent'],
  [['delivery::code', 'delivery::env-change'], 'EnvChangeAgent'],
  [['delivery::env-change', 'delivery::code', 'delivery::audit'], 'ReadonlyAuditAgent'],
];
it.each(routes)('routes %j to %s with a restricted tool set', async (labels, name) => {
  const { profile } = await resolve(labels);
  const inspect = ['jms_list_assets', 'jms_readonly_inspect'];
  const tools: Record<AgentProfileName, string[]> = { EnvChangeAgent: [...inspect, 'jms_run_ansible_job', 'jms_get_job_result'], ReadonlyAuditAgent: inspect, CodeDeliveryAgent: [] };
  expect(profile).toMatchObject({
    name, readonly: name === 'ReadonlyAuditAgent', disableBash: name !== 'CodeDeliveryAgent',
    enabledExtensionTools: tools[name],
  });
  if (name !== 'EnvChangeAgent') expect(await profile.canApprove!({
    projectId: 1, userId: 30, username: 'dev', approvalType: 'TOOL_USE', toolName: 'jms_run_ansible_job',
  })).toBe(false);
});

it('requires a listed project member or the configured production level, keeping normal Plan permissions', async () => {
  const approve = { projectId: 1, userId: 30, username: 'SrE', approvalType: 'TOOL_USE' as const, toolName: 'jms_run_ansible_job' };
  const { profile, gitlab } = await resolve([], { DELIVERY_PROD_APPROVERS: ' oncall, SRE , ' });
  expect(await profile.canApprove!({ ...approve, username: 'other', userId: 40 })).toBe(false);
  expect(gitlab.hasApprovalPermission).not.toHaveBeenCalled();
  expect(await profile.canApprove!({ ...approve, userId: 20 })).toBe(false);
  expect(await profile.canApprove!(approve)).toBe(true);
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(1, 30);

  const { profile: fallback } = await resolve([]);
  expect(await fallback.canApprove!(approve)).toBe(false);
  expect(await fallback.canApprove!({ ...approve, userId: 40 })).toBe(true);
  expect(await fallback.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  const { profile: stricter } = await resolve([], { DELIVERY_PROD_MIN_ACCESS_LEVEL: '50' });
  expect(await stricter.canApprove!({ ...approve, userId: 40 })).toBe(false);
  for (const value of ['0', '-10', '1.5', 'bad']) expect(() => loadDeliveryConfig({ DELIVERY_PROD_MIN_ACCESS_LEVEL: value })).toThrow();
});

it('completes inspections without Plan approval and enforces readonly on a default-mode resume', async () => {
  const { repo, gitlab, notes, config, deliveryConfig, client } = await deliveryFixture(['delivery::audit']);
  const run = vi.fn(async ({ gate, tools, sandbox }: TurnInput) => {
    await gate.invokeExtension('mcp__detent__jms_readonly_inspect', { asset_ids: ['web01'], command: 'uptime' });
    for (const name of ['Write', 'Edit', 'Bash', 'mcp__detent__detent_create_mr', 'mcp__detent__jms_run_ansible_job'])
      expect(await gate.preflight(name, { file_path: sandbox.workspaceRoot + '/file', command: 'git status' })).toMatchObject({ behavior: 'deny' });
    await expect(tools.invoke('detent_create_mr', {})).rejects.toThrow('read-only');
    return 'Diagnostic report';
  });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, {
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig), tools: createJumpServerTools({ client, config: deliveryConfig }),
  });
  await orchestrator.handleIssueOpened(opened);
  const s = (await repo.getSessionByIssue(1, issue.iid))!;
  expect(s.status).toBe('IDLE');
  await orchestrator.resumeSession(s.id, 'inspect again', { permissionMode: 'default' });
  expect(await repo.getSession(s.id)).toMatchObject({ status: 'IDLE', permissionMode: 'default' });
  expect(await repo.getLatestApproval(s.id)).toBeNull();
  expect(client.runReadonlyInspect).toHaveBeenCalledTimes(2);
  expect(client.runAnsibleJob).not.toHaveBeenCalled();
  expect(notes.at(-1)).toContain('Diagnostic report');
});

function template(name: string) {
  return readFileSync(new URL('../../../examples/hub-workspace/workflows/' + name + '.md', import.meta.url), 'utf8');
}
const workflows = {
  'release.md': template('release'), 'audit.md': template('audit'), 'env-change.md': template('env-change'),
  'code-delivery.md': template('code-delivery'),
};
function tool(name: string, policy: 'readonly' | 'always_approve') {
  return defineExtensionTool({ name, policy, description: name, schema: {}, execute: vi.fn() });
}
const release = { name: 'gitlab-release', enabled: true,
  tools: [tool('detent_list_tags', 'readonly'), tool('detent_create_release', 'always_approve')] };
const jumpserver = { name: 'jumpserver', enabled: true,
  tools: [tool('jms_readonly_inspect', 'readonly'), tool('jms_run_ansible_job', 'always_approve')] };
const disabled = { ...jumpserver, enabled: false, setupHint: '请配置 JUMPSERVER_BASE_URL' };
const approve = { projectId: 1, userId: 30, username: 'dev', approvalType: 'TOOL_USE' as const, toolName: 'Bash' };

it('reads a custom SOP from the configured branch on every resolution and applies its production tier', async () => {
  const files = { 'hotfix.md': '---\nlabel: delivery::hotfix\nrequires: [gitlab-release]\napprover_tier: prod\n---\nUse hf-* tags.' };
  const { profile, currentProfile, gitlab } = await resolve(['delivery::hotfix'], {}, [release], files);
  expect(gitlab.listRepositoryTree).toHaveBeenCalledWith(1, 'workflows', 'stable');
  expect(gitlab.getRepositoryFile).toHaveBeenCalledWith(1, 'workflows/hotfix.md', 'stable');
  expect(profile).toMatchObject({ name: 'hotfix', readonly: false, disableBash: true,
    enabledExtensionTools: ['detent_list_tags', 'detent_create_release'], extraSystemPrompt: '当前工作流：workflows/hotfix.md\n\nUse hf-* tags.' });
  expect(await profile.canApprove!(approve)).toBe(false);
  expect(await profile.canApprove!({ ...approve, userId: 40 })).toBe(true);
  expect(await profile.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  files['hotfix.md'] += '\nVerify the release branch.';
  expect((await currentProfile()).extraSystemPrompt).toContain('Verify the release branch.');
});

it('lists available Hub routes and gives setup instructions and ready alternatives for a missing pack', async () => {
  const { profile } = await resolve(['delivery::env-change'], {}, [release, disabled], workflows);
  expect(profile).toMatchObject({ readonly: true, disableBash: true, enabledExtensionTools: [] });
  for (const text of ['jumpserver', disabled.setupHint, 'workflows/env-change.md', 'delivery::release', 'delivery::code'])
    expect(profile.blockedMessage).toContain(text);
  expect(await profile.canApprove!({ ...approve, userId: 50, toolName: 'jms_run_ansible_job' })).toBe(false);
  const { profile: menu } = await resolve([], {}, [release, disabled], workflows);
  for (const file of Object.keys(workflows)) expect(menu.blockedMessage).toContain('workflows/' + file);
});

it('fits workflow display names into the execution audit column and retains the full SOP path', async () => {
  const file = 'environment-change-'.repeat(4) + '.md';
  const { profile } = await resolve(['delivery::env-change'], {}, [jumpserver], { [file]: workflows['env-change.md'] });
  expect(profile.name).toBe(file.slice(0, 64));
  expect(profile.extraSystemPrompt).toContain('workflows/' + file);
});

it.each([
  ['delivery::release', 'detent_create_release'], ['delivery::env-change', 'jms_run_ansible_job'],
])('enforces the production gate and rechecks pending cards after a label switch for %s', async (label, toolName) => {
  const labels = [label];
  const files = Object.fromEntries(Object.entries(workflows).map(([name, content]) => [name, content.replace('approver_tier: prod', 'approver_tier: standard')]));
  const capabilities = [jumpserver, release];
  const { profile } = await resolve(labels, { DELIVERY_PROD_APPROVERS: 'SRE' }, capabilities, files);
  expect(await profile.canApprove!({ ...approve, toolName, userId: 50 })).toBe(false);
  expect(await profile.canApprove!({ ...approve, toolName, username: 'Sre', userId: 20 })).toBe(false);
  expect(await profile.canApprove!({ ...approve, toolName, username: 'Sre' })).toBe(true);
  const { profile: byLevel } = await resolve(labels, { DELIVERY_PROD_MIN_ACCESS_LEVEL: '50' }, capabilities, files);
  expect(await byLevel.canApprove!({ ...approve, toolName, userId: 40 })).toBe(false);
  expect(await byLevel.canApprove!({ ...approve, toolName, userId: 50 })).toBe(true);

  const { config, repo, gitlab, deliveryConfig } = await deliveryFixture(labels);
  const session = await repo.getOrCreateSession(1, issue.iid, issue.title);
  const pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', toolName, {});
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, ...workflowTree(files) }, { run: vi.fn() }, {
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, { capabilities }),
  });
  for (const next of ['delivery::code', 'delivery::audit']) {
    labels[0] = next;
    await orchestrator.handleUserIntent(1, issue.iid, { type: 'APPROVE', userId: 8, username: 'sre' });
    expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'PENDING' });
  }
});

it('routes legacy Hubs without JumpServer using only available tools', async () => {
  const capabilities = [release, disabled];
  for (const labels of [[], ['delivery::code']]) {
    const { profile } = await resolve(labels, {}, capabilities);
    expect(profile).toMatchObject({ name: 'CodeDeliveryAgent', enabledExtensionTools: [] });
    expect(profile.extraSystemPrompt).not.toMatch(/jumpserver|ansible/i);
  }
  const { profile: audit } = await resolve(['delivery::audit'], {}, capabilities);
  expect(audit).toMatchObject({ readonly: true, enabledExtensionTools: [] });
  const { profile: env } = await resolve(['delivery::env-change'], {}, capabilities);
  expect(env.blockedMessage).toContain(disabled.setupHint);
  const { profile: rel } = await resolve(['delivery::release'], {}, capabilities);
  expect(rel.enabledExtensionTools).toEqual(['detent_list_tags', 'detent_create_release']);
  expect(await rel.canApprove!(approve)).toBe(false);
  const { profile: unavailable } = await resolve(['delivery::release'], {}, [disabled]);
  expect(unavailable.blockedMessage).toContain('gitlab-release');
});

it.each(['standard', 'prod'])('uses the %s approval tier for a readonly close request', async tier => {
  const files = { 'audit.md': workflows['audit.md'].replace('close_policy: auto', 'close_policy: approve')
    .replace('approver_tier: standard', 'approver_tier: ' + tier) };
  const { profile } = await resolve(['delivery::audit'], {}, [jumpserver], files);
  expect(profile).toMatchObject({ readonly: true, closePolicy: 'approve' });
  const request = { ...approve, toolName: 'detent_close_issue' };
  expect(await profile.canApprove!({ ...request, userId: 20 })).toBe(false);
  expect(await profile.canApprove!(request)).toBe(tier === 'standard');
  expect(await profile.canApprove!({ ...request, userId: 40 })).toBe(true);
});
