import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  defineExtensionTool, SessionOrchestrator, type DecisionClient, type DetentCapabilityPack, type GitLabClient, type IssueNote, type TurnProfileResolver,
} from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { dispatchWebhook } from '../../core/src/gitlab/webhook.js';
import { WebhookQueue } from '../../core/src/gitlab/webhook-queue.js';
import { git } from '../../core/src/workspace/ephemeral-sandbox.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { createDeliveryTurnProfileResolver, createJumpServerTools, loadDeliveryConfig, type AgentProfileName } from '../src/index.js';
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

function routingAnswers(choice: string, noul = 0.95) {
  return {
    agent: { type: 'choice' as const, choice },
    clear_match: { type: 'noul' as const, noul },
    ambiguity: { type: 'score' as const, score: 0.4 },
  };
}

function routingDecision() {
  return { provider: 'custom', threshold: 0.9, decide: vi.fn<DecisionClient['decide']>() } satisfies DecisionClient;
}

it('reads a custom SOP from the configured branch on every resolution and applies its production tier', async () => {
  const file = 'workflows/hotfix.md';
  const files = { [file]: '---\nlabel: delivery::hotfix\nrequires: [gitlab-release]\napprover_tier: prod\n---\nUse hf-* tags.' };
  const { profile, currentProfile, gitlab } = await resolve(['delivery::hotfix'], {}, [release], files);
  expect(gitlab.listRepositoryTree).toHaveBeenCalledWith(1, 'workflows', 'stable');
  expect(gitlab.getRepositoryFile).toHaveBeenCalledWith(1, 'workflows/hotfix.md', 'stable');
  expect(profile).toMatchObject({ name: 'hotfix', readonly: false, disableBash: true,
    enabledExtensionTools: ['detent_list_tags', 'detent_create_release'], extraSystemPrompt: '当前工作流：workflows/hotfix.md\n\nUse hf-* tags.' });
  expect(profile.sandboxScope).toBeUndefined();
  expect(await profile.canApprove!(approve)).toBe(false);
  expect(await profile.canApprove!({ ...approve, userId: 40 })).toBe(true);
  expect(await profile.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  files[file] += '\nVerify the release branch.';
  expect((await currentProfile()).extraSystemPrompt).toContain('Verify the release branch.');
});

it('resolves an Agent with local and shared Skills and enforces its production approval tier', async () => {
  const files: Record<string, string> = {
    'agents/Review/AGENT.md': '---\nrequires: [verification]\napprover_tier: prod\nclose_policy: approve\nshared_skills: [COMMON]\n---\nReview the changes.',
    'agents/Review/skills/ReviewDiff/SKILL.md': '---\nname: Review Diff\ndescription: Inspect the proposed changes.\n---\nFull local instructions.',
    'skills/Common/SKILL.md': '---\nname: Common Checks\ndescription: Apply the shared checks.\n---\nFull shared instructions.',
    'workflows/review.md': '---\nlabel: agent::review\n---\nLegacy review procedure.',
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
  expect(gitlab.listRepositoryTree.mock.calls).toEqual([[1, 'agents', 'stable', true], [1, 'skills', 'stable', true], [1, 'workflows', 'stable']]);
  expect(gitlab.getRepositoryFile).not.toHaveBeenCalledWith(1, 'workflows/review.md', 'stable');
  gitlab.getIssue.mockResolvedValueOnce({ ...issue, labels: [] });
  const coordinator = await resolveProfile({ session, repo, gitlab });
  const review = coordinator.subagents?.find(agent => agent.id === 'review');
  expect(review).toMatchObject({ closePolicy: 'approve', approverTier: 'prod', disableBash: true, enabledExtensionTools: ['confirm_review'] });
  expect(review?.prompt).toContain('Review the changes.');
  expect(review?.prompt).toContain('Full local instructions.');
  expect(review?.prompt).toContain('Full shared instructions.');
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
  const { profile: coordinator, currentProfile, gitlab } = await resolve([], {}, [release, disabled], agentTemplates);
  expect(coordinator).toMatchObject({ name: 'coordinator', coordinator: true, readonly: false, disableBash: false,
    enabledExtensionTools: ['detent_list_tags', 'detent_create_release'] });
  expect(coordinator.subagents?.map(agent => agent.id)).toEqual(['code-delivery', 'image-sync', 'release']);
  expect(coordinator.extraSystemPrompt).toContain(disabled.setupHint);
  expect(coordinator.blockedMessage).toBeUndefined();
  const decision = routingDecision();
  const listIssueNotes = vi.fn();
  const updateIssueLabels = vi.fn();
  const approval = await currentProfile({ purpose: 'approval', decision, gitlab: { ...gitlab, listIssueNotes, updateIssueLabels } });
  expect(approval).toMatchObject({ name: 'unmatched', readonly: true });
  expect(approval.extraSystemPrompt).toBeUndefined();
  for (const file of Object.keys(agentTemplates)) {
    expect(coordinator.extraSystemPrompt).not.toContain(file);
    expect(approval.blockedMessage).toContain(file);
  }
  expect(await approval.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan', userId: 50 })).toBe(false);
  expect(gitlab.hasApprovalPermission).not.toHaveBeenCalled();
  expect(listIssueNotes).not.toHaveBeenCalled();
  expect(decision.decide).not.toHaveBeenCalled();
  expect(updateIssueLabels).not.toHaveBeenCalled();
});

it('falls back to readonly triage when every registered agent lacks a capability', async () => {
  const file = 'agents/audit/AGENT.md';
  const { profile } = await resolve([], {}, [disabled], { [file]: agentTemplates[file] });
  expect(profile).toMatchObject({ name: 'triage', readonly: true, disableBash: true, enabledExtensionTools: [] });
  expect(profile.subagents).toBeUndefined();
});

it('rechecks an unlabeled tool card against its issuing agent and production membership', async () => {
  const { currentProfile } = await resolve([], {}, [release, jumpserver], agentTemplates);
  const approval = { approvalType: 'TOOL_USE' as const, toolName: 'detent_create_release' };
  const context = { purpose: 'approval' as const, approval };
  const issuing = await currentProfile({ ...context, coordinatorAgents: ['release'] });
  expect(await issuing.canApprove!({ ...approve, ...approval })).toBe(false);
  expect(await issuing.canApprove!({ ...approve, ...approval, userId: 40 })).toBe(true);
  const audit = await currentProfile({ ...context, coordinatorAgents: ['audit'] });
  expect(audit.blockedMessage).toBeTruthy();
});

it('keeps explicit labels, readonly precedence and label conflicts deterministic with Jev enabled', async () => {
  const labels = [' Delivery::Release '];
  const { currentProfile, gitlab } = await resolve(labels, {}, [release, jumpserver], agentTemplates);
  const decision = routingDecision();
  const listIssueNotes = vi.fn();
  const updateIssueLabels = vi.fn();
  const context = { decision, gitlab: { ...gitlab, listIssueNotes, updateIssueLabels } };
  expect(await currentProfile(context)).toMatchObject({ name: 'release', readonly: false });
  labels.push('delivery::env-change');
  expect(await currentProfile(context)).toMatchObject({ blockedMessage: expect.stringContaining('冲突') });
  labels.push('delivery::audit');
  expect(await currentProfile(context)).toMatchObject({ name: 'audit', readonly: true });
  expect(decision.decide).not.toHaveBeenCalled();
  expect(listIssueNotes).not.toHaveBeenCalled();
  expect(updateIssueLabels).not.toHaveBeenCalled();
});

it('offers all ready workflows to unlabeled turns and preserves default selection for existing approvals', async () => {
  const file = 'workflows/fallback.md';
  const files = { [file]: '---\nlabel: fallback\ndefault: true\n---\nDefault procedure.' };
  const { profile, currentProfile, gitlab } = await resolve([], {}, [], files);
  expect(profile).toMatchObject({ name: 'coordinator', subagents: [{ id: 'fallback' }] });
  const decision = routingDecision();
  decision.decide.mockRejectedValue(Error('Jev unavailable'));
  const updateIssueLabels = vi.fn();
  const context = { decision, gitlab: { ...gitlab, updateIssueLabels } };
  const approval = await currentProfile({ ...context, purpose: 'approval' });
  expect(approval.name).toBe('fallback');
  expect(await approval.canApprove!({ ...approve, approvalType: 'PLAN', toolName: 'Plan' })).toBe(true);
  expect(decision.decide).not.toHaveBeenCalled();
  expect(await currentProfile(context)).toMatchObject({ name: 'coordinator', subagents: [{ id: 'fallback' }] });
  expect(decision.decide).toHaveBeenCalledTimes(1);
  const conflict = await resolve([], {}, [], { ...files, 'workflows/other.md': files[file].replace('label: fallback', 'label: other') });
  expect(conflict.profile.subagents?.map(agent => agent.id)).toEqual(['fallback', 'other']);
  expect((await conflict.currentProfile({ purpose: 'approval' })).blockedMessage).toContain('默认工作流');
  expect(updateIssueLabels).not.toHaveBeenCalled();
});

it('returns capability setup guidance and alternatives without labeling a high-confidence unavailable Agent', async () => {
  const { currentProfile, gitlab } = await resolve([], {}, [release, disabled], agentTemplates);
  const decision = routingDecision();
  decision.decide.mockResolvedValue(routingAnswers('env-change'));
  const updateIssueLabels = vi.fn();
  const listIssueNotes = vi.fn().mockRejectedValue(Error('notes unavailable'));
  const profile = await currentProfile({ decision, prompt: 'Deploy to web01', gitlab: { ...gitlab, updateIssueLabels, listIssueNotes } });
  expect(profile).toMatchObject({ name: 'agents/env-change/AGENT.md', readonly: true, enabledExtensionTools: [] });
  for (const text of ['jumpserver', disabled.setupHint, 'delivery::release']) expect(profile.blockedMessage).toContain(text);
  expect(decision.decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recent_user_messages: ['Deploy to web01'] }), expect.any(Object));
  expect(updateIssueLabels).not.toHaveBeenCalled();
  expect(profile.routingNotice).toBeUndefined();
});

it.each([0.95, 0.55])('posts unavailable capability guidance without a Claude turn at routing confidence %s', async confidence => {
  const { gitlab, repo, notes, config, deliveryConfig } = await deliveryFixture([]);
  const decision = routingDecision();
  decision.decide.mockResolvedValue(routingAnswers('env-change', confidence));
  const run = vi.fn();
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, ...hubTree(agentTemplates) }, { run }, {
    decisionClient: decision, resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, { capabilities: [release, disabled] }),
  });
  await orchestrator.handleIssueOpened(opened);
  expect(await repo.getSessionByIssue(hub.id, issue.iid)).toMatchObject({ status: 'IDLE' });
  expect(notes).toEqual([expect.stringContaining('### ⚪ 当前能力尚未开通')]);
  expect(run).not.toHaveBeenCalled();
});

