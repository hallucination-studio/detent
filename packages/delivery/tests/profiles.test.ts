import { expect, it, vi } from 'vitest';
import { SessionOrchestrator, type TurnProfileResolver } from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { createDeliveryTurnProfileResolver, createJumpServerTools, loadDeliveryConfig, type AgentProfileName } from '../src/index.js';
import { deliveryFixture, issue, opened } from './delivery-fixture.js';

async function resolve(labels: string[], env = {}) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, issue.iid, issue.title);
  const gitlab = {
    getIssue: vi.fn(async () => ({ ...issue, labels })),
    hasApprovalPermission: vi.fn(async (_project: number, level: number, minimum = 30) => level >= minimum),
  } satisfies Parameters<TurnProfileResolver>[0]['gitlab'];
  const profile = await createDeliveryTurnProfileResolver(loadDeliveryConfig(env))({ session, repo, gitlab });
  expect(gitlab.getIssue).toHaveBeenCalledWith(1, issue.iid);
  return { profile, gitlab };
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
  expect(profile).toMatchObject({
    name, readonly: name === 'ReadonlyAuditAgent', disableBash: name !== 'CodeDeliveryAgent',
    enabledExtensionTools: name === 'EnvChangeAgent' ? [...inspect, 'jms_run_ansible_job', 'jms_get_job_result']
      : name === 'ReadonlyAuditAgent' ? inspect : [],
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
