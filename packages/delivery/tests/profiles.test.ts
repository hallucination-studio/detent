import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  defineExtensionTool, SessionOrchestrator, type DetentCapabilityPack, type TurnProfileResolver,
} from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { dispatchWebhook } from '../../core/src/gitlab/webhook.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { createDeliveryTurnProfileResolver, createJumpServerTools, loadDeliveryConfig } from '../src/index.js';
import { deliveryFixture, developer, hub, issue, opened } from './delivery-fixture.js';

type ProfileContext = Parameters<TurnProfileResolver>[0];

function hubTree(files: Record<string, string>) {
  return {
    listRepositoryTree: vi.fn(async (_project: number, dir: string, _ref: string, recursive = false) => Object.keys(files)
      .filter(path => path.startsWith(dir + '/') && (recursive || !path.slice(dir.length + 1).includes('/')))
      .map(path => ({ id: path, name: path.split('/').at(-1)!, path, type: 'blob' as const }))),
    getRepositoryFile: vi.fn(async (_project: number, path: string) => files[path] ?? null),
  };
}

async function resolve(labels: string[], env = {}, capabilities?: DetentCapabilityPack[], files: Record<string, string> = {}) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, issue.iid, issue.title);
  const gitlab = {
    ...hubTree(files),
    getIssue: vi.fn(async () => ({ ...issue, labels })),
    hasApprovalPermission: vi.fn(async (_project: number, level: number, minimum = 30) => level >= minimum),
  } satisfies ProfileContext['gitlab'];
  const resolveProfile = createDeliveryTurnProfileResolver(loadDeliveryConfig(env), { hubDefaultBranch: 'stable', capabilities });
  const currentProfile = (context: Partial<ProfileContext> = {}) => resolveProfile({ session, repo, gitlab, ...context });
  const profile = await currentProfile();
  expect(gitlab.getIssue).toHaveBeenCalledWith(1, issue.iid);
  return { profile, gitlab, currentProfile };
}

it('requires a listed project member or the configured production level, keeping normal Plan permissions', async () => {
  const approve = { projectId: 1, userId: 30, username: 'SrE', approvalType: 'TOOL_USE' as const, toolName: 'jms_run_ansible_job' };
  const { profile, gitlab } = await resolve([], { DELIVERY_PROD_APPROVERS: ' oncall, SRE , ' }, [jumpserver]);
  expect(await profile.canApprove!({ ...approve, username: 'other', userId: 40 })).toBe(false);
  expect(gitlab.hasApprovalPermission).not.toHaveBeenCalled();
  expect(await profile.canApprove!({ ...approve, userId: 20 })).toBe(false);
  expect(await profile.canApprove!(approve)).toBe(true);
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(1, 30);

  const { profile: fallback } = await resolve([], {}, [jumpserver]);
  expect(await fallback.canApprove!(approve)).toBe(false);
  expect(await fallback.canApprove!({ ...approve, userId: 40 })).toBe(true);
  expect(await fallback.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  const { profile: stricter } = await resolve([], { DELIVERY_PROD_MIN_ACCESS_LEVEL: '50' }, [jumpserver]);
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
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig),
    capabilities: [{ name: 'jumpserver', enabled: true, tools: createJumpServerTools({ client, config: deliveryConfig }) }],
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

const agentTemplates = Object.fromEntries(['release', 'audit', 'env-change', 'code-delivery', 'image-sync', 'onboarding'].map(name => {
  const file = 'agents/' + name + '/AGENT.md';
  return [file, readFileSync(new URL('../../../examples/hub-workspace/' + file, import.meta.url), 'utf8')];
}));
function tool(name: string, policy: 'readonly' | 'always_approve') {
  return defineExtensionTool({ name, policy, description: name, schema: {}, execute: vi.fn() });
}
const release = { name: 'gitlab-release', enabled: true,
  tools: [tool('detent_list_tags', 'readonly'), tool('detent_create_release', 'always_approve')] };
const jumpserver = { name: 'jumpserver', enabled: true,
  tools: [tool('jms_readonly_inspect', 'readonly'), tool('jms_run_ansible_job', 'always_approve')] };
const disabled = { ...jumpserver, enabled: false, setupHint: '请配置 JUMPSERVER_BASE_URL' };
const approve = { projectId: 1, userId: 30, username: 'dev', approvalType: 'TOOL_USE' as const, toolName: 'Bash' };

it('prioritizes explicit packs and requires tool selection when a caller supplies the profile', async () => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'Sync image');
  const gitlab = { getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true) };
  const explicit = { name: ' Harbor-Sync ', enabled: true, approverTier: 'prod', tools: [tool('harbor-sync__mirror', 'always_approve')] } as const;
  const other = { name: 'image-catalog', enabled: true, tools: [] };
  const resolveTurnProfile = vi.fn<TurnProfileResolver>(() => ({ readonly: false }));
  const resolve = createDeliveryTurnProfileResolver(loadDeliveryConfig({}), { capabilities: [explicit], resolveTurnProfile });
  const context = { session, repo, gitlab, capabilities: [{ name: 'harbor-sync', enabled: false, tools: [] }, other] };
  const approval = { ...approve, userId: 40, toolName: 'harbor-sync__mirror' };
  expect(await (await resolve(context)).canApprove!(approval)).toBe(false);
  expect(gitlab.hasApprovalPermission).not.toHaveBeenCalled();
  expect(resolveTurnProfile).toHaveBeenCalledWith(expect.objectContaining({ capabilities: [explicit, other] }));
  resolveTurnProfile.mockReturnValue({ enabledExtensionTools: [approval.toolName] });
  expect(await (await resolve(context)).canApprove!(approval)).toBe(true);
  expect(gitlab.hasApprovalPermission).toHaveBeenCalledExactlyOnceWith(1, 40, 40);
});

