import { renderApprovalCard } from '../gitlab/note-streamer.js';
import { z } from 'zod';
import { defineExtensionTool, type ExtensionToolContext, type TurnProfile } from '../extensions.js';

export async function checkIssueClosure(
  profile: TurnProfile, { session, repo, permissionMode, approvalId }: Pick<ExtensionToolContext, 'session' | 'repo' | 'permissionMode' | 'approvalId'>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!profile.readonly && permissionMode === 'plan') return { ok: false, reason: '方案尚未批准，禁止关闭工单' };
  const pending = await repo.getLatestPendingApproval(session.id);
  if (pending && pending.id !== approvalId) return { ok: false, reason: '尚有待审批项，禁止关闭工单' };
  const mrs = await repo.listSessionMergeRequests(session.id);
  if (mrs.some(mr => mr.mrState === 'opened')) return { ok: false, reason: '尚有未合并的 MR，禁止关闭工单' };
  if ((await repo.listSessionPipelineWatches(session.id)).some(w => w.status === 'PENDING'))
    return { ok: false, reason: '尚有等待终态的流水线，禁止关闭工单' };
  return profile.canCloseIssue?.({ session, repo }) ?? { ok: true };
}

export function createCloseIssueTool(profile: TurnProfile, schedule: (request: { summary: string }) => void) {
  if (profile.closePolicy !== 'auto' && profile.closePolicy !== 'approve') return;
  return defineExtensionTool({
    name: 'detent_close_issue',
    description: '全部验收条件满足后登记关单请求，轮末复核通过后关闭工单。',
    schema: { summary: z.string().trim().min(1).max(2000) },
    policy: profile.closePolicy === 'approve' ? 'always_approve' : 'readonly',
    guard: (_input, ctx) => checkIssueClosure(profile, ctx),
    renderApprovalCard(approvalId, { summary }) {
      return renderApprovalCard({ icon: '✅', title: '工单闭环关闭审批', approvalId,
        rows: [['操作', '验收通过后关闭本工单']], body: summary,
        approverHint: profile.workflow?.approverTier === 'prod' ? '生产审批人' : '项目成员' });
    },
    async execute({ summary }) {
      schedule({ summary });
      return { scheduled: true, summary };
    },
  });
}
