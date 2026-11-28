import { MergeRequestOrchestrator } from '../../core/src/orchestrator/mr-orchestrator.js';
import { GitLabClient } from '../../core/src/gitlab/client.js';
import { randomUUID } from 'node:crypto';
import { appendFile, cp, readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createDetentApp, createWebhookApp, SessionOrchestrator } from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { transcriptPath } from '../../core/src/claude/transcript-hydrator.js';
import { dispatchWebhook } from '../../core/src/gitlab/webhook.js';
import { WebhookQueue } from '../../core/src/gitlab/webhook-queue.js';
import { git } from '../../core/src/workspace/ephemeral-sandbox.js';
import {
  createDeliveryApp, HttpJumpServerClient, DeliveryJobPoller, createDeliveryTurnProfileResolver, createJumpServerTools, formatDeliveryExecutionsStatus, matchMergeRequestWebhook,
  type DeliveryAuditRepository, type DeliveryExecutionRow,
} from '../src/index.js';
import { deliveryFixture, developer, hub, issue, maintainer, opened } from './delivery-fixture.js';

vi.mock('@detent/core', async original => {
  const core = await original<typeof import('@detent/core')>();
  return { ...core, createDetentApp: vi.fn<typeof core.createDetentApp>() };
});

function auditFixture() {
  const rows: DeliveryExecutionRow[] = [];
  const tracker: DeliveryAuditRepository = {
    async recordExecution(record) {
      rows.push({ ...record, id: randomUUID(), createdAt: new Date(), finishedAt: null, outputSummary: null });
    },
    async hasSessionJob(session, job) { return rows.some(r => r.sessionId === session && r.jumpserverJobId === job); },
    async listPendingExecutions() { return rows.filter(r => r.status === 'PENDING' || r.status === 'RUNNING'); },
    acknowledgeCallback: vi.fn(async () => {}),
    async completeExecution(session, job, status, outputSummary) {
      const row = rows.find(r => r.sessionId === session && r.jumpserverJobId === job);
      if (!row || row.finishedAt) return false;
      Object.assign(row, { status, outputSummary, finishedAt: new Date() });
      return true;
    },
    async listSessionExecutions(session) { return rows.filter(r => r.sessionId === session); },
  };
  return { rows, tracker };
}

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
type Run = (turn: TurnInput) => Promise<string>;

function checkpointed(run: Run) {
  return { async run(turn: TurnInput) {
    const file = transcriptPath(turn.sandbox.claudeHome, turn.sandbox.workspaceRoot, turn.session.claudeSessionId!);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify({ type: 'assistant', prompt: turn.prompt }) + '\n');
    return run(turn);
  } };
}

function webhookFixture({ repo, config, gitlab }: Fixture, orchestrator: SessionOrchestrator, run: Run) {
  const report = vi.fn();
  const clientForMr = Object.assign(new GitLabClient(config, async () => { throw Error('Unexpected GitLab API call'); }), gitlab, { listOpenMergeRequestsByBranch: async () => [] });
  const mrs = new MergeRequestOrchestrator(config, repo, clientForMr, { run }, { runHubEvent: vi.fn(), wakeQueuedIssue: orchestrator.wakeQueuedIssue.bind(orchestrator) });
  const queue = new WebhookQueue((event, id) => dispatchWebhook(orchestrator, event, id, mrs), report);
  const app = createWebhookApp(config, gitlab, (id, event) => queue.submit(id, event), matchMergeRequestWebhook);
  const post = async (payload: object) => {
    const response = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload,
      headers: { 'x-gitlab-token': config.gitlabWebhookSecret, 'x-gitlab-event-uuid': randomUUID() } });
    expect(response.statusCode).toBe(202);
  };
  const approve = (noteId: number, user: typeof developer) => post({
    object_kind: 'emoji', project_id: hub.id, issue, user,
    object_attributes: { awardable_type: 'Note', awardable_id: noteId, name: 'thumbsup', action: 'award' },
  });
  onTestFinished(async () => {
    queue.stop();
    await queue.drain();
    await mrs.drain();
    await app.close();
    expect(report).not.toHaveBeenCalled();
  });
  return { post, approve, queue, report, clientForMr };
}

