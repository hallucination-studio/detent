import { z } from 'zod';
import { defineExtensionTool, type AnyDetentExtensionTool, type DetentCapabilityPack, type ExtensionToolContext } from '../extensions.js';
import { escapeTableCell, renderNote } from '../gitlab/note-streamer.js';
import { isTerminalPipeline, redactGitUrl, type GitLabClient } from '../gitlab/client.js';
import { logError } from '../gitlab/redact.js';

export type ReleaseGitLab = Pick<GitLabClient,
  'getProject' | 'listTags' | 'getCommit' | 'getTag' | 'listPipelinesBySha' | 'createTag' | 'createRelease' |
  'createPipeline' | 'getPipeline' | 'listPipelines' | 'getPipelineJobs'
>;
interface ReleaseOptions {
  gitlab: ReleaseGitLab;
  blockFailedPipeline?: boolean;
}

const project = z.union([z.number().int().positive(), z.string().trim().min(1).max(255)]);
const pipelineRef = z.string().trim().min(1).max(255);
const pipelineVariables = z.record(z.string().max(255).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(1000))
  .refine(vars => Object.keys(vars).length <= 20, '每次最多传入 20 个流水线变量');
const tagName = z.string().min(1).max(128).refine(name =>
  !/[\s\p{Cc}~^:?*\[\\]/u.test(name) && !name.includes('..') && !name.includes('@{') &&
  !name.endsWith('.') && name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')),
  '无效的 Tag 名称',
);
const commitSha = z.string().length(40).regex(/^[0-9a-f]{40}$/i).toLowerCase();
const releaseSchema = {
  project, tag_name: tagName, commit_sha: commitSha,
  release_name: z.string().max(255).optional(), release_notes: z.string().max(16000).optional(),
  tag_only: z.boolean().default(false),
};

export function createGitLabReleaseTools({ gitlab, blockFailedPipeline }: ReleaseOptions): AnyDetentExtensionTool[] {
  type Pipeline = Awaited<ReturnType<ReleaseGitLab['getPipeline']>>;
  async function watch(ctx: ExtensionToolContext, projectId: number, ref: string, pipeline: Pipeline | undefined, triggered: boolean) {
    const result = (p?: Pipeline) => ({ pipelineId: p?.id ?? null, status: p?.status ?? null, webUrl: p?.web_url ?? null, ref });
    const terminal = async (p: Pipeline) => ({
      ...result(p), ...(!triggered && { jobs: await gitlab.getPipelineJobs(projectId, p.id) }),
    });
    if (pipeline && isTerminalPipeline(pipeline.status)) return terminal(pipeline);
    const id = await ctx.repo.createPipelineWatch(ctx.session.id, projectId, pipeline?.id ?? null, ref);
    // A short pipeline may finish between the GitLab read and the committed subscription.
    let latest: Pipeline | undefined;
    let verificationError: string | undefined;
    try {
      latest = pipeline ? await gitlab.getPipeline(projectId, pipeline.id) : (await gitlab.listPipelines(projectId, ref))[0];
    } catch (error) {
      // The trigger and its watch are already committed. Report the read error without inviting another POST.
      verificationError = logError('pipeline-watch', error);
    }
    if (latest && isTerminalPipeline(latest.status) &&
        (await ctx.repo.resolveMatchingPipelineWatches(projectId, latest.id, ref, { onlyWatchId: id })).length) return terminal(latest);
    return { ...result(latest ?? pipeline), asyncCallback: true, ...(!triggered && { watching: true }), ...(verificationError && { verificationError }),
      nextAction: triggered ? '流水线已触发并登记终态回调，请结束本轮等待自动唤醒。' : '已登记流水线终态回调，请结束本轮等待自动唤醒。' };
  }
  return [
    defineExtensionTool({
      name: 'detent_list_tags', description: 'List Git tags and their commit SHAs', policy: 'readonly',
      schema: { project, search: z.string().trim().max(128).optional(), limit: z.number().int().positive().max(100).optional() },
      async execute({ project, search, limit }) {
        const p = await gitlab.getProject(project);
        const tags = await gitlab.listTags(p.id, search);
        return tags.slice(0, limit ?? 100).map(tag => ({ name: tag.name, commitSha: tag.commit.id, message: tag.message }));
      },
    }),
    defineExtensionTool({
      name: 'detent_create_release', description: 'Create a Git tag or GitLab release at an approved commit',
      policy: 'always_approve', schema: releaseSchema,
      async guard(input) {
        if (!tagName.safeParse(input.tag_name).success) return { ok: false, reason: '无效的 Tag 名称' };
        const sha = commitSha.safeParse(input.commit_sha);
        if (!sha.success) return { ok: false, reason: '需要完整的 40 位 Commit SHA' };
        const p = await gitlab.getProject(input.project);
        if (!(await gitlab.getCommit(p.id, sha.data))) return { ok: false, reason: '目标仓库不存在该提交' };
        if (await gitlab.getTag(p.id, input.tag_name)) return { ok: false, reason: '目标 Tag 已存在' };
        if (blockFailedPipeline !== false) {
          const pipelines = await gitlab.listPipelinesBySha(p.id, sha.data);
          const latest = [...pipelines].sort((a, b) => b.id - a.id)[0];
          if (latest?.status === 'failed') return { ok: false, reason: '目标提交的最新流水线失败' };
        }
        return { ok: true };
      },
      async renderApprovalCard(approvalId, input) {
        const p = await gitlab.getProject(input.project);
        const notes = Array.from(redactGitUrl(input.release_notes ?? '').trim());
        const preview = notes.slice(0, 512).join('') + (notes.length > 512 ? '…' : '');
        const mode = input.tag_only ? '仅创建 Git Tag' : '创建 Git Tag + GitLab Release';
        const name = input.release_name;
        const table = [
          '| 项目 | 内容 |', '| :--- | :--- |',
          '| 目标仓库 | ' + escapeTableCell(p.path_with_namespace, 'code') + ' |',
          '| Tag / 模式 | ' + escapeTableCell(input.tag_name, 'code') + '（' + mode + '） |',
          '| 锁定提交 | ' + escapeTableCell(input.commit_sha.toLowerCase(), 'code') + ' |',
          !input.tag_only && name && name !== input.tag_name && '| Release 名称 | ' + escapeTableCell(name) + ' |',
        ].filter(Boolean).join('\n');
        return renderNote([
          '### 🚀 GitLab 发布审批', table,
          preview && '<details><summary>Release Notes 预览</summary>\n\n' + preview + '\n\n</details>',
          '> 👍 或 `/approve` 放行 · 👎 或 `/reject <原因>` 拒绝 · <sub>审批单 `' + approvalId + '`</sub>',
        ].filter(Boolean).join('\n\n'));
      },
      async execute(input, ctx) {
        if (!ctx.approvalId) throw Error('发布缺少审批单');
        const p = await gitlab.getProject(input.project);
        const sha = commitSha.parse(input.commit_sha);
        const tag = { tag_name: input.tag_name, ref: sha };
        let releaseUrl: string | null = null;
        if (input.tag_only) {
          await gitlab.createTag(p.id, tag);
        } else {
          const release = await gitlab.createRelease(p.id, {
            ...tag, name: input.release_name ?? tag.tag_name, description: input.release_notes ?? '',
          });
          // GitLab uses an existing tag if another writer creates it after the guard.
          if (release.commit && release.commit.id.toLowerCase() !== sha)
            throw Error('GitLab 已创建 Release，但返回的提交与审批 SHA 不一致，请核查目标 Tag。');
          releaseUrl = release._links?.self ?? null;
        }
        return {
          project: p.path_with_namespace, tagName: tag.tag_name, commitSha: sha,
          mode: input.tag_only ? 'tag' : 'release', releaseUrl,
        };
      },
    }),
    defineExtensionTool({
      name: 'detent_trigger_pipeline', description: '触发目标仓库流水线。未结束时自动登记终态回调。', policy: 'coding_auto',
      schema: { project, ref: pipelineRef, variables: pipelineVariables.optional() },
      async execute({ project, ref, variables }, ctx) {
        const p = await gitlab.getProject(project);
        return watch(ctx, p.id, ref, await gitlab.createPipeline(p.id, { ref, variables }), true);
      },
    }),
    defineExtensionTool({
      name: 'detent_await_pipeline', description: '等待指定流水线 ID 或分支/Tag 的最新流水线。仅在用户或 SOP 明确要求等待时订阅尚未出现的 ref。',
      policy: 'readonly', schema: { project, ref_or_pipeline_id: z.union([z.number().int().positive(), pipelineRef]) },
      async execute({ project, ref_or_pipeline_id: target }, ctx) {
        const p = await gitlab.getProject(project);
        if (typeof target === 'number') {
          const pipeline = await gitlab.getPipeline(p.id, target);
          return watch(ctx, p.id, pipeline.ref, pipeline, false);
        }
        return watch(ctx, p.id, target, (await gitlab.listPipelines(p.id, target))[0], false);
      },
    }),
  ];
}

export function createGitLabReleaseCapability(options: ReleaseOptions): DetentCapabilityPack {
  return { name: 'gitlab-release', enabled: true, tools: createGitLabReleaseTools(options) };
}
