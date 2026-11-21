import type { WebhookExtension } from '@detent/core';
import { z } from 'zod';

const id = z.number().int().positive();
const mergeEvent = z.object({
  object_kind: z.literal('merge_request'),
  project: z.object({ id, path_with_namespace: z.string().optional() }),
  user: z.object({ id: id.optional(), username: z.string().trim().min(1) }),
  object_attributes: z.object({
    iid: id,
    action: z.literal('merge'),
    state: z.literal('merged').optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    merge_commit_sha: z.string().nullish(),
    last_commit: z.object({ id: z.string() }).nullish(),
  }),
});

export const matchMergeRequestWebhook: WebhookExtension = (event) => {
  const parsed = mergeEvent.safeParse(event);
  if (!parsed.success) return null;
  const { project, user, object_attributes: attrs } = parsed.data;
  const sha = attrs.merge_commit_sha || attrs.last_commit?.id || null;
  return {
    key: `mr/${project.id}/${attrs.iid}`,
    async handle(orchestrator) {
      const { repo, gitlab } = orchestrator;
      for (const mr of await repo.findMergeRequest(project.id, attrs.iid)) {
        if (mr.mrState === 'merged') continue;
        const ref = `${project.path_with_namespace ?? mr.targetProjectPath}!${attrs.iid}`;
        const url = mr.mrWebUrl;
        const branches = `${attrs.source_branch ?? mr.sourceBranch} → ${attrs.target_branch ?? mr.targetBranch}`;
        const prompt = `关联 MR ${ref} (${url}) 已由 @${user.username} 合并。分支 ${branches}，合并提交 SHA：${sha ?? '未知'}。请按已批准的方案继续下一步。`;
        await orchestrator.resumeSession(mr.sessionId, prompt, {
          permissionMode: 'default',
          async beforeRun(session) {
            if (!(await repo.markMergeRequestMerged(mr.id, sha, user.username))) return false;
            if (session.status === 'DONE') return false;
            const waiting = session.status === 'WAITING_PLAN' || session.status === 'WAITING_TOOL';
            const status = waiting ? '会话正在等待审批，审批后将继续。' : '正在自动恢复变更会话…';
            const commit = sha ? ` (commit ${sha.slice(0, 8)})` : '';
            await gitlab.createIssueNote(
              session.hubProjectId, session.hubIssueIid,
              `✅ 关联 MR [${ref}](<${url}>) 已由 @${user.username} 合并${commit}，${status}`,
            );
            return !waiting;
          },
        });
      }
    },
  };
};
