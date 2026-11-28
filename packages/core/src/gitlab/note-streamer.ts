import type { SessionStatus, ApprovalRequestRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { redactGitUrl, workspacePathFilter } from './redact.js';

export function neutralizeQuickActions(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/^([^\S\n]*)\/(?=[A-Za-z_])/gm, '$1\\/');
}

export function renderNote(text: string, secret?: string | readonly string[]) {
  return neutralizeQuickActions(redactGitUrl(text, secret));
}

function backtickFence(text: string, minimum: number) {
  let length = minimum;
  for (const [run] of text.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  return '`'.repeat(length);
}

function inlineCode(text: string) {
  const literal = text.replace(/[\r\n]+/g, ' ');
  const fence = backtickFence(literal, 1);
  return fence.length === 1 ? fence + literal + fence : fence + ' ' + literal + ' ' + fence;
}

export function escapeTableCell(text: string, format: 'text' | 'code' = 'text') {
  const value = text.replace(/[\r\n]+/g, ' ');
  if (format === 'text') return value.replace(/[\\|`\[\]<>]/g, '\\$&');
  const literal = value.replace(/(\\*)\|/g, '$1$1\\|');
  return inlineCode(literal);
}

function codeFence(text: string, lang = '') {
  const fence = backtickFence(text, 3);
  return [fence + lang, neutralizeQuickActions(text), fence].join('\n');
}

export const waitingToolGuidance = '> ⏸️ 当前正在等待上方审批卡确认：点 👍 放行执行；如需按新意见调整方案，请对审批卡点 👎（或回复 `/reject`），我会按你的要求重新规划。';
export function formatUserError(error: unknown, secrets?: readonly string[]) {
  const detail = redactGitUrl(error instanceof Error ? error.message : String(error), secrets).replace(/^Error:\s*/, '').trim();
  if (detail.includes('error_max_turns'))
    return '本次处理步骤较多，已达到单轮步数上限并自动保存当前进度。直接回复“继续”即可从断点接着执行。';
  if (detail.includes('Claude ended without a result'))
    return '模型本轮未返回有效结果，已保存当前进度，请回复“继续”重试。';
  const hint = '可直接补充说明重试，或发送 `/reset` 重置会话。';
  if (detail.length > 180 || /\n\s*at\s/.test(detail))
    return renderNote('⚠️ 本轮执行失败。' + hint + '\n\n<details><summary>技术详情</summary>\n\n' +
      codeFence(detail.slice(0, 2000)) + '\n\n</details>');
  return renderNote('⚠️ 本轮执行失败：' + (detail || '未知错误') + '\n\n' + hint);
}

export function renderStatus(status: SessionStatus, pending?: ApprovalRequestRow | null) {
  const badges: Record<SessionStatus, string> = {
    PLANNING: '🔄 **规划中** · 正在分析需求并拟定方案',
    WAITING_PLAN: '⏸️ **等待方案确认** · 请在方案卡点 👍 批准，或直接回复修改意见',
    CODING: '⚙️ **执行中** · 正在按已批准方案实施',
    WAITING_TOOL: pending?.approvalType === 'ASK_USER' ? '💬 **等待你的确认** · 请直接回复确认内容'
      : '⏸️ **等待操作审批** · 请在上方审批卡点 👍 放行或 👎 拒绝',
    IDLE: '💤 **待命** · 直接回复即可继续',
    DONE: '✅ **已完成**',
    FAILED: '⚠️ **执行失败** · 可补充说明重试，或发 `/reset` 重置',
  };
  return badges[status];
}

export function renderSummary(trees: SessionWorktreeRow[], mrs: SessionMergeRequestRow[], { includeWorktrees = false } = {}) {
  const visibleTrees = includeWorktrees ? trees : [];
  return renderNote([
    visibleTrees.length && '### 活跃 Worktrees',
    ...visibleTrees.map(
      (t) =>
        '- ' + t.targetProjectPath + ' · ' + t.branchName + ' @ ' + (t.lastCommitSha?.slice(0, 8) ?? '—'),
    ),
    mrs.length && '### Merge Requests',
    ...mrs.map((m) => {
      const pipeline = m.latestPipelineId ? `#${m.latestPipelineId} ${m.latestPipelineStatus}` : '—';
      const state = m.mrState === 'merged' && m.mergeCommitSha ? 'merged @ ' + m.mergeCommitSha.slice(0, 8) : m.mrState;
      return `- [${m.targetProjectPath}!${m.mrIid} ${m.mrTitle}](${m.mrWebUrl}) · ${state} · Pipeline ${pipeline}`;
    }),
  ].filter(Boolean).join('\n'));
}

export function renderPlanApprovalCard(plan: string, approvalId: string) {
  return renderApprovalCard({ icon: '📋', title: '实施方案审批', approvalId,
    rows: [['审批范围', '本工单实施方案']], body: plan + '\n\n可直接回复修改意见，调整方案后再批准。' });
}

