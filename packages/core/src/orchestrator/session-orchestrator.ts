import { z } from 'zod';
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
  SessionInboxRow,
} from '../types.js';
import { redactGitUrl, type GitLabClient } from '../gitlab/client.js';
import type { WebhookEvent } from '../gitlab/webhook.js';
import { escapeTableCell, formatUserError, NoteStreamer, renderNote, renderPlanApprovalCard, renderStatus, renderSummary, waitingToolGuidance } from '../gitlab/note-streamer.js';
import { logError, scrubJson } from '../gitlab/redact.js';
import { EphemeralSandbox, type TurnSandbox, type WorkspaceGitLab } from '../workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../workspace/mcp-tools.js';
import { TranscriptHydrator } from '../claude/transcript-hydrator.js';
import { ColdHold, PermissionGate } from '../claude/permission-gate.js';
import { buildSystemPrompt } from '../claude/prompts.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { loadHubAgents, missingHubCapabilities } from '../workflows/hub-agents.js';
import { normalizeHubValue } from '../workflows/hub-frontmatter.js';
import { connectMcpCapabilityPack } from '../extensions/mcp-bridge.js';
import { loadHubCapabilities, resolveHubMcpCapabilities } from '../workflows/hub-capabilities.js';
import { defineExtensionTool, type DetentCapabilityPack, type DetentExtensions } from '../extensions.js';
import { checkIssueClosure, createCloseIssueTool } from './close-issue.js';
import { notifyHook } from './lifecycle.js';

export { SessionBusy } from './turn-runtime.js';
const helpHint = '> 💡 发送 `/help` 可随时查看当前工作区的能力与指令。';
type TurnTrigger = 'request' | 'continuation' | 'plan';
function inboxTrigger(items: SessionInboxRow[]): TurnTrigger {
  return items.every(item => item.sourceKind === 'system') ? 'continuation' : 'request';
}

type Client = WorkspaceGitLab &
  Pick<
    GitLabClient,
    'createIssueNote' | 'updateIssueNote' | 'syncIssueStatusLabel' | 'getIssue' | 'hasApprovalPermission'
  > & Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile' | 'closeIssue' | 'getIssueNote'>>;