it('governs Issue #88 through inspection, Plan, MR !205, production approval, execution and verification', async () => {
  const fixture = await deliveryFixture(['delivery::env-change']);
  const { root, config, repo, gitlab, notes, client, deliveryConfig } = fixture;
  const { rows, tracker } = auditFixture();
  const branch = 'issue/88';
  const playbook = 'deploy/nginx-reload.yml';
  const mrUrl = 'https://git.test/ops/ansible/-/merge_requests/205';
  const projects = gitlab.getProject;
  gitlab.getProject = async id => {
    const project = await projects(id);
    return project.id === 2 ? { ...project, path_with_namespace: 'ops/ansible' } : project;
  };
  gitlab.createMergeRequest.mockResolvedValue({ iid: 205, title: issue.title, web_url: mrUrl,
    state: 'opened', source_branch: branch, target_branch: 'main' });
  const job = { target_project_id: 2, mr_iid: 205, playbook_path: playbook, asset_ids: ['web01'], commit_sha: '' };
  const inspect = { asset_ids: job.asset_ids, commands: ['systemctl status nginx'] };
  const planReport = 'Inspect web01, reload nginx after review, verify health and roll back on failure.';
  const finalReport = 'Reload verified on web01.';
  const run = vi.fn<(turn: TurnInput) => Promise<string>>()
    .mockImplementationOnce(async ({ gate }) => {
      expect(await gate.invokeExtension('mcp__detent__jms_list_assets', {})).toMatchObject([{ id: 'web01' }]);
      expect(await gate.invokeExtension('mcp__detent__jms_shell', inspect)).toMatchObject({ outputSummary: 'active' });
      expect(await gate.preflight('Bash', { command: 'git status' })).toMatchObject({ behavior: 'deny' });
      return planReport;
    })
    .mockImplementationOnce(async ({ tools, sandbox, gate, session }) => {
      expect(session.status).toBe('CODING');
      const dir = await tools.invoke('detent_checkout_worktree', { project: 2, branch_name: branch });
      const file = path.join(sandbox.workspaceRoot, 'projects', String(dir), playbook);
      expect(await gate.preflight('Write', { file_path: file })).toMatchObject({ behavior: 'allow' });
      await mkdir(path.dirname(file));
      await writeFile(file, '- hosts: all\n  tasks:\n    - ansible.builtin.service: { name: nginx, state: reloaded }\n');
      job.commit_sha = String(await tools.invoke('detent_commit_and_push', { directory_name: dir, commit_message: issue.title }));
      await tools.invoke('detent_create_mr', { project: 2, source_branch: branch, target_branch: 'main', title: issue.title });
      await expect(gate.invokeExtension('mcp__detent__jms_job', job)).rejects.toThrow('尚未合并');
      return 'Please review and merge ' + mrUrl;
    })
    .mockImplementationOnce(async ({ gate, prompt }) => {
      expect(prompt).toContain(job.commit_sha);
      await gate.invokeExtension('mcp__detent__jms_job', job);
      throw Error('Expected production approval hold');
    })
    .mockImplementationOnce(async ({ gate }) => {
      const result = await gate.invokeExtension('mcp__detent__jms_job', job);
      expect(result).toMatchObject({ jobId: 'job-88', status: 'PENDING', asyncCallback: true });
      return 'Submitted https://jms.test/job-88';
    })
    .mockImplementationOnce(async ({ gate, prompt }) => {
      expect(prompt).toContain('nginx reloaded');
      expect(await gate.invokeExtension('mcp__detent__jms_shell', inspect)).toMatchObject({ outputSummary: 'active' });
      return finalReport;
    });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, checkpointed(run), {
    capabilities: [{ name: 'jumpserver', enabled: true, tools: createJumpServerTools({ client, config: deliveryConfig, tracker }) }],
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig),
    renderStatusExtra: async s => formatDeliveryExecutionsStatus(await tracker.listSessionExecutions(s.id)),
  });
  const { post, approve, queue, report } = webhookFixture(fixture, orchestrator, run);
  await post(opened);
  await queue.drain();
  const session = (await repo.getSessionByIssue(hub.id, issue.iid))!;
  expect(session.status).toBe('WAITING_PLAN');
  const plan = (await repo.getLatestPendingApproval(session.id))!;
  expect(notes[plan.gitlabNoteId! - 1]).toContain(planReport);
  await approve(plan.gitlabNoteId!, developer);
  await queue.drain();
  expect(await repo.getLatestApproval(session.id)).toMatchObject({ id: plan.id, status: 'APPROVED', decidedBy: developer.username });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });
  const [mr] = await repo.listSessionMergeRequests(session.id);
  expect(mr).toMatchObject({ mrState: 'opened', mrIid: 205, targetProjectPath: 'ops/ansible' });
  expect(notes.join('\n')).not.toContain('生产变更执行审批');
  expect(client.runAnsibleJob).not.toHaveBeenCalled();

  // Fast-forward the test remote exactly as the human merge described by the webhook.
  const remote = path.join(root, '2.git');
  expect((await git(['rev-parse', branch], remote, root)).trim()).toBe(job.commit_sha);
  await git(['update-ref', 'refs/heads/main', job.commit_sha], remote, root);
  expect(await git(['show', 'main:' + playbook], remote, root)).toContain('state: reloaded');
  await post({ object_kind: 'merge_request', user: maintainer, project: { id: 2 }, object_attributes: {
    action: 'merge', state: 'merged', iid: 205, merge_commit_sha: job.commit_sha,
  } });
  await vi.waitFor(async () => expect((await repo.getSession(session.id))?.status).toBe('WAITING_TOOL'));
  expect(run.mock.calls[2][0]).toMatchObject({
    resume: true, session: { id: session.id, claudeSessionId: session.claudeSessionId, permissionMode: 'default' },
  });
  expect(await repo.findMergeRequest(2, 205)).toMatchObject([{ id: mr.id, mrState: 'merged', mergeCommitSha: job.commit_sha }]);
  expect(notes).toContainEqual(expect.stringContaining('已由 @sre 合并'));
  const approval = (await repo.getLatestPendingApproval(session.id))!;
  const card = notes[approval.gitlabNoteId! - 1];
  for (const value of ['生产变更执行审批', job.commit_sha, mrUrl, playbook, 'web01']) expect(card).toContain(value);
  await approve(approval.gitlabNoteId!, developer);
  await vi.waitFor(() => expect(gitlab.hasApprovalPermission).toHaveBeenCalledWith(hub.id, developer.id, 40));
  expect((await repo.getApproval(approval.id))?.status).toBe('PENDING');
  expect(client.runAnsibleJob).not.toHaveBeenCalled();
  await approve(approval.gitlabNoteId!, maintainer);
  await queue.drain();
  expect(client.runAnsibleJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commitSha: job.commit_sha, playbookPath: playbook }));
  expect(await repo.getApproval(approval.id)).toMatchObject({ status: 'APPROVED', decidedBy: maintainer.username });
  expect(rows[0].status).toBe('PENDING');
  expect(client.getJobResult).not.toHaveBeenCalled();
  const poller = new DeliveryJobPoller({
    auditRepo: tracker, resolveClient: () => client, report,
    async onCompleted(row, result) {
      await orchestrator.deliverSystemEvent(row.sessionId, 'jms-job:' + row.jumpserverJobId, result.outputSummary, { sender: 'jumpserver' });
    },
  });
  await poller.pollOnce();
  expect(rows).toMatchObject([{
    sessionId: session.id, mrId: mr.id, approvalId: approval.id, agentProfile: 'env-change', jumpserverJobId: 'job-88',
    playbookPath: playbook, commitSha: job.commit_sha, targetAssets: ['web01'], status: 'SUCCESS', outputSummary: 'nginx reloaded',
  }]);
  expect(client.runShell).toHaveBeenCalledTimes(2);
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  expect(notes.join('\n')).toContain(finalReport);
  await post({ object_kind: 'note', project: hub, issue, user: developer,
    object_attributes: { id: 1000, noteable_type: 'Issue', note: '/status' } });
  await queue.drain();
  for (const value of ['ops/ansible!205', 'merged @ ' + job.commit_sha.slice(0, 8), '### 交付执行记录',
    'env-change', 'SUCCESS', playbook, rows[0].jumpserverJobUrl, approval.id]) expect(notes.at(-1)).toContain(value);
  expect(report).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(5);
  expect(await readdir(config.ephemeralRoot)).toEqual([]);
}, 15000);

