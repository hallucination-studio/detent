import mysql, { type Pool } from 'mysql2/promise';
import type { AppConfig } from '../config.js';

export function createMySqlPool(config: AppConfig) {
  return mysql.createPool({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    connectionLimit: config.mysqlConnectionLimit,
    charset: 'utf8mb4',
  });
}

const timestamps = `created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`;
const sessionFK = 'session_id CHAR(36) NOT NULL, FOREIGN KEY (session_id) REFERENCES issue_sessions(id)';
export async function initMySqlSchema(pool: Pool) {
  const tables = [
    `issue_sessions (id CHAR(36) PRIMARY KEY, hub_project_id BIGINT NOT NULL, hub_issue_iid BIGINT NOT NULL,
      issue_title VARCHAR(512) NOT NULL, claude_session_id VARCHAR(128), last_message_seq INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'PLANNING',
      permission_mode VARCHAR(32) NOT NULL DEFAULT 'plan', active_note_id BIGINT,
      stop_requested BOOLEAN NOT NULL DEFAULT FALSE, locked_by_pod VARCHAR(192), lock_expires_at DATETIME(3), ${timestamps}, UNIQUE(hub_project_id, hub_issue_iid))`,
    `session_messages (id BIGINT AUTO_INCREMENT PRIMARY KEY, ${sessionFK}, seq INT NOT NULL,
      message_uuid VARCHAR(64), message_type VARCHAR(64) NOT NULL, raw_json_line MEDIUMTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(session_id, seq))`,
    `session_worktrees (id CHAR(36) PRIMARY KEY, ${sessionFK}, target_project_id BIGINT NOT NULL,
      target_project_path VARCHAR(255) NOT NULL, repo_http_url VARCHAR(1024) NOT NULL,
      directory_name VARCHAR(255) NOT NULL, branch_name VARCHAR(255) NOT NULL, base_branch VARCHAR(255) NOT NULL,
      last_commit_sha VARCHAR(64), uncommitted_diff MEDIUMTEXT, status VARCHAR(32) NOT NULL, ${timestamps},
      UNIQUE(session_id, target_project_id, branch_name), UNIQUE(session_id, directory_name))`,
    `session_merge_requests (id CHAR(36) PRIMARY KEY, ${sessionFK}, worktree_id CHAR(36),
      FOREIGN KEY(worktree_id) REFERENCES session_worktrees(id), target_project_id BIGINT NOT NULL,
      target_project_path VARCHAR(255) NOT NULL, mr_iid BIGINT NOT NULL, mr_title VARCHAR(512) NOT NULL,
      mr_web_url VARCHAR(1024) NOT NULL, source_branch VARCHAR(255) NOT NULL, target_branch VARCHAR(255) NOT NULL,
      mr_state VARCHAR(32) NOT NULL, merge_commit_sha VARCHAR(64), merged_by VARCHAR(128), merged_at DATETIME(3),
      latest_pipeline_id BIGINT, latest_pipeline_status VARCHAR(64), ${timestamps},
      UNIQUE(session_id, target_project_id, mr_iid), INDEX(target_project_id, source_branch), INDEX(target_project_id, mr_iid))`,
    `approval_requests (id CHAR(36) PRIMARY KEY, ${sessionFK}, approval_type VARCHAR(32) NOT NULL,
      gitlab_note_id BIGINT, tool_name VARCHAR(128) NOT NULL, tool_input JSON NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING', decided_by VARCHAR(128), decision_comment TEXT,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), decided_at DATETIME(3),
      INDEX(session_id, status, created_at), INDEX(gitlab_note_id))`,
  ];
  for (const table of tables)
    await pool.query(
      'CREATE TABLE IF NOT EXISTS ' + table + ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    );
}
