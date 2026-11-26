import { expect, it, vi } from 'vitest';
import { createDetentApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import * as mysql from '../src/db/mysql.js';
import { GitLabClient } from '../src/gitlab/client.js';
import { normalizeGitLabEvent } from '../src/gitlab/webhook.js';
import { SessionOrchestrator } from '../src/orchestrator/session-orchestrator.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { matchHubEvent, evaluateEventPolicy, loadHubEventPolicy } from '../src/router/event-policy.js';
import { sendEventNotification } from '../src/router/notifier.js';
import type { DecisionClient } from '../src/decision/jev-client.js';

const bot = { id: 99, username: 'detent', name: 'Detent' };
const event = normalizeGitLabEvent('e1', { object_kind: 'push', project: { id: 7, path_with_namespace: 'apps/site' },
  ref: 'refs/heads/fix/one', checkout_sha: 'abc', user_name: 'User', user_username: 'dev' });
const load = (rules: object[]) => loadHubEventPolicy({
  getRepositoryFile: async () => JSON.stringify({ version: 1, rules }),
}, 1, 'main');

it('loads only version 1 policies from the configured Hub ref', async () => {
  const getRepositoryFile = vi.fn<GitLabClient['getRepositoryFile']>().mockResolvedValue(null);
  expect(await loadHubEventPolicy({ getRepositoryFile }, 42, 'trunk')).toEqual({ present: false, rules: [] });
  expect(getRepositoryFile).toHaveBeenCalledWith(42, 'events.json', 'trunk');
  for (const file of ['{', '{"version":2,"rules":[]}', '{"version":1,"rules":[{"event":"*","action":"typo"}]}']) {
    getRepositoryFile.mockResolvedValue(file);
    expect(await loadHubEventPolicy({ getRepositoryFile }, 42, 'trunk')).toEqual({ present: true, rules: [] });
  }
});
it('uses the first matching rule including project, branch, action, status and ownership', async () => {
  const policy = await load([
    { event: 'push', branch: 'fix.one', action: 'ignore' },
    { event: ['push', 'release'], project: 'apps/*', branch: 'fix/*', action: 'notify' },
    { event: '*', action: 'run' },
  ]);
  expect(event).toMatchObject({ ref: 'fix/one', sha: 'abc', project: { id: 7 }, actor: { username: 'dev' } });
  expect((await evaluateEventPolicy(policy, event)).action).toBe('notify');
  expect((await evaluateEventPolicy(policy, { ...event, ref: 'fix.one' })).action).toBe('ignore');
  expect((await evaluateEventPolicy(policy, { ...event, ref: 'fixXone' })).action).toBe('run');
  const mr = normalizeGitLabEvent('mr', { object_kind: 'merge_request', project: { id: 7 },
    object_attributes: { iid: 8, action: 'open', state: 'opened', description: 'review @detent' }, assignees: [bot] });
  for (const ownership of ['assigned', 'mentioned']) {
    const owned = await load([{ event: '*', ownership, action: 'open', actionType: 'run', status: 'opened' }]);
    expect((await evaluateEventPolicy(owned, mr, { bot })).action).toBe('run');
    expect((await evaluateEventPolicy(owned, mr)).action).toBe('ignore');
    expect((await evaluateEventPolicy(owned, { ...mr, action: 'close' }, { bot })).action).toBe('ignore');
  }
});
it('matches any listed filter value and requires every specified field to match', async () => {
  const rule = { event: 'push', status: ['failed'], project: ['infra/*', '7'], branch: ['main', 'release/*'],
    action: ['open', 'update'], actionType: 'notify' };
  const policy = await load([rule]);
  const failed = { ...event, ref: 'main', status: 'failed', action: 'update' };
  for (const overrides of [{}, { ref: 'release/v1', action: 'open', project: { path: 'infra/web' } }])
    expect((await evaluateEventPolicy(policy, { ...failed, ...overrides })).action).toBe('notify');
  for (const overrides of [{ status: 'success' }, { ref: 'feature' }, { project: { id: 8 } }, { action: 'close' }])
    expect((await evaluateEventPolicy(policy, { ...failed, ...overrides })).action).toBe('ignore');
  for (const field of ['status', 'project', 'branch', 'action'])
    expect((await load([{ ...rule, [field]: [] }])).rules).toEqual([]);
});
it('limits semantic decisions to the configured choices and supplies only compact context', async () => {
  const policy = await load([{ event: '*', action: 'semantic', promptHint: 'assess impact',
    allowedActions: ['notify', 'ignore'], fallbackAction: 'ignore' }]);
  const decide = vi.fn<DecisionClient['decide']>();
  const decision = { provider: 'custom' as const, threshold: 0.9, decide };
  for (const choice of ['notify', 'run']) {
    decide.mockResolvedValue({ action: { type: 'choice', choice } });
    expect((await evaluateEventPolicy(policy, event, { decision })).action).toBe(choice === 'notify' ? 'notify' : 'ignore');
  }
  expect(decide).toHaveBeenCalledWith({ summary: event.summary, hint: 'assess impact' },
    { action: { type: 'choice', criteria: { notify: 'notify', ignore: 'ignore' } } });
  decide.mockRejectedValue(Error('unavailable'));
  expect((await evaluateEventPolicy(policy, event, { decision })).action).toBe('ignore');
  expect((await evaluateEventPolicy(await load([{ event: '*', action: 'semantic' }]), event)).action).toBe('notify');
});
it('delivers redacted resource, commit and Hub alerts before notifying observers', async () => {
  const config = loadConfig({ JEV_API_KEY: 'private-key' });
  const http = vi.fn(async () => Response.json({ iid: 1, id: 1 }));
  const gitlab = new GitLabClient(config, http);
  const hook = vi.fn();
  const base = { eventId: '1', projectId: 7, body: 'private-key\n/close' };
  for (const route of [{ target: 'resource', mrIid: 3 }, { target: 'resource', issueIid: 4 },
    { target: 'commit', sha: 'abc' }, { target: 'hub_issue', hubIssueLabel: 'alert' }] as const)
    await sendEventNotification(gitlab, config, { ...base, ...route }, hook);
  expect(hook.mock.calls.map(([n]) => n.body)).toEqual(Array(4).fill('***\n\\/close'));
  expect(http.mock.invocationCallOrder[3]).toBeLessThan(hook.mock.invocationCallOrder[3]);
  http.mockRejectedValueOnce(Error('network error'));
  await expect(sendEventNotification(gitlab, config, { ...base, target: 'hub_issue' }, hook)).rejects.toThrow('network');
  expect(hook).toHaveBeenCalledTimes(4);
});
it('acknowledges pending policy reads, deduplicates deliveries and drains queued notifications', async () => {
  const schema = vi.spyOn(mysql, 'initMySqlSchema').mockResolvedValue();
  const hook = vi.fn();
  const requests: string[] = [];
  let releasePolicy!: () => void;
  const policyReady = new Promise<void>(resolve => { releasePolicy = resolve; });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (url.endsWith('/user')) return Response.json(bot);
    if (url.includes('/repository/files/')) {
      await policyReady;
      return Response.json({ content: Buffer.from(JSON.stringify({
        version: 1, rules: [{ event: 'build', action: 'notify', notifyTarget: 'commit' }],
      })).toString('base64') });
    }
    return Response.json({});
  });
  const app = createDetentApp(loadConfig({ WATCHDOG_INTERVAL_MS: '0', GITLAB_WEBHOOK_SECRET: 'secret' }), { onNotify: hook });
  const post = (kind: string) => app.inject({ method: 'POST', url: '/webhooks/gitlab',
    headers: { 'x-gitlab-token': 'secret' }, payload: { object_kind: kind, project_id: 7, sha: 'abc', user: bot } });
  try {
    expect((await post('deployment')).statusCode).toBe(202);
    expect((await post('build')).statusCode).toBe(202);
    expect((await post('build')).statusCode).toBe(202);
    expect(hook).not.toHaveBeenCalled();
    releasePolicy();
    await app.close();
    expect(requests.filter(url => url.includes('/repository/files/'))).toHaveLength(2);
    expect(requests.at(-1)).toMatch(/projects\/7\/repository\/commits\/abc\/comments$/);
    expect(hook).toHaveBeenCalledOnce();
  } finally {
    releasePolicy();
    await app.close();
    schema.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each([
  { project: { id: 7 }, rule: { action: 'run' } },
  { project: {}, rule: { action: 'semantic', fallbackAction: 'run' } },
])('ignores a human run without project permission', async ({ project, rule }) => {
  const config = loadConfig({});
  const gitlab = new GitLabClient(config);
  vi.spyOn(gitlab, 'getRepositoryFile').mockResolvedValue(JSON.stringify({ version: 1, rules: [{ event: '*', ...rule }] }));
  const permission = vi.spyOn(gitlab, 'hasApprovalPermission').mockResolvedValue(false);
  const createIssue = vi.spyOn(gitlab, 'createIssue');
  const repo = new InMemoryDetentRepository();
  const session = vi.spyOn(repo, 'getOrCreateSession');
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run: vi.fn() });
  const wake = vi.spyOn(orchestrator, 'wakeSession');
  await matchHubEvent(gitlab, config, { ...event, project, actor: { id: 12 } }).handle(orchestrator);
  expect(permission).toHaveBeenCalledWith(project.id ?? config.gitlabHubProjectId, 12);
  expect(createIssue).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});

it('creates a Hub Issue for a run action and enters the normal Issue turn path', async () => {
  const config = loadConfig({});
  const gitlab = new GitLabClient(config, async (url, init) => {
    if (String(url).includes('/repository/files/')) return Response.json({ content: Buffer.from(JSON.stringify({
      version: 1, rules: [{ event: 'push', action: 'run', hubIssueLabel: 'review' }],
    })).toString('base64') });
    if (String(url).endsWith('/projects/7/members/all/12')) return Response.json({ access_level: 30 });
    if (String(url).endsWith('/issues')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ labels: 'review', description: event.summary });
      return Response.json({ iid: 17, title: 'Review' });
    }
    return Response.json({ id: 1 });
  });
  const repo = new InMemoryDetentRepository();
  const profile = vi.fn(() => ({ blockedMessage: 'select a workflow' }));
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run: vi.fn() }, { resolveTurnProfile: profile });
  const match = matchHubEvent(gitlab, config, { ...event, actor: { id: 12 } });
  await match.handle(orchestrator);
  expect(await repo.getSessionByIssue(1, 17)).toMatchObject({ permissionMode: 'plan', status: 'IDLE' });
  expect(profile).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'turn', prompt: expect.stringContaining(event.summary) }));
});
