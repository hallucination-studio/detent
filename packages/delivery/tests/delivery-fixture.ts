import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { loadConfig } from '@detent/core';
import { bareProjects } from '../../core/tests/bare-projects.js';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { loadDeliveryConfig, type JumpServerClient } from '../src/index.js';

export const hub = { id: 1 };
export const issue = { id: 1088, iid: 88, title: 'Reload nginx', description: 'Verify web01', state: 'opened' as const, action: 'open' };
export const developer = { id: 7, username: 'dev' };
export const maintainer = { id: 8, username: 'sre' };
export const opened = { object_kind: 'issue' as const, project: hub, user: developer, object_attributes: issue };

export async function deliveryFixture(labels: string[]) {
  const root = await mkdtemp('/tmp/detent-stage4-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ GITLAB_WEBHOOK_SECRET: 'fixture-webhook-key', EPHEMERAL_ROOT: path.join(root, 'turns'), HOT_HOLD_TIMEOUT_MS: '3000' });
  const repo = new InMemoryDetentRepository();
  const notes: string[] = [];
  const gitlab = {
    ...await bareProjects(root), isBotUser: () => false,
    listRepositoryTree: async (_project: number, dir: string) => dir === 'agents' ? ['audit', 'env-change'].map(id =>
      ({ id, name: 'AGENT.md', type: 'blob' as const, path: 'agents/' + id + '/AGENT.md' })) : [],
    getRepositoryFile: async (_project: number, file: string) => file === 'capabilities.json' ? null :
      readFile(new URL('../../../examples/hub-workspace/' + file, import.meta.url), 'utf8'),
    getIssue: vi.fn(async (_project: number, _iid: number) => ({ ...issue, labels })),
    hasApprovalPermission: vi.fn(async (_project: number, user: number, minimum = 30) =>
      (user === maintainer.id ? 40 : user === developer.id ? 30 : 0) >= minimum),
    createIssueNote: async (_project: number, _iid: number, body: string) => ({ id: notes.push(body) }),
    updateIssueNote: async (_project: number, _iid: number, id: number, body: string) => { notes[id - 1] = body; },
    syncIssueStatusLabel: vi.fn(),
  };
  const client: JumpServerClient = {
    listAssets: vi.fn<JumpServerClient['listAssets']>().mockResolvedValue([{ id: 'web01', name: 'web01', address: '192.0.2.1' }]),
    runReadonlyInspect: vi.fn<JumpServerClient['runReadonlyInspect']>().mockResolvedValue({
      jobId: 'inspect', jobUrl: 'https://jms.test/inspect', status: 'SUCCESS', outputSummary: 'active',
    }),
    runAnsibleJob: vi.fn<JumpServerClient['runAnsibleJob']>().mockResolvedValue({
      jobId: 'job-88', jobUrl: 'https://jms.test/job-88', status: 'PENDING',
    }),
    getJobResult: vi.fn<JumpServerClient['getJobResult']>().mockResolvedValue({
      jobId: 'job-88', jobUrl: 'https://jms.test/job-88', status: 'SUCCESS', outputSummary: 'nginx reloaded',
    }),
  };
  return { root, config, repo, gitlab, notes, client, deliveryConfig: loadDeliveryConfig({}) };
}