it('mounts a ready production pack without an SOP and denies its outstanding card after removal', async () => {
  const name = 'publish_artifact';
  const pack: DetentCapabilityPack = { name: 'artifacts', enabled: true, approverTier: 'prod', tools: [tool(name, 'always_approve')] };
  const { profile, currentProfile } = await resolve([], {}, [pack], {});
  expect(profile.enabledExtensionTools).toEqual([name]);
  const request = { ...approve, toolName: name };
  expect(await profile.canApprove!(request)).toBe(false);
  expect(await profile.canApprove!({ ...request, userId: 40 })).toBe(true);
  pack.enabled = false;
  const revoked = await currentProfile({ purpose: 'approval', approval: request });
  expect(revoked.blockedMessage).toBeTruthy();
  expect(await (await currentProfile()).canApprove!({ ...request, userId: 40 })).toBe(false);
});

it('reads a custom SOP from the configured branch on every resolution and applies its production tier', async () => {
  const file = 'agents/hotfix/AGENT.md';
  const files = { [file]: '---\nlabel: delivery::hotfix\nrequires: [gitlab-release]\napprover_tier: prod\n---\nUse hf-* tags.' };
  const { profile, currentProfile, gitlab } = await resolve(['delivery::hotfix'], {}, [release], files);
  expect(gitlab.listRepositoryTree).toHaveBeenCalledWith(1, 'agents', 'stable', true);
  expect(gitlab.getRepositoryFile).toHaveBeenCalledWith(1, 'agents/hotfix/AGENT.md', 'stable');
  expect(profile).toMatchObject({ name: 'hotfix', readonly: false, disableBash: true,
    enabledExtensionTools: ['detent_list_tags', 'detent_create_release'], extraSystemPrompt: '当前 Agent：agents/hotfix/AGENT.md\n\nUse hf-* tags.' });
  expect(profile.sandboxScope?.agentDir).toBe('hotfix');
  expect(await profile.canApprove!({ ...approve, toolName: 'detent_create_release' })).toBe(false);
  expect(await profile.canApprove!({ ...approve, toolName: 'detent_create_release', userId: 40 })).toBe(true);
  expect(await profile.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  files[file] += '\nVerify the release branch.';
  expect((await currentProfile()).extraSystemPrompt).toContain('Verify the release branch.');
});

it('resolves an Agent with local and shared Skills and enforces its production approval tier', async () => {
  const files: Record<string, string> = {
    'agents/Review/AGENT.md': '---\nrequires: [verification]\napprover_tier: prod\nclose_policy: approve\nshared_skills: [COMMON]\n---\nReview the changes.',
    'agents/Review/skills/ReviewDiff/SKILL.md': '---\nname: Review Diff\ndescription: Inspect the proposed changes.\n---\nFull local instructions.',
    'skills/Common/SKILL.md': '---\nname: Common Checks\ndescription: Apply the shared checks.\n---\nFull shared instructions.',
  };
  const gitlab = {
    ...hubTree(files),
    getIssue: vi.fn(async () => ({ ...issue, labels: [' AGENT::REVIEW '] })),
    hasApprovalPermission: vi.fn(async (_project: number, level: number, minimum = 30) => level >= minimum),
  } satisfies ProfileContext['gitlab'];
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, issue.iid, issue.title);
  const verification = { name: 'verification', enabled: true, tools: [tool('confirm_review', 'always_approve')] };
  const resolveProfile = createDeliveryTurnProfileResolver(loadDeliveryConfig({ DELIVERY_PROD_MIN_ACCESS_LEVEL: '45' }), {
    hubDefaultBranch: 'stable', capabilities: [verification],
  });
  const profile = await resolveProfile({ session, repo, gitlab });
  expect(profile).toMatchObject({
    name: 'review', readonly: false, disableBash: true, closePolicy: 'approve', enabledExtensionTools: ['confirm_review'],
    sandboxScope: { agentDir: 'Review', sharedSkills: ['common'] },
  });
  expect(profile.extraSystemPrompt).toBe([
    '当前 Agent：agents/Review/AGENT.md', '', 'Review the changes.', '', '## 可用 Skills（命中子任务时请用 Read 读取完整规范）',
    '- Review Diff（agents/Review/skills/ReviewDiff/SKILL.md）：Inspect the proposed changes.',
    '- Common Checks（skills/Common/SKILL.md）：Apply the shared checks.',
  ].join('\n'));
  expect(gitlab.listRepositoryTree.mock.calls).toEqual([[1, 'agents', 'stable', true], [1, 'skills', 'stable', true]]);
  gitlab.getIssue.mockResolvedValueOnce({ ...issue, labels: [] });
  const unified = await resolveProfile({ session, repo, gitlab });
  expect(unified).toMatchObject({ name: 'unified', closePolicy: 'manual', disableBash: false, enabledExtensionTools: ['confirm_review'] });
  expect(unified.extraSystemPrompt).toContain('review（agents/Review/AGENT.md）');
  const approval = { ...approve, toolName: 'confirm_review' };
  expect(await profile.canApprove!(approval)).toBe(false);
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(1, 30, 45);
  expect(await profile.canApprove!({ ...approval, userId: 45 })).toBe(true);
  expect(await profile.canApprove!({ ...approval, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(1, 30);
});

it('lists available Hub routes and gives setup instructions and ready alternatives for a missing pack', async () => {
  const { profile } = await resolve(['delivery::env-change'], {}, [release, disabled], agentTemplates);
  expect(profile).toMatchObject({ readonly: true, disableBash: true, enabledExtensionTools: [] });
  for (const text of ['jumpserver', disabled.setupHint, '### ⚪ 当前能力尚未开通', 'delivery::release', 'delivery::code', 'agent::image-sync'])
    expect(profile.blockedMessage).toContain(text);
  expect(await profile.canApprove!({ ...approve, userId: 50, toolName: 'jms_run_ansible_job' })).toBe(false);
  const { profile: unified, currentProfile } = await resolve([], {}, [release, disabled], agentTemplates);
  expect(unified).toMatchObject({ name: 'unified', readonly: false, disableBash: false, closePolicy: 'manual',
    enabledExtensionTools: ['detent_list_tags', 'detent_create_release'] });
  expect(unified.extraSystemPrompt).toContain('audit（未开通）：jumpserver：' + disabled.setupHint);
  expect(unified.extraSystemPrompt).toContain('code-delivery（agents/code-delivery/AGENT.md）');
  const approval = await currentProfile({ purpose: 'approval', approval: { approvalType: 'TOOL_USE', toolName: 'detent_create_release' } });
  expect(await approval.canApprove!({ ...approve, toolName: 'detent_create_release' })).toBe(false);
  expect(await approval.canApprove!({ ...approve, toolName: 'detent_create_release', userId: 40 })).toBe(true);
});

it('notifies each project member once per denied production approval and stays silent for outsiders', async () => {
  const { notes, repo, config, gitlab, deliveryConfig } = await deliveryFixture(['delivery::release']);
  const run = vi.fn();
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, ...hubTree(agentTemplates) }, { run }, {
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, { capabilities: [release] }),
  });
  const session = await repo.getOrCreateSession(hub.id, issue.iid, issue.title);
  await repo.updateSessionState(session.id, { status: 'WAITING_TOOL' });
  for (let i = 0; i < 2; i++) {
    const pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'detent_create_release', {});
    await dispatchWebhook(orchestrator, userNote('/approve', { id: 100, username: 'outside' }));
    expect(notes).toHaveLength(i);
    await Promise.all([1, 2].map(() => dispatchWebhook(orchestrator, userNote('/approve'))));
    expect(notes).toHaveLength(i + 1);
    expect(notes.at(-1)).toContain('🔒 该操作需要生产审批权限');
    expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'PENDING' });
    await repo.resolveApprovalRequest(pending.id, 'EXPIRED', 'test');
  }
  expect(run).not.toHaveBeenCalled();
});

