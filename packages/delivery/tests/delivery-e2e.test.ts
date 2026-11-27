import { MergeRequestOrchestrator } from '../../core/src/orchestrator/mr-orchestrator.js';
import { GitLabClient } from '../../core/src/gitlab/client.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWebhookApp, SessionOrchestrator } from '@detent/core';
import type { TurnInput } from '../../core/src/claude/runner.js';
import { transcriptPath } from '../../core/src/claude/transcript-hydrator.js';
import { dispatchWebhook } from '../../core/src/gitlab/webhook.js';
import { WebhookQueue } from '../../core/src/gitlab/webhook-queue.js';
import { git } from '../../core/src/workspace/ephemeral-sandbox.js';
import {
  createDeliveryTurnProfileResolver, createJumpServerTools, formatDeliveryExecutionsStatus, matchMergeRequestWebhook,
  type DeliveryAuditRepository, type DeliveryExecutionRow,
} from '../src/index.js';
import { deliveryFixture, developer, hub, issue, maintainer, opened } from './delivery-fixture.js';

it('governs Issue #88 through inspection, Plan, MR !205, production approval, execution and verification', async () => {
  const { root, config, repo, gitlab, notes, client, deliveryConfig } = await deliveryFixture(['delivery::env-change']);
  const rows: DeliveryExecutionRow[] = [];
  const tracker: DeliveryAuditRepository = {
    async recordExecution(record) {
      rows.push({ ...record, id: randomUUID(), createdAt: new Date(), finishedAt: null, outputSummary: null });
    },
    async hasSessionJob(session, job) { return rows.some(r => r.sessionId === session && r.jumpserverJobId === job); },
    async updateExecutionResult(session, job, status, outputSummary) {
      const row = rows.find(r => r.sessionId === session && r.jumpserverJobId === job)!;
      Object.assign(row, { status, outputSummary, finishedAt: new Date() });
    },
    async listSessionExecutions(session) { return rows.filter(r => r.sessionId === session); },
  };
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
  const inspect = { asset_ids: job.asset_ids, command: 'systemctl status nginx' };
  const planReport = 'Inspect web01, reload nginx after review, verify health and roll back on failure.';
  const finalReport = 'Reload verified on web01.';
  const run = vi.fn<(turn: TurnInput) => Promise<string>>()
    .mockImplementationOnce(async ({ gate }) => {
      expect(await gate.invokeExtension('mcp__detent__jms_list_assets', {})).toMatchObject([{ id: 'web01' }]);
      expect(await gate.invokeExtension('mcp__detent__jms_readonly_inspect', inspect)).toMatchObject({ outputSummary: 'active' });
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
      await expect(gate.invokeExtension('mcp__detent__jms_run_ansible_job', job)).rejects.toThrow('尚未合并');
      return 'Please review and merge ' + mrUrl;
    })
    .mockImplementationOnce(async ({ gate, prompt }) => {
      expect(prompt).toContain(job.commit_sha);
      const result = await gate.invokeExtension('mcp__detent__jms_run_ansible_job', job);
      expect(result).toMatchObject({ jobId: 'job-88', status: 'PENDING' });
      expect(await gate.invokeExtension('mcp__detent__jms_get_job_result', { job_id: 'job-88' })).toMatchObject({ status: 'SUCCESS' });
      expect(await gate.invokeExtension('mcp__detent__jms_readonly_inspect', inspect)).toMatchObject({ outputSummary: 'active' });
      return finalReport;
    });
  const orchestrator = new SessionOrchestrator(config, repo, gitlab, {
    async run(turn) {
      const file = transcriptPath(turn.sandbox.claudeHome, turn.sandbox.workspaceRoot, turn.session.claudeSessionId!);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify({ type: 'assistant', prompt: turn.prompt }) + '\n');
      return run(turn);
    },
  }, {
    capabilities: [{ name: 'jumpserver', enabled: true, tools: createJumpServerTools({ client, config: deliveryConfig, tracker }) }],
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig),
    renderStatusExtra: async s => formatDeliveryExecutionsStatus(await tracker.listSessionExecutions(s.id)),
  });
  const report = vi.fn();
  const clientForMr = Object.assign(new GitLabClient(config, async () => { throw Error('Unexpected GitLab API call'); }), gitlab);
  const mrs = new MergeRequestOrchestrator(config, repo, clientForMr, { run }, { runHubEvent: vi.fn() });
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
  try {
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
    expect(rows).toMatchObject([{
      sessionId: session.id, mrId: mr.id, approvalId: approval.id, agentProfile: 'env-change', jumpserverJobId: 'job-88',
      playbookPath: playbook, commitSha: job.commit_sha, targetAssets: ['web01'], status: 'SUCCESS', outputSummary: 'nginx reloaded',
    }]);
    expect(client.runReadonlyInspect).toHaveBeenCalledTimes(2);
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', lockedByPod: null });
    expect(notes.join('\n')).toContain(finalReport);
    await post({ object_kind: 'note', project: hub, issue, user: developer,
      object_attributes: { id: 1000, noteable_type: 'Issue', note: '/status' } });
    await queue.drain();
    for (const value of ['ops/ansible!205', 'merged @ ' + job.commit_sha.slice(0, 8), '### 交付执行记录',
      'env-change', 'SUCCESS', playbook, rows[0].jumpserverJobUrl, approval.id]) expect(notes.at(-1)).toContain(value);
    expect(report).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    queue.stop();
    await queue.drain();
    await app.close();
  }
}, 15000);
