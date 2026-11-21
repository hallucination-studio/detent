import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type {
  ApprovalRequestRow,
  IssueSessionRow,
  ParsedUserIntent,
  PermissionMode,
  SessionStatus,
} from '../types.js';
import { redactGitUrl, type GitLabClient } from '../gitlab/client.js';
import type { WebhookEvent } from '../gitlab/webhook.js';
import { NoteStreamer, renderPlanApprovalCard, renderSummary } from '../gitlab/note-streamer.js';
import { EphemeralSandbox, type TurnSandbox, type WorkspaceGitLab } from '../workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../workspace/mcp-tools.js';
import { TranscriptHydrator } from '../claude/transcript-hydrator.js';
import { ColdHold, PermissionGate } from '../claude/permission-gate.js';
import { buildSystemPrompt } from '../claude/prompts.js';
import type { ClaudeRunner } from '../claude/runner.js';

import type { DetentExtensions } from '../extensions.js';
import { notifyHook, resolveApproval } from './lifecycle.js';

export class SessionBusy extends Error {}
class StopTurn extends Error {}
type Client = WorkspaceGitLab &
  Pick<
    GitLabClient,
    'createIssueNote' | 'updateIssueNote' | 'syncIssueStatusLabel' | 'getIssue' | 'hasApprovalPermission'
  > & Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile'>>;
