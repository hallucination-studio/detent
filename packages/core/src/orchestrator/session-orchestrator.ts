import { createDecisionClient, type DecisionClient } from '../decision/jev-client.js';
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
import { escapeTableCell, NoteStreamer, renderPlanApprovalCard, renderSummary } from '../gitlab/note-streamer.js';
import { EphemeralSandbox, type TurnSandbox, type WorkspaceGitLab } from '../workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../workspace/mcp-tools.js';
import { TranscriptHydrator } from '../claude/transcript-hydrator.js';
import { ColdHold, PermissionGate } from '../claude/permission-gate.js';
import { buildSystemPrompt } from '../claude/prompts.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { loadHubAgents } from '../workflows/hub-agents.js';
import { normalizeHubValue } from '../workflows/hub-frontmatter.js';

import type { DetentExtensions } from '../extensions.js';
import { checkIssueClosure, createCloseIssueTool } from './close-issue.js';
import { notifyHook, resolveApproval } from './lifecycle.js';

export class SessionBusy extends Error {}
class StopTurn extends Error {}
type Client = WorkspaceGitLab &
  Pick<
    GitLabClient,
    'createIssueNote' | 'updateIssueNote' | 'syncIssueStatusLabel' | 'getIssue' | 'hasApprovalPermission'
  > & Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile' | 'listIssueNotes' | 'updateIssueLabels' | 'isBotUser' | 'closeIssue'>>;
