import type { ApprovalRequestRow, SessionWorktreeRow, SessionMergeRequestRow } from '../types.js';
import { redactGitUrl } from './client.js';

export function renderSummary(trees: SessionWorktreeRow[], mrs: SessionMergeRequestRow[]) {
  return [
    '### 活跃 Worktrees',
    ...trees.map(
      (t) =>
        '- ' + t.targetProjectPath + ' · ' + t.branchName + ' @ ' + (t.lastCommitSha?.slice(0, 8) ?? '—'),
    ),
    '### Merge Requests',
    ...mrs.map((m) => {
      const pipeline = m.latestPipelineId ? `#${m.latestPipelineId} ${m.latestPipelineStatus}` : '—';
      const state = m.mrState === 'merged' && m.mergeCommitSha ? 'merged @ ' + m.mergeCommitSha.slice(0, 8) : m.mrState;
      return `- [${m.targetProjectPath}!${m.mrIid} ${m.mrTitle}](${m.mrWebUrl}) · ${state} · Pipeline ${pipeline}`;
    }),
  ].join('\n');
}
export function renderPlanApprovalCard(plan: string) {
  return redactGitUrl(
    '## 📋 Claude 实施方案审批\n\n' + plan + '\n\n👍 或 /approve 批准实施，回复修改意见可调整方案。',
  );
}
export function renderToolApprovalCard(
  a: Pick<ApprovalRequestRow, 'id' | 'toolName' | 'toolInput' | 'approvalType'>,
) {
  return redactGitUrl(
    [
      '## 🛡️ Claude 工具审批',
      a.toolName + ' · ' + a.id,
      '\n' +
        JSON.stringify(a.toolInput, null, 2)
          .split('\n')
          .map((l) => '    ' + l)
          .join('\n'),
      a.approvalType === 'ASK_USER'
        ? '请使用 /approve <回答> 回复问题。'
        : '👍 或 /approve 允许本次操作，👎 或 /reject <原因> 拒绝。',
    ].join('\n\n'),
  );
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
        const trace = [
          '<details><summary>🛠️ 已执行 ' + this.steps.length + ' 个步骤（点击展开轨迹）</summary>',
          '',
          ...this.steps.map((s) => '- ' + s),
          '',
          '</details>',
        ].join('\n');
        await this.update(
          redactGitUrl([this.heading, this.draft, trace, await this.summary()].filter(Boolean).join('\n\n')),
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