type Active = { controller: AbortController; ownsLease: boolean; gate?: PermissionGate };
export class SessionOrchestrator {
  private active = new Map<string, Active>();
  constructor(
    readonly config: AppConfig,
    readonly repo: DetentRepository,
    readonly gitlab: Client,
    private runner: ClaudeRunner,
    private extensions: DetentExtensions = {},
  ) {}
  private resolveTurnProfile(session: IssueSessionRow) {
    return this.extensions.resolveTurnProfile?.({ session, repo: this.repo, gitlab: this.gitlab });
  }
  async resumeSession(id: string, prompt: string, options?: {
    permissionMode?: PermissionMode;
    beforeRun?: (session: IssueSessionRow) => Promise<boolean>;
  }) {
    const session = await this.repo.getSession(id);
    if (!session) throw Error('Unknown session: ' + id);
    await this.withLease(session, async (s, active) => {
      if (options?.beforeRun && !(await options.beforeRun(s))) return;
      if (s.status === 'WAITING_PLAN' || s.status === 'WAITING_TOOL')
        throw Error('Session is waiting for approval');
      s.permissionMode = options?.permissionMode ?? s.permissionMode;
      await this.run(s, active, prompt);
    });
  }
  async handleIssueOpened(event: Extract<WebhookEvent, { object_kind: 'issue' }>) {
    if (event.project.id !== this.config.gitlabHubProjectId) return;
    const issue = event.object_attributes;
    const s = await this.repo.getOrCreateSession(event.project.id, issue.iid, issue.title);
    await this.withLease(s, async (session, active) => {
      if (session.status === 'PLANNING')
        await this.run(session, active, issue.title + '\n' + (issue.description ?? ''));
    });
  }
  private async withLease(
    s: IssueSessionRow,
    fn: (s: IssueSessionRow, a: Active) => Promise<void>,
    shouldWait?: () => Promise<boolean>,
  ) {
    const owner = this.config.podId + '/' + randomUUID();
    const ttl = this.config.leaseTtlSeconds;
    while (!(await this.repo.acquireSessionLease(s.id, owner, ttl))) {
      if (!shouldWait) throw new SessionBusy('Session has an active turn');
      await delay(500);
      if (!(await shouldWait())) return;
    }
    const active: Active = { controller: new AbortController(), ownsLease: true };
    this.active.set(s.id, active);
    let checking = false;
    const timer = setInterval(
      async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await this.repo.renewSessionLease(s.id, owner, ttl))) {
            active.ownsLease = false;
            active.controller.abort(Error('Turn lease expired'));
          } else if (await this.repo.stopRequested(s.id, owner)) active.controller.abort(new StopTurn());
        } catch (error) {
          active.ownsLease = false;
          active.controller.abort(error);
        } finally {
          checking = false;
        }
      },
      Math.max(25, Math.min(15000, (ttl * 1000) / 3)),
    );
    try {
      await fn((await this.repo.getSession(s.id))!, active);
    } finally {
      clearInterval(timer);
      if (this.active.get(s.id) === active) this.active.delete(s.id);
      await this.repo.releaseSessionLease(s.id, owner);
    }
  }
  private async state(s: IssueSessionRow, status: SessionStatus, permissionMode?: PermissionMode) {
    await this.repo.updateSessionState(s.id, permissionMode ? { status, permissionMode } : { status });
    s.status = status;
    await this.gitlab.syncIssueStatusLabel(s.hubProjectId, s.hubIssueIid, status);
  }
  private async expire(s: IssueSessionRow) {
    const pending = await this.repo.getLatestPendingApproval(s.id);
    if (pending) await resolveApproval(
      this.repo, s, pending.id, 'EXPIRED', 'detent', '轮次已结束', this.extensions.hooks?.onApprovalResolved,
    );
  }
  private async summary(id: string) {
    return renderSummary(
      ...(await Promise.all([this.repo.listActiveWorktrees(id), this.repo.listSessionMergeRequests(id)])),
    );
  }
  private async run(
    s: IssueSessionRow,
    active: Active,
    prompt: string,
    previousDecision?: ApprovalRequestRow,
  ) {
    const host = new EphemeralSandbox(this.config, this.repo, this.gitlab);
    const transcripts = new TranscriptHydrator(this.repo);
    const plan = s.permissionMode === 'plan';
    const { controller } = active;
    let sandbox: TurnSandbox | undefined;
    let streamer: NoteStreamer | undefined;
    try {
      const profile = await this.resolveTurnProfile(s);
      controller.signal.throwIfAborted();
      if (profile?.blockedMessage?.trim()) {
        await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, redactGitUrl(profile.blockedMessage));
        await this.state(s, 'IDLE');
        return;
      }
      await this.state(s, plan ? 'PLANNING' : 'CODING', s.permissionMode);
      const note = await this.gitlab.createIssueNote(
        s.hubProjectId,
        s.hubIssueIid,
        plan ? '正在分析需求…' : '正在执行已审批方案…',
      );
      const resume = !!s.claudeSessionId && s.lastMessageSeq > 0;
      s.claudeSessionId ??= randomUUID();
      await this.repo.updateSessionState(s.id, { activeNoteId: note.id, claudeSessionId: s.claudeSessionId });
      s.activeNoteId = note.id;
      sandbox = await host.prepareTurnSandbox(s);
      const { claudeHome, workspaceRoot } = sandbox;
      await transcripts.hydrateTranscriptToTmp(s, claudeHome, workspaceRoot);
      const flush = () =>
        transcripts.flushIncrementalTranscriptToMySql(s, claudeHome, workspaceRoot, s.claudeSessionId!);
      const checkpoint = async () => {
        await flush();
        await host.checkpoint(sandbox!, s.id);
      };
      const effectivePlan = plan || (profile?.readonly ?? false);
      const gate = new PermissionGate({
        extensionTools: [
          ...(this.extensions.tools ?? []),
          ...(this.extensions.capabilities ?? []).filter(pack => pack.enabled).flatMap(pack => pack.tools),
        ],
        profile,
        onApprovalResolved: this.extensions.hooks?.onApprovalResolved,
        session: s,
        config: this.config,
        repo: this.repo,
        controller,
        gitlab: this.gitlab,
        workspaceRoot,
        checkpoint,
        previousDecision,
      });
      active.gate = gate;
      streamer = new NoteStreamer(
        this.config.noteStreamThrottleMs,
        (body) => this.gitlab.updateIssueNote(s.hubProjectId, s.hubIssueIid, note.id, body),
        () => this.summary(s.id),
      );
      const systemPrompt = buildSystemPrompt(
        s,
        await this.repo.listActiveWorktrees(s.id),
        await this.repo.listSessionMergeRequests(s.id),
        gate.readonly,
      );
      controller.signal.throwIfAborted();
      let result: string;
      try {
        result = await this.runner.run({
          session: s,
          sandbox,
          resume,
          prompt,
          controller,
          gate,
          systemPrompt: profile?.extraSystemPrompt ? systemPrompt + '\n' + profile.extraSystemPrompt : systemPrompt,
          tools: new WorkspaceTools(host, sandbox, s.id, effectivePlan),
          progress: (step) => streamer!.push(step),
          appendText: (delta) => streamer!.appendText(delta),
        });
      } finally {
        if (active.ownsLease) await flush();
      }
      controller.signal.throwIfAborted();
      await host.checkpoint(sandbox, s.id);
      controller.signal.throwIfAborted();
      if (plan && !profile?.readonly) {
        const approval = await this.repo.createApprovalRequest(s.id, 'PLAN', 'Plan', {});
        await this.repo.updateApprovalNoteId(approval.id, note.id);
        await this.state(s, 'WAITING_PLAN');
        await streamer.flush(renderPlanApprovalCard(result));
      } else {
        await streamer.flush(result);
        await this.state(s, 'IDLE');
      }
      const completed = this.extensions.hooks?.onTurnCompleted;
      if (completed) await notifyHook(async () => completed((await this.repo.getSession(s.id))!, result));
    } catch (error) {
      const cause = controller.signal.reason ?? error;
      if (!active.ownsLease) throw cause;
      if (sandbox) await host.checkpoint(sandbox, s.id);
      if (cause instanceof ColdHold) {
        await streamer?.flush('等待工具审批，审批后将恢复会话。');
        return;
      }
      await this.expire(s);
      if (cause instanceof StopTurn) {
        await streamer?.flush('本轮已中止。');
        await this.state(s, 'IDLE');
        return;
      }
      await this.state(s, 'FAILED');
      const message = redactGitUrl('本轮执行失败：' + (error instanceof Error ? error.message : '未知错误'));
      if (streamer) await streamer.flush(message);
      else await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, message);
    } finally {
      if (sandbox) await host.destroy(sandbox);
    }
  }
  private async stop(s: IssueSessionRow) {
    if (!s.lockedByPod || Number(s.lockExpiresAt) <= Date.now()) return;
    await this.repo.requestStop(s.id, s.lockedByPod);
    this.active.get(s.id)?.controller.abort(new StopTurn());
    throw new SessionBusy('Waiting for turn to checkpoint and release');
  }
  async handleIssueClosed(project: number, iid: number) {
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    await this.stop(s);
    await this.withLease(s, async (session) => {
      await this.expire(session);
      for (const t of await this.repo.listActiveWorktrees(s.id)) await this.repo.archiveWorktree(t.id);
      await this.state(session, 'IDLE');
    });
  }
  async handleUserIntent(project: number, iid: number, intent: ParsedUserIntent) {
    if (project !== this.config.gitlabHubProjectId) return;
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    if (intent.type === 'STATUS') return this.replyStatus(s);
    if (
      ['RESET', 'ABORT'].includes(intent.type) &&
      !(await this.gitlab.hasApprovalPermission(project, intent.userId))
    )
      return;
    if (intent.type === 'APPROVE' || intent.type === 'REJECT') return this.handleApprovalIntent(s, intent);
    return this.handleSessionCommand(s, intent);
  }
  private async replyStatus(s: IssueSessionRow) {
    const pending = await this.repo.getLatestPendingApproval(s.id);
    await this.gitlab.createIssueNote(
      s.hubProjectId,
      s.hubIssueIid,
      [
        s.status,
        await this.summary(s.id),
        (await this.extensions.renderStatusExtra?.(s))?.trim(),
        pending ? '待审批 ' + pending.approvalType + ' ' + pending.id : '无待审批项',
      ].filter(Boolean).join('\n\n'),
    );
  }
  private async handleApprovalIntent(s: IssueSessionRow, intent: ParsedUserIntent) {
    const pending =
      intent.targetNoteId !== undefined
        ? await this.repo.getApprovalByNoteId(s.id, intent.targetNoteId)
        : await this.repo.getLatestPendingApproval(s.id);
    if (pending?.status !== 'PENDING') return;
    const profile = await this.resolveTurnProfile(s);
    const permitted = profile?.canApprove
      ? await profile.canApprove({
          projectId: s.hubProjectId, userId: intent.userId, username: intent.username,
          approvalType: pending.approvalType, toolName: pending.toolName,
        })
      : await this.gitlab.hasApprovalPermission(s.hubProjectId, intent.userId);
    if (!permitted) return;
    const status = intent.type === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    if (!(await resolveApproval(
      this.repo, s, pending.id, status, intent.username, intent.comment, this.extensions.hooks?.onApprovalResolved,
    ))) return;
    if (await this.active.get(s.id)?.gate?.notify(pending.id)) return;
    const expected = pending.approvalType === 'PLAN' ? 'WAITING_PLAN' : 'WAITING_TOOL';
    const stillWaiting = async (session: IssueSessionRow | null) =>
      session?.status === expected && (await this.repo.getLatestApproval(s.id))?.id === pending.id;
    await this.withLease(s, async (session, active) => {
      if (!(await stillWaiting(session))) return;
      const comment = intent.comment ?? '';
      if (pending.approvalType === 'PLAN') {
        const approved = status === 'APPROVED';
        session.permissionMode = approved ? 'default' : 'plan';
        const instruction = approved ? '实施方案已获批准，请按方案开始实施。' : '实施方案未获批准，请重新调整方案。';
        const feedback = approved ? '附加说明：' : '修改意见：';
        await this.run(session, active, comment ? instruction + '\n' + feedback + comment : instruction);
      } else {
        const decision = (await this.repo.getApproval(pending.id))!;
        const prompt = `GitLab 审批结果 ${status}，工具 ${decision.toolName}，参数 ${JSON.stringify(decision.toolInput)}。审批说明：${comment}`;
        await this.run(session, active, prompt, decision);
      }
    }, async () => stillWaiting(await this.repo.getSession(s.id)));
  }
  private async handleSessionCommand(s: IssueSessionRow, intent: ParsedUserIntent) {
    if (intent.type === 'ABORT' || intent.type === 'RESET') await this.stop(s);
    await this.withLease(s, async (session, active) => {
      if (intent.type === 'RESET') {
        await this.expire(session);
        await this.repo.resetTranscript(s.id);
        session = (await this.repo.getSession(s.id))!;
      }
      if (intent.type === 'ABORT') {
        await this.expire(session);
        await this.state(session, 'IDLE');
        return;
      }
      if (session.status === 'WAITING_TOOL' && intent.type === 'PROMPT') {
        await this.gitlab.createIssueNote(
          s.hubProjectId,
          s.hubIssueIid,
          '有工具请求正在等待审批，请回复 /approve 或 /reject <原因>。',
        );
        return;
      }
      await this.expire(session);
      if (intent.type === 'PLAN' || session.status === 'WAITING_PLAN') session.permissionMode = 'plan';
      await this.run(session, active, intent.comment || session.issueTitle);
    });
  }
  async handlePipelineEvent(event: Extract<WebhookEvent, { object_kind: 'pipeline' }>) {
    const p = event.object_attributes;
    const matches = await this.repo.findMergeRequestByBranch(
      event.project.id,
      event.merge_request?.source_branch ?? p.ref,
    );
    const notified = new Set<string>();
    for (const mr of matches) {
      if (event.merge_request && mr.mrIid !== event.merge_request.iid) continue;
      if (!(await this.repo.updateMergeRequestPipeline(mr.id, p.id, p.status))) continue;
      if (p.status !== 'failed' || notified.has(mr.sessionId)) continue;
      const s = await this.repo.getSession(mr.sessionId);
      if (s)
        await this.gitlab.createIssueNote(
          s.hubProjectId,
          s.hubIssueIid,
          `Pipeline #${p.id} failed · [${mr.targetProjectPath}!${mr.mrIid}](${mr.mrWebUrl})`,
        );
      notified.add(mr.sessionId);
    }
  }
}
