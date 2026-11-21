import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type {
  ApprovalRequestRow,
  ApprovalStatus,
  ApprovalType,
  IssueSessionRow,
  SessionMergeRequestRow,
  SessionMessageRow,
  SessionWorktreeRow,
} from '../types.js';

export type State = Partial<Pick<IssueSessionRow, 'status' | 'permissionMode' | 'activeNoteId' | 'claudeSessionId'>>;
export type Message = Omit<SessionMessageRow, 'sessionId' | 'id' | 'createdAt'>;
export type NewRow<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>;
export type Worktree = NewRow<SessionWorktreeRow>;
type MergeMetadata = Pick<SessionMergeRequestRow, 'mergeCommitSha' | 'mergedBy' | 'mergedAt'>;
export type MR = Omit<NewRow<SessionMergeRequestRow>, keyof MergeMetadata> & Partial<MergeMetadata>;
export type Decision = Exclude<ApprovalStatus, 'PENDING'>;

export interface DetentRepository {
  requestStop(id: string, owner: string): Promise<void>;
  stopRequested(id: string, owner: string): Promise<boolean>;
  getLatestApproval(id: string): Promise<ApprovalRequestRow | null>;
  getOrCreateSession(project: number, iid: number, title: string): Promise<IssueSessionRow>;
  getSession(id: string): Promise<IssueSessionRow | null>;
  getSessionByIssue(project: number, iid: number): Promise<IssueSessionRow | null>;
  updateSessionState(id: string, state: State): Promise<void>;
  acquireSessionLease(id: string, pod: string, ttl: number): Promise<boolean>;
  renewSessionLease(id: string, pod: string, ttl: number): Promise<boolean>;
  releaseSessionLease(id: string, pod: string): Promise<void>;
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
    await this.change('UPDATE issue_sessions SET stop_requested=TRUE WHERE id=? AND locked_by_pod=?', [
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
  private async rows<T>(table: string, where: string, args: unknown[]): Promise<T[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
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
  async getOrCreateSession(project: number, iid: number, title: string) {
    await this.change(
      'INSERT INTO issue_sessions(id,hub_project_id,hub_issue_iid,issue_title) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
      [randomUUID(), project, iid, title],
    );
    return (await this.getSessionByIssue(project, iid))!;
  }
  async getSessionByIssue(project: number, iid: number) {
    return (
      (
        await this.rows<IssueSessionRow>('issue_sessions', 'hub_project_id=? AND hub_issue_iid=?', [
          project,
          iid,
        ])
      )[0] ?? null
    );
  }
  async getSession(id: string) {
    return (await this.rows<IssueSessionRow>('issue_sessions', 'id=?', [id]))[0] ?? null;
  }
  async updateSessionState(id: string, state: State) {
    await this.change('UPDATE issue_sessions SET ? WHERE id=?', [columns(state), id]);
  }
  acquireSessionLease(id: string, pod: string, ttl: number) {
    return this.change(
      'UPDATE issue_sessions SET stop_requested=IF(locked_by_pod<=>?,stop_requested,FALSE),locked_by_pod=?,lock_expires_at=TIMESTAMPADD(SECOND,?,NOW(3)) WHERE id=? AND (locked_by_pod IS NULL OR locked_by_pod=? OR lock_expires_at<=NOW(3))',
      [pod, pod, ttl, id, pod],
    );
  }
  renewSessionLease(id: string, pod: string, ttl: number) {
    return this.change(
      'UPDATE issue_sessions SET lock_expires_at=TIMESTAMPADD(SECOND,?,NOW(3)) WHERE id=? AND locked_by_pod=? AND lock_expires_at>NOW(3)',
      [ttl, id, pod],
    );
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
  private async transaction(write: (cx: PoolConnection) => Promise<void>) {
    const cx = await this.pool.getConnection();
    try {
      await cx.beginTransaction();
      await write(cx);
      await cx.commit();
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
        "UPDATE issue_sessions SET last_message_seq=0,claude_session_id=NULL,permission_mode='plan',status='PLANNING' WHERE id=?",
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
