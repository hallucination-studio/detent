import * as fs from 'node:fs/promises';
import { z } from 'zod';
import type { LiveMr } from '../gitlab/client.js';
import type { SessionWorktreeRow } from '../types.js';
import { EphemeralSandbox, git, type TurnSandbox } from './ephemeral-sandbox.js';

const name = z.string().trim().min(1).max(255);
const project = z.union([z.number().int().positive(), name]);
export const schemas = {
  detent_list_projects: { search: z.string().optional() },
  detent_checkout_worktree: { project, branch_name: name, base_branch: name.optional() },
  detent_close_worktree: { directory_name: name },
  detent_commit_and_push: { directory_name: name, commit_message: z.string().min(1) },
  detent_create_mr: {
    project,
    source_branch: name,
    target_branch: name,
    title: name,
    description: z.string().default(''),
  },
  detent_get_pipeline_status: { project, ref_or_mr_iid: project },
  detent_get_pipeline_job_log: { project, job_id: z.number().int().positive() },
};
export type ToolName = keyof typeof schemas;
export const mrWorkspaceTools = ['detent_commit_and_push', 'detent_get_pipeline_status', 'detent_get_pipeline_job_log'] as const satisfies readonly ToolName[];
export function isWorkspaceTool(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}
// Checkout is read-only in plan mode because checkout() requires an existing remote branch.
export function allowedInPlan(name: ToolName) {
  return (
    name === 'detent_list_projects' ||
    name === 'detent_checkout_worktree' ||
    name === 'detent_get_pipeline_status' ||
    name === 'detent_get_pipeline_job_log'
  );
}
export class WorkspaceTools {
  constructor(
    private host: EphemeralSandbox,
    private sandbox: TurnSandbox,
    private sessionId: string,
    private plan = false,
    private lockedWorktree?: Pick<SessionWorktreeRow, 'directoryName' | 'branchName'>,
    private mr?: LiveMr,
  ) {}
  private async tree(name: string) {
    const row = (await this.host.repo.listActiveWorktrees(this.sessionId)).find(
      (t) => t.directoryName === name,
    );
    if (!row) throw Error('Unknown active worktree');
    return row;
  }
  private async push(t: SessionWorktreeRow, message: string) {
    const { host, sandbox: s } = this;
    if (this.lockedWorktree && (this.lockedWorktree.directoryName !== t.directoryName || this.lockedWorktree.branchName !== t.branchName))
      throw Error('Push is restricted to the MR worktree');
    const dir = await host.projectDir(s, t.directoryName);
    if (this.lockedWorktree && (await git(['branch', '--show-current'], dir, s.claudeHome)).trim() !== t.branchName)
      throw Error('Push is restricted to the MR source branch');
    await git(['add', '-A', '--', '.'], dir, s.claudeHome);
    if ((await git(['diff', '--cached', '--name-only'], dir, s.claudeHome)).trim() ||
        await fs.stat(dir + '/.git/MERGE_HEAD').then(() => true, () => false))
      await git(['commit', '-m', message], dir, s.claudeHome);
    const sha = (await git(['rev-parse', 'HEAD'], dir, s.claudeHome)).trim();
    await host.remote(s, dir, t.repoHttpUrl, ['push', t.repoHttpUrl, 'HEAD:refs/heads/' + t.branchName]);
    await git(['update-ref', 'refs/remotes/origin/' + t.branchName, sha], dir, s.claudeHome);
    s.mrMergeParent = undefined;
    await host.repo.updateWorktreeCheckpoint(t.id, sha, null);
    return sha;
  }
  invoke(tool: ToolName, raw: Record<string, unknown>): Promise<unknown> {
    return this.host.serialize(() => this.execute(tool, raw));
  }
  private async execute(tool: ToolName, raw: Record<string, unknown>): Promise<unknown> {
    const { gitlab, repo } = this.host;
    if (this.lockedWorktree && !mrWorkspaceTools.some(name => name === tool)) throw Error('Tool unavailable in MR sessions');
    if (this.plan && !allowedInPlan(tool)) throw Error('Plan mode is read-only');
    switch (tool) {
      case 'detent_list_projects':
        return gitlab.listProjects(z.object(schemas[tool]).parse(raw).search);
      case 'detent_checkout_worktree': {
        const i = z.object(schemas[tool]).parse(raw);
        const tree = await this.host.checkout(this.sandbox, this.sessionId, i.project, i.branch_name, i.base_branch, this.plan);
        return tree.directoryName;
      }
      case 'detent_close_worktree': {
        const t = await this.tree(z.object(schemas[tool]).parse(raw).directory_name);
        await this.host.checkpointTree(this.sandbox, t);
        await repo.archiveWorktree(t.id);
        await fs.rm(await this.host.projectDir(this.sandbox, t.directoryName), {
          recursive: true,
          force: true,
        });
        return t.directoryName;
      }
      case 'detent_commit_and_push': {
        const i = z.object(schemas[tool]).parse(raw);
        return this.push(await this.tree(i.directory_name), i.commit_message);
      }
      case 'detent_create_mr': {
        const i = z.object(schemas[tool]).parse(raw);
        const p = await gitlab.getProject(i.project);
        const botId = gitlab.getBotIdentity?.()?.id;
        const mr = await gitlab.createMergeRequest(p.id, { ...i, ...(botId && { assignee_ids: [botId] }) });
        const tree = (await repo.listActiveWorktrees(this.sessionId)).find(
          (t) => t.targetProjectId === p.id && t.branchName === mr.source_branch,
        );
        return repo.upsertMergeRequest({
          sessionId: this.sessionId,
          worktreeId: tree?.id ?? null,
          targetProjectId: p.id,
          targetProjectPath: p.path_with_namespace,
          mrIid: mr.iid,
          mrTitle: mr.title,
          mrWebUrl: mr.web_url,
          mrState: mr.state,
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
          latestPipelineId: null,
          latestPipelineStatus: null,
        });
      }
      case 'detent_get_pipeline_status': {
        const i = z.object(schemas[tool]).parse(raw);
        const p = await gitlab.getProject(i.project);
        if (this.mr && !(p.id === this.mr.target_project_id && i.ref_or_mr_iid === this.mr.iid) &&
            !(p.id === this.mr.source_project_id && i.ref_or_mr_iid === this.mr.source_branch))
          throw Error('Pipeline is outside this MR');
        const [pipeline] = await gitlab.listPipelines(p.id, i.ref_or_mr_iid);
        return pipeline ? { pipeline, jobs: await gitlab.getPipelineJobs(pipeline.project_id ?? p.id, pipeline.id) } : null;
      }
      case 'detent_get_pipeline_job_log': {
        const i = z.object(schemas[tool]).parse(raw);
        const p = await gitlab.getProject(i.project);
        return gitlab.getJobTrace(p.id, i.job_id, this.mr);
      }
    }
  }
}
