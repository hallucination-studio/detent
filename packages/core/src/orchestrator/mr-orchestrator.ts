import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { DecisionClient } from '../decision/jev-client.js';
import type { DetentExtensions } from '../extensions.js';
import { PermissionGate, ColdHold } from '../claude/permission-gate.js';
import { buildMrSystemPrompt, inlinePosition } from '../claude/prompts.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { TranscriptHydrator } from '../claude/transcript-hydrator.js';
import { redactGitUrl, type GitLabClient } from '../gitlab/client.js';
import { hasBotMention, parseNoteIntent, parseEmojiIntent } from '../gitlab/command-parser.js';
import { NoteStreamer, renderPlanApprovalCard } from '../gitlab/note-streamer.js';
import { actionableMr, normalizeGitLabEvent, type EventOf } from '../gitlab/webhook.js';
import { evaluateEventPolicy, loadHubEventPolicy } from '../router/event-policy.js';
import { sendEventNotification } from '../router/notifier.js';
import type { ApprovalRequestRow, IssueSessionRow, NormalizedGitLabEvent, ParsedUserIntent, SessionInboxRow } from '../types.js';
import { EphemeralSandbox, type TurnSandbox, type WorkspaceGitLab } from '../workspace/ephemeral-sandbox.js';
import { mrWorkspaceTools, WorkspaceTools } from '../workspace/mcp-tools.js';
import { createMrTools } from '../workspace/mr-tools.js';
import { createMrChannel } from './channel.js';
import { formatInboxMessages, SessionBusy, StopTurn, TurnRuntime, type Active } from './turn-runtime.js';

type Client = WorkspaceGitLab & Parameters<typeof sendEventNotification>[0] & Pick<GitLabClient,
  'getMergeRequest' | 'getBotIdentity' | 'isBotUser' | 'hasApprovalPermission' | 'getRepositoryFile' |
  'listOpenMergeRequestsByBranch' | 'listMergeRequestDiffs' | 'listMergeRequestDiscussions'>;

