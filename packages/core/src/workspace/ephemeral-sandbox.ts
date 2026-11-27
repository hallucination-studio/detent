import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { SandboxScope } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { redactGitUrl } from '../gitlab/client.js';
import type { IssueSessionRow, SessionWorktreeRow } from '../types.js';
import { isHubPathSegment } from './hub-paths.js';

export interface TurnSandbox {
  rootDir: string;
  claudeHome: string;
  workspaceRoot: string;
  mrMergeParent?: string;
}
export type WorkspaceGitLab = Pick<
  GitLabClient,
  | 'getProject'
  | 'buildAuthenticatedCloneUrl'
  | 'listProjects'
  | 'createMergeRequest'
  | 'listPipelines'
  | 'getPipelineJobs'
  | 'getJobTrace'
> & Partial<Pick<GitLabClient, 'getBotIdentity'>>;

export function git(args: string[], cwd: string, home: string, input = '', auth?: URL): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Detent',
    GIT_AUTHOR_EMAIL: 'detent@localhost',
    GIT_COMMITTER_NAME: 'Detent',
    GIT_COMMITTER_EMAIL: 'detent@localhost',
  };
  if (auth?.password) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.' + auth.origin + '/.extraHeader';
    env.GIT_CONFIG_VALUE_0 =
      'Authorization: Basic ' + Buffer.from('oauth2:' + decodeURIComponent(auth.password)).toString('base64');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'http.followRedirects=false',
        ...args,
      ],
      { cwd, env, stdio: 'pipe' },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_000_000) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2048);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString())
        : reject(Error('git ' + args[0] + ' failed: ' + redactGitUrl(stderr))),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export class EphemeralSandbox {
  constructor(
    readonly config: AppConfig,
    readonly repo: DetentRepository,
    readonly gitlab: WorkspaceGitLab,
  ) {}
  private pending: Promise<unknown> = Promise.resolve();
  serialize<T>(operation: () => Promise<T>) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  async projectDir(s: TurnSandbox, name: string, existing = true) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) throw Error('Invalid worktree directory');
    const parent = path.join(s.workspaceRoot, 'projects');
    if ((await fs.realpath(parent)) !== parent) throw Error('Invalid projects path');
    const dir = path.join(parent, name);
    if (existing && (await fs.realpath(dir)) !== dir) throw Error('Invalid worktree path');
    return dir;
  }
  remote(s: TurnSandbox, cwd: string, url: string, args: string[]) {
    const auth = new URL(this.gitlab.buildAuthenticatedCloneUrl(url));
    return git(args, cwd, s.claudeHome, '', auth);
  }
  async clone(s: TurnSandbox, url: string, branch: string, dir: string) {
    await git(['check-ref-format', '--branch', branch], s.workspaceRoot, s.claudeHome);
    await this.remote(s, s.workspaceRoot, url, [
      'clone',
      '--depth=1',
      '--single-branch',
      '--branch',
      branch,
      '--',
      url,
      dir,
    ]);
  }
  async ensureMrWorktree(s: TurnSandbox, sessionId: string, mr: { sourceProjectId: number; sourceBranch: string; targetBranch: string }) {
    return this.checkout(s, sessionId, mr.sourceProjectId, mr.sourceBranch, mr.targetBranch, true);
  }
  async checkout(s: TurnSandbox, sessionId: string, project: string | number, branch: string, baseBranch: string | undefined, existingOnly: boolean) {
    const p = await this.gitlab.getProject(project);
    const base = baseBranch ?? p.default_branch;
    const existing = await this.repo.findWorktree(sessionId, p.id, branch);
    if (existing) {
      if (existing.status === 'ARCHIVED') {
        await this.restoreTree(s, existing);
        const { id, createdAt, updatedAt, ...fields } = existing;
        return this.repo.upsertWorktree({ ...fields, baseBranch: base, status: 'ACTIVE' });
      }
      return existing;
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
    const dir = await this.projectDir(s, directoryName, false);
    const url = p.http_url_to_repo;
    const exists = (
      await this.remote(s, s.workspaceRoot, url, ['ls-remote', '--heads', '--', url, 'refs/heads/' + branch])
    ).trim();
    if (!exists && existingOnly) throw Error('Checkout requires an existing remote branch');
    await fs.mkdir(dir); // Never remove an existing directory on a failed clone.
    try {
      await this.clone(s, url, exists ? branch : base, dir);
      if (!exists) {
        await git(['switch', '-c', branch], dir, s.claudeHome);
        await this.remote(s, dir, url, ['push', url, 'HEAD:refs/heads/' + branch]);
        await git(['update-ref', 'refs/remotes/origin/' + branch, 'HEAD'], dir, s.claudeHome);
      }
      return await this.repo.upsertWorktree({
        sessionId,
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
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  async prepareTurnSandbox(session: IssueSessionRow, scope?: SandboxScope): Promise<TurnSandbox> {
    await fs.mkdir(this.config.ephemeralRoot, { recursive: true });
    const rootDir = path.join(await fs.realpath(this.config.ephemeralRoot), 'turn-' + randomUUID());
    await fs.mkdir(rootDir, { mode: 0o700 });
    const s = {
      rootDir,
      claudeHome: path.join(rootDir, 'home'),
      workspaceRoot: path.join(rootDir, 'workspace'),
    };
    try {
      await fs.mkdir(s.claudeHome);
      await fs.mkdir(path.join(s.workspaceRoot, 'projects'), { recursive: true });
      if (session.sessionKind === 'issue') await this.copyHub(s, session.hubProjectId, scope);
      for (const t of await this.repo.listActiveWorktrees(session.id)) {
        await this.restoreTree(s, t);
      }
      return s;
    } catch (error) {
      await this.destroy(s);
      throw error;
    }
  }
  private async copyHub(s: TurnSandbox, project: number, scope?: SandboxScope) {
    const hub = await this.gitlab.getProject(project);
    const dir = path.join(s.rootDir, 'hub');
    await this.clone(s, hub.http_url_to_repo, this.config.gitlabHubDefaultBranch, dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const copy = (name: string) => fs.cp(path.join(dir, name), path.join(s.workspaceRoot, name), {
      recursive: true,
      filter: async (file) => !(await fs.lstat(file)).isSymbolicLink(),
    });
    const common = !scope?.agentDir ? ['CLAUDE.md', '.claude', 'agents', 'skills'] : ['CLAUDE.md', '.claude'];
    for (const entry of entries) {
      if (common.includes(entry.name)) await copy(entry.name);
    }
    const agentDir = scope?.agentDir;
    if (agentDir && isHubPathSegment(agentDir) && entries.some(entry => entry.name === 'agents' && entry.isDirectory())) {
      const agents = await fs.readdir(path.join(dir, 'agents'), { withFileTypes: true });
      if (agents.some(entry => entry.name === agentDir && entry.isDirectory())) await copy(path.join('agents', agentDir));
    }
    const sharedSkills = new Set(scope?.sharedSkills?.filter(isHubPathSegment).map(name => name.toLowerCase()));
    if (sharedSkills.size && entries.some(entry => entry.name === 'skills' && entry.isDirectory())) {
      const skills = await fs.readdir(path.join(dir, 'skills'), { withFileTypes: true });
      // Match normalized names while preserving the Hub's spelling for Read paths.
      const names = skills.filter(entry => entry.isDirectory() && isHubPathSegment(entry.name)).map(entry => entry.name).sort();
      for (const skill of sharedSkills) {
        const matches = names.filter(name => name.toLowerCase() === skill);
        let selected = matches[0];
        if (matches.length > 1) {
          // If directories differ only by case, follow the manifest used by the loader.
          for (const name of matches) {
            const children = await fs.readdir(path.join(dir, 'skills', name), { withFileTypes: true });
            if (children.some(entry => entry.name === 'SKILL.md' && !entry.isDirectory())) {
              selected = name;
              break;
            }
          }
        }
        if (selected) await copy(path.join('skills', selected));
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
  async restoreTree(s: TurnSandbox, t: SessionWorktreeRow) {
    const target = await this.projectDir(s, t.directoryName, false);
    await this.clone(s, t.repoHttpUrl, t.branchName, target);
    if (
      t.lastCommitSha &&
      t.lastCommitSha !== (await git(['rev-parse', 'HEAD'], target, s.claudeHome)).trim() &&
      t.uncommittedDiff
    ) {
      await this.remote(s, target, t.repoHttpUrl, ['fetch', '--depth=1', t.repoHttpUrl, t.lastCommitSha]);
      await git(['reset', '--hard', 'FETCH_HEAD'], target, s.claudeHome);
      await git(['update-ref', 'refs/remotes/origin/' + t.branchName, 'FETCH_HEAD'], target, s.claudeHome);
    }
    if (t.uncommittedDiff) {
      // A patch preserves the files. A suspended MR merge also needs its second parent.
      const header = /^Detent-Merge-Parent: ([a-f0-9]{40,64})\n/.exec(t.uncommittedDiff);
      const patch = t.uncommittedDiff.slice(header?.[0].length ?? 0);
      if (patch) await git(['apply', '--whitespace=nowarn', '-'], target, s.claudeHome, patch);
      if (header) {
        const session = await this.repo.getSession(t.sessionId);
        if (session?.sessionKind !== 'mr') throw Error('Expected an MR merge checkpoint');
        const project = await this.gitlab.getProject(session.hubProjectId);
        await this.remote(s, target, project.http_url_to_repo, ['fetch', '--no-tags', '--', project.http_url_to_repo, header[1]]);
        await fs.writeFile(path.join(target, '.git', 'MERGE_HEAD'), header[1] + '\n');
        s.mrMergeParent = header[1];
      }
    }
  }
  async checkpointTree(s: TurnSandbox, t: SessionWorktreeRow) {
    const dir = await this.projectDir(s, t.directoryName);
    // A local-only commit must also survive destruction. Use the last remote ref as patch base.
    const base = (await git(['rev-parse', 'refs/remotes/origin/' + t.branchName], dir, s.claudeHome)).trim();
    // Only add untracked paths. Adding '.' also overwrites unresolved merge index entries.
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], dir, s.claudeHome);
    if (untracked) await git(['--literal-pathspecs', 'add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], dir, s.claudeHome, untracked);
    const patch = await git(
      ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--', '.'],
      dir,
      s.claudeHome,
    );
    const header = s.mrMergeParent ? 'Detent-Merge-Parent: ' + s.mrMergeParent + '\n' : '';
    await this.repo.updateWorktreeCheckpoint(t.id, base, (header + patch) || null);
  }
  checkpoint(s: TurnSandbox, id: string) {
    return this.serialize(async () => {
      for (const t of await this.repo.listActiveWorktrees(id)) await this.checkpointTree(s, t);
    });
  }
  async destroy(s: TurnSandbox) {
    await fs.rm(s.rootDir, { recursive: true, force: true });
  }
  async checkpointAndDestroySandbox(s: TurnSandbox, id: string) {
    try {
      await this.checkpoint(s, id);
    } finally {
      await this.destroy(s);
    }
  }
}