type Active = { controller: AbortController; ownsLease: boolean; gate?: PermissionGate };
export class SessionOrchestrator {
  private active = new Map<string, Active>();
  private readonly decision?: DecisionClient;
  constructor(
    readonly config: AppConfig,
    readonly repo: DetentRepository,
    readonly gitlab: Client,
    private runner: ClaudeRunner,
    private extensions: DetentExtensions = {},
  ) {
    this.decision = extensions.decisionClient ?? createDecisionClient(config);
  }
  private getCapabilities() {
    return this.extensions.capabilities ?? [];
  }
  private resolveTurnProfile(session: IssueSessionRow, context: { purpose: 'turn' | 'approval'; prompt?: string }) {
    return this.extensions.resolveTurnProfile?.({
      session, repo: this.repo, gitlab: this.gitlab, decision: this.decision, capabilities: this.getCapabilities(), ...context,
    });
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
    for (let pending = await this.repo.getLatestPendingApproval(s.id); pending; pending = await this.repo.getLatestPendingApproval(s.id)) {
      await resolveApproval(this.repo, s, pending.id, 'EXPIRED', 'detent', '轮次已结束', this.extensions.hooks?.onApprovalResolved);
    }
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
    const { controller } = active;
    let sandbox: TurnSandbox | undefined;
    let streamer: NoteStreamer | undefined;
    let issueClosed = false;
    try {
      const profile = await this.resolveTurnProfile(s, { purpose: 'turn', prompt });
      controller.signal.throwIfAborted();
      if (profile?.blockedMessage?.trim()) {
        await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, redactGitUrl(profile.blockedMessage));
        await this.state(s, 'IDLE');
        return;
      }
      const plan = s.permissionMode === 'plan';
      const routingPrefix = profile?.routingNotice ? redactGitUrl(profile.routingNotice, this.config.jevApiKey) + '\n\n' : '';
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
      sandbox = await host.prepareTurnSandbox(s, profile?.sandboxScope);
      const { claudeHome, workspaceRoot } = sandbox;
      await transcripts.hydrateTranscriptToTmp(s, claudeHome, workspaceRoot);
      const flush = () =>
        transcripts.flushIncrementalTranscriptToMySql(s, claudeHome, workspaceRoot, s.claudeSessionId!);
      const checkpoint = async () => {
        await flush();
        await host.checkpoint(sandbox!, s.id);
      };
      const effectivePlan = plan || (profile?.readonly ?? false);
      let closeRequested: { summary: string } | undefined;
      const closeTool = profile && createCloseIssueTool(profile, request => { closeRequested = request; });
      const gate = new PermissionGate({
        decision: this.decision,
        capabilities: this.getCapabilities(),
        extensionTools: closeTool ? [...(this.extensions.tools ?? []), closeTool] : this.extensions.tools,
        profile: closeTool && profile?.enabledExtensionTools
          ? { ...profile, enabledExtensionTools: [...profile.enabledExtensionTools, closeTool.name] }
          : profile,
        onApprovalResolved: this.extensions.hooks?.onApprovalResolved,
        session: s,
        config: this.config,
        repo: this.repo,
        controller,
        gitlab: this.gitlab,
        workspaceRoot,
        checkpoint,
        previousDecision: profile?.routingNotice ? undefined : previousDecision,
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
          systemPrompt: [
            systemPrompt, profile?.extraSystemPrompt,
            closeTool && '全部验收条件满足后调用 detent_close_issue 完结工单（含只读巡检模式，该工具已获授权）；汇报正文无需提及该工具名。',
          ].filter(Boolean).join('\n'),
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
        await streamer.flush(routingPrefix + renderPlanApprovalCard(result));
      } else if (closeRequested && profile) {
        // Tools may have created new work after the close request.
        const checked = await checkIssueClosure(profile, { session: s, repo: this.repo, permissionMode: s.permissionMode });
        if (!checked.ok) throw Error(checked.reason);
        controller.signal.throwIfAborted();
        await this.archiveWorktrees(s.id);
        controller.signal.throwIfAborted();
        await streamer.flush(routingPrefix + result);
        controller.signal.throwIfAborted();
        await this.gitlab.closeIssue?.(s.hubProjectId, s.hubIssueIid);
        issueClosed = true;
        await this.state(s, 'DONE');
      } else {
        await streamer.flush(routingPrefix + result);
        await this.state(s, 'IDLE');
      }
      const completed = this.extensions.hooks?.onTurnCompleted;
      if (completed) await notifyHook(async () => completed((await this.repo.getSession(s.id))!, result));
    } catch (error) {
      const cause = controller.signal.reason ?? error;
      // A status-sync failure after GitLab accepted the close cannot undo it.
      if (issueClosed || !active.ownsLease) throw cause;
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
  private async archiveWorktrees(sessionId: string) {
    for (const tree of await this.repo.listActiveWorktrees(sessionId)) await this.repo.archiveWorktree(tree.id);
  }
  async handleIssueClosed(project: number, iid: number) {
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    await this.stop(s);
    await this.withLease(s, async (session) => {
      await this.expire(session);
      await this.archiveWorktrees(session.id);
      await this.state(session, 'DONE');
    });
  }
  async handleUserIntent(project: number, iid: number, intent: ParsedUserIntent) {
    if (project !== this.config.gitlabHubProjectId) return;
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    if (intent.type === 'STATUS') return this.replyStatus(s);
    if (
      ['RESET', 'ABORT', 'USE'].includes(intent.type) &&
      !(await this.gitlab.hasApprovalPermission(project, intent.userId))
    )
      return;
    if (intent.type === 'USE') return this.handleUseAgent(s, intent);
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
    const profile = await this.resolveTurnProfile(s, { purpose: 'approval' });
    if (profile?.blockedMessage?.trim()) return;
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
  private async handleUseAgent(s: IssueSessionRow, intent: ParsedUserIntent) {
    const args = intent.comment?.trim() ?? '';
    const target = args.split(/\s+/, 1)[0];
    const prompt = args.slice(target.length).trim();
    const idOrLabel = normalizeHubValue(target);
    const { agents } = await loadHubAgents(this.gitlab, s.hubProjectId, this.config.gitlabHubDefaultBranch);
    const matched = agents.find(agent => agent.id === idOrLabel || agent.label === idOrLabel);
    if (!matched) {
      const message = agents.length ? [
        '未找到指定的 Agent。可用 Agent：',
        ...agents.map(agent => `- ${escapeTableCell(agent.id, 'code')}（标签 ${escapeTableCell(agent.label, 'code')}）`),
      ].join('\n') : 'Hub 仓库尚未配置可用 Agent。';
      await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, redactGitUrl(message, this.config.jevApiKey));
      return;
    }
    if (!this.gitlab.updateIssueLabels) {
      await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, '无法更新 Issue 标签，请手动添加目标 Agent 的标签。');
      return;
    }

    const otherLabels = new Set(agents.map(agent => agent.label).filter(label => label !== matched.label));
    await this.stop(s);
    await this.withLease(s, async (session, active) => {
      const { hubProjectId, hubIssueIid } = session;
      await this.expire(session);
      active.controller.signal.throwIfAborted();
      // Clear the waiting state and persist the Plan reset before GitLab can change the route.
      await this.repo.updateSessionState(session.id, { status: 'IDLE', permissionMode: 'plan' });
      session.status = 'IDLE';
      session.permissionMode = 'plan';
      const issue = await this.gitlab.getIssue(hubProjectId, hubIssueIid);
      const remove = issue.labels.filter(label => otherLabels.has(normalizeHubValue(label)));
      active.controller.signal.throwIfAborted();
      await this.gitlab.updateIssueLabels?.(hubProjectId, hubIssueIid, { add: [matched.label], remove });
      await this.run(session, active, prompt || session.issueTitle);
    });
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
