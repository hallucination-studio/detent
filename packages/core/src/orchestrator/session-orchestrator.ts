import { createDecisionClient, type DecisionClient } from '../decision/jev-client.js';
import { randomUUID } from 'node:crypto';
import { createIssueChannel } from './channel.js';
import { TurnRuntime, SessionBusy, StopTurn, formatInboxMessages, type Active } from './turn-runtime.js';
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
import { escapeTableCell, NoteStreamer, recoveryHint, renderPlanApprovalCard, renderStatus, renderSummary, waitingToolGuidance } from '../gitlab/note-streamer.js';
import { EphemeralSandbox, type TurnSandbox, type WorkspaceGitLab } from '../workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../workspace/mcp-tools.js';
import { TranscriptHydrator } from '../claude/transcript-hydrator.js';
import { ColdHold, PermissionGate } from '../claude/permission-gate.js';
import { buildSystemPrompt } from '../claude/prompts.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { missingHubCapabilities } from '../workflows/hub-workflows.js';
import { loadHubAgents } from '../workflows/hub-agents.js';
import { normalizeHubValue } from '../workflows/hub-frontmatter.js';
import { connectMcpCapabilityPack } from '../extensions/mcp-bridge.js';
import { loadHubCapabilities, resolveHubMcpCapabilities } from '../workflows/hub-capabilities.js';
import type { DetentCapabilityPack, DetentExtensions } from '../extensions.js';
import { checkIssueClosure, createCloseIssueTool } from './close-issue.js';
import { notifyHook } from './lifecycle.js';

export { SessionBusy } from './turn-runtime.js';
const helpHint = '> 💡 发送 `/help` 可随时查看当前工作区的能力与指令。';
function coordinatorAgents(card?: ApprovalRequestRow, recheckIssuer = false): string[] | undefined {
  const scope = card?.toolInput.__detentCoordinator;
  if (!scope || typeof scope !== 'object' || !('agents' in scope) || !Array.isArray(scope.agents) ||
      !scope.agents.every(id => typeof id === 'string')) return;
  if (recheckIssuer && card?.approvalType !== 'PLAN')
    return 'issuer' in scope && typeof scope.issuer === 'string' ? [scope.issuer] : [];
  return scope.agents;
}
type Client = WorkspaceGitLab &
  Pick<
    GitLabClient,
    'createIssueNote' | 'updateIssueNote' | 'syncIssueStatusLabel' | 'getIssue' | 'hasApprovalPermission'
  > & Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile' | 'listIssueNotes' | 'updateIssueLabels' | 'isBotUser' | 'closeIssue'>>;