it.each(['success', 'failed'] as const)('delivers a two-owner release with a cross-project gate and a %s production job', async outcome => {
  const fixture = await deliveryFixture(['delivery::release']);
  const { repo, config, gitlab, notes, root, deliveryConfig } = fixture;
  const { tracker, rows } = auditFixture();
  const seed = path.join(root, 'seed');
  const remote = (project: number) => path.join(root, project + '.git');
  for (const name of ['skills', 'agents'])
    await cp(new URL('../../../examples/hub-workspace/' + name, import.meta.url), path.join(seed, name), { recursive: true });
  await git(['add', '.'], seed, root);
  await git(['commit', '-m', 'Install Hub SOPs'], seed, root);
  await git(['push', remote(1), 'main'], seed, root);
  const tag = 'v2';
  const stable = 'v1';
  const stableSha = (await git(['rev-parse', 'main'], remote(2), root)).trim();
  await git(['tag', stable, stableSha], remote(2), root);
  const appDir = path.join(root, 'app');
  await git(['worktree', 'add', appDir, 'main'], remote(2), root);
  await writeFile(path.join(appDir, 'tracked'), 'candidate release');
  await git(['commit', '-am', 'Prepare v2'], appDir, root);
  const sha = (await git(['rev-parse', 'HEAD'], appDir, root)).trim();
  const configDir = path.join(root, 'config');
  await git(['worktree', 'add', configDir, 'main'], remote(3), root);
  for (const env of ['pre', 'prod']) await writeFile(path.join(configDir, 'values-' + env + '.yaml'), 'image:\n  tag: ' + stable + '\n');
  await git(['add', '.'], configDir, root);
  await git(['commit', '-m', 'Record stable configuration'], configDir, root);
  const pipeline = { id: 101, ref: 'main', status: 'running', web_url: 'https://git/qa/platform-e2e/-/pipelines/101' };
  const releaseApi = {
    ...gitlab, getCommit: vi.fn(async () => ({ id: sha, title: 'ready' })), getTag: vi.fn(async () => null),
    listTags: vi.fn(async () => [{ name: stable, commit: { id: stableSha }, message: null }]), listPipelinesBySha: vi.fn(async () => []),
    createTag: vi.fn(async (project: number, input: { tag_name: string; ref: string }) => {
      await git(['tag', input.tag_name, input.ref], remote(project), root);
      return { name: input.tag_name, commit: { id: input.ref }, message: null };
    }), createRelease: vi.fn(), createPipeline: vi.fn(async () => pipeline), getPipeline: vi.fn(async () => pipeline),
    listPipelines: vi.fn(async () => []),
  };
  let iid = 0;
  gitlab.createMergeRequest.mockImplementation(async (_id, params) => ({
    ...params, iid: ++iid, web_url: 'https://git/config/-/merge_requests/' + iid, state: 'opened',
  }));
  const closeIssue = vi.fn();
  const originalRead = gitlab.getRepositoryFile;
  gitlab.getRepositoryFile = async (project, file) => file === 'capabilities.json' ? JSON.stringify({
    'gitlab-release': { type: 'gitlab-release', approver_tier: 'standard' },
    jumpserver: { type: 'jumpserver', base_url: 'https://jms.test', auth: { token: '$secret:JMS' },
      environments: { pre: { match: ['label:env:pre'], approver_tier: 'standard' }, prod: { match: ['/DEFAULT/prod'] } } },
  }) : originalRead(project, file);
  config.secrets.JMS = 'fixture-jms-auth';
  vi.spyOn(HttpJumpServerClient.prototype, 'getAsset').mockImplementation(async id => ({
    id, name: id, address: 'shared-host', nodes: ['/DEFAULT/' + id], labels: ['env:' + id],
  }));
  const submit = vi.spyOn(HttpJumpServerClient.prototype, 'runAnsibleJob').mockImplementation(async () => {
    const jobId = 'job-' + (rows.length + 1);
    return { jobId, jobUrl: 'https://jms.test/' + jobId, status: 'PENDING' };
  });
  vi.spyOn(HttpJumpServerClient.prototype, 'getJobResult').mockImplementation(async jobId => {
    const failed = outcome === 'failed' && jobId === 'job-2';
    return { jobId, jobUrl: 'https://jms.test/' + jobId, status: failed ? 'FAILED' : 'SUCCESS', outputSummary: failed ? 'rollout failed' : 'deployed' };
  });
  createDeliveryApp(config, { gitlabClient: releaseApi, deliveryConfig, executionTracker: tracker });
  const extensions = vi.mocked(createDetentApp).mock.lastCall![1]!;
  const run = vi.fn<Run>();
  const orchestrator = new SessionOrchestrator(config, repo, { ...gitlab, closeIssue }, checkpointed(run), extensions);
  const { post, approve, queue, clientForMr, report } = webhookFixture(fixture, orchestrator, run);
  let poller!: DeliveryJobPoller;
  vi.spyOn(DeliveryJobPoller.prototype, 'start').mockImplementation(function (this: DeliveryJobPoller) { poller = this; });
  const cleanup = await extensions.onReady!({ orchestrator, repo, gitlab: clientForMr, report });
  onTestFinished(async () => { await cleanup?.(); });
  async function send(event: object) { await post(event); await queue.drain(); }
  const invoke = (t: TurnInput, tool: string, args: Record<string, unknown>) => t.gate.invokeExtension('mcp__detent__' + tool, args);
  const version = { project: 2, tag_name: tag, commit_sha: sha, tag_only: true };
  run.mockImplementationOnce(async t => {
    expect(await invoke(t, 'detent_list_tags', { project: 2 })).toMatchObject([{ name: stable }]);
    expect(await readFile(path.join(t.sandbox.workspaceRoot, 'skills/env-topology/SKILL.md'), 'utf8')).toContain('promotion_gate');
    await invoke(t, 'detent_submit_plan', { plan: 'Release v2 via pre, gate, prod. Restore v1 on failure.' });
    return 'Proposed rollout';
  });
  await send(opened);
  const session = (await repo.getSessionByIssue(hub.id, issue.iid))!;
  async function vote(tool: string, actor = developer, allowed = true) {
    const pending = (await repo.getLatestPendingApproval(session.id))!;
    expect(pending?.toolName, notes.at(-1)).toBe(tool);
    await approve(pending.gitlabNoteId!, actor);
    await queue.drain();
    expect(await repo.getApproval(pending.id)).toMatchObject({ status: allowed ? 'APPROVED' : 'PENDING', decidedBy: allowed ? actor.username : null });
    return pending;
  }
  run.mockImplementationOnce(async t => { await invoke(t, 'detent_create_release', version); return ''; });
  await vote('Plan');
  run.mockImplementationOnce(async t => {
    await invoke(t, 'detent_create_release', version);
    expect(await invoke(t, 'detent_await_pipeline', { project: 2, ref_or_pipeline_id: tag })).toMatchObject({ asyncCallback: true, watching: true });
    await expect(invoke(t, 'detent_close_issue', { summary: 'premature' })).rejects.toThrow('等待终态的流水线');
    return 'Waiting for image';
  });
  await vote('detent_create_release');
  expect((await git(['rev-parse', tag], remote(2), root)).trim()).toBe(sha);
  type Env = 'pre' | 'prod';
  function configMr(env: Env, targetTag: string): Run {
    return async t => {
      const branch = env + '-' + targetTag;
      const dir = await t.tools.invoke('detent_checkout_worktree', { project: 3, branch_name: branch });
      await writeFile(path.join(t.sandbox.workspaceRoot, 'projects', String(dir), 'values-' + env + '.yaml'), 'image:\n  tag: ' + targetTag + '\n');
      await t.tools.invoke('detent_commit_and_push', { directory_name: dir, commit_message: branch });
      await t.tools.invoke('detent_create_mr', { project: 3, source_branch: branch, target_branch: 'main', title: branch });
      return env === 'prod' ? '@sre please review ' + branch : 'Review ' + branch;
    };
  }
  async function terminal(project: number, id: number, ref: string) {
    const event = { object_kind: 'pipeline', project: { id: project }, object_attributes: { id, ref, status: 'success' } };
    await send(event);
    const calls = run.mock.calls.length;
    await send(event);
    expect(run).toHaveBeenCalledTimes(calls);
  }
  run.mockImplementationOnce(configMr('pre', tag));
  await terminal(2, 88, tag);
  async function deploy(env: Env, targetTag: string, actor: typeof developer) {
    const opened = (await repo.listSessionMergeRequests(session.id)).filter(m => m.mrState === 'opened');
    expect(opened).toMatchObject([{ sourceBranch: env + '-' + targetTag }]);
    const [mr] = opened;
    const merged = (await git(['rev-parse', mr.sourceBranch], remote(3), root)).trim();
    await git(['update-ref', 'refs/heads/main', merged], remote(3), root);
    const job = { environment: env, asset_ids: [env], target_project_id: 3, mr_iid: mr.mrIid, commit_sha: merged, playbook_path: 'site.yml' };
    run.mockImplementationOnce(async t => {
      if (env === 'pre') await expect(invoke(t, 'jms_job', { ...job, asset_ids: ['pre', 'prod'] })).rejects.toThrow(/不属于.*prod/);
      await invoke(t, 'jms_job', job);
      return '';
    });
    await send({ object_kind: 'merge_request', project: { id: 3 }, user: actor, object_attributes: { action: 'merge', state: 'merged', iid: mr.mrIid, merge_commit_sha: merged } });
    const before = rows.length;
    if (env === 'prod') {
      await vote('jms_job', developer, false);
      expect(submit).toHaveBeenCalledTimes(before);
    }
    run.mockImplementationOnce(async t => {
      expect(await invoke(t, 'jms_job', job)).toMatchObject({ asyncCallback: true, commitSha: merged });
      return 'Waiting for execution';
    });
    const approval = await vote('jms_job', actor);
    expect(rows.at(-1)).toMatchObject({ mrId: mr.id, commitSha: merged, targetAssets: [env], approvalId: approval.id, status: 'PENDING' });
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  }
  await deploy('pre', tag, developer);
  run.mockImplementationOnce(async t => {
    expect(t.prompt).toContain('SUCCESS');
    expect(await invoke(t, 'detent_trigger_pipeline', { project: 4, ref: 'main', variables: { RELEASE_TAG: tag } })).toMatchObject({ pipelineId: 101, asyncCallback: true });
    return 'Waiting for cross-project E2E';
  });
  await poller.pollOnce();
  expect(releaseApi.createPipeline).toHaveBeenCalledExactlyOnceWith(4, { ref: 'main', variables: { RELEASE_TAG: tag } });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
  run.mockImplementationOnce(configMr('prod', tag));
  await terminal(4, 101, 'main');
  expect(notes).toContainEqual(expect.stringContaining('@sre please review'));
  await deploy('prod', tag, maintainer);
  if (outcome === 'failed') {
    run.mockImplementationOnce(async t => {
      expect(t.prompt).toContain('FAILED');
      await expect(invoke(t, 'detent_close_issue', { summary: 'premature' })).rejects.toThrow('FAILED');
      return configMr('prod', stable)(t);
    });
    await poller.pollOnce();
    expect(closeIssue).not.toHaveBeenCalled();
    await deploy('prod', stable, maintainer);
  }
  run.mockImplementationOnce(async t => {
    expect(t.prompt).toContain('SUCCESS');
    if (outcome === 'success') await invoke(t, 'detent_close_issue', { summary: 'Both environments verified' });
    return outcome === 'success' ? 'Released' : 'Restored stable version, awaiting owner decision';
  });
  await poller.pollOnce();
  expect(rows.map(r => r.status)).toEqual(outcome === 'success' ? ['SUCCESS', 'SUCCESS'] : ['SUCCESS', 'FAILED', 'SUCCESS']);
  expect(await git(['show', 'main:values-pre.yaml'], remote(3), root)).toContain('tag: ' + tag);
  expect(await git(['show', 'main:values-prod.yaml'], remote(3), root)).toContain('tag: ' + (outcome === 'success' ? tag : stable));
  expect(await repo.getSession(session.id)).toMatchObject({ status: outcome === 'success' ? 'DONE' : 'IDLE', lockedByPod: null });
  expect(closeIssue).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  expect(await readdir(config.ephemeralRoot)).toEqual([]);
}, 30000);
