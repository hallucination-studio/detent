import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
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
  ) {}
  private pending: Promise<unknown> = Promise.resolve();
  private async tree(name: string) {
    const row = (await this.host.repo.listActiveWorktrees(this.sessionId)).find(
      (t) => t.directoryName === name,
    );
    if (!row) throw Error('Unknown active worktree');
    return row;
  }
  private async checkout(input: z.infer<z.ZodObject<typeof schemas.detent_checkout_worktree>>) {
    const { host, sandbox: s } = this;
    const p = await host.gitlab.getProject(input.project);
    const branch = input.branch_name;
    const base = input.base_branch ?? p.default_branch;
    const existing = await host.repo.findWorktree(this.sessionId, p.id, branch);
    if (existing) {
      if (existing.status === 'ARCHIVED') {
        await host.restoreTree(s, existing);
        const { id, createdAt, updatedAt, ...fields } = existing;
        await host.repo.upsertWorktree({ ...fields, status: 'ACTIVE' });
      }
      return existing.directoryName;
    }
    for (const b of [branch, base])
      await git(['check-ref-format', '--branch', b], s.workspaceRoot, s.claudeHome);
    const directoryName =
      (p.path_with_namespace.split('/').pop() + '__' + branch).replace(/[^\w.-]/g, '-').slice(0, 96) +
      '-' +
      createHash('sha256')
        .update(p.id + '/' + branch)
        .digest('hex')
        .slice(0, 12);
    const dir = await host.projectDir(s, directoryName, false);
    const url = p.http_url_to_repo;
    const exists = (
      await host.remote(s, s.workspaceRoot, url, ['ls-remote', '--heads', '--', url, 'refs/heads/' + branch])
    ).trim();
    if (!exists && this.plan) throw Error('Plan mode requires an existing remote branch');
    await fs.mkdir(dir); // Never remove an existing directory on a failed clone.
    try {
      await host.clone(s, url, exists ? branch : base, dir);
      if (!exists) {
        await git(['switch', '-c', branch], dir, s.claudeHome);
        await host.remote(s, dir, url, ['push', url, 'HEAD:refs/heads/' + branch]);
        await git(['update-ref', 'refs/remotes/origin/' + branch, 'HEAD'], dir, s.claudeHome);
      }
      await host.repo.upsertWorktree({
        sessionId: this.sessionId,
        targetProjectId: p.id,
        targetProjectPath: p.path_with_namespace,
        repoHttpUrl: url,
        directoryName,
        branchName: branch,
        baseBranch: base,
        lastCommitSha: (await git(['rev-parse', 'HEAD'], dir, s.claudeHome)).trim(),
        uncommittedDiff: null,
        status: 'ACTIVE',
      });
      return directoryName;
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  private async push(t: SessionWorktreeRow, message: string) {
    const { host, sandbox: s } = this;
    const dir = await host.projectDir(s, t.directoryName);
    await git(['add', '-A', '--', '.'], dir, s.claudeHome);
    if ((await git(['diff', '--cached', '--name-only'], dir, s.claudeHome)).trim())
      await git(['commit', '-m', message], dir, s.claudeHome);
    const sha = (await git(['rev-parse', 'HEAD'], dir, s.claudeHome)).trim();
    await host.remote(s, dir, t.repoHttpUrl, ['push', t.repoHttpUrl, 'HEAD:refs/heads/' + t.branchName]);
    await git(['update-ref', 'refs/remotes/origin/' + t.branchName, sha], dir, s.claudeHome);
    await host.repo.updateWorktreeCheckpoint(t.id, sha, null);
    return sha;
  }
  invoke(tool: ToolName, raw: Record<string, unknown>): Promise<unknown> {
    const operation = this.pending.then(() => this.execute(tool, raw));
    this.pending = operation.catch(() => {});
    return operation;
  }
  private async execute(tool: ToolName, raw: Record<string, unknown>): Promise<unknown> {
    const { gitlab, repo } = this.host;
    if (this.plan && !allowedInPlan(tool)) throw Error('Plan mode is read-only');
    switch (tool) {
      case 'detent_list_projects':
        return gitlab.listProjects(z.object(schemas[tool]).parse(raw).search);
      case 'detent_checkout_worktree':
        return this.checkout(z.object(schemas[tool]).parse(raw));
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
        const mr = await gitlab.createMergeRequest(p.id, i);
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
        const [pipeline] = await gitlab.listPipelines(p.id, i.ref_or_mr_iid);
        return pipeline ? { pipeline, jobs: await gitlab.getPipelineJobs(p.id, pipeline.id) } : null;
      }
      case 'detent_get_pipeline_job_log': {
        const i = z.object(schemas[tool]).parse(raw);
        return gitlab.getJobTrace((await gitlab.getProject(i.project)).id, i.job_id);
      }
    }
  }
}
