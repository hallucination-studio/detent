import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGitLabReleaseCapability, createGitLabReleaseTools, type ReleaseGitLab } from '../src/index.js';
import { ColdHold, PermissionGate } from '../src/claude/permission-gate.js';
import { loadConfig } from '../src/config.js';
import { InMemoryDetentRepository } from './memory-repository.js';

const sha = 'abcdef0123'.repeat(4);
const input = { project: 'group/app', tag_name: 'stable/v1', commit_sha: sha };
const tag = { name: 'stable/v1', commit: { id: sha }, message: null };
const url = 'https://git.example/group/app/-/releases/stable%2Fv1';

async function setup(blockFailedPipeline = true) {
  const gitlab = {
    getProject: vi.fn().mockResolvedValue({ id: 7, path_with_namespace: 'group/app' }),
    listTags: vi.fn().mockResolvedValue([tag, { ...tag, name: 'v0' }]),
    getTag: vi.fn().mockResolvedValue(null),
    getCommit: vi.fn().mockResolvedValue({ id: sha, title: 'Ready' }),
    listPipelinesBySha: vi.fn().mockResolvedValue([]),
    createPipeline: vi.fn(), getPipeline: vi.fn(), listPipelines: vi.fn(), getPipelineJobs: vi.fn(),
    createTag: vi.fn().mockResolvedValue(tag),
    createRelease: vi.fn().mockResolvedValue({ tag_name: tag.name, _links: { self: url } }),
  } satisfies ReleaseGitLab;
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 42, 'test');
  session.permissionMode = 'default';
  const ctx = { session, repo, permissionMode: session.permissionMode, workspaceRoot: '/workspace' };
  const [list, release, trigger, wait] = createGitLabReleaseTools({ gitlab, blockFailedPipeline });
  return { gitlab, ctx, list, release, trigger, wait };
}

it('registers the optional pack and lists bounded, searchable tags', async () => {
  const { gitlab, ctx, list } = await setup();
  const pack = createGitLabReleaseCapability({ gitlab });
  expect(pack).toMatchObject({ name: 'gitlab-release', enabled: true, tools: [
    { name: 'detent_list_tags', policy: 'readonly' }, { name: 'detent_create_release', policy: 'always_approve' },
    { name: 'detent_trigger_pipeline', policy: 'coding_auto' }, { name: 'detent_await_pipeline', policy: 'readonly' },
  ] });
  const schema = z.object(list.schema);
  expect(schema.safeParse({ project: 0 }).success).toBe(false);
  expect(schema.safeParse({ project: 7, limit: 101 }).success).toBe(false);
  const args = schema.parse({ project: ' group/app ', search: ' ^v ', limit: 1 });
  expect(await list.execute(args, ctx)).toEqual([{ name: tag.name, commitSha: sha, message: null }]);
  expect(gitlab.getProject).toHaveBeenCalledWith('group/app');
  expect(gitlab.listTags).toHaveBeenCalledWith(7, '^v');
});

it('rejects unsafe ref names and abbreviated or malformed SHAs before any GitLab calls', async () => {
  const { release, ctx, gitlab } = await setup();
  const schema = z.object(release.schema);
  for (const tag_name of ['', 'a'.repeat(129), 'v 1', 'v\t1', 'v\x071', 'r..1', 'a~1', 'x^', 'x:y',
    'a?', 'a*', 'a[b', 'a\\b', '/a', 'a/', '.a', 'a.', 'x.lock', 'a//b', 'a/.hidden', 'a@{b']) {
    const invalid = { ...input, tag_name };
    expect(schema.safeParse(invalid).success, tag_name).toBe(false);
    expect(await release.guard!(invalid, ctx)).toMatchObject({ ok: false });
  }
  for (const commit_sha of ['main', sha.slice(1), sha + '\n', 'x'.repeat(40)]) {
    const invalid = { ...input, commit_sha };
    expect(schema.safeParse(invalid).success).toBe(false);
    expect(await release.guard!(invalid, ctx)).toMatchObject({ ok: false });
  }
  expect(gitlab.getProject).not.toHaveBeenCalled();
  expect(schema.parse({ ...input, commit_sha: sha.toUpperCase() })).toMatchObject({ commit_sha: sha, tag_only: false });
});