/** Row values may include links and inline code. Escape untrusted cells before passing them in. */
export function renderApprovalCard(card: {
  icon: string; title: string; badge?: string; rows: [string, string][];
  body?: string; details?: { summary: string; content: string }; approverHint?: string; approvalId: string;
}) {
  const { icon, title, badge, rows, body, details, approverHint = '项目成员', approvalId } = card;
  return renderNote([
    '### ' + icon + ' ' + title + (badge ? ' [' + escapeTableCell(badge) + ']' : ''),
    ['| 项目 | 内容 |', '| :--- | :--- |', ...rows.map(([key, value]) => '| ' + escapeTableCell(key) + ' | ' + value + ' |')].join('\n'),
    body, details && '<details><summary>' + details.summary + '</summary>\n\n' + details.content + '\n\n</details>',
    '> 请' + approverHint + '点 👍 或回复 `/approve` 放行 · 👎 或 `/reject <原因>` 拒绝',
    '<sub>审批单 ' + inlineCode(approvalId) + '</sub>',
  ].filter(Boolean).join('\n\n'));
}

export function renderToolApprovalCard(
  a: Pick<ApprovalRequestRow, 'id' | 'toolName' | 'toolInput' | 'approvalType'>,
  approverHint?: string,
) {
  const { questions } = a.toolInput;
  if (a.approvalType === 'ASK_USER') {
    const lines = (Array.isArray(questions) ? questions : [])
      .filter(q => typeof q?.question === 'string')
      .map((q, i) => `${i + 1}. ${neutralizeQuickActions(q.question)}`);
    return renderNote([
      '### 💬 需要你的确认',
      lines.join('\n'),
      '> 💬 直接回复你的确认内容即可继续（或回复 `/abort` 取消）。',
    ].filter(Boolean).join('\n\n'));
  }
  const entries = Object.entries(a.toolInput);
  const simple = entries.length && entries.every(([, value]) => value === null || typeof value !== 'object');
  const rows: [string, string][] = [['工具', escapeTableCell(a.toolName, 'code')]];
  if (simple) for (const [key, value] of entries) rows.push([key, escapeTableCell(String(value))]);
  return renderApprovalCard({ icon: '🛡️', title: '工具执行审批', rows, approvalId: a.id, approverHint,
    details: simple ? undefined : { summary: '调用参数', content: codeFence(JSON.stringify(a.toolInput, null, 2), 'json') } });
}
export interface ToolStep {
  id: string;
  name: string;
  input: string;
  result: string;
}

function renderTrace(steps: Map<string, ToolStep>) {
  if (!steps.size) return '';
  const lines = ['<details><summary>🔍 工具调用轨迹（' + steps.size + ' 步）</summary>', ''];
  let index = 0;
  for (const { name, input, result } of steps.values()) {
    index++;
    if (steps.size > 60 && index > 30 && index <= steps.size - 30) {
      if (index === 31) lines.push('', `…（中间省略 ${steps.size - 60} 步）…`, '');
      continue;
    }
    const indent = ' '.repeat(String(index).length + 2);
    lines.push(`${index}. **${inlineCode(name)}** ${inlineCode(input)}  `,
      `${indent}↳ ${inlineCode(result)}`);
  }
  return [...lines, '', '</details>'].join('\n');
}

export class NoteStreamer {
  private steps = new Map<string, ToolStep>();
  private timer?: NodeJS.Timeout;
  private pending = Promise.resolve('');
  private revision = 0;
  private written = -1;
  private heading = '⏳ 正在处理…';
  constructor(
    private throttle: number,
    private update: (body: string) => Promise<void>,
    private summary: () => Promise<string>,
    private secrets?: readonly string[],
  ) {}
  private relativePaths = workspacePathFilter();
  scopeWorkspace(root: string) { this.relativePaths = workspacePathFilter(root); }
  private draft = '';
  appendText(delta: string) {
    this.draft += delta;
    this.schedule();
  }
  push(step: ToolStep) {
    this.steps.set(step.id, step);
    this.schedule();
  }
  private schedule() {
    this.revision++;
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.write().catch(() => {}); // A failed update stays dirty for the final flush.
      }, this.throttle);
  }
  private write() {
    this.pending = this.pending
      .catch(() => '')
      .then(async previous => {
        if (this.written === this.revision) return previous;
        const revision = this.revision;
        const body = renderNote([this.heading, this.draft, renderTrace(this.steps), await this.summary()]
          .filter(Boolean).join('\n\n'), this.secrets);
        const visible = this.relativePaths(body);
        await this.update(visible);
        this.written = revision;
        return visible;
      });
    return this.pending;
  }
  async flush(heading?: string) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (heading !== undefined) {
      this.heading = heading;
      this.draft = '';
      this.revision++;
    }
    return this.write();
  }
}
