import type { LiveMr, MergeRequestDiscussion, MergeRequestNote } from '../gitlab/client.js';
import type { IssueSessionRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { schemas } from '../workspace/mcp-tools.js';
import { renderSummary } from '../gitlab/note-streamer.js';

function permissionPrompt(readonly: boolean, mode: IssueSessionRow['permissionMode']) {
  if (readonly) return '本轮仅允许只读检查（不可修改文件或仓库）。完成检查后直接输出精炼结论，不要提及 plan 模式。';
  if (mode === 'plan') return '当前为方案阶段（只读）。只读问答直接报告证据；需要变更时调用 detent_submit_plan 提交精炼方案并结束本轮；严禁用 AskUserQuestion 询问“是否批准方案”。仅在缺少关键业务信息无法规划时才使用 AskUserQuestion。';
  return '已获方案审批。仅在新特性分支上修改和推送代码，方案阶段检出的默认分支仅供只读检查。检出仓库位于相对路径 projects/<directory_name>（每轮临时目录会重建，勿硬编码绝对路径）。读写与检索优先用 Read/Glob/Grep/Edit/Write，提交用 detent_commit_and_push，可在检出目录内运行测试和只读 git 查询。';
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
    '输出要求：面向研发/运维工程师，结论先行、精炼干练（方案 15–25 行内，汇报 10–20 行内，善用短列表或短表格）。不要向用户提及内部工具名、“已排期关闭”、“自动关单关键词”或沙箱路径等系统细节。',
    ...Object.entries(schemas).map(([name, shape]) => name + ' (' + Object.keys(shape).join(', ') + ')'),
    renderSummary(trees, mrs),
  ].filter(Boolean).join('\n');
}

export function buildMrSystemPrompt(mr: LiveMr, tree: SessionWorktreeRow, readonly: boolean,
  plan: boolean, pipeline: LiveMr['head_pipeline'], failedJobs: string[], discussions: MergeRequestDiscussion[],
  targetProjectPath = tree.targetProjectPath) {
  return [
    `GitLab MR ${targetProjectPath} (#${mr.target_project_id})!${mr.iid} · ${mr.title}`, mr.description,
    `${mr.source_branch} -> ${mr.target_branch} · draft=${!!mr.draft} · has_conflicts=${mr.has_conflicts ?? 'unknown'} · ${mr.detailed_merge_status ?? ''}`,
    `When calling GitLab tools that take a project argument, pass project: ${mr.target_project_id}.`,
    `Prefer Read/Glob/Grep inside projects/${tree.directoryName} over shell cat/ls.`,
    'If CLAUDE.md or skills/ exist in the workspace root, read relevant conventions before reviewing or modifying code.',
    pipeline ? `Pipeline #${pipeline.id} ${pipeline.status}. Failed jobs: ${failedJobs.join(', ') || 'none'}` : 'No pipeline.',
    ...discussions.flatMap(thread => thread.notes.filter(n => n.resolvable && !n.resolved && !n.system)
      .map(n => `Unresolved review: ${inlinePosition(n)}${n.body}`)),
    readonly && 'Read-only fork. Post suggested fixes in the MR comments. You have no push permission.',
    plan && '当前为方案阶段（只读）。输出精炼方案供 GitLab 用户审批。',
    'Diagnose the root cause of failed CI, review requests or merge conflicts. On assignment investigate even without a specific request.',
    'For casual teammate discussion acknowledge briefly or explain without making changes. Test requested fixes and push only to the MR source branch.',
    'Keep replies concise and actionable. Never disclose internal tool names or credentials.',
  ].filter(Boolean).join('\n');
}

export function inlinePosition(note: Pick<MergeRequestNote, 'type' | 'position'>) {
  const p = note.position;
  if (note.type !== 'DiffNote' || !p) return '';
  return `${p.new_path ?? p.old_path}:${p.new_line ?? p.old_line ?? '?'} `;
}
