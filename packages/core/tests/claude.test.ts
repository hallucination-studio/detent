import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openModelTransport } from '../src/claude/model-transport.js';

import { it, expect, vi } from 'vitest';
import { mkdtemp, realpath, appendFile, readFile, rm, symlink, link, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { InMemoryDetentRepository } from './memory-repository.js';
import { PermissionGate, ColdHold } from '../src/claude/permission-gate.js';
import { schemas } from '../src/workspace/mcp-tools.js';
import { TranscriptHydrator, transcriptPath } from '../src/claude/transcript-hydrator.js';

async function setup() {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'test');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'detent-claude-')));
  const gitlab = { createIssueNote: vi.fn(async () => ({ id: 20 })), syncIssueStatusLabel: vi.fn() };
  const ctx = {
    config: loadConfig({}),
    repo,
    session,
    workspaceRoot: root,
    gitlab,
    controller: new AbortController(),
    checkpoint: vi.fn(),
  };
  return { root, repo, session, ctx, gate: new PermissionGate(ctx) };
}
it('hydrates exact lines and appends only new sequences, including repeated checkpoints', async () => {
  const { repo, root, session } = await setup();
  try {
    session.claudeSessionId = 'session-1';
    session.lastMessageSeq = 3;
    const raw = (n: number) => JSON.stringify({ uuid: 'u' + n, type: 'assistant', n });
    await repo.appendIncrementalMessages(
      session.id,
      [1, 2, 3].map((n) => ({ seq: n, messageType: 'assistant', messageUuid: 'u' + n, rawJsonLine: raw(n) })),
    );
    const spy = vi.spyOn(repo, 'appendIncrementalMessages');
    const hydrator = new TranscriptHydrator(repo);
    await hydrator.hydrateTranscriptToTmp(session, root, root);
    const file = transcriptPath(root, root, session.claudeSessionId);
    expect(await readFile(file, 'utf8')).toBe([1, 2, 3].map(raw).join('\n') + '\n');
    await appendFile(file, [4, 5].map(raw).join('\n') + '\n');
    for (let i = 0; i < 2; i++)
      await hydrator.flushIncrementalTranscriptToMySql(session, root, root, session.claudeSessionId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].map((m) => m.seq)).toEqual([4, 5]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('scrubs credentials from nested transcript values before checkpoint and resume', async () => {
  const { repo, root, session } = await setup();
  try {
    session.claudeSessionId = 'session-2';
    const hydrator = new TranscriptHydrator(repo, ['value"with-quotes', 'extension-token', '12345']);
    const file = transcriptPath(root, root, session.claudeSessionId);
    await mkdir(path.dirname(file), { recursive: true });
    const line = { uuid: 'u1', message: { 'value"with-quotes': 12345, content: [{ text: 'value"with-quotes extension-token https://oauth2:private@host/repo' }] } };
    await writeFile(file, JSON.stringify(line) + '\n');
    await hydrator.flushIncrementalTranscriptToMySql(session, root, root, session.claudeSessionId);
    const [record] = await repo.getSessionMessages(session.id);
    expect(JSON.parse(record.rawJsonLine)).toEqual({ uuid: 'u1', message: { '***': '***', content: [{ text: '*** *** https://oauth2:***@host/repo' }] } });
    await hydrator.hydrateTranscriptToTmp(session, root, root);
    expect(await readFile(file, 'utf8')).toBe(record.rawJsonLine + '\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('disables Bash in plan and readonly modes regardless of legacy safe prefixes', async () => {
  const { root, session, ctx } = await setup();
  try {
    const config = loadConfig({ SAFE_BASH_PREFIXES: 'git status, sudo' });
    expect(config.safeBashPrefixes).toEqual(['git status', 'sudo']);
    for (const mode of ['plan', 'default'] as const) {
      session.permissionMode = mode;
      const gate = new PermissionGate({ ...ctx, config, profile: { readonly: mode === 'default' } });
      for (const command of ['git status', 'sh check.sh', 'sudo id'])
        expect(await gate.canUseTool('Bash', { command })).toMatchObject({ behavior: 'deny' });
    }
    const coding = new PermissionGate({ ...ctx, config });
    expect(await coding.canUseTool('Bash', { command: 'npm test' })).toMatchObject({ behavior: 'allow' });
    expect(await coding.canUseTool('Bash', { command: 'sudo id' })).toMatchObject({ behavior: 'deny' });
    const input = { command: 'git push' };
    const legacy = await ctx.repo.createApprovalRequest(session.id, 'TOOL_USE', 'Bash', input);
    await ctx.repo.resolveApprovalRequest(legacy.id, 'APPROVED', 'dev');
    const replay = new PermissionGate({ ...ctx, previousDecision: (await ctx.repo.getApproval(legacy.id))! });
    expect(await replay.canUseTool('Bash', input)).toMatchObject({ behavior: 'deny' });
    expect(ctx.checkpoint).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('checks the existing path prefix and protects workspace metadata on writes', async () => {
  const { gate, root, session } = await setup();
  try {
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'src', 'file'), 'data');
    await link(path.join(root, 'src', 'file'), path.join(root, 'hardlink'));
    await symlink('src', path.join(root, 'inside'));
    await symlink('.git', path.join(root, 'metadata'));
    await symlink(path.dirname(root), path.join(root, 'outside'));
    await symlink(path.join(path.dirname(root), 'missing-' + path.basename(root)), path.join(root, 'dangling'));

    expect(await gate.canUseTool('Edit', { file_path: 'src/file' })).toMatchObject({ behavior: 'deny' });
    session.permissionMode = 'default';
    for (const tool of ['Read', 'Write']) {
      for (const file_path of ['../secret', '~/.claude/settings.json', 'outside', 'outside/new/file', 'dangling', 'dangling/file'])
        expect(await gate.canUseTool(tool, { file_path }), file_path).toMatchObject({ behavior: 'deny' });
      for (const file_path of ['inside/file', 'inside/new/file', 'new/sub/file', 'hardlink'])
        expect(await gate.canUseTool(tool, { file_path }), file_path).toMatchObject({ behavior: 'allow' });
    }
    for (const file_path of ['.git/config', '.claude/settings.json', 'src/.mcp.json', 'metadata/new/file']) {
      expect(await gate.canUseTool('Write', { file_path }), file_path).toMatchObject({ behavior: 'deny' });
      expect(await gate.canUseTool('Read', { file_path }), file_path).toMatchObject({ behavior: 'allow' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('automatically allows every registered workspace tool after plan approval', async () => {
  const { gate, session, ctx, root } = await setup();
  try {
    for (const name of ['detent_commit_and_push', 'detent_create_mr', 'detent_close_worktree'])
      expect(await gate.preflight(name, {})).toMatchObject({ behavior: 'deny' });

    for (const name of ['detent_list_projects', 'detent_checkout_worktree', 'detent_get_pipeline_status', 'detent_get_pipeline_job_log'])
      expect(await gate.preflight(name, {})).toMatchObject({ behavior: 'allow' });
    session.permissionMode = 'default';
    for (const name of Object.keys(schemas))
      expect(await gate.canUseTool('mcp__detent__' + name, {})).toMatchObject({ behavior: 'allow' });
    expect(await gate.preflight('detent_unknown', {})).toMatchObject({ behavior: 'deny' });
    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each(['APPROVED', 'REJECTED'] as const)('suspends and replays a tool approval %s', async (status) => {
  const { repo, session, ctx, root } = await setup();
  try {
    session.permissionMode = 'default';
    const tool = { name: 'release', policy: 'always_approve' as const, schema: {}, description: 'Release', execute: vi.fn() };
    const options = { ...ctx, extensionTools: [tool] };
    const gate = new PermissionGate(options);
    const input = {};
    await expect(gate.canUseTool('mcp__detent__release', input)).rejects.toBeInstanceOf(ColdHold);
    expect(ctx.controller.signal.reason).toBeInstanceOf(ColdHold);
    expect(ctx.checkpoint).toHaveBeenCalledOnce();
    expect(await repo.getApprovalByNoteId(session.id, 20)).toMatchObject({
      status: 'PENDING',
      approvalType: 'TOOL_USE',
    });
    const row = (await repo.getLatestPendingApproval(session.id))!;
    await repo.resolveApprovalRequest(row.id, status, 'dev', 'because');
    const resumed = new PermissionGate({ ...options, controller: new AbortController(), previousDecision: (await repo.getApproval(row.id))! });
    expect(await resumed.canUseTool('mcp__detent__release', input)).toMatchObject(
      status === 'APPROVED' ? { behavior: 'allow' } : { behavior: 'deny', message: 'because' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('suspends immediately and retains the pending question for another pod', async () => {
  const { repo, session, ctx, gate, root } = await setup();
  try {
    await expect(
      gate.canUseTool('AskUserQuestion', { questions: [{ question: 'Which branch?' }] }),
    ).rejects.toBeInstanceOf(ColdHold);
    expect(ctx.controller.signal.aborted).toBe(true);
    expect(await repo.getLatestPendingApproval(session.id)).toMatchObject({ approvalType: 'ASK_USER' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('normalizes SDK models for messages and token counts before forwarding upstream', async () => {
  const config = loadConfig({ CLAUDE_MODEL: 'custom-gateway-model-v1' });
  const requests: { path?: string; model: string }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, model: JSON.parse(Buffer.concat(chunks).toString()).model });
    res.end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    const base = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port;
    const proxy = await openModelTransport(base, '', [], config.claudeModel);
    try {
      for (const [path, model] of [['/v1/messages', 'claude-sonnet-4'], ['/v1/messages/count_tokens', 'claude-3-5-haiku-latest']]) {
        const response = await fetch(proxy.url + path, { method: 'POST', headers: { authorization: 'Bearer detent-local' },
          body: JSON.stringify({ model, messages: [] }) });
        expect(response.status).toBe(200);
      }
      expect(requests).toEqual(['/v1/messages', '/v1/messages/count_tokens'].map(path => ({ path, model: config.claudeModel })));
    } finally { proxy.close(); }
  } finally { upstream.close(); upstream.closeAllConnections(); }
});
