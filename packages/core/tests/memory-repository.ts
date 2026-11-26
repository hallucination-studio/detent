import { randomUUID } from 'node:crypto';
import {
  validateSequence,
  type InboxInput,
  type Decision,
  type Message,
  type MR,
  type NewRow,
  type DetentRepository,
  type State,
  type Worktree,
} from '../src/db/repository.js';
import type {
  ApprovalRequestRow,
  ApprovalType,
  IssueSessionRow,
  SessionKind,
  SessionInboxRow,
  SessionMergeRequestRow,
  SessionMessageRow,
  SessionWorktreeRow,
} from '../src/types.js';

export class InMemoryDetentRepository implements DetentRepository {
  private stops = new Map<string, string>();
  async requestStop(id: string, owner: string) {
    if (this.sessions.get(id)?.lockedByPod === owner) this.stops.set(id, owner);
  }
  async stopRequested(id: string, owner: string) {
    return this.stops.get(id) === owner;
  }
  async getLatestApproval(id: string) {
    return structuredClone([...this.approvals.values()].reverse().find((a) => a.sessionId === id) ?? null);
  }
  private sessions = new Map<string, IssueSessionRow>();
  private messages = new Map<string, SessionMessageRow[]>();
  private trees = new Map<string, SessionWorktreeRow>();
  private mrs = new Map<string, SessionMergeRequestRow>();
  private approvals = new Map<string, ApprovalRequestRow>();
  private inbox: SessionInboxRow[] = [];
  getOrCreateSession(project: number, iid: number, title: string) {
    return this.createSession('issue', project, iid, title);
  }
  getOrCreateMrSession(project: number, iid: number, title: string) {
    return this.createSession('mr', project, iid, title);
  }
  private async createSession(sessionKind: SessionKind, project: number, iid: number, title: string) {
    const existing = [...this.sessions.values()].find(
      (s) => s.sessionKind === sessionKind && s.hubProjectId === project && s.hubIssueIid === iid,
    );
    if (existing) return structuredClone(existing);
    const now = new Date();
    const s: IssueSessionRow = {
      id: randomUUID(),
      hubProjectId: project,
      hubIssueIid: iid,
      issueTitle: title,
      sessionKind, recoveryAttempts: 0, lastFailedPipelineId: null, autoFixAttempts: 0,
      status: sessionKind === 'issue' ? 'PLANNING' : 'CODING',
      permissionMode: sessionKind === 'issue' ? 'plan' : 'default',
      claudeSessionId: null,
      lastMessageSeq: 0,
      activeNoteId: null,
      lockedByPod: null,
      lockExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(s.id, s);
    this.messages.set(s.id, []);
    return structuredClone(s);
  }
  async getSession(id: string) {
    return structuredClone(this.sessions.get(id) ?? null);
  }
  getSessionByIssue(project: number, iid: number) {
    return this.byResource('issue', project, iid);
  }
  getSessionByMr(project: number, iid: number) {
    return this.byResource('mr', project, iid);
  }
  private async byResource(sessionKind: SessionKind, project: number, iid: number) {
    return structuredClone(
      [...this.sessions.values()].find((s) => s.sessionKind === sessionKind && s.hubProjectId === project && s.hubIssueIid === iid) ?? null,
    );
  }
  async updateSessionState(id: string, state: State) {
    Object.assign(this.sessions.get(id)!, state, { updatedAt: new Date() });
  }
  async acquireSessionLease(id: string, pod: string, ttl: number, expiredAt?: Date) {
    const s = this.sessions.get(id)!;
    if (expiredAt && (Number(s.lockExpiresAt) !== Number(expiredAt) || !['PLANNING', 'CODING'].includes(s.status))) return false;
    if (s.lockedByPod && s.lockedByPod !== pod && Number(s.lockExpiresAt) > Date.now()) return false;
    if (s.lockedByPod !== pod) this.stops.delete(id);
    s.lockedByPod = pod;
    s.lockExpiresAt = new Date(Date.now() + ttl * 1000);
    return true;
  }
  async renewSessionLease(id: string, pod: string, ttl: number) {
    const s = this.sessions.get(id)!;
    if (s.lockedByPod !== pod || Number(s.lockExpiresAt) <= Date.now()) return false;
    return this.acquireSessionLease(id, pod, ttl);
  }
  async releaseIfInboxEmpty(id: string, owner: string) {
    if (this.sessions.get(id)?.lockedByPod !== owner || this.inbox.some(i => i.sessionId === id && i.status === 'PENDING')) return false;
    await this.releaseSessionLease(id, owner);
    return true;
  }
  async releaseSessionLease(id: string, pod: string) {
    const s = this.sessions.get(id)!;
    if (s.lockedByPod === pod) Object.assign(s, { lockedByPod: null, lockExpiresAt: null });
  }
  async appendIncrementalMessages(id: string, messages: Message[]) {
    const s = this.sessions.get(id)!;
    s.lastMessageSeq = validateSequence(s.lastMessageSeq, messages);
    const rows = this.messages.get(id)!;
    for (const m of messages) if (!rows.some((r) => r.seq === m.seq)) rows.push({ ...m, sessionId: id });
    rows.sort((a, b) => a.seq - b.seq);
  }
  async getSessionMessages(id: string, afterSeq = 0) {
    return structuredClone(this.messages.get(id)!.filter((m) => m.seq > afterSeq));
  }
  async resetTranscript(id: string) {
    this.messages.set(id, []);
    Object.assign(this.sessions.get(id)!, {
      lastMessageSeq: 0,
      claudeSessionId: null,
      permissionMode: this.sessions.get(id)!.sessionKind === 'mr' ? 'default' : 'plan',
      status: this.sessions.get(id)!.sessionKind === 'mr' ? 'CODING' : 'PLANNING',
      updatedAt: new Date(),
    });
  }
  private save<T extends { id: string; createdAt: Date; updatedAt: Date }>(
    map: Map<string, T>,
    row: NewRow<T>,
    previous: T | undefined,
  ) {
    const saved = {
      ...row,
      id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? new Date(),
      updatedAt: new Date(),
    } as T;
    map.set(saved.id, saved);
    return structuredClone(saved);
  }
  async findWorktree(id: string, project: number, branch: string) {
    return structuredClone(
      [...this.trees.values()].find(
        (t) => t.sessionId === id && t.targetProjectId === project && t.branchName === branch,
      ) ?? null,
    );
  }
  async upsertWorktree(row: Worktree) {
    return this.save(
      this.trees,
      row,
      [...this.trees.values()].find(
        (t) => t.sessionId === row.sessionId && t.targetProjectId === row.targetProjectId && t.branchName === row.branchName,
      ),
    );
  }
  async listActiveWorktrees(id: string) {
    return structuredClone(
      [...this.trees.values()].filter((t) => t.sessionId === id && t.status === 'ACTIVE'),
    );
  }
  async updateWorktreeCheckpoint(id: string, sha: string, patch: string | null) {
    Object.assign(this.trees.get(id)!, { lastCommitSha: sha, uncommittedDiff: patch, updatedAt: new Date() });
  }
  async archiveWorktree(id: string) {
    this.trees.get(id)!.status = 'ARCHIVED';
  }
  async upsertMergeRequest(row: MR) {
    const previous = [...this.mrs.values()].find(
      (m) => m.sessionId === row.sessionId && m.targetProjectId === row.targetProjectId && m.mrIid === row.mrIid,
    );
    const {
      mergeCommitSha = previous?.mergeCommitSha ?? null,
      mergedBy = previous?.mergedBy ?? null,
      mergedAt = previous?.mergedAt ?? null,
    } = row;
    return this.save(this.mrs, { ...row, mergeCommitSha, mergedBy, mergedAt }, previous);
  }
  async listSessionMergeRequests(id: string) {
    return structuredClone([...this.mrs.values()].filter((m) => m.sessionId === id));
  }
  async findMergeRequest(targetProjectId: number, mrIid: number) {
    return structuredClone([...this.mrs.values()].filter((m) => m.targetProjectId === targetProjectId && m.mrIid === mrIid));
  }
  async getMrSessionByApprovalNote(project: number, note: number) {
    const card = [...this.approvals.values()].find(a => a.gitlabNoteId === note && a.status === 'PENDING');
    const s = card && this.sessions.get(card.sessionId);
    return s?.sessionKind === 'mr' && s.hubProjectId === project ? structuredClone(s) : null;
  }
  async claimPipelineFailure(id: string, pipeline: number, max: number, content: string) {
    const s = this.sessions.get(id)!;
    if (s.status === 'DONE' || (s.lastFailedPipelineId ?? 0) >= pipeline) return 'skip' as const;
    s.lastFailedPipelineId = pipeline;
    if (s.autoFixAttempts >= max) return 'escalate' as const;
    s.autoFixAttempts++;
    await this.enqueueSessionInbox({ sessionId: id, eventId: 'pipeline/' + pipeline, sourceKind: 'pipeline', content });
    return 'run' as const;
  }
  async markMergeRequestClosed(id: string) {
    const mr = this.mrs.get(id);
    if (mr?.mrState !== 'opened') return false;
    Object.assign(mr, { mrState: 'closed', updatedAt: new Date() });
    return true;
  }
  async enqueueSessionInbox(input: InboxInput) {
    if (this.inbox.some(row => row.sessionId === input.sessionId && row.eventId === input.eventId)) return false;
    if (!this.sessions.has(input.sessionId)) return false;
    this.inbox.push({ ...input, senderUsername: input.senderUsername ?? null, discussionId: input.discussionId ?? null,
      id: this.inbox.length + 1, status: 'PENDING', createdAt: new Date(), consumedAt: null });
    return true;
  }
  async drainSessionInbox(sessionId: string, owner?: string, sourceKind?: string) {
    const session = this.sessions.get(sessionId);
    if (owner && (session?.lockedByPod !== owner || Number(session.lockExpiresAt) <= Date.now())) return [];
    const pending = this.inbox.filter(row => row.sessionId === sessionId && row.status === 'PENDING' && (!sourceKind || row.sourceKind === sourceKind));
    const snapshot = structuredClone(pending);
    for (const row of pending) Object.assign(row, { status: 'CONSUMED', consumedAt: new Date() });
    return snapshot;
  }
  async failRecovery(sessionId: string) {
    for (const i of this.inbox) if (i.sessionId === sessionId && i.status === 'PENDING') i.status = 'EXPIRED';
    await this.updateSessionState(sessionId, { status: 'FAILED' });
  }
  async listExpiredActiveSessions(limit = 50) {
    return structuredClone([...this.sessions.values()].filter(s => ['PLANNING','CODING'].includes(s.status) &&
      s.lockExpiresAt && Number(s.lockExpiresAt) <= Date.now()).sort((a,b) => Number(a.lockExpiresAt) - Number(b.lockExpiresAt)).slice(0, limit));
  }
  async listSessionsWithPendingInbox(limit = 50) {
    return structuredClone([...this.sessions.values()].filter(s => !['WAITING_PLAN','WAITING_TOOL','DONE'].includes(s.status) &&
      (!s.lockedByPod || Number(s.lockExpiresAt) <= Date.now()) && this.inbox.some(i => i.sessionId === s.id && i.status === 'PENDING'))
      .sort((a,b) => Number(a.updatedAt) - Number(b.updatedAt)).slice(0, limit));
  }
  async markMergeRequestMerged(id: string, mergeCommitSha: string | null, mergedBy: string) {
    const mr = this.mrs.get(id);
    if (!mr || mr.mrState === 'merged') return false;
    const now = new Date();
    Object.assign(mr, { mrState: 'merged', mergeCommitSha, mergedBy, mergedAt: now, updatedAt: now });
    return true;
  }
  async findMergeRequestByBranch(project: number, branch: string) {
    return structuredClone(
      [...this.mrs.values()].filter((m) => m.targetProjectId === project && m.sourceBranch === branch),
    );
  }
  async updateMergeRequestPipeline(id: string, pipeline: number, status: string) {
    const m = this.mrs.get(id)!;
    if (
      m.latestPipelineId !== null &&
      (pipeline < m.latestPipelineId ||
        (pipeline === m.latestPipelineId && status === m.latestPipelineStatus))
    )
      return false;
    Object.assign(m, { latestPipelineId: pipeline, latestPipelineStatus: status });
    return true;
  }
  async createApprovalRequest(id: string, type: ApprovalType, tool: string, input: Record<string, unknown>) {
    const a: ApprovalRequestRow = {
      id: randomUUID(),
      sessionId: id,
      approvalType: type,
      toolName: tool,
      toolInput: structuredClone(input),
      gitlabNoteId: null,
      status: 'PENDING',
      decidedBy: null,
      decisionComment: null,
      createdAt: new Date(),
      decidedAt: null,
    };
    this.approvals.set(a.id, a);
    return structuredClone(a);
  }
  async updateApprovalNoteId(id: string, note: number) {
    this.approvals.get(id)!.gitlabNoteId = note;
  }
  async getLatestPendingApproval(id: string) {
    return structuredClone(
      [...this.approvals.values()].reverse().find((a) => a.sessionId === id && a.status === 'PENDING') ??
        null,
    );
  }
  async getApprovalByNoteId(id: string, note: number) {
    return structuredClone(
      [...this.approvals.values()].find((a) => a.sessionId === id && a.gitlabNoteId === note) ?? null,
    );
  }
  async getApproval(id: string) {
    return structuredClone(this.approvals.get(id) ?? null);
  }
  async resolveApprovalRequest(id: string, status: Decision, user: string, comment = '') {
    const a = this.approvals.get(id);
    if (a?.status !== 'PENDING') return false;
    Object.assign(a, { status, decidedBy: user, decisionComment: comment, decidedAt: new Date() });
    return true;
  }
}