export class MergeRequestOrchestrator extends TurnRuntime {
  private turns = new Set<Promise<void>>();
  constructor(config: AppConfig, repo: DetentRepository, private gitlab: Client, private runner: ClaudeRunner,
    private options: { decision?: DecisionClient; onNotify?: DetentExtensions['onNotify'];
      runHubEvent: (event: NormalizedGitLabEvent, body: string, label?: string) => Promise<void> }) {
    super(config, repo);
  }
  private channel(s: IssueSessionRow, discussion?: string) {
    return createMrChannel(this.gitlab, s.hubProjectId, s.hubIssueIid, discussion);
  }
  private async reopen(s: IssueSessionRow) {
    await this.withLease(s, async session => {
      if (session.status === 'DONE') await this.repo.updateSessionState(s.id, {
        status: 'IDLE', permissionMode: 'default', autoFixAttempts: 0, recoveryAttempts: 0,
      });
    });
  }
  private wake(s: IssueSessionRow, reason: 'inbox' | 'note' = 'inbox') {
    // The durable inbox outlives this task. Keep webhook lanes free for interrupts and approvals.
    const task = this.wakeSession(s, reason).catch(error => {
      if (!(error instanceof SessionBusy)) console.error(redactGitUrl(String(error), this.config.jevApiKey));
    }).finally(() => this.turns.delete(task));
    this.turns.add(task);
  }
  async drain() {
    await Promise.all(this.turns);
  }
  async handleMergeRequestEvent(event: EventOf<'merge_request'>, eventId: string = randomUUID()) {
    if (!actionableMr(event, this.gitlab)) return;
    const a = event.object_attributes;
    const project = a.target_project_id ?? event.project.id;
    if (a.action === 'close' || a.action === 'merge') {
      const s = await this.repo.getSessionByMr(project, a.iid);
      if (s) {
        await this.stop(s);
        await this.withLease(s, async (session, active) => {
          await this.expire(session);
          await this.drainInbox(s.id, active);
          await this.archiveWorktrees(s.id);
          await this.repo.updateSessionState(s.id, { status: 'DONE' });
        });
      }
      if (a.action === 'close')
        for (const row of await this.repo.findMergeRequest(project, a.iid)) await this.repo.markMergeRequestClosed(row.id);
      return;
    }
    if (event.user.id === undefined || !await this.gitlab.hasApprovalPermission(project, event.user.id)) return;
    const s = await this.repo.getOrCreateMrSession(project, a.iid, a.title ?? 'MR !' + a.iid);
    if (s.status === 'DONE') {
      if ((await this.gitlab.getMergeRequest(project, a.iid)).state !== 'opened') return;
      await this.reopen(s);
    }
    await this.repo.enqueueSessionInbox({ sessionId: s.id, sourceKind: 'merge_request', eventId,
      senderUsername: event.user.username, content: '请检查新分配的 MR，诊断流水线、评审意见与合并冲突，并处理需要修复的问题。' });
    this.wake(s);
  }
  async handleMergeRequestNote(event: EventOf<'note'>, eventId = 'note/' + event.object_attributes.id) {
    const a = event.object_attributes;
    const resource = event.merge_request;
    if (a.noteable_type !== 'MergeRequest' || a.system || (a.action && a.action !== 'create') || resource?.state !== 'opened') return;
    const project = resource.target_project_id ?? event.project.id;
    if (!await this.gitlab.hasApprovalPermission(project, event.user.id)) return;
    let s = await this.repo.getSessionByMr(project, resource.iid);
    const botUsername = this.gitlab.getBotIdentity()?.username;
    const intent = parseNoteIntent({ userId: event.user.id, username: event.user.username, noteBody: a.note,
      sessionStatus: s?.status ?? 'IDLE', botUsername });
    const discussion = a.discussion_id ?? undefined;
    if (intent.type !== 'PROMPT') {
      if (s && s.status !== 'DONE') {
        if (s.autoFixAttempts) await this.repo.updateSessionState(s.id, { autoFixAttempts: 0 });
        await this.command(s, intent, discussion);
      }
      return;
    }
    const mr = await this.gitlab.getMergeRequest(project, resource.iid);
    if (mr.state !== 'opened') return;
    if (!mr.assignees?.some(a => this.gitlab.isBotUser(a.id, a.username)) && !hasBotMention(a.note, botUsername)) return;
    s ??= await this.repo.getOrCreateMrSession(project, mr.iid, mr.title);
    if (s.status === 'DONE') await this.reopen(s);
    const added = await this.repo.enqueueSessionInbox({ sessionId: s.id, eventId, sourceKind: 'note', discussionId: discussion,
      senderUsername: event.user.username, content: redactGitUrl(inlinePosition({ type: a.type, position: a.position ?? undefined }) +
        (intent.comment || a.note), this.config.jevApiKey) });
    if (added) await this.repo.updateSessionState(s.id, { autoFixAttempts: 0 });
    this.wake(s, 'note');
  }
  async handleMergeRequestEmoji(event: EventOf<'emoji'>) {
    if (event.object_attributes.awardable_type !== 'Note') return;
    const project = event.merge_request?.target_project_id ?? event.project?.id ?? event.project_id;
    const a = event.object_attributes;
    const intent = parseEmojiIntent({ userId: event.user.id, username: event.user.username, emojiName: a.name,
      noteId: a.awardable_id, action: a.action });
    if (!intent || !await this.gitlab.hasApprovalPermission(project, event.user.id)) return;
    const iid = event.merge_request?.iid ?? event.note?.noteable_iid;
    const s = iid ? await this.repo.getSessionByMr(project, iid) : await this.repo.getMrSessionByApprovalNote(project, a.awardable_id);
    if (s && s.status !== 'DONE') await this.command(s, intent, event.note?.discussion_id ?? undefined);
  }
  private async command(s: IssueSessionRow, intent: ParsedUserIntent, discussion?: string) {
    const pending = intent.targetNoteId ? await this.repo.getApprovalByNoteId(s.id, intent.targetNoteId)
      : await this.repo.getLatestPendingApproval(s.id);
    if (intent.type === 'STATUS') {
      await this.channel(s, discussion).createNote([s.status, pending?.approvalType].filter(Boolean).join(' · '));
    } else if (intent.type === 'APPROVE' || intent.type === 'REJECT') {
      if (pending?.status === 'PENDING') await this.applyApproval(s, pending, intent, (session, active, prompt, previous) =>
        this.run(session, active, prompt, discussion ? [discussion] : [], previous));
    } else if (['PLAN', 'ABORT', 'RESET'].includes(intent.type)) {
      if (intent.type !== 'PLAN') await this.stop(s);
      await this.withLease(s, async (session, active) => {
        if (session.status === 'DONE') return;
        await this.expire(session);
        if (intent.type === 'ABORT') {
          await this.drainInbox(s.id, active);
          await this.repo.updateSessionState(s.id, { status: 'IDLE' });
          await this.channel(s, discussion).createNote('本轮已中止。');
          return;
        }
        if (intent.type === 'RESET') {
          await this.repo.resetTranscript(s.id);
          session = (await this.repo.getSession(s.id))!;
        } else session.permissionMode = 'plan';
        await this.run(session, active, intent.comment || session.issueTitle, discussion ? [discussion] : []);
      });
    }
  }
  async wakeSession(candidate: IssueSessionRow, reason: 'inbox' | 'expired' | 'note') {
    if (candidate.sessionKind !== 'mr') return;
    await this.withLease(candidate, async (s, active) => {
      if (s.status === 'DONE' || s.status === 'WAITING_TOOL' || (s.status === 'WAITING_PLAN' && reason !== 'note')) return;
      if (reason === 'expired' && !await this.recover(s, this.channel(s))) return;
      const items = await this.drainInbox(s.id, active, s.status === 'WAITING_PLAN' ? 'note' : undefined);
      if (!items.length && reason !== 'expired') return;
      if (s.status === 'WAITING_PLAN') await this.expire(s);
      await this.run(s, active, formatInboxMessages(items, this.config.jevApiKey) || '上轮执行中断，请检查已保存进度并继续。', threads(items));
    }, undefined, reason === 'expired' ? candidate.lockExpiresAt! : undefined);
  }
  private async run(s: IssueSessionRow, active: Active, prompt: string, discussions: string[], previous?: ApprovalRequestRow) {
    for (;;) {
      await this.runTurn(s, active, prompt, discussions, previous);
      if (active.controller.signal.aborted || !['IDLE', 'WAITING_PLAN'].includes(s.status)) return;
      if (await this.repo.releaseIfInboxEmpty(s.id, active.owner)) {
        active.ownsLease = false;
        return;
      }
      const late = await this.drainInbox(s.id, active, s.status === 'WAITING_PLAN' ? 'note' : undefined);
      if (!late.length) return;
      if (s.status === 'WAITING_PLAN') await this.expire(s);
      prompt = formatInboxMessages(late, this.config.jevApiKey);
      discussions = threads(late);
      previous = undefined;
    }
  }
  private async runTurn(s: IssueSessionRow, active: Active, prompt: string, discussions: string[], previousDecision?: ApprovalRequestRow) {
    const channel = this.channel(s, discussions[0]);
    const { controller } = active;
    const host = new EphemeralSandbox(this.config, this.repo, this.gitlab);
    const redact = (text: string) => redactGitUrl(text, this.config.jevApiKey);
    let sandbox: TurnSandbox | undefined;
    let streamer: NoteStreamer | undefined;
    try {
      const mr = await this.gitlab.getMergeRequest(s.hubProjectId, s.hubIssueIid);
      if (mr.state !== 'opened') {
        await this.expire(s);
        await this.archiveWorktrees(s.id);
        s.status = 'DONE';
        await this.repo.updateSessionState(s.id, { status: s.status });
        return;
      }
      const bot = this.gitlab.getBotIdentity();
      const readonly = mr.source_project_id !== mr.target_project_id &&
        !(bot && await this.gitlab.hasApprovalPermission(mr.source_project_id, bot.id, 30));
      const plan = s.permissionMode === 'plan';
      const resume = !!s.claudeSessionId && s.lastMessageSeq > 0;
      s.claudeSessionId ??= randomUUID();
      const note = await channel.createNote('正在检查 MR…');
      s.status = plan ? 'PLANNING' : 'CODING';
      await this.repo.updateSessionState(s.id, { status: s.status, activeNoteId: note.id,
        permissionMode: s.permissionMode, claudeSessionId: s.claudeSessionId });
      streamer = new NoteStreamer(this.config.noteStreamThrottleMs, body => channel.updateNote(note.id, redact(body)), async () => '');
      sandbox = await host.prepareTurnSandbox(s);
      const tree = await host.ensureMrWorktree(sandbox, s.id, { sourceProjectId: mr.source_project_id, sourceBranch: mr.source_branch, targetBranch: mr.target_branch });
      const transcript = new TranscriptHydrator(this.repo);
      const { workspaceRoot, claudeHome } = sandbox;
      await transcript.hydrateTranscriptToTmp(s, claudeHome, workspaceRoot);
      const flush = () => transcript.flushIncrementalTranscriptToMySql(s, claudeHome, workspaceRoot, s.claudeSessionId!);
      const gate = new PermissionGate({ session: s, config: this.config, repo: this.repo, controller, workspaceRoot, channel,
        profile: { readonly }, decision: this.options.decision, previousDecision, allowedWorkspaceTools: mrWorkspaceTools,
        extensionTools: createMrTools(this.gitlab, mr, host, sandbox, tree),
        checkpoint: async () => { await flush(); await host.checkpoint(sandbox!, s.id); } });
      active.gate = gate;
      const pipeline = mr.head_pipeline ?? (await this.gitlab.listPipelines(s.hubProjectId, mr.iid))[0]
        ?? (await this.gitlab.listPipelines(mr.source_project_id, mr.source_branch))[0];
      const jobs = pipeline?.status === 'failed' ? await this.gitlab.getPipelineJobs(pipeline.project_id ?? mr.source_project_id, pipeline.id) : [];
      const system = buildMrSystemPrompt(mr, tree, readonly, plan, pipeline, jobs.filter(j => j.status === 'failed').map(j => j.name),
        await this.gitlab.listMergeRequestDiscussions(s.hubProjectId, mr.iid));
      controller.signal.throwIfAborted();
      const replyThreads = new Set(discussions);
      let result: string;
      try {
        result = await this.runner.run({ session: s, sandbox, prompt: redact(prompt), systemPrompt: redact(system),
          gate, controller, resume, allowedWorkspaceTools: mrWorkspaceTools, tools: new WorkspaceTools(host, sandbox, s.id, readonly || plan, tree, mr),
          progress: step => streamer!.push(step), appendText: text => streamer!.appendText(text),
          drainInbox: async () => {
            const items = await this.drainInbox(s.id, active);
            for (const discussion of threads(items)) replyThreads.add(discussion);
            return items;
          } });
      } finally {
        if (active.ownsLease) await flush();
      }
      controller.signal.throwIfAborted();
      await host.checkpoint(sandbox, s.id);
      controller.signal.throwIfAborted();
      let discussionReply = result;
      if (plan && !readonly) {
        const card = await this.repo.createApprovalRequest(s.id, 'PLAN', 'Plan', {});
        await this.repo.updateApprovalNoteId(card.id, note.id);
        s.status = 'WAITING_PLAN';
        await this.repo.updateSessionState(s.id, { status: s.status });
        await streamer.flush(renderPlanApprovalCard(result));
      } else {
        discussionReply = await streamer.flush(result);
        s.status = 'IDLE';
      }
      for (const discussion of replyThreads)
        if (discussion !== discussions[0]) await this.channel(s, discussion).createNote(redact(discussionReply));
      await this.repo.updateSessionState(s.id, { status: s.status, recoveryAttempts: 0 });
    } catch (error) {
      const cause = controller.signal.reason ?? error;
      if (!active.ownsLease) throw cause;
      try {
        if (sandbox) await host.checkpoint(sandbox, s.id);
      } finally {
        if (cause instanceof ColdHold) await streamer?.flush('等待工具审批，审批后继续。');
        else {
          await this.expire(s);
          const stopped = cause instanceof StopTurn;
          s.status = stopped ? 'IDLE' : 'FAILED';
          await this.repo.updateSessionState(s.id, { status: s.status });
          const body = stopped ? '本轮已中止。' : redact('本轮执行失败：' + String(cause));
          if (streamer) await streamer.flush(body);
          else await channel.createNote(body);
        }
      }
    } finally {
      active.gate = undefined;
      if (sandbox) await host.destroy(sandbox);
    }
  }
  async handlePipelineEvent(event: EventOf<'pipeline'>, eventId = 'pipeline/' + event.object_attributes.id) {
    const p = event.object_attributes;
    const project = event.merge_request?.target_project_id ?? event.project.id;
    const rows = event.merge_request ? await this.repo.findMergeRequest(project, event.merge_request.iid)
      : await this.repo.findMergeRequestByBranch(project, p.ref);
    const updated = new Set<string>();
    for (const row of rows)
      if (await this.repo.updateMergeRequestPipeline(row.id, p.id, p.status)) updated.add(row.id);
    if (p.status !== 'success' && p.status !== 'failed') return;
    const matches = event.merge_request ? [event.merge_request] : await this.gitlab.listOpenMergeRequestsByBranch(project, p.ref);
    if (p.status === 'success') {
      for (const { iid } of matches) {
        const s = await this.repo.getSessionByMr(project, iid);
        if (s?.autoFixAttempts && (s.lastFailedPipelineId ?? 0) <= p.id) await this.repo.updateSessionState(s.id, { autoFixAttempts: 0 });
      }
      return;
    }
    const policy = await loadHubEventPolicy(this.gitlab, this.config.gitlabHubProjectId, this.config.gitlabHubDefaultBranch);
    const options = { bot: this.gitlab.getBotIdentity(), decision: this.options.decision };
    const normalized = normalizeGitLabEvent(eventId, event);
    const notified = new Set<string>();
    for (const match of matches.length ? matches : [null]) {
      const mr = match && await this.gitlab.getMergeRequest(project, match.iid);
      if (mr && (mr.state !== 'opened' || (mr.sha && p.sha && mr.sha !== p.sha))) continue;
      const context = {
        ...normalized, ref: mr?.source_branch ?? normalized.ref,
        summary: redactGitUrl([normalized.summary, mr?.title].filter(Boolean).join(' · '), this.config.jevApiKey),
        mr: mr ? { iid: mr.iid, title: mr.title, description: mr.description ?? undefined, assignees: mr.assignees ?? [] } : undefined,
      };
      const { rule, action } = await evaluateEventPolicy(policy, context, options);
      const assigned = mr?.assignees?.some(a => this.gitlab.isBotUser(a.id, a.username));
      const route = rule ? action : assigned ? 'run' : 'ignore';
      const resource = mr?.web_url ?? `${event.project.path_with_namespace ?? project}@${p.ref}`;
      let body = redactGitUrl([`Pipeline #${p.id} failed · ${resource}`, p.url].filter(Boolean).join('\n'), this.config.jevApiKey);
      if (route === 'notify') {
        await sendEventNotification(this.gitlab, this.config, { eventId, target: rule?.notifyTarget ?? 'resource',
          projectId: project, mrIid: mr?.iid, sha: p.sha, body, hubIssueLabel: rule?.hubIssueLabel }, this.options.onNotify);
        continue;
      }
      if (!mr) {
        if (route === 'run') await this.options.runHubEvent(context, body, rule?.hubIssueLabel);
        continue;
      }
      if (route === 'run') {
        const s = await this.repo.getOrCreateMrSession(project, mr.iid, mr.title);
        const outcome = await this.repo.claimPipelineFailure(s.id, p.id, rule?.maxAutoFixAttempts ?? this.config.mrMaxAutoFixAttempts, body);
        if (outcome === 'skip') continue;
        if (outcome === 'run') { this.wake(s); continue; }
        body += ' · 自动修复次数已用尽，请人工检查。';
        await this.channel(s).createNote(body);
      } else if (rule) continue;
      for (const row of rows) {
        if (row.mrIid !== mr.iid || notified.has(row.sessionId) || (route !== 'run' && !updated.has(row.id))) continue;
        const hub = await this.repo.getSession(row.sessionId);
        if (hub?.sessionKind === 'issue') {
          await sendEventNotification(this.gitlab, this.config, { eventId, target: 'hub_issue',
            projectId: hub.hubProjectId, issueIid: hub.hubIssueIid, body }, this.options.onNotify);
          notified.add(hub.id);
        }
      }
    }
  }
}

function threads(items: SessionInboxRow[]) {
  return [...new Set(items.flatMap(item => item.discussionId ? [item.discussionId] : []))];
}