it('offers coordination when a ready candidate outranks the unavailable suggestion', async () => {
  const { currentProfile } = await resolve([], {}, [release, disabled], agentTemplates);
  const decision = routingDecision();
  const answers = routingAnswers('env-change', 0.55);
  decision.decide.mockResolvedValue({ ...answers, agent: { ...answers.agent, probabilities: { 'env-change': 0.3, release: 0.6 } } });
  expect(await currentProfile({ decision })).toMatchObject({ name: 'coordinator' });
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

const imageSyncFile = 'agents/image-sync/AGENT.md';
const agentFiles = {
  [imageSyncFile]: '---\ndescription: Mirror container images\nrouting_hint: Sync an exact image tag to a registry\n---\nPlan the image sync.',
  'agents/release/AGENT.md': '---\ndescription: Publish a release\n---\nPlan the release.',
  'agents/audit/AGENT.md': '---\ndescription: Inspect project state\nmode: readonly\n---\nAudit the project.',
};

async function routingFixture(labels: string[], files: Record<string, string> = agentFiles) {
  const fixture = await deliveryFixture(labels);
  const seed = path.join(fixture.root, 'seed');
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(seed, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(['add', 'agents'], seed, fixture.root);
  await git(['commit', '-m', 'Register Hub Agents'], seed, fixture.root);
  await git(['push', path.join(fixture.root, '1.git'), 'main'], seed, fixture.root);
  const gitlab = {
    ...fixture.gitlab, ...hubTree(files),
    updateIssueLabels: vi.fn<GitLabClient['updateIssueLabels']>(async (_project, _iid, { add = [], remove = [] }) => {
      const kept = labels.filter(label => !remove.includes(label));
      labels.splice(0, labels.length, ...new Set([...kept, ...add]));
    }),
  };
  return { ...fixture, gitlab };
}

function userNote(note: string, user = developer) {
  return { object_kind: 'note' as const, project: hub, user, issue, object_attributes: { id: 50, note, noteable_type: 'Issue' } };
}

it('clarifies a vague Issue, routes the follow-up into a scoped Agent plan and fails closed if its label is removed', async () => {
  const labels = ['team::infra', 'claude::idle'];
  const { repo, gitlab, notes, config, deliveryConfig } = await routingFixture(labels);
  const request = { ...issue, title: '镜像', description: '请处理一下。' };
  gitlab.getIssue.mockResolvedValue({ ...request, labels });
  const issueNotes: IssueNote[] = [];
  const listIssueNotes = vi.fn(async () => issueNotes);
  const isBotUser = (id?: number, username?: string) => id === 99 || username === 'detent-bot';
  const decision = routingDecision();
  decision.decide.mockResolvedValueOnce(routingAnswers('image-sync', 0.56)).mockResolvedValueOnce(routingAnswers('image-sync'));
  const run = vi.fn<(turn: TurnInput) => Promise<string>>()
    .mockImplementationOnce(async ({ gate, sandbox, session, systemPrompt, subagents }) => {
      expect(session.permissionMode).toBe('plan');
      expect(gate).toMatchObject({ readonly: false, disableBash: false, extensionTools: new Map() });
      expect(subagents?.map(agent => agent.id)).toEqual(['audit', 'image-sync', 'release']);
      expect((await readdir(sandbox.workspaceRoot)).sort()).toEqual(['CLAUDE.md', 'projects']);
      expect(await gate.preflight('Task', { subagent_type: 'audit' })).toMatchObject({ behavior: 'allow' });
      expect(systemPrompt).toContain('image-sync — Mirror container images');
      return '请提供源镜像的 Tag 和目标镜像仓库。';
    })
    .mockImplementationOnce(async ({ gate, sandbox, session, systemPrompt }) => {
      expect(session.permissionMode).toBe('plan');
      expect(gate.readonly).toBe(false);
      expect(await readdir(path.join(sandbox.workspaceRoot, 'agents'))).toEqual(['image-sync']);
      expect(await readFile(path.join(sandbox.workspaceRoot, imageSyncFile), 'utf8')).toBe(agentFiles[imageSyncFile]);
      expect(systemPrompt).toContain('Plan the image sync.');
      expect(gitlab.updateIssueLabels).toHaveBeenCalledExactlyOnceWith(hub.id, issue.iid, { add: ['agent::image-sync'] });
      return '镜像同步方案';
    });
  const resolveTurnProfile = vi.fn(createDeliveryTurnProfileResolver(deliveryConfig));
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, listIssueNotes, isBotUser }, { run }, {
    decisionClient: decision, resolveTurnProfile, tools: [tool('audit', 'readonly')],
  });
  await orchestrator.handleIssueOpened({ ...opened, object_attributes: request });
  const session = (await repo.getSessionByIssue(hub.id, issue.iid))!;
  expect(session).toMatchObject({ status: 'IDLE', permissionMode: 'plan' });
  expect(await repo.getLatestPendingApproval(session.id)).toBeNull();
  expect(resolveTurnProfile.mock.calls[0][0]).toMatchObject({ purpose: 'turn', prompt: request.title + '\n' + request.description, decision });
  expect(decision.decide.mock.calls[0][0]).toMatchObject({ recent_user_messages: [] });
  expect(gitlab.updateIssueLabels).not.toHaveBeenCalled();
  expect(notes.at(-1)).toBe('请提供源镜像的 Tag 和目标镜像仓库。');

  const details = '同步 app:v2 到 staging.example。';
  issueNotes.push(
    { id: 1, body: '源镜像在 team/app。', author: developer },
    { id: 2, body: 'changed labels', system: true },
    { id: 3, body: notes.at(-1)!, author: { id: 99, username: 'detent-bot' } },
    { id: 4, body: details, author: developer },
  );
  await dispatchWebhook(orchestrator, userNote(details));
  expect(listIssueNotes).toHaveBeenCalledTimes(2);
  expect(decision.decide.mock.calls[1][0]).toEqual({
    surface: 'hub_agent_routing', issue_title: request.title, issue_description: request.description,
    recent_user_messages: ['源镜像在 team/app。', details], existing_labels: ['team::infra'],
  });
  expect(labels).toEqual(['team::infra', 'claude::idle', 'agent::image-sync']);
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan' });
  const approval = (await repo.getLatestPendingApproval(session.id))!;
  expect(approval).toMatchObject({ approvalType: 'PLAN', status: 'PENDING' });
  expect(notes.at(-1)).toBe('> 🧭 已进入 **Mirror container images** 流程（发 `/help` 可查看或切换其他能力）' +
    '\n\n### 📋 实施方案审批\n\n镜像同步方案\n\n---\n> 👍 或 `/approve` 批准实施 · 直接回复即可调整方案');

  labels.pop();
  await dispatchWebhook(orchestrator, userNote('/approve'));
  expect(resolveTurnProfile.mock.calls.at(-1)?.[0]).toMatchObject({ purpose: 'approval', decision });
  expect(await repo.getApproval(approval.id)).toMatchObject({ status: 'PENDING' });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(decision.decide).toHaveBeenCalledTimes(2);
  expect(listIssueNotes).toHaveBeenCalledTimes(2);
  expect(gitlab.updateIssueLabels).toHaveBeenCalledTimes(1);
  expect(await readdir(config.ephemeralRoot)).toEqual([]);
});

it('resumes the approved coordinator delegation, then requires a fresh plan for a new Jev route', async () => {
  const files = { ...agentFiles, 'agents/release/AGENT.md': agentFiles['agents/release/AGENT.md'].replace('---\n', '---\ndefault: true\n') };
  const { repo, gitlab, config, deliveryConfig } = await routingFixture([], files);
  const decision = routingDecision();
  decision.decide.mockResolvedValueOnce(routingAnswers('__none__')).mockResolvedValueOnce(routingAnswers('image-sync'));
  const run = vi.fn<(turn: TurnInput) => Promise<string>>()
    .mockImplementationOnce(async ({ gate }) => {
      gate.setActiveSubagent('release');
      return 'Release plan';
    })
    .mockImplementationOnce(async ({ session, subagents }) => {
      expect(session.permissionMode).toBe('default');
      expect(subagents?.map(agent => agent.id)).toEqual(['audit', 'release']);
      return 'Release complete';
    })
    .mockImplementationOnce(async ({ session, sandbox }) => {
      expect(session.permissionMode).toBe('plan');
      expect(await readdir(path.join(sandbox.workspaceRoot, 'agents'))).toEqual(['image-sync']);
      return 'Image sync plan';
    });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, {
    decisionClient: decision, resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig),
  });
  await orchestrator.handleIssueOpened(opened);
  const session = (await repo.getSessionByIssue(hub.id, issue.iid))!;
  const original = (await repo.getLatestPendingApproval(session.id))!;
  await dispatchWebhook(orchestrator, userNote('/approve'));
  expect(await repo.getApproval(original.id)).toMatchObject({ status: 'APPROVED' });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });
  await dispatchWebhook(orchestrator, userNote('Sync the image'));
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan' });
  const next = await repo.getLatestPendingApproval(session.id);
  expect(next).toMatchObject({ approvalType: 'PLAN' });
  expect(next?.id).not.toBe(original.id);
  expect(decision.decide).toHaveBeenCalledTimes(2);
});