it('checks commit existence, tag availability and the newest pipeline in order', async () => {
  const { release, gitlab, ctx } = await setup();
  gitlab.getCommit.mockResolvedValueOnce(null);
  expect(await release.guard!(input, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('提交') });
  expect(gitlab.getTag).not.toHaveBeenCalled();
  gitlab.getTag.mockResolvedValueOnce(tag);
  expect(await release.guard!(input, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('已存在') });
  expect(gitlab.listPipelinesBySha).not.toHaveBeenCalled();
  gitlab.listPipelinesBySha.mockResolvedValueOnce([{ id: 2, status: 'success' }, { id: 3, status: 'failed' }])
    .mockResolvedValueOnce([{ id: 2, status: 'failed' }, { id: 3, status: 'success' }]);
  expect(await release.guard!(input, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('流水线') });
  expect(await release.guard!(input, ctx)).toEqual({ ok: true });
  expect(await release.guard!(input, ctx)).toEqual({ ok: true });
  expect(gitlab.getCommit).toHaveBeenCalledWith(7, sha);
  expect(gitlab.getTag).toHaveBeenCalledWith(7, input.tag_name);
  expect(gitlab.listPipelinesBySha).toHaveBeenCalledWith(7, sha);
  const unblocked = await setup(false);
  expect(await unblocked.release.guard!(input, ctx)).toEqual({ ok: true });
  expect(unblocked.gitlab.listPipelinesBySha).not.toHaveBeenCalled();
});

it('escapes approval fields and quick actions and truncates only the notes preview', async () => {
  const { release, ctx, gitlab } = await setup();
  const notes = '# Heading\r/close\r\n/label ~other\n' + '文'.repeat(800) + 'end-of-release-notes';
  const card = await release.renderApprovalCard!('approval', { ...input, release_name: 'v1|beta\n/close', release_notes: notes }, ctx);
  for (const field of ['<sub>审批单 `approval`</sub>', '| 目标仓库 | `group/app` |', '| Tag / 模式 | `stable/v1`（创建 Git Tag + GitLab Release） |',
    '| 锁定提交 | `' + sha + '` |', '| Release 名称 | v1\\|beta /close |', '<details><summary>Release Notes 预览</summary>',
    '# Heading\n\\/close\n\\/label ~other'])
    expect(card).toContain(field);
  expect(card).not.toMatch(/^\/(close|label)/m);
  expect(card).toContain('…');
  expect(card).not.toContain('end-of-release-notes');
  expect(card).toMatch(/👍.*\/approve.*👎.*\/reject/);
  const tagOnly = await release.renderApprovalCard!('approval', { ...input, tag_only: true }, ctx);
  expect(tagOnly).toContain('仅创建 Git Tag');
  expect(tagOnly).not.toMatch(/Release 名称|<details>/);
  await release.execute({ ...input, release_name: 'v1', release_notes: notes }, { ...ctx, approvalId: 'approval' });
  expect(gitlab.createRelease).toHaveBeenCalledWith(7, { tag_name: input.tag_name, ref: sha, name: 'v1', description: notes });
});

it('requires approval and writes exactly one tag or release at the pinned SHA', async () => {
  const { release, ctx, gitlab } = await setup();
  await expect(release.execute(input, ctx)).rejects.toThrow('审批单');
  expect(gitlab.getProject).not.toHaveBeenCalled();
  const approved = { ...ctx, approvalId: 'approved' };
  expect(await release.execute(input, approved)).toEqual({
    project: input.project, tagName: tag.name, commitSha: sha, mode: 'release', releaseUrl: url,
  });
  expect(gitlab.createRelease).toHaveBeenCalledWith(7, { tag_name: tag.name, ref: sha, name: tag.name, description: '' });
  expect(gitlab.createTag).not.toHaveBeenCalled();
  expect(await release.execute({ ...input, tag_only: true }, approved)).toEqual({
    project: input.project, tagName: tag.name, commitSha: sha, mode: 'tag', releaseUrl: null,
  });
  expect(gitlab.createTag).toHaveBeenCalledWith(7, { tag_name: tag.name, ref: sha });
  expect(gitlab.createRelease).toHaveBeenCalledOnce();
});

it('rechecks the tag after a human approves the card', async () => {
  const { release, ctx, gitlab } = await setup();
  const notes = { createIssueNote: vi.fn().mockResolvedValue({ id: 41 }), syncIssueStatusLabel: vi.fn() };
  const context = {
    ...ctx, gitlab: notes, extensionTools: [release], checkpoint: vi.fn(),
    config: loadConfig({}), controller: new AbortController(),
  };
  const tool = 'mcp__detent__detent_create_release';
  await expect(new PermissionGate(context).invokeExtension(tool, input)).rejects.toBeInstanceOf(ColdHold);
  gitlab.getTag.mockResolvedValue(tag);
  const approval = (await ctx.repo.getLatestPendingApproval(ctx.session.id))!;
  await ctx.repo.resolveApprovalRequest(approval.id, 'APPROVED', 'dev');
  const resumed = new PermissionGate({ ...context, controller: new AbortController(), previousDecision: (await ctx.repo.getApproval(approval.id))! });
  await expect(resumed.invokeExtension(tool, input)).rejects.toThrow('已存在');
  expect(gitlab.createRelease).not.toHaveBeenCalled();
  expect(gitlab.createTag).not.toHaveBeenCalled();
});

