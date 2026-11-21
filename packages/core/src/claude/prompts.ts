import type { IssueSessionRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { schemas } from '../workspace/mcp-tools.js';
import { renderSummary } from '../gitlab/note-streamer.js';

function permissionPrompt(readonly: boolean, mode: IssueSessionRow['permissionMode']) {
  if (readonly) return '本轮仅允许只读操作，请直接返回检查结果。';
  if (mode === 'plan') return '当前只读。可以检出现有分支以分析需求。请直接返回跨项目实施方案，交由 GitLab 审批。';
  return '已获方案审批。仅在 projects 下修改获批范围内的项目，使用 detent_commit_and_push 推送提交。';
}

export function buildSystemPrompt(
  session: IssueSessionRow,
  trees: SessionWorktreeRow[],
  mrs: SessionMergeRequestRow[],
  readonly: boolean,
) {
  return [
    '你正在 GitLab 工作区项目 ' +
      session.hubProjectId +
      ' 的 Issue #' +
      session.hubIssueIid +
      ' 工作。标题为 ' +
      session.issueTitle,
    '每个 Issue 对应一个会话，可关联多个项目和 MR。',
    permissionPrompt(readonly, session.permissionMode),
    '使用 AskUserQuestion 向用户提问，通过以下 MCP 工具操作工作区。',
    ...Object.entries(schemas).map(([name, shape]) => name + ' (' + Object.keys(shape).join(', ') + ')'),
    renderSummary(trees, mrs),
  ].join('\n');
}