it('authorizes /use, preserves an active turn on unknown input, then stops it and replans with the new Agent label', async () => {
  const labels = [' AGENT::Release ', 'team::infra', 'claude::coding'];
  const { repo, gitlab, notes, config, deliveryConfig } = await routingFixture(labels);
  const session = await repo.getOrCreateSession(hub.id, issue.iid, issue.title);
  const stop = vi.spyOn(repo, 'requestStop');
  const prompt = 'Mirror app:v2\nto staging.example.';
  const run = vi.fn<(turn: TurnInput) => Promise<string>>()
    .mockImplementationOnce(async ({ gate, controller, session }) => {
      expect(session.permissionMode).toBe('default');
      await gate.canUseTool('AskUserQuestion', { questions: [{ question: 'Which release?' }] });
      controller.signal.throwIfAborted();
      return 'Previous Agent result';
    })
    .mockImplementationOnce(async turn => {
      expect(turn.prompt).toBe(prompt);
      expect(turn.session.permissionMode).toBe('plan');
      expect(await readdir(path.join(turn.sandbox.workspaceRoot, 'agents'))).toEqual(['image-sync']);
      expect(await turn.gate.preflight('Write', { file_path: 'app' })).toMatchObject({ behavior: 'deny' });
      return 'New Agent plan';
    });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, { resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig) });
  const original = orchestrator.resumeSession(session.id, 'Release app', { permissionMode: 'default' });
  const pending = await vi.waitFor(async () => {
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_TOOL' });
    return (await repo.getLatestPendingApproval(session.id))!;
  });
  const before = await repo.getSession(session.id);
  await dispatchWebhook(orchestrator, userNote('/use image-sync', { id: 99, username: 'guest' }));
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(hub.id, 99);
  expect(notes.at(-1)).toContain('Which release?');
  await dispatchWebhook(orchestrator, userNote('/use unknown'));
  expect(notes.at(-1)).toContain('未找到指定的 Agent');
  expect(notes.at(-1)).toContain('`image-sync`（标签 `agent::image-sync`）');
  expect(await repo.getSession(session.id)).toEqual(before);
  expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'PENDING' });
  expect(stop).not.toHaveBeenCalled();
  expect(gitlab.updateIssueLabels).not.toHaveBeenCalled();

  const report = vi.fn();
  const queue = new WebhookQueue(event => dispatchWebhook(orchestrator, event), report);
  labels.push('agent::audit');
  queue.submit('switch-agent', userNote('/use AGENT::IMAGE-SYNC   ' + prompt));
  await Promise.all([original, queue.drain()]);
  expect(report).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(gitlab.hasApprovalPermission).toHaveBeenLastCalledWith(hub.id, developer.id);
  expect(gitlab.updateIssueLabels).toHaveBeenCalledExactlyOnceWith(hub.id, issue.iid, {
    add: ['agent::image-sync'], remove: [' AGENT::Release ', 'agent::audit'],
  });
  expect(labels).toEqual(['team::infra', 'claude::coding', 'agent::image-sync']);
  expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'EXPIRED' });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan' });
  expect(notes.at(-1)).toContain('New Agent plan');
  expect(run).toHaveBeenCalledTimes(2);
});

