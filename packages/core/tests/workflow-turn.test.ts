import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { defineExtensionTool, GitLabClient, loadConfig, SessionOrchestrator, type SandboxScope } from '../src/index.js';
import type { TurnInput } from '../src/claude/runner.js';
import { EphemeralSandbox, git } from '../src/workspace/ephemeral-sandbox.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { bareProjects } from './bare-projects.js';

it('posts only redacted preflight guidance and preserves the stored permission mode', async () => {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'issue');
  const config = loadConfig({});
  const client = new GitLabClient(config);
  vi.spyOn(client, 'getRepositoryFile').mockResolvedValue(null);
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
    expect(note.mock.calls).toEqual([[1, 2, '请配置 https://oauth2:***@git/group/app\n\n> 💡 发送 `/help` 可随时查看当前工作区的能力与指令。']]);
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

it('mounts Hub playbooks without symlinks and protects only root governance paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-workflow-'));
  try {
    const projects = await bareProjects(root);
    const seed = path.join(root, 'seed');
    await mkdir(path.join(seed, 'agents/release'), { recursive: true });
    await writeFile(path.join(seed, 'agents/release/AGENT.md'), '# Procedure');
    await symlink('../../CLAUDE.md', path.join(seed, 'agents/release/linked.md'));
    await git(['add', 'agents'], seed, root);
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
      expect(await readdir(path.join(workspace, 'agents/release'))).toEqual(['AGENT.md']);
      expect(await readFile(path.join(workspace, 'agents/release/AGENT.md'), 'utf8')).toBe('# Procedure');
      await symlink('.', path.join(workspace, 'alias'));
      for (const file_path of ['CLAUDE.md', 'events.json', 'capabilities.json', 'alias/CapAbilities.json', 'agents/release/AGENT.md', 'Agents/new.md', 'claude.MD', 'alias/Agents/new.md']) {
        for (const action of ['Edit', 'Write'])
          expect(await gate.preflight(action, { file_path }), file_path).toMatchObject({ behavior: 'deny' });
        expect(await gate.preflight('Read', { file_path }), file_path).toMatchObject({ behavior: 'allow' });
      }
      for (const command of ['echo data > events.json', 'rm alias/events.json', 'echo data >capabilities.json', 'rm alias/capabilities.json'])
        expect(await gate.preflight('Bash', { command })).toMatchObject({ behavior: 'deny' });
      for (const file_path of ['projects/app/CLAUDE.md', 'projects/app/workflows/ci.yml', 'projects/app/events.json', 'projects/app/capabilities.json'])
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

it('projects a turn’s selected Agent and shared skills and protects the root paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-agent-'));
  try {
    const projects = await bareProjects(root);
    const seed = path.join(root, 'seed');
    const files = {
      '.claude/settings.json': '{}',
      'agents/Deploy/AGENT.md': '# Deploy', 'agents/Deploy/skills/Local/SKILL.md': '# Local',
      'agents/Other/AGENT.md': '# Other', 'skills/Shared/SKILL.md': '# Shared', 'skills/Unused/SKILL.md': '# Unused',
    };
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(seed, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await symlink('../CLAUDE.md', path.join(seed, '.claude/linked.md'));
    await symlink('../Other', path.join(seed, 'agents/Deploy/linked'));
    await symlink('Unused', path.join(seed, 'skills/Alias'));
    await symlink('../Unused', path.join(seed, 'skills/Shared/linked'));
    await git(['add', '.'], seed, root);
    await git(['commit', '-m', 'Add scoped Hub content'], seed, root);
    await git(['push', path.join(root, '1.git'), 'main'], seed, root);

    const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns'), SAFE_BASH_PREFIXES: 'touch,cat' });
    const gitlab = {
      ...projects, createIssueNote: vi.fn().mockResolvedValue({ id: 1 }), updateIssueNote: vi.fn(),
      syncIssueStatusLabel: vi.fn(), hasApprovalPermission: vi.fn(), getIssue: vi.fn(),
    };
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 2, 'scoped');
    const sandboxScope: SandboxScope = { agentDir: 'Deploy', sharedSkills: ['shared', 'alias', 'missing', '../agents/Other'] };
    const run = vi.fn(async ({ gate, sandbox }: TurnInput) => {
      const workspace = sandbox.workspaceRoot;
      expect((await readdir(workspace)).sort()).toEqual(['.claude', 'CLAUDE.md', 'agents', 'projects', 'skills']);
      expect(await readdir(path.join(workspace, '.claude'))).toEqual(['settings.json']);
      expect(await readdir(path.join(workspace, 'agents'))).toEqual(['Deploy']);
      expect((await readdir(path.join(workspace, 'agents/Deploy'))).sort()).toEqual(['AGENT.md', 'skills']);
      expect(await readdir(path.join(workspace, 'skills'))).toEqual(['Shared']);
      expect(await readdir(path.join(workspace, 'skills/Shared'))).toEqual(['SKILL.md']);
      expect(await readFile(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe('hub rules');
      expect(await readFile(path.join(workspace, 'agents/Deploy/skills/Local/SKILL.md'), 'utf8')).toBe('# Local');
      expect(await readFile(path.join(workspace, 'skills/Shared/SKILL.md'), 'utf8')).toBe('# Shared');

      await symlink('agents/Deploy', path.join(workspace, 'agent alias'));
      await symlink('skills', path.join(workspace, 'skill-alias'));
      await symlink('skills/Shared/missing.md', path.join(workspace, 'dangling-skill-alias'));
      const protectedPaths = ['agents/Deploy/AGENT.md', 'AGENTS/Deploy/new.md', 'skills/Shared/SKILL.md',
        'SkIlLs/Shared/new=notes.md', 'agent alias/new.md', 'skill-alias/Shared/new.md'];
      for (const file_path of protectedPaths) {
        for (const action of ['Write', 'Edit'])
          expect(await gate.preflight(action, { file_path }), file_path).toMatchObject({ behavior: 'deny' });
        expect(await gate.preflight('Read', { file_path }), file_path).toMatchObject({ behavior: 'allow' });
        expect(await gate.preflight('Bash', { command: `touch "${file_path}"` }), file_path).toMatchObject({ behavior: 'deny' });
      }
      expect(await gate.preflight('Bash', { command: 'touch dangling-skill-alias' })).toMatchObject({ behavior: 'deny' });
      expect(await gate.preflight('Bash', { command: 'unlink skills/Shared/SKILL.md' })).toMatchObject({ behavior: 'deny' });
      for (const file_path of ['agents/Deploy/AGENT.md', 'skills/Shared/SKILL.md']) {
        expect(await gate.preflight('Bash', { command: 'cat ' + file_path })).toMatchObject({ behavior: 'allow' });
      }
      for (const file_path of ['projects/app/agents/new.md', 'projects/app/skills/new.md']) {
        expect(await gate.preflight('Write', { file_path })).toMatchObject({ behavior: 'allow' });
        expect(await gate.preflight('Bash', { command: 'touch ' + file_path })).toMatchObject({ behavior: 'allow' });
      }
      return 'Agent projection verified';
    });
    const orchestrator = new SessionOrchestrator(config, repo, gitlab, { run }, { resolveTurnProfile: () => ({ sandboxScope }) });
    await orchestrator.resumeSession(session.id, 'verify', { permissionMode: 'default' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(gitlab.updateIssueNote.mock.lastCall?.[3]).toContain('Agent projection verified');
    expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });
    expect(await readdir(config.ephemeralRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('skips symlinked projection roots and unsafe paths when a scope is supplied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-scoped-roots-'));
  try {
    const gitlab = await bareProjects(root);
    const seed = path.join(root, 'seed');
    await mkdir(path.join(seed, 'hidden/Example'), { recursive: true });
    await writeFile(path.join(seed, 'hidden/Example/AGENT.md'), '# Hidden');
    await symlink('hidden', path.join(seed, 'agents'));
    await symlink('hidden', path.join(seed, 'skills'));
    await git(['add', '.'], seed, root);
    await git(['commit', '-m', 'Add symlinked projection roots'], seed, root);
    await git(['push', path.join(root, '1.git'), 'main'], seed, root);

    const config = loadConfig({ EPHEMERAL_ROOT: path.join(root, 'turns') });
    const repo = new InMemoryDetentRepository();
    const session = await repo.getOrCreateSession(1, 2, 'scoped');
    const host = new EphemeralSandbox(config, repo, gitlab);
    for (const scope of [{}, { agentDir: 'Example', sharedSkills: ['example'] }, { agentDir: '../hidden/Example' }]) {
      const sandbox = await host.prepareTurnSandbox(session, scope);
      try {
        expect((await readdir(sandbox.workspaceRoot)).sort()).toEqual(['CLAUDE.md', 'projects']);
      } finally {
        await host.destroy(sandbox);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires a submitted plan for a unified change and keeps ordinary diagnostic replies idle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'detent-unified-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = new InMemoryDetentRepository();
  const config = loadConfig({ EPHEMERAL_ROOT: root, DETENT_SECRET_PRIVATE: 'server-only-value' });
  const gitlab = { ...await bareProjects(root), createIssueNote: vi.fn(async () => ({ id: 7 })),
    updateIssueNote: vi.fn(), syncIssueStatusLabel: vi.fn(), getIssue: vi.fn(), hasApprovalPermission: vi.fn(async () => true) };
  const run = vi.fn<((turn: TurnInput) => Promise<string>)>();
  const pod = new SessionOrchestrator(config, repo, gitlab, { run });
  const session = await repo.getOrCreateSession(1, 2, 'Inspect service');
  const actor = { username: 'dev', userId: 7 };
  run.mockResolvedValueOnce('Service is healthy.');
  await pod.resumeSession(session.id, 'inspect');
  expect(await repo.getLatestPendingApproval(session.id)).toBeNull();
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE' });

  run.mockImplementationOnce(async ({ gate }) => {
    for (const name of ['Write', 'Edit', 'detent_commit_and_push', 'detent_create_mr', 'Bash'])
      expect(await gate.preflight(name, { command: 'touch file', file_path: 'file' }))
        .toMatchObject({ behavior: 'deny', message: expect.stringContaining('detent_submit_plan') });
    const submit = 'mcp__detent__detent_submit_plan';
    await expect(gate.invokeExtension(submit, { plan: 'server-only-value' })).rejects.toThrow('凭证');
    expect(await gate.invokeExtension(submit, { plan: 'Change the config and run tests.' })).toMatchObject({ submitted: true });
    return 'Waiting for review.';
  });
  await pod.handleUserIntent(1, 2, { ...actor, type: 'PROMPT', comment: 'Fix config' });
  const card = await repo.getLatestPendingApproval(session.id);
  expect(card).toMatchObject({ approvalType: 'PLAN', toolInput: {} });
  expect(gitlab.updateIssueNote.mock.lastCall?.[3]).toContain('Change the config and run tests.');
  expect(gitlab.updateIssueNote.mock.lastCall?.[3]).not.toContain('Waiting for review.');
  run.mockImplementationOnce(async ({ gate }) => {
    expect(gate.extensionTools.has('mcp__detent__detent_submit_plan')).toBe(false);
    expect(await gate.preflight('Edit', { file_path: 'config' })).toMatchObject({ behavior: 'allow' });
    return 'Implemented.';
  });
  await pod.handleUserIntent(1, 2, { ...actor, type: 'APPROVE', targetNoteId: card!.gitlabNoteId! });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'IDLE', permissionMode: 'plan' });
  run.mockResolvedValueOnce('A specifically requested plan.');
  await pod.handleUserIntent(1, 2, { ...actor, type: 'PLAN' });
  expect(await repo.getSession(session.id)).toMatchObject({ status: 'WAITING_PLAN' });
  expect(gitlab.updateIssueNote.mock.lastCall?.[3]).toContain('A specifically requested plan.');
});
