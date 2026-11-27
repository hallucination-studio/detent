import type { SessionStatus, ApprovalRequestRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { redactGitUrl } from './redact.js';

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

export function escapeTableCell(text: string, format: 'text' | 'code' = 'text') {
  const value = text.replace(/[\r\n]+/g, ' ');
  if (format === 'text') return value.replace(/[\\|`\[\]<>]/g, '\\$&');
  const literal = value.replace(/(\\*)\|/g, '$1$1\\|');
  const fence = backtickFence(literal, 1);
  if (fence.length === 1) return fence + literal + fence;
  return fence + ' ' + literal + ' ' + fence;
}

function codeFence(text: string, lang = '') {
  const fence = backtickFence(text, 3);
  return [fence + lang, neutralizeQuickActions(text), fence].join('\n');
}

export const waitingToolGuidance = '> ⏸️ 当前正在等待上方审批卡确认：点 👍 放行执行；如需按新意见调整方案，请对审批卡点 👎（或回复 `/reject`），我会按你的要求重新规划。';
export const recoveryHint = '\n\n> 💡 可直接补充说明重试，或发送 `/reset` 重置会话。';

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

export function renderSummary(trees: SessionWorktreeRow[], mrs: SessionMergeRequestRow[]) {
  return renderNote([
    trees.length && '### 活跃 Worktrees',
    ...trees.map(
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

export function renderPlanApprovalCard(plan: string) {
  return renderNote('### 📋 实施方案审批\n\n' + plan + '\n\n---\n> 👍 或 `/approve` 批准实施 · 直接回复即可调整方案');
}

export function renderToolApprovalCard(
  a: Pick<ApprovalRequestRow, 'id' | 'toolName' | 'toolInput' | 'approvalType'>,
  workspaceRoot?: string,
  riskNote?: string,
) {
  const { questions, command, description } = a.toolInput;
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
  const footer = `> 👍 或 \`/approve\` 放行 · 👎 或 \`/reject <原因>\` 拒绝 · <sub>\`${a.id}\`</sub>`;
  if (a.toolName === 'Bash') {
    let shell = typeof command === 'string' ? command : '';
    if (workspaceRoot) shell = shell.replaceAll(workspaceRoot + '/', '').replaceAll(workspaceRoot, '.');
    return renderNote([
      '### 🛡️ 命令执行审批',
      typeof description === 'string' && description && '**用途**：' + description,
      codeFence(shell, 'sh'),
      riskNote && '**风控提示**：' + riskNote,
      footer,
    ].filter(Boolean).join('\n\n'));
  }
  const entries = Object.entries(a.toolInput);
  const simple = entries.length && entries.every(([, value]) => value === null || typeof value !== 'object');
  const details = simple
    ? ['| 参数 | 内容 |', '| :--- | :--- |', ...entries.map(([key, value]) =>
        `| ${escapeTableCell(key)} | ${escapeTableCell(String(value))} |`)].join('\n')
    : codeFence(JSON.stringify(a.toolInput, null, 2), 'json');
  return renderNote(['### 🛡️ 工具执行审批', a.toolName, details, footer].join('\n\n'));
}
export class NoteStreamer {
  private steps: string[] = [];
  private timer?: NodeJS.Timeout;
  private pending = Promise.resolve('');
  private revision = 0;
  private written = -1;
  private heading = '⏳ 正在处理…';
  constructor(
    private throttle: number,
    private update: (body: string) => Promise<void>,
    private summary: () => Promise<string>,
  ) {}
  private draft = '';
  appendText(delta: string) {
    this.draft += delta;
    this.schedule();
  }
  push(step: string) {
    if (this.steps.at(-1) === step) return;
    this.steps.push(step);
    this.schedule();
  }
  private traceSteps() {
    const steps: string[] = [];
    let project: string | undefined;
    const reads = new Set<string>();
    const flushReads = () => {
      if (reads.size > 1) steps.push(`读取 ${project} 内 ${reads.size} 个文件`);
      else steps.push(...reads);
      reads.clear();
    };
    for (const step of this.steps) {
      const directory = /^读取 ([^/]+)\/.+/.exec(step)?.[1];
      if (directory !== project) flushReads();
      project = directory;
      if (project) reads.add(step);
      else steps.push(step);
    }
    flushReads();
    return steps;
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
        const steps = this.traceSteps();
        const trace = steps.length && [
          '<details><summary>📎 执行记录（' + steps.length + ' 步）</summary>',
          '',
          ...steps.map((s) => '- ' + escapeTableCell(s, 'code')),
          '',
          '</details>',
        ].join('\n');
        const body = renderNote([this.heading, this.draft, trace, await this.summary()].filter(Boolean).join('\n\n'));
        await this.update(body);
        this.written = revision;
        return body;
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
