import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { git, EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { loadConfig } from '../src/config.js';
import { GitLabError } from '../src/gitlab/client.js';

import { bareProjects } from './bare-projects.js';
it('restores two projects and binary, staged and untracked changes in another pod', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-git-'));
  try {
    const gitlab = await bareProjects(root);
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 42, 'test');
    const host = new EphemeralSandbox(loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') }), repo, gitlab);
    const first = await host.prepareTurnSandbox(session);
    const plan = new WorkspaceTools(host, first, session.id, true);
    await expect(plan.invoke('detent_checkout_worktree', { project: 2, branch_name: 'feat/42' }))
      .rejects.toThrow('当前为只读/方案阶段，仅允许检出现有远端分支（如 main）阅读代码；创建新特性分支请先提交方案并等待审批。');
    const tools = new WorkspaceTools(host, first, session.id);
    for (const project of [2, 3])
      await tools.invoke('detent_checkout_worktree', { project, branch_name: 'feat/42' });
    const [t] = await repo.listActiveWorktrees(session.id);
    const dir = await host.projectDir(first, t.directoryName);
    await writeFile(path.join(dir, 'tracked'), 'modified');
    await git(['add', 'tracked'], dir, first.claudeHome);
    const binary = Buffer.from([0, 1, 0, 255]);
    await writeFile(path.join(dir, 'binary'), binary);
    await host.checkpointAndDestroySandbox(first, session.id);
    expect(await readdir(host.config.ephemeralRoot)).toEqual([]);
    expect((await repo.listActiveWorktrees(session.id))[0].uncommittedDiff).toContain('GIT binary patch');
    const podB = new EphemeralSandbox(host.config, repo, gitlab);
    const next = await podB.prepareTurnSandbox(session);
    expect(next.rootDir).not.toBe(first.rootDir);
    const restored = await podB.projectDir(next, t.directoryName);
    expect(await readFile(path.join(restored, 'tracked'), 'utf8')).toBe('modified');
    expect(await readFile(path.join(restored, 'binary'))).toEqual(binary);
    expect(await readFile(path.join(next.workspaceRoot, 'CLAUDE.md'), 'utf8')).toBe('hub rules');
    const nextTools = new WorkspaceTools(podB, next, session.id);
    await nextTools.invoke('detent_close_worktree', { directory_name: t.directoryName });
    expect(await repo.listActiveWorktrees(session.id)).toHaveLength(1);
    await nextTools.invoke('detent_checkout_worktree', {
      project: t.targetProjectId,
      branch_name: t.branchName,
    });
    expect(await readFile(path.join(restored, 'binary'))).toEqual(binary);
    await nextTools.invoke('detent_commit_and_push', {
      directory_name: t.directoryName,
      commit_message: 'feature',
    });
    await podB.checkpointAndDestroySandbox(next, session.id);
    expect((await repo.listActiveWorktrees(session.id))[0].uncommittedDiff).toBeNull();
    expect(await readdir(host.config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it.each([
  { branch: 'main', base: undefined },
  { branch: 'release', base: 'release' },
  { branch: 'main', base: 'release' },
])('rejects a coding turn push to $branch checked out during planning with base $base', async ({ branch, base }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-base-branch-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const gitlab = await bareProjects(root);
  const remote = path.join(root, '2.git');
  await git(['branch', 'release', 'main'], remote, root);
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'test');
  const host = new EphemeralSandbox(loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') }), repo, gitlab);
  const sandbox = await host.prepareTurnSandbox(session);
  const plan = new WorkspaceTools(host, sandbox, session.id, true);
  await plan.invoke('detent_checkout_worktree', { project: 2, branch_name: branch, base_branch: base });
  const [tree] = await repo.listActiveWorktrees(session.id);
  const dir = await host.projectDir(sandbox, tree.directoryName);
  await writeFile(path.join(dir, 'tracked'), 'modified');
  const coding = new WorkspaceTools(host, sandbox, session.id);
  await expect(coding.invoke('detent_commit_and_push', { directory_name: tree.directoryName, commit_message: 'change' }))
    .rejects.toThrow('禁止直接推送到基线分支 ' + branch);
  expect((await git(['status', '--porcelain'], dir, sandbox.claudeHome)).trimEnd()).toBe(' M tracked');
  expect((await git(['rev-parse', 'refs/heads/' + branch], remote, root)).trim()).toBe(tree.lastCommitSha);
});

it('projects only shared conventions from the configured Hub into MR workspaces', async ({ onTestFinished }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-mr-hub-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const gitlab = await bareProjects(root);
  const seed = path.join(root, 'seed');
  for (const dir of ['skills/shared', 'agents/local', '.claude']) {
    await mkdir(path.join(seed, dir), { recursive: true });
    await writeFile(path.join(seed, dir, 'guide.md'), dir);
  }
  await symlink('../../tracked', path.join(seed, 'skills/shared/link'));
  await git(['add', '.'], seed, root);
  await git(['commit', '-m', 'Shared conventions'], seed, root);
  await git(['push', path.join(root, '3.git'), 'main'], seed, root);
  const repo = new InMemoryDetentRepository();
  const mr = await repo.getOrCreateMrSession(2, 42, 'review');
  const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), GITLAB_HUB_PROJECT_ID: '3' });
  const host = new EphemeralSandbox(config, repo, gitlab);
  const sandbox = await host.prepareTurnSandbox(mr);
  expect((await readdir(sandbox.workspaceRoot)).sort()).toEqual(['CLAUDE.md', 'projects', 'skills']);
  expect(await readFile(path.join(sandbox.workspaceRoot, 'CLAUDE.md'), 'utf8')).toBe('hub rules');
  expect(await readdir(path.join(sandbox.workspaceRoot, 'skills/shared'))).toEqual(['guide.md']);
  expect(await readFile(path.join(sandbox.workspaceRoot, 'skills/shared/guide.md'), 'utf8')).toBe('skills/shared');
  await host.destroy(sandbox);
});

it('skips inaccessible or missing MR Hubs and surfaces unexpected errors', async ({ onTestFinished }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-mr-no-hub-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const gitlab = await bareProjects(root);
  const repo = new InMemoryDetentRepository();
  const mr = await repo.getOrCreateMrSession(2, 42, 'review');
  const host = new EphemeralSandbox(loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') }), repo, gitlab);
  const getProject = vi.spyOn(gitlab, 'getProject');
  for (const status of [403, 404]) {
    getProject.mockRejectedValueOnce(new GitLabError(status));
    const sandbox = await host.prepareTurnSandbox(mr);
    expect(await readdir(sandbox.workspaceRoot)).toEqual(['projects']);
    await host.destroy(sandbox);
  }
  getProject.mockRejectedValueOnce(new GitLabError(500));
  await expect(host.prepareTurnSandbox(mr)).rejects.toThrow('500');
  vi.spyOn(host, 'clone').mockRejectedValueOnce(Error('disk full'));
  await expect(host.prepareTurnSandbox(mr)).rejects.toThrow('disk full');
  expect(await readdir(host.config.ephemeralRoot)).toEqual([]);
});
