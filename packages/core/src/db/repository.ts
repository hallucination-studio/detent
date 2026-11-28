import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type {
  ApprovalRequestRow,
  ApprovalStatus,
  ApprovalType,
  IssueSessionRow,
  SessionKind,
  SessionInboxRow,
  SessionMergeRequestRow,
  SessionMessageRow,
  SessionPipelineWatchRow,
  SessionWorktreeRow,
} from '../types.js';

export type State = Partial<Pick<IssueSessionRow, 'status' | 'permissionMode' | 'activeNoteId' | 'claudeSessionId' | 'autoFixAttempts' | 'lastFailedPipelineId' | 'recoveryAttempts'>>;
export type Message = Omit<SessionMessageRow, 'sessionId' | 'id' | 'createdAt'>;
export type NewRow<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>;
export type Worktree = NewRow<SessionWorktreeRow>;
type MergeMetadata = Pick<SessionMergeRequestRow, 'mergeCommitSha' | 'mergedBy' | 'mergedAt'>;
export type MR = Omit<NewRow<SessionMergeRequestRow>, keyof MergeMetadata> & Partial<MergeMetadata>;
export type Decision = Exclude<ApprovalStatus, 'PENDING'>;

export async function recordMergedMr(repo: DetentRepository, mr: SessionMergeRequestRow, sha: string | null, username: string, others: SessionMergeRequestRow[]) {
  if (!await repo.markMergeRequestMerged(mr.id, sha, username)) return false;
  if (mr.worktreeId && !others.some(row => row.id !== mr.id && row.mrState === 'opened' && row.worktreeId === mr.worktreeId))
    await repo.archiveWorktree(mr.worktreeId);
  return true;
}

export type InboxInput = Pick<SessionInboxRow, 'sessionId' | 'eventId' | 'sourceKind' | 'content'> &
  Partial<Pick<SessionInboxRow, 'senderUsername' | 'discussionId'>>;
export interface WatchResolution {
  onlyWatchId?: string;
  inbox?: (watch: SessionPipelineWatchRow) => InboxInput;
}

export interface DetentRepository {
  createPipelineWatch(sessionId: string, projectId: number, pipelineId: number | null, refName: string | null): Promise<string>;
  listSessionPipelineWatches(sessionId: string): Promise<SessionPipelineWatchRow[]>;
  resolveMatchingPipelineWatches(projectId: number, pipelineId: number, refName: string, options?: WatchResolution): Promise<SessionPipelineWatchRow[]>;
  expireSessionPipelineWatches(sessionId: string): Promise<void>;
  getOrCreateMrSession(project: number, iid: number, title: string): Promise<IssueSessionRow>;
  getSessionByMr(project: number, iid: number): Promise<IssueSessionRow | null>;
  getMrSessionByApprovalNote(project: number, note: number): Promise<IssueSessionRow | null>;
  claimPipelineFailure(id: string, pipeline: number, max: number, content: string): Promise<'skip' | 'escalate' | 'run'>;
  markMergeRequestClosed(id: string): Promise<boolean>;
  enqueueSessionInbox(input: InboxInput): Promise<boolean>;
  getFollowupSession(parent: IssueSessionRow): Promise<IssueSessionRow | null>;
  drainSessionInbox(sessionId: string, owner?: string, sourceKind?: string): Promise<SessionInboxRow[]>;
  failRecovery(sessionId: string): Promise<void>;
  listExpiredActiveSessions(limit?: number): Promise<IssueSessionRow[]>;
  listSessionsWithPendingInbox(limit?: number): Promise<IssueSessionRow[]>;
  requestStop(id: string, owner: string): Promise<void>;
  stopRequested(id: string, owner: string): Promise<boolean>;
  getLatestApproval(id: string): Promise<ApprovalRequestRow | null>;
  getOrCreateSession(project: number, iid: number, title: string): Promise<IssueSessionRow>;
  getSession(id: string): Promise<IssueSessionRow | null>;
  getSessionByIssue(project: number, iid: number): Promise<IssueSessionRow | null>;
  updateSessionState(id: string, state: State): Promise<void>;
  acquireSessionLease(id: string, pod: string, ttl: number, expiredAt?: Date): Promise<boolean>;
  renewSessionLease(id: string, pod: string, ttl: number): Promise<boolean>;
  releaseSessionLease(id: string, pod: string): Promise<void>;
  releaseIfInboxEmpty(id: string, owner: string): Promise<boolean>;
  appendIncrementalMessages(id: string, messages: Message[]): Promise<void>;
  getSessionMessages(id: string, afterSeq?: number): Promise<SessionMessageRow[]>;
  resetTranscript(id: string): Promise<void>;
  findWorktree(id: string, project: number, branch: string): Promise<SessionWorktreeRow | null>;
  upsertWorktree(row: Worktree): Promise<SessionWorktreeRow>;
  listActiveWorktrees(id: string): Promise<SessionWorktreeRow[]>;
  updateWorktreeCheckpoint(id: string, sha: string, patch: string | null): Promise<void>;
  archiveWorktree(id: string): Promise<void>;
  upsertMergeRequest(row: MR): Promise<SessionMergeRequestRow>;
  listSessionMergeRequests(id: string): Promise<SessionMergeRequestRow[]>;
  findMergeRequest(targetProjectId: number, mrIid: number): Promise<SessionMergeRequestRow[]>;
  markMergeRequestMerged(id: string, mergeCommitSha: string | null, mergedBy: string): Promise<boolean>;
  findMergeRequestByBranch(project: number, branch: string): Promise<SessionMergeRequestRow[]>;
  updateMergeRequestPipeline(id: string, pipeline: number, status: string): Promise<boolean>;
  createApprovalRequest(
    id: string,
    type: ApprovalType,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<ApprovalRequestRow>;
  updateApprovalNoteId(id: string, note: number): Promise<void>;
  getLatestPendingApproval(id: string): Promise<ApprovalRequestRow | null>;
  getApprovalByNoteId(id: string, note: number): Promise<ApprovalRequestRow | null>;
  getApproval(id: string): Promise<ApprovalRequestRow | null>;
  resolveApprovalRequest(
    id: string,
    status: Decision,
    user: string,
    comment?: string,
  ): Promise<boolean>;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const columns = (obj: object) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [snake(k), v]));
