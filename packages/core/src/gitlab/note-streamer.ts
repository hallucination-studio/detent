import type { ApprovalRequestRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { redactGitUrl } from './redact.js';

export function neutralizeQuickActions(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/^([^\S\n]*)\/(?=[A-Za-z_])/gm, '$1\\/');
}

export function renderNote(text: string, secret?: string) {
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
      '> 请回复 `/approve <你的回答>` 继续，或 `/reject <原因>` 取消。',
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
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  private written = -1;
  private heading = '## 🤖 Claude 执行进展';
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
    this.steps.push(step);
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
      .catch(() => {})
      .then(async () => {
        if (this.written === this.revision) return;
        const revision = this.revision;
        const trace = this.steps.length && [
          '<details><summary>🛠️ 已执行 ' + this.steps.length + ' 个步骤（点击展开轨迹）</summary>',
          '',
          ...this.steps.map((s) => '- ' + escapeTableCell(s, 'code')),
          '',
          '</details>',
        ].join('\n');
        await this.update(
          renderNote([this.heading, this.draft, trace, await this.summary()].filter(Boolean).join('\n\n')),
        );
        this.written = revision;
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
    await this.write();
  }
}