it('persists the /use Plan reset and expires old approvals even if the selected Agent cannot start', async () => {
  const files = { ...agentFiles, [imageSyncFile]: agentFiles[imageSyncFile].replace('---\n', '---\nrequires: [registry]\n') };
  const labels = ['agent::release'];
  const { repo, gitlab, notes, config, deliveryConfig } = await routingFixture(labels, files);
  const session = await repo.getOrCreateSession(hub.id, issue.iid, issue.title);
  await repo.updateSessionState(session.id, { status: 'WAITING_TOOL', permissionMode: 'default' });
  const old = await repo.createApprovalRequest(session.id, 'PLAN', 'Plan', {});
  const pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'Bash', {});
  const resolveTurnProfile = vi.fn(createDeliveryTurnProfileResolver(deliveryConfig));
  const run = vi.fn();
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, { resolveTurnProfile });
  await dispatchWebhook(orchestrator, userNote('/use IMAGE-SYNC'));
  expect(labels).toEqual(['agent::image-sync']);
  expect(resolveTurnProfile.mock.calls[0][0]).toMatchObject({ purpose: 'turn', prompt: issue.title });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', permissionMode: 'plan' });
  expect(await repo.getApproval(old.id)).toMatchObject({ status: 'EXPIRED' });
  expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'EXPIRED' });
  expect(notes.at(-1)).toContain('registry');
  expect(run).not.toHaveBeenCalled();
});