export class MySqlDetentRepository implements DetentRepository {
  constructor(private pool: Pool) {}
  async requestStop(id: string, owner: string) {
    await this.change('UPDATE issue_sessions SET stop_requested=TRUE WHERE id=? AND locked_by_pod=? AND lock_expires_at>NOW(3)', [
      id,
      owner,
    ]);
  }
  async stopRequested(id: string, owner: string) {
    return !!(
      await this.rows('issue_sessions', 'id=? AND locked_by_pod=? AND stop_requested=TRUE', [id, owner])
    ).length;
  }
  getLatestApproval(id: string) {
    return this.approval('session_id=? ORDER BY created_at DESC LIMIT 1', [id]);
  }
  private async rows<T>(table: string, where: string, args: unknown[], cx: Pool | PoolConnection = this.pool): Promise<T[]> {
    const [rows] = await cx.query<RowDataPacket[]>(
      'SELECT * FROM ' + table + ' WHERE ' + where,
      args,
    );
    return rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
        ) as T,
    );
  }
  private async change(sql: string, args: unknown[]) {
    const [result] = await this.pool.query<ResultSetHeader>(sql, args);
    return result.affectedRows > 0;
  }
  private async createSession(kind: SessionKind, project: number, iid: number, title: string) {
    await this.change(
      'INSERT INTO issue_sessions(id,session_kind,hub_project_id,hub_issue_iid,issue_title,status,permission_mode) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
      [randomUUID(), kind, project, iid, title, kind === 'issue' ? 'PLANNING' : 'CODING', kind === 'issue' ? 'plan' : 'default'],
    );
    return (await this.byResource(kind, project, iid))!;
  }
  private async byResource(kind: SessionKind, project: number, iid: number): Promise<IssueSessionRow | null> {
    return (await this.rows<IssueSessionRow>('issue_sessions', 'session_kind=? AND hub_project_id=? AND hub_issue_iid=?', [kind, project, iid]))[0] ?? null;
  }
  getOrCreateSession(project: number, iid: number, title: string) {
    return this.createSession('issue', project, iid, title);
  }
  getOrCreateMrSession(project: number, iid: number, title: string) {
    return this.createSession('mr', project, iid, title);
  }
  getSessionByIssue(project: number, iid: number) {
    return this.byResource('issue', project, iid);
  }
  getSessionByMr(project: number, iid: number) {
    return this.byResource('mr', project, iid);
  }
  async getMrSessionByApprovalNote(project: number, note: number) {
    return (await this.rows<IssueSessionRow>('issue_sessions',
      "session_kind='mr' AND hub_project_id=? AND id IN (SELECT session_id FROM approval_requests WHERE gitlab_note_id=? AND status='PENDING')",
      [project, note]))[0] ?? null;
  }
  claimPipelineFailure(id: string, pipeline: number, max: number, content: string) {
    return this.transaction(async cx => {
      // Serialize the budget decision and the durable wakeup across webhook workers.
      const [s] = await this.rows<IssueSessionRow>('issue_sessions', 'id=? FOR UPDATE', [id], cx);
      if (s.status === 'DONE' || (s.lastFailedPipelineId ?? 0) >= pipeline) return 'skip' as const;
      const run = s.autoFixAttempts < max;
      await cx.query('UPDATE issue_sessions SET auto_fix_attempts=auto_fix_attempts+?, last_failed_pipeline_id=? WHERE id=?',
        [run ? 1 : 0, pipeline, id]);
      if (!run) return 'escalate' as const;
      await cx.query('INSERT INTO session_inbox SET ?', [columns({
        sessionId: id, eventId: 'pipeline/' + pipeline, sourceKind: 'pipeline', content,
      })]);
      return 'run' as const;
    });
  }
  markMergeRequestClosed(id: string) {
    return this.change("UPDATE session_merge_requests SET mr_state='closed' WHERE id=? AND mr_state='opened'", [id]);
  }
  async createPipelineWatch(sessionId: string, projectId: number, pipelineId: number | null, refName: string | null) {
    const id = randomUUID();
    await this.change('INSERT INTO session_pipeline_watches(id,session_id,target_project_id,pipeline_id,ref_name) VALUES(?,?,?,?,?)',
      [id, sessionId, projectId, pipelineId, refName]);
    return id;
  }
  listSessionPipelineWatches(sessionId: string) {
    return this.rows<SessionPipelineWatchRow>('session_pipeline_watches', 'session_id=? ORDER BY created_at,id', [sessionId]);
  }
  resolveMatchingPipelineWatches(projectId: number, pipelineId: number, refName: string, { onlyWatchId, inbox }: WatchResolution = {}) {
    return this.transaction(async cx => {
      const watches = await this.rows<SessionPipelineWatchRow>('session_pipeline_watches',
        "target_project_id=? AND status='PENDING' AND (pipeline_id=? OR (pipeline_id IS NULL AND ref_name=?))" +
        (onlyWatchId ? ' AND id=?' : '') + ' FOR UPDATE', [projectId, pipelineId, refName, ...(onlyWatchId ? [onlyWatchId] : [])], cx);
      if (watches.length) await cx.query("UPDATE session_pipeline_watches SET status='RESOLVED' WHERE id IN (?)", [watches.map(w => w.id)]);
      // A pod can stop before it wakes the Issue. The watchdog must already have its event.
      if (inbox) for (const w of watches) await this.insertInbox(cx, inbox(w));
      return watches.map(w => ({ ...w, status: 'RESOLVED' as const }));
    });
  }
  async expireSessionPipelineWatches(sessionId: string) {
    await this.change("UPDATE session_pipeline_watches SET status='EXPIRED' WHERE session_id=? AND status='PENDING'", [sessionId]);
  }
  enqueueSessionInbox(input: InboxInput) {
    return this.insertInbox(this.pool, input);
  }
  async getFollowupSession(parent: IssueSessionRow) {
    return (await this.rows<IssueSessionRow>('issue_sessions s', `session_kind='issue' AND hub_project_id=? AND EXISTS
      (SELECT 1 FROM session_inbox i WHERE i.session_id=s.id AND i.event_id=CONCAT('followup:', ?, ':', s.hub_issue_iid)) LIMIT 1`,
      [parent.hubProjectId, parent.id]))[0] ?? null;
  }
  private async insertInbox(cx: Pool | PoolConnection, input: InboxInput) {
    // A watch UUID plus a large GitLab ID can exceed the existing 64-character deduplication key.
    const eventId = input.eventId.length > 64 ? createHash('sha256').update(input.eventId).digest('hex') : input.eventId;
    const [result] = await cx.query<ResultSetHeader>(
      `INSERT IGNORE INTO session_inbox (session_id, event_id, source_kind, sender_username, discussion_id, content)
       SELECT id, ?, ?, ?, ?, ? FROM issue_sessions WHERE id=? AND status <> 'DONE' FOR SHARE`,
      [eventId, input.sourceKind, input.senderUsername ?? null, input.discussionId ?? null, input.content, input.sessionId]);
    return result.affectedRows > 0;
  }
  drainSessionInbox(sessionId: string, owner?: string, sourceKind?: string) {
    return this.transaction(async cx => {
      const ownerCheck = owner ? ' AND EXISTS (SELECT 1 FROM issue_sessions WHERE id=? AND locked_by_pod=? AND lock_expires_at>NOW(3))' : '';
      const items = await this.rows<SessionInboxRow>('session_inbox',
        "session_id=? AND status='PENDING'" + (sourceKind ? ' AND source_kind=?' : '') + ownerCheck + ' ORDER BY id ASC FOR UPDATE',
        [sessionId, ...(sourceKind ? [sourceKind] : []), ...(owner ? [sessionId, owner] : [])], cx);
      if (items.length) await cx.query("UPDATE session_inbox SET status='CONSUMED', consumed_at=NOW(3) WHERE id IN (?)",
        [items.map(item => item.id)]);
      return items;
    });
  }
  failRecovery(sessionId: string) {
    return this.transaction(async cx => {
      await cx.query("UPDATE issue_sessions SET status='FAILED' WHERE id=?", [sessionId]);
      await cx.query("UPDATE session_inbox SET status='EXPIRED' WHERE session_id=? AND status='PENDING'", [sessionId]);
    });
  }
  listExpiredActiveSessions(limit = 50) {
    return this.rows<IssueSessionRow>('issue_sessions',
      "status IN ('PLANNING','CODING') AND lock_expires_at IS NOT NULL AND lock_expires_at <= NOW(3) ORDER BY lock_expires_at LIMIT ?", [limit]);
  }
  listSessionsWithPendingInbox(limit = 50) {
    return this.rows<IssueSessionRow>('issue_sessions s',
      `status NOT IN ('WAITING_PLAN','WAITING_TOOL','DONE') AND (locked_by_pod IS NULL OR lock_expires_at <= NOW(3))
       AND EXISTS (SELECT 1 FROM session_inbox i WHERE i.session_id=s.id AND i.status='PENDING') ORDER BY updated_at LIMIT ?`, [limit]);
  }
  async getSession(id: string) {
    return (await this.rows<IssueSessionRow>('issue_sessions', 'id=?', [id]))[0] ?? null;
  }
  async updateSessionState(id: string, state: State) {
    if (state.status === 'DONE') {
      // An event committed just before closure can still be waiting for the session lease.
      await this.transaction(async cx => {
        await cx.query('UPDATE issue_sessions SET ? WHERE id=?', [columns(state), id]);
        await cx.query("UPDATE session_inbox SET status='EXPIRED' WHERE session_id=? AND status='PENDING'", [id]);
      });
      return;
    }
    await this.change('UPDATE issue_sessions SET ? WHERE id=?', [columns(state), id]);
  }
  acquireSessionLease(id: string, pod: string, ttl: number, expiredAt?: Date) {
    return this.change(
      'UPDATE issue_sessions SET stop_requested=IF(locked_by_pod<=>?,stop_requested,FALSE),locked_by_pod=?,lock_expires_at=TIMESTAMPADD(SECOND,?,NOW(3)) WHERE id=? AND (locked_by_pod IS NULL OR locked_by_pod=? OR lock_expires_at<=NOW(3))' +
        (expiredAt ? " AND lock_expires_at=? AND status IN ('PLANNING','CODING')" : ''),
      [pod, pod, ttl, id, pod, ...(expiredAt ? [expiredAt] : [])],
    );
  }
  renewSessionLease(id: string, pod: string, ttl: number) {
    return this.change(
      'UPDATE issue_sessions SET lock_expires_at=TIMESTAMPADD(SECOND,?,NOW(3)) WHERE id=? AND locked_by_pod=? AND lock_expires_at>NOW(3)',
      [ttl, id, pod],
    );
  }
  releaseIfInboxEmpty(id: string, owner: string) {
    return this.change(`UPDATE issue_sessions SET locked_by_pod=NULL, lock_expires_at=NULL
      WHERE id=? AND locked_by_pod=? AND NOT EXISTS
      (SELECT 1 FROM session_inbox WHERE session_id=? AND status='PENDING')`, [id, owner, id]);
  }
  async releaseSessionLease(id: string, pod: string) {
    await this.change(
      'UPDATE issue_sessions SET locked_by_pod=NULL,lock_expires_at=NULL WHERE id=? AND locked_by_pod=?',
      [id, pod],
    );
  }
  async appendIncrementalMessages(id: string, messages: Message[]) {
    if (!messages.length) return;
    await this.transaction(async (cx) => {
      const [sessions] = await cx.query<RowDataPacket[]>(
        'SELECT last_message_seq FROM issue_sessions WHERE id=? FOR UPDATE',
        [id],
      );
      const cursor = sessions[0]?.last_message_seq;
      if (typeof cursor !== 'number') throw Error('Unknown session');
      const next = validateSequence(cursor, messages);
      await cx.query(
        'INSERT IGNORE INTO session_messages(session_id,seq,message_uuid,message_type,raw_json_line) VALUES ?',
        [messages.map((m) => [id, m.seq, m.messageUuid, m.messageType, m.rawJsonLine])],
      );
      await cx.query('UPDATE issue_sessions SET last_message_seq=? WHERE id=?', [next, id]);
    });
  }
  private async transaction<T>(write: (cx: PoolConnection) => Promise<T>) {
    const cx = await this.pool.getConnection();
    try {
      await cx.beginTransaction();
      const value = await write(cx);
      await cx.commit();
      return value;
    } catch (error) {
      await cx.rollback();
      throw error;
    } finally {
      cx.release();
    }
  }
  getSessionMessages(id: string, afterSeq = 0) {
    return this.rows<SessionMessageRow>('session_messages', 'session_id=? AND seq>? ORDER BY seq', [
      id,
      afterSeq,
    ]);
  }
  async resetTranscript(id: string) {
    await this.transaction(async (cx) => {
      await cx.query(
        "UPDATE issue_sessions SET last_message_seq=0,claude_session_id=NULL,permission_mode=IF(session_kind='mr','default','plan'),status=IF(session_kind='mr','CODING','PLANNING') WHERE id=?",
        [id],
      );
      await cx.query('DELETE FROM session_messages WHERE session_id=?', [id]);
    });
  }
  private async upsert<T>(table: string, row: Worktree | MR, key: string, args: unknown[]) {
    const data = columns(row);
    await this.change('INSERT INTO ' + table + ' SET ? ON DUPLICATE KEY UPDATE ?', [
      { id: randomUUID(), ...data },
      data,
    ]);
    return (await this.rows<T>(table, key, args))[0];
  }
  async findWorktree(id: string, project: number, branch: string) {
    return (
      (
        await this.rows<SessionWorktreeRow>(
          'session_worktrees',
          'session_id=? AND target_project_id=? AND branch_name=?',
          [id, project, branch],
        )
      )[0] ?? null
    );
  }
  upsertWorktree(row: Worktree) {
    return this.upsert<SessionWorktreeRow>(
      'session_worktrees',
      row,
      'session_id=? AND target_project_id=? AND branch_name=?',
      [row.sessionId, row.targetProjectId, row.branchName],
    );
  }
  listActiveWorktrees(id: string) {
    return this.rows<SessionWorktreeRow>('session_worktrees', "session_id=? AND status='ACTIVE'", [id]);
  }
  async updateWorktreeCheckpoint(id: string, sha: string, patch: string | null) {
    await this.change('UPDATE session_worktrees SET last_commit_sha=?, uncommitted_diff=? WHERE id=?', [
      sha,
      patch,
      id,
    ]);
  }
  async archiveWorktree(id: string) {
    await this.change("UPDATE session_worktrees SET status='ARCHIVED' WHERE id=?", [id]);
  }
  upsertMergeRequest(row: MR) {
    return this.upsert<SessionMergeRequestRow>(
      'session_merge_requests',
      row,
      'session_id=? AND target_project_id=? AND mr_iid=?',
      [row.sessionId, row.targetProjectId, row.mrIid],
    );
  }
  listSessionMergeRequests(id: string) {
    return this.rows<SessionMergeRequestRow>('session_merge_requests', 'session_id=?', [id]);
  }
  findMergeRequest(targetProjectId: number, mrIid: number) {
    return this.rows<SessionMergeRequestRow>('session_merge_requests', 'target_project_id=? AND mr_iid=?', [
      targetProjectId, mrIid,
    ]);
  }
  markMergeRequestMerged(id: string, mergeCommitSha: string | null, mergedBy: string) {
    return this.change(
      "UPDATE session_merge_requests SET mr_state='merged', merge_commit_sha=?, merged_by=?, merged_at=NOW(3) WHERE id=? AND mr_state<>'merged'",
      [mergeCommitSha, mergedBy, id],
    );
  }
  findMergeRequestByBranch(project: number, branch: string) {
    return this.rows<SessionMergeRequestRow>(
      'session_merge_requests',
      'target_project_id=? AND source_branch=?',
      [project, branch],
    );
  }
  updateMergeRequestPipeline(id: string, pipeline: number, status: string) {
    return this.change(
      'UPDATE session_merge_requests SET latest_pipeline_id=?, latest_pipeline_status=? WHERE id=? AND (latest_pipeline_id IS NULL OR latest_pipeline_id<? OR (latest_pipeline_id=? AND latest_pipeline_status<>?))',
      [pipeline, status, id, pipeline, pipeline, status],
    );
  }
  async createApprovalRequest(id: string, type: ApprovalType, tool: string, input: Record<string, unknown>) {
    const approvalId = randomUUID();
    await this.change(
      'INSERT INTO approval_requests(id,session_id,approval_type,tool_name,tool_input) VALUES(?,?,?,?,?)',
      [approvalId, id, type, tool, JSON.stringify(input)],
    );
    return (await this.getApproval(approvalId))!;
  }
  async updateApprovalNoteId(id: string, note: number) {
    await this.change('UPDATE approval_requests SET gitlab_note_id=? WHERE id=?', [note, id]);
  }
  private async approval(where: string, args: unknown[]): Promise<ApprovalRequestRow | null> {
    type StoredApproval = Omit<ApprovalRequestRow, 'toolInput'> & {
      toolInput: ApprovalRequestRow['toolInput'] | string;
    };
    const [row] = await this.rows<StoredApproval>('approval_requests', where, args);
    if (!row) return null;
    const toolInput = typeof row.toolInput === 'string' ? JSON.parse(row.toolInput) : row.toolInput;
    return { ...row, toolInput };
  }
  getLatestPendingApproval(id: string) {
    return this.approval("session_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [id]);
  }
  getApprovalByNoteId(id: string, note: number) {
    return this.approval('session_id=? AND gitlab_note_id=?', [id, note]);
  }
  getApproval(id: string) {
    return this.approval('id=?', [id]);
  }
  resolveApprovalRequest(id: string, status: Decision, user: string, comment = '') {
    return this.change(
      "UPDATE approval_requests SET status=?, decided_by=?, decision_comment=?, decided_at=NOW(3) WHERE id=? AND status='PENDING'",
      [status, user, comment, id],
    );
  }
}

export function validateSequence(cursor: number, messages: Message[]) {
  for (const m of messages) {
    // INSERT IGNORE must only suppress duplicates. Reject data MySQL would truncate.
    if (
      Buffer.byteLength(m.rawJsonLine) > 0xffffff ||
      /[\r\n]/.test(m.rawJsonLine) ||
      m.messageType.length > 64 ||
      (m.messageUuid?.length ?? 0) > 64
    )
      throw Error('Invalid transcript line');
  }
  for (const seq of messages.map((m) => m.seq).sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > cursor + 1) throw Error('Invalid transcript sequence');
    cursor = Math.max(cursor, seq);
  }
  return cursor;
}