it('reports a concurrent tag change when GitLab returns a release on another commit', async () => {
  const { release, ctx, gitlab } = await setup();
  gitlab.createRelease.mockResolvedValueOnce({ tag_name: tag.name, commit: { id: 'f'.repeat(40) } });
  await expect(release.execute(input, { ...ctx, approvalId: 'approved' })).rejects.toThrow('提交与审批 SHA 不一致');
  expect(gitlab.createRelease).toHaveBeenCalledOnce();
});

it('subscribes to an explicit ref or pipeline ID, returns terminal jobs, and closes the registration race', async () => {
  const { gitlab, ctx, trigger, wait } = await setup();
  const pipeline = { id: 91, ref: 'main', status: 'pending', web_url: 'https://git.example/pipelines/91' };
  const jobs = [{ id: 3, name: 'test', status: 'success' }];
  const args = { project: 7, ref: 'main', variables: { RELEASE_TAG: 'v2' } };
  const triggerSchema = z.object(trigger.schema);
  for (const key of ['', '9INVALID', 'BAD-KEY', 'A B']) expect(triggerSchema.safeParse({ ...args, variables: { [key]: 'v' } }).success).toBe(false);
  const full = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['VAR_' + i, 'x'.repeat(1000)]));
  expect(triggerSchema.safeParse({ ...args, variables: full }).success).toBe(true);
  for (const variables of [{ ...full, EXTRA: '' }, { LONG: 'x'.repeat(1001) }, { ['X'.repeat(256)]: '' }])
    expect(triggerSchema.safeParse({ ...args, variables }).success).toBe(false);
  gitlab.createPipeline.mockResolvedValue(pipeline);
  gitlab.getPipeline.mockResolvedValue(pipeline);
  gitlab.listPipelines.mockResolvedValue([]);
  gitlab.getPipelineJobs.mockResolvedValue(jobs);
  const awaitTarget = (target: string | number) => wait.execute({ project: 7, ref_or_pipeline_id: target }, ctx);
  expect(await trigger.execute(triggerSchema.parse(args), ctx)).toMatchObject({ pipelineId: 91, status: 'pending', webUrl: pipeline.web_url, asyncCallback: true });
  expect(gitlab.createPipeline).toHaveBeenCalledExactlyOnceWith(7, { ref: 'main', variables: args.variables });
  expect(await awaitTarget('v2')).toMatchObject({ watching: true, pipelineId: null });
  expect(await awaitTarget(91)).toMatchObject({ watching: true, pipelineId: 91 });
  expect(await ctx.repo.listSessionPipelineWatches(ctx.session.id)).toMatchObject([
    { targetProjectId: 7, pipelineId: 91, refName: 'main' }, { pipelineId: null, refName: 'v2' }, { pipelineId: 91 },
  ]);
  for (const status of ['success', 'failed', 'skipped', 'canceled']) {
    gitlab.listPipelines.mockResolvedValueOnce([{ ...pipeline, status }]);
    expect(await awaitTarget('main')).toMatchObject({ status, jobs, pipelineId: 91 });
  }
  gitlab.getPipeline.mockRejectedValueOnce(Error('GitLab HTTP 404'));
  await expect(awaitTarget(92)).rejects.toThrow('404');
  expect(await ctx.repo.listSessionPipelineWatches(ctx.session.id)).toHaveLength(3);
  gitlab.getPipeline.mockResolvedValueOnce({ ...pipeline, status: 'success' });
  expect(await trigger.execute(args, ctx)).toMatchObject({ status: 'success', pipelineId: 91 });
  expect((await ctx.repo.listSessionPipelineWatches(ctx.session.id)).map(w => w.status)).toEqual(['PENDING', 'PENDING', 'PENDING', 'RESOLVED']);
  gitlab.getPipeline.mockRejectedValueOnce(Error('GitLab HTTP 503'));
  expect(await trigger.execute(args, ctx)).toMatchObject({ pipelineId: 91, asyncCallback: true, verificationError: 'GitLab HTTP 503' });
  expect((await ctx.repo.listSessionPipelineWatches(ctx.session.id)).at(-1)?.status).toBe('PENDING');
});