export class SessionOrchestrator extends TurnRuntime {
  private readonly denialNotices = new Set<string>();
  constructor(
    config: AppConfig,
    repo: DetentRepository,
    readonly gitlab: Client,
    private runner: ClaudeRunner,
    private extensions: DetentExtensions = {},
  ) {
    super(config, repo, extensions.hooks);
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
    context: { purpose: 'turn' } | { purpose: 'approval'; approval: Pick<ApprovalRequestRow, 'approvalType' | 'toolName' | 'toolInput'> }) {
    return this.extensions.resolveTurnProfile?.({
      session, repo: this.repo, gitlab: this.gitlab, capabilities, ...context,
    });
  }
  private registeredTools(capabilities: readonly DetentCapabilityPack[]) {
    return [...(this.extensions.tools ?? []), ...capabilities.filter(pack => pack.enabled).flatMap(pack => pack.tools)];
  }
  async isExtensionToolEnabled(session: IssueSessionRow, name: string) {
    const capabilities = await this.getCapabilities();
    const profile = await this.resolveTurnProfile(session, capabilities, { purpose: 'turn' });
    return !profile?.blockedMessage && !profile?.readonly && (profile?.enabledExtensionTools?.includes(name) ?? true) &&
      this.registeredTools(capabilities).some(tool => tool.name === name);
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
      await this.run(s, active, prompt, undefined, options?.permissionMode ? 'continuation' : 'request');
    });
  }
  async deliverSystemEvent(sessionId: string, eventId: string, content: string, options?: { sender?: string }): Promise<boolean> {
    const session = await this.repo.getSession(sessionId);
    if (!session || session.sessionKind !== 'issue' || session.status === 'DONE') return false;
    const queued = await this.repo.enqueueSessionInbox({
      sessionId, eventId, sourceKind: 'system', senderUsername: options?.sender ?? 'detent',
      content: redactGitUrl(content, this.secrets),
    });
    if (!queued) return false;
    await this.wakeQueuedIssue(session);
    return true;
  }
  async wakeQueuedIssue(session: IssueSessionRow) {
    if (session.status === 'DONE' || session.sessionKind !== 'issue') return;
    try {
      await this.wakeSession(session, 'inbox');
    } catch (error) {
      if (!(error instanceof SessionBusy)) throw error;
    }
  }
  async wakeSession(candidate: IssueSessionRow, reason: 'expired' | 'inbox') {
    // The Issue runner publishes Issue approvals and may close the Issue.
    if (candidate.sessionKind !== 'issue') return;
    await this.withLease(candidate, async (s, active) => {
      if (['WAITING_TOOL', 'WAITING_PLAN', 'DONE'].includes(s.status)) return;
      if (reason === 'expired' && !await this.recover(s, this.channel(s))) return;
      const items = await this.drainInbox(s.id, active);
      if (!items.length && reason === 'inbox') return;
      await this.run(s, active, formatInboxMessages(items, this.secrets) || '上轮执行中断，请检查已保存的进度并继续。',
        undefined, inboxTrigger(items));
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
  private async summary(id: string, includeWorktrees = false) {
    return renderSummary(
      ...(await Promise.all([includeWorktrees ? this.repo.listActiveWorktrees(id) : [], this.repo.listSessionMergeRequests(id)])),
      { includeWorktrees },
    );
  }
  private async run(
    s: IssueSessionRow,
    active: Active,
    prompt: string | undefined,
    previousDecision?: ApprovalRequestRow,
    trigger: TurnTrigger = 'request',
  ) {
    let next: string | undefined = prompt;
    for (;;) {
      const pending: SessionInboxRow[] | undefined = next === undefined ? undefined : await this.runTurn(s, active, next, previousDecision, trigger);
      next = pending && formatInboxMessages(pending, this.secrets);
      if (pending) trigger = inboxTrigger(pending);
      previousDecision = undefined;
      if (next === undefined && !active.controller.signal.aborted && ['IDLE', 'WAITING_PLAN'].includes(s.status)) {
        // A comment can arrive during the final GitLab write or sandbox cleanup.
        if (await this.repo.releaseIfInboxEmpty(s.id, active.owner)) {
          active.ownsLease = false;
          return;
        }
        // Only human feedback supersedes a published plan. System callbacks stay
        // in the inbox until the approval resumes the session.
        const late = await this.drainInbox(s.id, active, s.status === 'WAITING_PLAN' ? 'note' : undefined);
        if (late.length) {
          if (s.status === 'WAITING_PLAN') await this.expire(s);
          next = formatInboxMessages(late, this.secrets);
          trigger = inboxTrigger(late);
        }
      }
      if (next === undefined) return;
    }
  }
  private async runTurn(s: IssueSessionRow, active: Active, prompt: string, previousDecision?: ApprovalRequestRow, trigger: TurnTrigger = 'request'): Promise<SessionInboxRow[] | undefined> {
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
      const profile = await this.resolveTurnProfile(s, capabilities, { purpose: 'turn' });
      controller.signal.throwIfAborted();
      if (profile?.blockedMessage?.trim()) {
        await channel.createNote(redactGitUrl(profile.blockedMessage + '\n\n' + helpHint, this.secrets));
        await this.state(s, 'IDLE');
        return;
      }
      const unified = !profile?.sandboxScope?.agentDir;
      if (unified && trigger === 'request') s.permissionMode = 'plan';
      const plan = s.permissionMode === 'plan';
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
      let submittedPlan: string | undefined;
      const turnTools = [];
      if (closeTool) turnTools.push(closeTool);
      if (plan && !profile?.readonly) turnTools.push(defineExtensionTool({
        name: 'detent_submit_plan', policy: 'readonly', description: '提交本轮实施方案供 GitLab 用户审批。',
        schema: { plan: z.string().trim().min(1).max(16000) },
        async execute({ plan }) {
          submittedPlan = plan;
          return { submitted: true, nextAction: '方案已登记，请直接结束本轮等待用户在 GitLab 点 👍 批准。' };
        },
      }));
      const gate = new PermissionGate({
        capabilities,
        extensionTools: [...(this.extensions.tools ?? []), ...turnTools],
        profile: profile?.enabledExtensionTools
          ? { ...profile, enabledExtensionTools: [...profile.enabledExtensionTools, ...turnTools.map(tool => tool.name)] }
          : profile,
        onApprovalResolved: this.extensions.hooks?.onApprovalResolved,
        session: s,
        config: this.config,
        repo: this.repo,
        controller,
        channel,
        workspaceRoot,
        checkpoint,
        previousDecision,
      });
      streamer = new NoteStreamer(
        this.config.noteStreamThrottleMs,
        (body) => channel.updateNote(note.id, body),
        () => this.summary(s.id),
        this.secrets,
      );
      streamer.scopeWorkspace(workspaceRoot);
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
        await streamer.flush(result);
      } else if (plan && (submittedPlan || trigger === 'plan' || (!unified && !profile?.readonly && !closeRequested))) {
        const approval = await this.repo.createApprovalRequest(s.id, 'PLAN', 'Plan', {});
        await this.repo.updateApprovalNoteId(approval.id, note.id);
        await this.state(s, 'WAITING_PLAN');
        await streamer.flush(renderPlanApprovalCard(submittedPlan ?? result, approval.id));
      } else if (closeRequested && profile) {
        // Tools may have created new work after the close request.
        const checked = await checkIssueClosure(profile, { session: s, repo: this.repo, permissionMode: s.permissionMode });
        if (!checked.ok) throw Error(checked.reason);
        controller.signal.throwIfAborted();
        await this.archiveWorktrees(s.id);
        controller.signal.throwIfAborted();
        await streamer.flush(result);
        controller.signal.throwIfAborted();
        await this.gitlab.closeIssue?.(s.hubProjectId, s.hubIssueIid);
        issueClosed = true;
        await this.state(s, 'DONE');
      } else {
        await streamer.flush(result);
        if (unified) s.permissionMode = 'plan';
        await this.state(s, 'IDLE', unified ? s.permissionMode : undefined);
      }
      if (s.recoveryAttempts) {
        await this.repo.updateSessionState(s.id, { recoveryAttempts: 0 });
        s.recoveryAttempts = 0;
      }
      const completed = this.extensions.hooks?.onTurnCompleted;
      if (completed) await notifyHook(async () => completed((await this.repo.getSession(s.id))!, result), this.secrets);
      if (pending.length) return pending;
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
      const message = formatUserError(cause, this.secrets);
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
      await this.repo.expireSessionPipelineWatches(session.id);
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
      await this.gitlab.createIssueNote(project, iid, redactGitUrl([
        '### 可用能力',
        menu.length === 0 ? '当前工作区尚未登记能力。' : ['| 能力场景 | 触发方式 / 标签 | 状态 |', '| :--- | :--- | :--- |', ...menu].join('\n'),
        '`/status` 查看进度 · `/plan` 拟定方案',
        '新建工单时可在 GitLab 的模板菜单直接选择对应场景，按提示填写需求。',
        '审批卡上点 👍 批准或 👎 拒绝 · `/abort` 中止 · `/reset` 重置会话',
      ].join('\n\n'), this.secrets));
      return;
    }
    const s = await this.repo.getSessionByIssue(project, iid);
    if (!s) return;
    if (intent.type === 'STATUS') {
      if (await this.gitlab.hasApprovalPermission(project, intent.userId)) await this.replyStatus(s);
      return;
    }
    if (
      ['RESET', 'ABORT'].includes(intent.type) &&
      !(await this.gitlab.hasApprovalPermission(project, intent.userId))
    )
      return;
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
    const watches = (await this.repo.listSessionPipelineWatches(s.id)).filter(w => w.status === 'PENDING');
    const projects = new Map(await Promise.all([...new Set(watches.map(w => w.targetProjectId))].map(async id => {
      try { return [id, await this.gitlab.getProject(id)] as const; }
      catch (error) { logError('status-pipeline-project', error, this.secrets, 'project=' + id); return [id, undefined] as const; }
    })));
    await this.gitlab.createIssueNote(
      s.hubProjectId,
      s.hubIssueIid,
      renderNote([
        renderStatus(s.status, pending),
        watches.length && '等待流水线终态\n' + watches.map(w => {
          const project = projects.get(w.targetProjectId);
          const label = (project?.path_with_namespace ?? '项目 ' + w.targetProjectId) +
            (w.pipelineId === null ? '' : ' · #' + w.pipelineId) + (w.refName ? ' · ' + w.refName : '');
          if (!project) return '- ' + escapeTableCell(label);
          const base = project.web_url ?? this.config.gitlabBaseUrl.replace(/\/$/, '') + '/' + project.path_with_namespace;
          const target = w.pipelineId === null ? '?ref=' + encodeURIComponent(w.refName ?? '') : '/' + w.pipelineId;
          return '- [' + escapeTableCell(label) + '](<' + base + '/-/pipelines' + target + '>)';
        }).join('\n'),
        await this.summary(s.id, true),
        (await this.extensions.renderStatusExtra?.(s))?.trim(),
      ].filter(Boolean).join('\n\n'), this.secrets),
    );
  }
  private async handleApprovalIntent(s: IssueSessionRow, intent: ParsedUserIntent, question?: ApprovalRequestRow) {
    const pending = question ?? (
      intent.targetNoteId !== undefined
        ? await this.repo.getApprovalByNoteId(s.id, intent.targetNoteId)
        : await this.repo.getLatestPendingApproval(s.id));
    if (pending?.status !== 'PENDING') return;
    const { approvalType, toolName, toolInput } = pending;
    const capabilities = await this.getCapabilities();
    const profile = await this.resolveTurnProfile(s, capabilities, { purpose: 'approval', approval: { approvalType, toolName, toolInput } });
    if (profile?.blockedMessage?.trim()) return;
    const { approvalProjectId } = this.channel(s);
    const permitted = profile?.canApprove
      ? await profile.canApprove({
          projectId: approvalProjectId, userId: intent.userId, username: intent.username,
          approvalType, toolName, toolInput,
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
        await this.channel(s).createNote('> 🔒 该操作需要生产审批权限（Maintainer 或指定生产审批人），请邀请负责人在审批卡上点 👍 放行。');
      } catch (error) {
        this.denialNotices.delete(key);
        throw error;
      }
      return;
    }
    const direct = this.registeredTools(capabilities).some(tool => tool.name === toolName && tool.directExecuteOnApproval);
    await this.applyApproval(s, pending, intent, this.channel(s), (session, active, prompt, decision) =>
      this.run(session, active, prompt, decision, 'continuation'),
      direct ? (session, active, decision) => this.executeApprovedTool(session, active, decision, intent) : undefined);
  }
  private async executeApprovedTool(s: IssueSessionRow, active: Active, decision: ApprovalRequestRow, intent: ParsedUserIntent) {
    const channel = this.channel(s);
    const { toolName, toolInput, approvalType } = decision;
    let continuation: string | undefined;
    try {
      const capabilities = await this.getCapabilities();
      const profile = await this.resolveTurnProfile(s, capabilities, { purpose: 'turn' });
      const matches = this.registeredTools(capabilities).filter(tool => tool.name === toolName);
      const tool = matches[0];
      if (matches.length !== 1 || !tool.directExecuteOnApproval || tool.policy !== 'always_approve' ||
          profile?.blockedMessage || profile?.readonly || !profile?.enabledExtensionTools?.includes(toolName) ||
          s.permissionMode !== 'default') throw Error('该操作已不在当前流程的授权范围内。');
      const authorized = profile.canApprove
        ? await profile.canApprove({ projectId: s.hubProjectId, userId: intent.userId, username: intent.username, approvalType, toolName, toolInput })
        : await this.gitlab.hasApprovalPermission(s.hubProjectId, intent.userId);
      if (!authorized) throw Error('当前审批权限已变更，请重新申请审批。');
      const parsed = z.object(tool.schema).safeParse(toolInput);
      if (!parsed.success) throw Error('原审批参数与当前工具定义不符，请重新申请审批。');
      const ctx = { session: s, repo: this.repo, workspaceRoot: '', permissionMode: s.permissionMode, workflow: profile.workflow,
        approvalId: decision.id, approvedBy: intent.username, profileName: profile.name };
      const checked = await tool.guard?.(parsed.data, ctx);
      if (checked && !checked.ok) throw Error(checked.reason);
      active.controller.signal.throwIfAborted();
      const result = await tool.execute(parsed.data, ctx);
      const redact = (value: string) => redactGitUrl(value, this.secrets);
      const summary = redact(JSON.stringify(scrubJson(result, redact)) ?? 'null');
      if (tool.directExecuteOnApproval === 'resume') {
        continuation = redact(`工具 ${toolName} 已由 @${intent.username} 批准，系统已按审批参数直接执行完成。请勿重复调用该工具，直接基于结果继续已批准的步骤并完成核验。\n执行结果（JSON）：\n${summary}` +
          (decision.decisionComment ? '\n审批人补充说明：' + decision.decisionComment : ''));
      } else {
        let progress = `✅ @${intent.username} 已批准，操作已提交。等待异步回调后自动核验。\n\n${summary.slice(0, 1500)}`;
        try { progress = tool.formatDirectResult?.(result, parsed.data, ctx) ?? progress; }
        catch (error) { logError('approved-tool-summary', error, this.secrets, toolName); }
        await this.repo.updateSessionState(s.id, { status: 'IDLE', recoveryAttempts: 0 });
        s.status = 'IDLE';
        s.recoveryAttempts = 0;
        try { await channel.syncStatusLabel('IDLE'); }
        catch (error) { logError('approved-tool-label', error, this.secrets); }
        try { await channel.createNote(renderNote(progress, this.secrets)); }
        catch (error) { logError('approved-tool-note', error, this.secrets); }
      }
    } catch (error) {
      if (!active.ownsLease) throw error;
      logError('approved-tool', error, this.secrets, toolName);
      await this.state(s, 'FAILED');
      await channel.createNote(formatUserError(error, this.secrets));
      return;
    }
    await this.run(s, active, continuation, undefined, 'continuation');
  }
  private async handleSessionCommand(s: IssueSessionRow, intent: ParsedUserIntent) {
    if (intent.type === 'ABORT' || intent.type === 'RESET') await this.stop(s);
    await this.withLease(s, async (session, active) => {
      if (intent.type === 'ABORT' || intent.type === 'RESET') await this.repo.expireSessionPipelineWatches(session.id);
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
      await this.run(session, active, intent.comment || session.issueTitle, undefined, intent.type === 'PLAN' ? 'plan' : 'request');
    });
  }
}
