import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { git, EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { loadConfig } from '../src/config.js';

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
      .rejects.toThrow('existing remote branch');
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
});
