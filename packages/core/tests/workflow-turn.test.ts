import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { defineExtensionTool, GitLabClient, loadConfig, SessionOrchestrator } from '../src/index.js';
import type { TurnInput } from '../src/claude/runner.js';
import { EphemeralSandbox, git } from '../src/workspace/ephemeral-sandbox.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { bareProjects } from './bare-projects.js';

it('posts only redacted preflight guidance and preserves the stored permission mode', async () => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'issue');
  const config = loadConfig({});
  const client = new GitLabClient(config);
  const note = vi.spyOn(client, 'createIssueNote').mockResolvedValue({ id: 1 });
  const sync = vi.spyOn(client, 'syncIssueStatusLabel').mockResolvedValue();
  const prepare = vi.spyOn(EphemeralSandbox.prototype, 'prepareTurnSandbox');
  const run = vi.fn();
  const update = vi.spyOn(repo, 'updateSessionState');
  try {
    const orchestrator = new SessionOrchestrator(config, repo, client, { run }, {
      resolveTurnProfile: () => ({ blockedMessage: '请配置 https://oauth2:secret@git/group/app' }),
    });
    await orchestrator.resumeSession(session.id, 'continue', { permissionMode: 'default' });
    expect(note.mock.calls).toEqual([[1, 2, '请配置 https://oauth2:***@git/group/app']]);
    expect(sync.mock.calls).toEqual([[1, 2, 'IDLE']]);
    expect(update.mock.calls).toEqual([[session.id, { status: 'IDLE' }]]);
    expect(await repo.getSession(session.id)).toMatchObject({
      status: 'IDLE', permissionMode: 'plan', claudeSessionId: null, activeNoteId: null, lockedByPod: null,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

it('mounts Hub workflow files without symlinks and protects only root governance paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-workflow-'));
  try {
    const projects = await bareProjects(root);
    const seed = path.join(root, 'seed');
    await mkdir(path.join(seed, 'workflows'));
    await writeFile(path.join(seed, 'workflows/release.md'), '# Procedure');
    await symlink('../CLAUDE.md', path.join(seed, 'workflows/linked.md'));
    await git(['add', 'workflows'], seed, root);
    await git(['commit', '-m', 'Add workflow'], seed, root);
    await git(['push', path.join(root, '1.git'), 'main'], seed, root);

    const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
    const gitlab = {
      ...projects, createIssueNote: vi.fn().mockResolvedValue({ id: 1 }), updateIssueNote: vi.fn(),
      syncIssueStatusLabel: vi.fn(), hasApprovalPermission: vi.fn(), getIssue: vi.fn(),
    };
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 2, 'workflow');
    const tool = defineExtensionTool({ name: 'inspect', policy: 'readonly', description: 'Inspect', schema: {}, execute: vi.fn() });
    const runner = { async run({ gate, sandbox }: TurnInput) {
      expect([...gate.extensionTools.keys()]).toEqual(['mcp__detent__base', 'mcp__detent__inspect']);
      const workspace = sandbox.workspaceRoot;
      expect(await readdir(path.join(workspace, 'workflows'))).toEqual(['release.md']);
      expect(await readFile(path.join(workspace, 'workflows/release.md'), 'utf8')).toBe('# Procedure');
      await symlink('.', path.join(workspace, 'alias'));
      for (const file_path of ['CLAUDE.md', 'workflows/release.md', 'WorkFlows/new.md', 'claude.MD', 'alias/WorkFlows/new.md']) {
        for (const action of ['Edit', 'Write'])
          expect(await gate.preflight(action, { file_path }), file_path).toMatchObject({ behavior: 'deny' });
        expect(await gate.preflight('Read', { file_path }), file_path).toMatchObject({ behavior: 'allow' });
      }
      for (const file_path of ['projects/app/CLAUDE.md', 'projects/app/workflows/ci.yml'])
        expect(await gate.preflight('Write', { file_path }), file_path).toMatchObject({ behavior: 'allow' });
      return 'verified';
    } };
    const orchestrator = new SessionOrchestrator(config, repo, gitlab, runner, {
      tools: [{ ...tool, name: 'base' }],
      capabilities: [
        { name: 'enabled', enabled: true, tools: [tool] },
        { name: 'disabled', enabled: false, tools: [{ ...tool, name: 'excluded' }] },
      ],
    });
    await orchestrator.resumeSession(session.id, 'verify', { permissionMode: 'default' });
    expect(gitlab.updateIssueNote.mock.lastCall?.[3]).toContain('verified');
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
