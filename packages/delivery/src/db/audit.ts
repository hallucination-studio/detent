import { randomUUID } from 'node:crypto';
import { escapeMarkdownCell } from '@detent/core';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { DeliveryExecutionRecord, DeliveryExecutionTracker } from '../jumpserver/tools.js';

export interface DeliveryExecutionRow extends DeliveryExecutionRecord {
  id: string;
  outputSummary: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface DeliveryAuditRepository extends DeliveryExecutionTracker {
  acknowledgeCallback(sessionId: string, jobId: string): Promise<void>;
  listPendingExecutions(): Promise<DeliveryExecutionRow[]>;
  completeExecution(sessionId: string, jobId: string, status: 'SUCCESS' | 'FAILED', outputSummary: string): Promise<boolean>;
  listSessionExecutions(sessionId: string): Promise<DeliveryExecutionRow[]>;
}

type Status = DeliveryExecutionRecord['status'];
type SqlRow = RowDataPacket & Omit<DeliveryExecutionRow, 'targetAssets'> & { targetAssets: string | string[] };
const isTerminal = (status: Status) => status === 'SUCCESS' || status === 'FAILED';
const assetList = z.array(z.string());

export class MySqlDeliveryAuditRepository implements DeliveryAuditRepository {
  private pool?: Pool;

  async init(pool: Pool): Promise<void> {
    await pool.query(`CREATE TABLE IF NOT EXISTS delivery_executions (
      id CHAR(36) PRIMARY KEY, session_id CHAR(36) NOT NULL, mr_id CHAR(36) NOT NULL, approval_id CHAR(36) NOT NULL,
      agent_profile VARCHAR(64) NOT NULL, jumpserver_job_id VARCHAR(128) NOT NULL, jumpserver_job_url VARCHAR(512) NOT NULL,
      playbook_path VARCHAR(255) NOT NULL, commit_sha VARCHAR(64) NOT NULL, target_assets JSON NOT NULL,
      status VARCHAR(32) NOT NULL, output_summary MEDIUMTEXT, callback_pending BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), finished_at DATETIME(3),
      FOREIGN KEY (session_id) REFERENCES issue_sessions(id),
      FOREIGN KEY (mr_id) REFERENCES session_merge_requests(id),
      FOREIGN KEY (approval_id) REFERENCES approval_requests(id),
      UNIQUE (session_id, jumpserver_job_id), INDEX (session_id, created_at), INDEX pending_executions (status, created_at), INDEX pending_callbacks (callback_pending, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    // CREATE TABLE IF NOT EXISTS does not add the scan index to existing installations.
    const [indexes] = await pool.query<RowDataPacket[]>("SHOW INDEX FROM delivery_executions WHERE Key_name='pending_executions'");
    if (!indexes.length) {
      try {
        await pool.query('ALTER TABLE delivery_executions ADD INDEX pending_executions (status, created_at)');
      } catch (error) {
        // Concurrent pod startup can create the same index after SHOW INDEX.
        if (!(error instanceof Error && 'code' in error && error.code === 'ER_DUP_KEYNAME')) throw error;
      }
    }
    const [columns] = await pool.query<RowDataPacket[]>("SHOW COLUMNS FROM delivery_executions LIKE 'callback_pending'");
    if (!columns.length) {
      try {
        await pool.query('ALTER TABLE delivery_executions ADD callback_pending BOOLEAN NOT NULL DEFAULT FALSE, ADD INDEX pending_callbacks (callback_pending, created_at)');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ER_DUP_FIELDNAME')) throw error;
      }
    }
    this.pool = pool;
  }

  private get db(): Pool {
    if (!this.pool) throw Error('Delivery audit repository has not been initialized');
    return this.pool;
  }

  async recordExecution(r: DeliveryExecutionRecord) {
    await this.db.execute(`INSERT INTO delivery_executions
      (id, session_id, mr_id, approval_id, agent_profile, jumpserver_job_id, jumpserver_job_url,
       playbook_path, commit_sha, target_assets, status, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(?, NOW(3), NULL))`,
    [randomUUID(), r.sessionId, r.mrId, r.approvalId, r.agentProfile, r.jumpserverJobId, r.jumpserverJobUrl,
      r.playbookPath, r.commitSha, JSON.stringify(r.targetAssets), r.status, isTerminal(r.status)]);
  }

  async hasSessionJob(sessionId: string, jobId: string) {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT 1 FROM delivery_executions WHERE session_id=? AND jumpserver_job_id=?', [sessionId, jobId],
    );
    return rows.length > 0;
  }

  async updateExecutionResult(sessionId: string, jobId: string, status: Status, outputSummary: string) {
    // Preserve the first completion time and ignore out-of-order poll responses.
    await this.db.execute(`UPDATE delivery_executions SET status=?, output_summary=?,
      finished_at=IF(?, COALESCE(finished_at, NOW(3)), finished_at)
      WHERE session_id=? AND jumpserver_job_id=?
        AND (status='PENDING' OR (status='RUNNING' AND ? <> 'PENDING') OR status=?)`,
    [status, outputSummary, isTerminal(status), sessionId, jobId, status, status]);
  }

  async completeExecution(sessionId: string, jobId: string, status: 'SUCCESS' | 'FAILED', outputSummary: string) {
    const [result] = await this.db.execute<ResultSetHeader>(`UPDATE delivery_executions SET status=?, output_summary=?,
      callback_pending=TRUE, finished_at=COALESCE(finished_at, NOW(3)) WHERE session_id=? AND jumpserver_job_id=? AND status IN ('PENDING', 'RUNNING')`,
    [status, outputSummary, sessionId, jobId]);
    return result.affectedRows > 0;
  }

  async acknowledgeCallback(sessionId: string, jobId: string) {
    await this.db.execute('UPDATE delivery_executions SET callback_pending=FALSE WHERE session_id=? AND jumpserver_job_id=? AND callback_pending=TRUE', [sessionId, jobId]);
  }

  listPendingExecutions() {
    return this.listExecutions("WHERE status IN ('PENDING', 'RUNNING') OR callback_pending=TRUE ORDER BY created_at ASC LIMIT 50", []);
  }

  listSessionExecutions(sessionId: string) {
    return this.listExecutions('WHERE session_id=? ORDER BY created_at ASC, id ASC', [sessionId]);
  }

  private async listExecutions(clause: string, params: string[]): Promise<DeliveryExecutionRow[]> {
    const [rows] = await this.db.execute<SqlRow[]>(`SELECT id, session_id AS sessionId, mr_id AS mrId,
      approval_id AS approvalId, agent_profile AS agentProfile, jumpserver_job_id AS jumpserverJobId,
      jumpserver_job_url AS jumpserverJobUrl, playbook_path AS playbookPath, commit_sha AS commitSha,
      target_assets AS targetAssets, status, output_summary AS outputSummary, created_at AS createdAt,
      finished_at AS finishedAt FROM delivery_executions ${clause}`, params);
    return rows.map(row => ({
      ...row, targetAssets: assetList.parse(typeof row.targetAssets === 'string' ? JSON.parse(row.targetAssets) : row.targetAssets),
    }));
  }
}

export function formatDeliveryExecutionsStatus(rows: DeliveryExecutionRow[]): string | null {
  if (!rows.length) return null;
  return ['### 交付执行记录', ...rows.map(r =>
    `- ${r.agentProfile} · ${escapeMarkdownCell(r.playbookPath, 'code')} @ \`${r.commitSha.slice(0, 8)}\` · ${r.status} · [JumpServer](<${r.jumpserverJobUrl}>) · 审批单 \`${r.approvalId}\``,
  )].join('\n');
}
