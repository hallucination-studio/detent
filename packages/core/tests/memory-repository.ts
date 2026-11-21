import { randomUUID } from 'node:crypto';
import {
  validateSequence,
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
  async getOrCreateSession(project: number, iid: number, title: string) {
    const existing = [...this.sessions.values()].find(
      (s) => s.hubProjectId === project && s.hubIssueIid === iid,
    );
    if (existing) return structuredClone(existing);
    const now = new Date();
    const s: IssueSessionRow = {
      id: randomUUID(),
      hubProjectId: project,
      hubIssueIid: iid,
      issueTitle: title,
      status: 'PLANNING',
      permissionMode: 'plan',
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
  async getSessionByIssue(project: number, iid: number) {
    return structuredClone(
      [...this.sessions.values()].find((s) => s.hubProjectId === project && s.hubIssueIid === iid) ?? null,
    );
  }
  async updateSessionState(id: string, state: State) {
    Object.assign(this.sessions.get(id)!, state, { updatedAt: new Date() });
  }
  async acquireSessionLease(id: string, pod: string, ttl: number) {
    const s = this.sessions.get(id)!;
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
      permissionMode: 'plan',
      status: 'PLANNING',
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