it('keeps /use in Plan if GitLab applies the label change but loses the response', async () => {
  const labels = ['agent::release'];
  const { repo, gitlab, config, deliveryConfig } = await routingFixture(labels);
  const session = await repo.getOrCreateSession(hub.id, issue.iid, issue.title);
  await repo.updateSessionState(session.id, { status: 'WAITING_TOOL', permissionMode: 'default' });
  const pending = await repo.createApprovalRequest(session.id, 'TOOL_USE', 'Bash', {});
  const applyLabels = gitlab.updateIssueLabels.getMockImplementation()!;
  gitlab.updateIssueLabels.mockImplementationOnce(async (...args) => {
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', permissionMode: 'plan' });
    await applyLabels(...args);
    throw Error('label update response lost');
  });
  const run = vi.fn(async ({ session, sandbox }: TurnInput) => {
    expect(session.permissionMode).toBe('plan');
    expect(await readdir(path.join(sandbox.workspaceRoot, 'agents'))).toEqual(['image-sync']);
    return 'Image sync plan';
  });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, { resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig) });
  await expect(dispatchWebhook(orchestrator, userNote('/use image-sync'))).rejects.toThrow('label update response lost');
  expect(labels).toEqual(['agent::image-sync']);
  expect(await repo.getApproval(pending.id)).toMatchObject({ status: 'EXPIRED' });
  expect(run).not.toHaveBeenCalled();
  await dispatchWebhook(orchestrator, userNote('Mirror app:v2 to staging.'));
  expect(run).toHaveBeenCalledTimes(1);
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN', permissionMode: 'plan' });
});

it('fits workflow display names into the execution audit column and retains the full SOP path', async () => {
  const name = 'environment-change-'.repeat(4);
  const file = 'workflows/' + name + '.md';
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
