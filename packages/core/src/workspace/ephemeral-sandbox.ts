import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { GitLabClient } from '../gitlab/client.js';
import { redactGitUrl } from '../gitlab/client.js';
import type { IssueSessionRow, SessionWorktreeRow } from '../types.js';

export interface TurnSandbox {
  rootDir: string;
  claudeHome: string;
  workspaceRoot: string;
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
>;

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
  async prepareTurnSandbox(session: IssueSessionRow): Promise<TurnSandbox> {
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
      const hub = await this.gitlab.getProject(session.hubProjectId);
      const dir = path.join(rootDir, 'hub');
      await this.clone(s, hub.http_url_to_repo, this.config.gitlabHubDefaultBranch, dir);
      for (const name of (await fs.readdir(dir)).filter(
        (name) => name === 'CLAUDE.md' || name === '.claude',
      )) {
        const source = path.join(dir, name);
        await fs.cp(source, path.join(s.workspaceRoot, name), {
          recursive: true,
          filter: async (file) => !(await fs.lstat(file)).isSymbolicLink(),
        });
      }
      await fs.rm(dir, { recursive: true, force: true });
      for (const t of await this.repo.listActiveWorktrees(session.id)) {
        await this.restoreTree(s, t);
      }
      return s;
    } catch (error) {
      await this.destroy(s);
      throw error;
    }
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
    if (t.uncommittedDiff)
      await git(['apply', '--whitespace=nowarn', '-'], target, s.claudeHome, t.uncommittedDiff);
  }
  async checkpointTree(s: TurnSandbox, t: SessionWorktreeRow) {
    const dir = await this.projectDir(s, t.directoryName);
    // A local-only commit must also survive destruction. Use the last remote ref as patch base.
    const base = (await git(['rev-parse', 'refs/remotes/origin/' + t.branchName], dir, s.claudeHome)).trim();
    await git(['add', '-N', '--', '.'], dir, s.claudeHome);
    const patch = await git(
      ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--', '.'],
      dir,
      s.claudeHome,
    );
    await this.repo.updateWorktreeCheckpoint(t.id, base, patch || null);
  }
  async checkpoint(s: TurnSandbox, id: string) {
    for (const t of await this.repo.listActiveWorktrees(id)) await this.checkpointTree(s, t);
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