export class SessionOrchestrator extends TurnRuntime {
  private readonly denialNotices = new Set<string>();
  private readonly decision?: DecisionClient;
  constructor(
    config: AppConfig,
    repo: DetentRepository,
    readonly gitlab: Client,
    private runner: ClaudeRunner,
    private extensions: DetentExtensions = {},
  ) {
    super(config, repo, extensions.hooks);
    this.decision = extensions.decisionClient ?? createDecisionClient(config);
  }
  private async getCapabilities(): Promise<readonly DetentCapabilityPack[]> {
    const { config, gitlab } = this;
    const { gitlabHubProjectId: hubProjectId, gitlabHubDefaultBranch: hubDefaultBranch } = config;
    const document = await loadHubCapabilities(gitlab, hubProjectId, hubDefaultBranch);
    const fixed = this.extensions.capabilities ?? [];
    if (document.invalid) return fixed.map(pack => ({ ...pack, enabled: false, tools: [], setupHint: document.error }));
    const [dynamic, mcp] = await Promise.all([
      this.extensions.resolveCapabilities?.({ config, gitlab, document, hubProjectId, hubDefaultBranch }),
      resolveHubMcpCapabilities(document, config.secrets, (cfg, options) => connectMcpCapabilityPack(cfg, { ...options, secrets: this.secrets })),
    ]);
    const live = [...(dynamic ?? []), ...mcp];
    const packs = new Map<string, DetentCapabilityPack>();
    for (const pack of fixed) {
      const name = normalizeHubValue(pack.name);
      const overridden = Object.keys(document.entries).some(key => normalizeHubValue(key) === name);
      packs.set(name, overridden ? { ...pack, enabled: false, tools: [], setupHint: '请检查 Hub capabilities.json 中的能力类型' } : pack);
    }
    for (const pack of live) packs.set(normalizeHubValue(pack.name), pack);
    return [...packs.values()];
  }
  private resolveTurnProfile(session: IssueSessionRow, capabilities: readonly DetentCapabilityPack[],
    context: { purpose: 'turn'; prompt: string } | { purpose: 'approval'; approval: Pick<ApprovalRequestRow, 'approvalType' | 'toolName'> },
    card?: ApprovalRequestRow) {
    return this.extensions.resolveTurnProfile?.({
      session, repo: this.repo, gitlab: this.gitlab, decision: this.decision, capabilities, coordinatorAgents: coordinatorAgents(card, context.purpose === 'approval'), ...context,
    });
  }
  async resumeSession(id: string, prompt: string, options?: {
    permissionMode?: PermissionMode;
    beforeRun?: (session: IssueSessionRow) => Promise<boolean>;
  }) {
    const session = await this.repo.getSession(id);
    if (!session) throw Error('Unknown session: ' + id);
    if (session.sessionKind !== 'issue') throw Error('Expected an Issue session');
    await this.withLease(session, async (s, active) => {
      if (options?.beforeRun && !(await options.beforeRun(s))) return;
      if (s.status === 'WAITING_PLAN' || s.status === 'WAITING_TOOL')
        throw Error('Session is waiting for approval');
      s.permissionMode = options?.permissionMode ?? s.permissionMode;
      await this.run(s, active, prompt, undefined, options?.permissionMode);
    });
  }
  async wakeSession(candidate: IssueSessionRow, reason: 'expired' | 'inbox') {
    // The Issue runner publishes Issue approvals and may close the Issue.
    if (candidate.sessionKind !== 'issue') return;
    await this.withLease(candidate, async (s, active) => {
      if (['WAITING_TOOL', 'WAITING_PLAN', 'DONE'].includes(s.status)) return;
      if (reason === 'expired' && !await this.recover(s, this.channel(s))) return;
      const items = await this.drainInbox(s.id, active);
      if (!items.length && reason === 'inbox') return;
      await this.run(s, active, formatInboxMessages(items, this.secrets) || '上轮执行中断，请检查已保存的进度并继续。');
    }, undefined, reason === 'expired' ? candidate.lockExpiresAt! : undefined);
  }
  async handleIssueOpened(event: Extract<WebhookEvent, { object_kind: 'issue' }>) {
    if (event.project.id !== this.config.gitlabHubProjectId) return;
    const issue = event.object_attributes;
    const s = await this.repo.getOrCreateSession(event.project.id, issue.iid, issue.title);
    await this.withLease(s, async (session, active) => {
      if (issue.action === 'reopen' && session.status === 'DONE') {
        if ((await this.gitlab.getIssue(session.hubProjectId, session.hubIssueIid)).state !== 'opened') return;
        session.permissionMode = 'plan';
      } else if (session.status !== 'PLANNING') return;
      await this.run(session, active, issue.title + '\n' + (issue.description ?? ''));
    });
  }
  private channel(s: IssueSessionRow) {
    return createIssueChannel(this.gitlab, s.hubProjectId, s.hubIssueIid);
  }
  private async state(s: IssueSessionRow, status: SessionStatus, permissionMode?: PermissionMode) {
    await this.repo.updateSessionState(s.id, permissionMode ? { status, permissionMode } : { status });
    s.status = status;
    await this.channel(s).syncStatusLabel(status);
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
    resumeMode?: PermissionMode,
  ) {
    let next: string | undefined = prompt;
    while (next !== undefined) {
      next = await this.runTurn(s, active, next, previousDecision, resumeMode);
      resumeMode = undefined;
      previousDecision = undefined;
      if (next === undefined && !active.controller.signal.aborted && ['IDLE', 'WAITING_PLAN'].includes(s.status)) {
        // A comment can arrive during the final GitLab write or sandbox cleanup.
        if (await this.repo.releaseIfInboxEmpty(s.id, active.owner)) {
          active.ownsLease = false;
          return;
        }
        const late = await this.drainInbox(s.id, active);
        if (late.length) {
          if (s.status === 'WAITING_PLAN') await this.expire(s);
          next = formatInboxMessages(late, this.secrets);
        }
      }
    }
  }
  private async runTurn(s: IssueSessionRow, active: Active, prompt: string, previousDecision?: ApprovalRequestRow, resumeMode?: PermissionMode): Promise<string | undefined> {
    const channel = this.channel(s);
    const drainInbox = () => this.drainInbox(s.id, active);
    const host = new EphemeralSandbox(this.config, this.repo, this.gitlab);
    const transcripts = new TranscriptHydrator(this.repo, this.secrets);
    const { controller } = active;
    let sandbox: TurnSandbox | undefined;
    let streamer: NoteStreamer | undefined;
    let issueClosed = false;
    try {
      const capabilities = await this.getCapabilities();
      const profile = await this.resolveTurnProfile(s, capabilities, { purpose: 'turn', prompt }, previousDecision);
      controller.signal.throwIfAborted();
      if (profile?.blockedMessage?.trim()) {
        await channel.createNote(redactGitUrl(profile.blockedMessage + '\n\n' + helpHint, this.secrets));
        await this.state(s, 'IDLE');
        return;
      }
      // A new coordinator request cannot inherit a different turn's implementation approval.
      if (profile?.coordinator && !resumeMode && !coordinatorAgents(previousDecision)) s.permissionMode = 'plan';
      const plan = s.permissionMode === 'plan';
      const routingPrefix = profile?.routingNotice ? redactGitUrl(profile.routingNotice, this.secrets) + '\n\n' : '';
      await this.state(s, plan ? 'PLANNING' : 'CODING', s.permissionMode);
      const note = await channel.createNote(
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
        capabilities,
        extensionTools: closeTool ? [...(this.extensions.tools ?? []), closeTool] : this.extensions.tools,
        profile: closeTool && profile?.enabledExtensionTools
          ? { ...profile, enabledExtensionTools: [...profile.enabledExtensionTools, closeTool.name] }
          : profile,
        onApprovalResolved: this.extensions.hooks?.onApprovalResolved,
        session: s,
        config: this.config,
        repo: this.repo,
        controller,
        channel,
        workspaceRoot,
        checkpoint,
        previousDecision: profile?.routingNotice ? undefined : previousDecision,
      });
      active.gate = gate;
      streamer = new NoteStreamer(
        this.config.noteStreamThrottleMs,
        (body) => channel.updateNote(note.id, body),
        () => this.summary(s.id),
        this.secrets,
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
          subagents: profile?.subagents,
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
          readonlyTools: profile?.subagents?.length && !effectivePlan ? new WorkspaceTools(host, sandbox, s.id, true) : undefined,
          drainInbox,
          progress: (step) => streamer!.push(step),
          appendText: (delta) => streamer!.appendText(delta),
        });
      } finally {
        if (active.ownsLease) await flush();
      }
      controller.signal.throwIfAborted();
      await host.checkpoint(sandbox, s.id);
      controller.signal.throwIfAborted();
      const pending = await drainInbox();
      if (pending.length) {
        await streamer.flush(routingPrefix + result);
      } else if (plan && !profile?.readonly && (!profile?.coordinator || gate.governedAgents.size || gate.requestedMutation)) {
        const agents = gate.governedAgents.size ? [...gate.governedAgents] : profile?.subagents?.filter(a => !a.readonly).map(a => a.id);
        const approval = await this.repo.createApprovalRequest(s.id, 'PLAN', 'Plan', profile?.coordinator ? { __detentCoordinator: { agents: agents ?? [] } } : {});
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
        if (profile?.coordinator) s.permissionMode = 'plan';
        await this.state(s, 'IDLE', profile?.coordinator ? s.permissionMode : undefined);
      }
      if (s.recoveryAttempts) {
        await this.repo.updateSessionState(s.id, { recoveryAttempts: 0 });
        s.recoveryAttempts = 0;
      }
      const completed = this.extensions.hooks?.onTurnCompleted;
      if (completed) await notifyHook(async () => completed((await this.repo.getSession(s.id))!, result), this.secrets);
      if (pending.length) return formatInboxMessages(pending, this.secrets);
    } catch (error) {
      const cause = controller.signal.reason ?? error;
      // A status-sync failure after GitLab accepted the close cannot undo it.
      if (issueClosed || !active.ownsLease) throw cause;
      if (sandbox) await host.checkpoint(sandbox, s.id);
      if (cause instanceof ColdHold) {
        await streamer?.flush(cause.message);
        return;
      }
      await this.expire(s);
      if (cause instanceof StopTurn) {
        await streamer?.flush('本轮已中止。');
        await this.state(s, 'IDLE');
        return;
      }
      await this.state(s, 'FAILED');
      const message = redactGitUrl('本轮执行失败：' + (error instanceof Error ? error.message : '未知错误'), this.secrets) + recoveryHint;
      if (streamer) await streamer.flush(message);
      else await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, message);
    } finally {
      if (sandbox) await host.destroy(sandbox);
    }
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
  async handleUserIntent(project: number, iid: number, intent: ParsedUserIntent, eventId?: string) {
    if (project !== this.config.gitlabHubProjectId) return;
    if (intent.type === 'HELP') {
      if (!await this.gitlab.hasApprovalPermission(project, intent.userId)) return;
      const { agents } = await loadHubAgents(this.gitlab, project, this.config.gitlabHubDefaultBranch);
      const capabilities = await this.getCapabilities();
      const menu = agents.map(agent => {
        const missing = missingHubCapabilities(agent, capabilities);
        const status = missing.length ? '⚪ 未开通（待配置 ' + escapeTableCell(missing.map(name => {
          const hint = capabilities.find(pack => normalizeHubValue(pack.name) === name)?.setupHint;
          return hint ? name + '：' + hint : name;
        }).join('、')) + '）' : '✅ 已就绪';
        return `| ${escapeTableCell(agent.description)} | ${escapeTableCell(agent.label, 'code')} | ${status} |`;
      });
      await this.gitlab.createIssueNote(project, iid, [
        '### 可用能力',
        menu.length === 0 ? '当前工作区尚未登记能力。' : ['| 能力场景 | 触发方式 / 标签 | 状态 |', '| :--- | :--- | :--- |', ...menu].join('\n'),
        '`/status` 查看进度 · `/plan` 拟定方案 · `/use <agent>` 切换能力',
        '审批卡上点 👍 批准或 👎 拒绝 · `/abort` 中止 · `/reset` 重置会话',
      ].join('\n\n'));
      return;
    }
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    if (intent.type === 'STATUS') {
      if (await this.gitlab.hasApprovalPermission(project, intent.userId)) await this.replyStatus(s);
      return;
    }
    if (
      ['RESET', 'ABORT', 'USE'].includes(intent.type) &&
      !(await this.gitlab.hasApprovalPermission(project, intent.userId))
    )
      return;
    if (intent.type === 'USE') return this.handleUseAgent(s, intent);
    if (intent.type === 'APPROVE' || intent.type === 'REJECT') return this.handleApprovalIntent(s, intent);
    if (intent.type !== 'PROMPT') return this.handleSessionCommand(s, intent);
    if (s.status === 'WAITING_TOOL') {
      const pending = await this.repo.getLatestPendingApproval(s.id);
      if (pending?.status === 'PENDING' && pending.approvalType === 'ASK_USER')
        return this.handleApprovalIntent(s, { ...intent, type: 'APPROVE', targetNoteId: pending.gitlabNoteId ?? undefined }, pending);
      if (pending?.approvalType === 'TOOL_USE' && await this.gitlab.hasApprovalPermission(project, intent.userId))
        await this.channel(s).createNote(waitingToolGuidance);
      return;
    }
    if (s.status === 'DONE') return;
    // Insert before trying the lease. Either the current turn drains this event, or this delivery wakes it.
    await this.repo.enqueueSessionInbox({ sessionId: s.id, eventId: eventId ?? randomUUID(),
      sourceKind: 'note', senderUsername: intent.username, content: redactGitUrl(intent.comment ?? s.issueTitle, this.secrets) });
    try {
      await this.withLease(s, async (session, active) => {
        if (session.status === 'WAITING_TOOL' || session.status === 'DONE') return;
        const pending = await this.drainInbox(s.id, active);
        if (!pending.length) return;
        await this.expire(session);
        if (session.status === 'WAITING_PLAN') session.permissionMode = 'plan';
        const prompt = pending.length === 1 ? redactGitUrl(pending[0].content, this.secrets)
          : formatInboxMessages(pending, this.secrets);
        await this.run(session, active, prompt);
      });
    } catch (error) {
      if (!(error instanceof SessionBusy)) throw error;
    }
  }
  private async replyStatus(s: IssueSessionRow) {
    const pending = await this.repo.getLatestPendingApproval(s.id);
    await this.gitlab.createIssueNote(
      s.hubProjectId,
      s.hubIssueIid,
      [
        renderStatus(s.status, pending),
        await this.summary(s.id),
        (await this.extensions.renderStatusExtra?.(s))?.trim(),
      ].filter(Boolean).join('\n\n'),
    );
  }
  private async handleApprovalIntent(s: IssueSessionRow, intent: ParsedUserIntent, question?: ApprovalRequestRow) {
    const pending = question ?? (
      intent.targetNoteId !== undefined
        ? await this.repo.getApprovalByNoteId(s.id, intent.targetNoteId)
        : await this.repo.getLatestPendingApproval(s.id));
    if (pending?.status !== 'PENDING') return;
    const { approvalType, toolName } = pending;
    const profile = await this.resolveTurnProfile(s, await this.getCapabilities(), { purpose: 'approval', approval: { approvalType, toolName } }, pending);
    if (profile?.blockedMessage?.trim()) return;
    const { approvalProjectId } = this.channel(s);
    const permitted = profile?.canApprove
      ? await profile.canApprove({
          projectId: approvalProjectId, userId: intent.userId, username: intent.username,
          approvalType, toolName,
        })
      : await this.gitlab.hasApprovalPermission(approvalProjectId, intent.userId);
    if (!permitted) {
      if (intent.type !== 'APPROVE' || !profile?.canApprove ||
          !await this.gitlab.hasApprovalPermission(approvalProjectId, intent.userId)) return;
      const key = pending.id + ':' + intent.userId;
      if (this.denialNotices.has(key)) return;
      this.denialNotices.add(key);
      if (this.denialNotices.size > 1024) this.denialNotices.delete(this.denialNotices.values().next().value!);
      try {
        await this.channel(s).createNote('> 🔒 该操作需要生产审批权限（Maintainer 及以上），请邀请项目负责人在审批卡上点 👍 放行。');
      } catch (error) {
        this.denialNotices.delete(key);
        throw error;
      }
      return;
    }
    await this.applyApproval(s, pending, intent, (session, active, prompt, decision) =>
      this.run(session, active, prompt, decision ?? (coordinatorAgents(pending) ? pending : undefined)));
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
      await this.gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, redactGitUrl(message, this.secrets));
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
      await this.expire(session);
      if (intent.type === 'PLAN' || session.status === 'WAITING_PLAN') session.permissionMode = 'plan';
      await this.run(session, active, intent.comment || session.issueTitle);
    });
  }
}