function userNote(note: string, user = developer) {
  return { object_kind: 'note' as const, project: hub, user, issue, object_attributes: { id: 50, note, noteable_type: 'Issue' } };
}

it('fits workflow display names into the execution audit column and retains the full SOP path', async () => {
  const name = 'environment-change-'.repeat(4);
  const file = 'agents/' + name + '/AGENT.md';
  const files = { [file]: '---\nlabel: delivery::env-change\nrequires: [jumpserver]\n---\nDeploy.' };
  const { profile } = await resolve(['delivery::env-change'], {}, [jumpserver], files);
  expect(profile.name).toBe(name.slice(0, 64));
  expect(profile.extraSystemPrompt).toContain(file);
});

it.each([
  ['agent::onboarding', 'detent_onboard_project'], ['delivery::release', 'detent_create_release'], ['delivery::env-change', 'jms_run_ansible_job'],
])('enforces the production gate and rechecks pending cards after a label switch for %s', async (label, toolName) => {
  const labels = [label];
  const files = Object.fromEntries(Object.entries(agentTemplates).map(([name, content]) => [name, content.replace('approver_tier: prod', 'approver_tier: standard')]));
  const capabilities = [jumpserver, release, { name: 'gitlab-onboarding', enabled: true, tools: [tool('detent_onboard_project', 'always_approve')] }];
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
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, ...hubTree(files) }, { run: vi.fn() }, {
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, { capabilities }),
  });
  for (const next of ['delivery::code', 'delivery::audit']) {
    labels[0] = next;
    await orchestrator.handleUserIntent(1, issue.iid, { type: 'APPROVE', userId: 8, username: 'sre' });
    expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'PENDING' });
  }
});

it.each(['standard', 'prod'])('uses the %s approval tier for a readonly close request', async tier => {
  const file = 'agents/audit/AGENT.md';
  const files = { [file]: agentTemplates[file].replace('close_policy: auto', 'close_policy: approve')
    .replace('approver_tier: standard', 'approver_tier: ' + tier) };
  const { profile } = await resolve(['delivery::audit'], {}, [jumpserver], files);
  expect(profile).toMatchObject({ readonly: true, closePolicy: 'approve' });
  const request = { ...approve, toolName: 'detent_close_issue' };
  expect(await profile.canApprove!({ ...request, userId: 20 })).toBe(false);
  expect(await profile.canApprove!(request)).toBe(tier === 'standard');
  expect(await profile.canApprove!({ ...request, userId: 40 })).toBe(true);
});
