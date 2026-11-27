import type { Pool } from 'mysql2/promise';
import { expect, it, vi } from 'vitest';
import {
  MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus, type DeliveryExecutionRecord, type DeliveryExecutionRow,
} from '../src/index.js';

const record: DeliveryExecutionRecord = {
  sessionId: 'session', mrId: 'mr', approvalId: 'approval', agentProfile: 'unified',
  jumpserverJobId: 'job', jumpserverJobUrl: 'https://jms.test/job', playbookPath: 'deploy/test.yml',
  commitSha: 'abcde123'.repeat(5), targetAssets: ['web01'], status: 'PENDING',
};
const row: DeliveryExecutionRow = { ...record, id: 'id', createdAt: new Date(), finishedAt: null, outputSummary: null };

function setup() {
  const query = vi.fn().mockResolvedValue([[{ Key_name: 'pending_executions' }]]), execute = vi.fn();
  const pool = { query, execute } as unknown as Pool;
  return { repo: new MySqlDeliveryAuditRepository(), query, execute, pool };
}

it('attaches the shared pool only after all foreign keys and indexes are ready', async () => {
  const { repo, pool, query, execute } = setup();
  query.mockRejectedValueOnce(Error('DDL failed'));
  await expect(repo.init(pool)).rejects.toThrow('DDL failed');
  for (const call of [
    () => repo.recordExecution(record), () => repo.hasSessionJob('a', 'b'), () => repo.listSessionExecutions('a'),
    () => repo.updateExecutionResult('a', 'b', 'RUNNING', ''),
  ]) await expect(call()).rejects.toThrow('initialized');
  expect(execute).not.toHaveBeenCalled();
  await repo.init(pool);
  const ddl = query.mock.calls.find(([sql]) => sql.startsWith('CREATE TABLE'))![0];
  for (const clause of ['CREATE TABLE IF NOT EXISTS delivery_executions', 'target_assets JSON NOT NULL',
    'REFERENCES issue_sessions(id)', 'REFERENCES session_merge_requests(id)', 'REFERENCES approval_requests(id)',
    'UNIQUE (session_id, jumpserver_job_id)', 'INDEX (session_id, created_at)', 'ENGINE=InnoDB', 'utf8mb4_bin'])
    expect(ddl).toContain(clause);
});

it('records the submission and checks ownership with both session and job IDs', async () => {
  const { repo, pool, execute } = setup();
  await repo.init(pool);
  await repo.recordExecution(record);
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO delivery_executions'), [
    expect.stringMatching(/^[a-f0-9-]{36}$/), record.sessionId, record.mrId, record.approvalId, record.agentProfile,
    record.jumpserverJobId, record.jumpserverJobUrl, record.playbookPath, record.commitSha,
    JSON.stringify(record.targetAssets), 'PENDING', false,
  ]);
  execute.mockResolvedValueOnce([[{ '1': 1 }]]).mockResolvedValueOnce([[]]);
  expect(await repo.hasSessionJob('session', 'job')).toBe(true);
  expect(await repo.hasSessionJob('other', 'job')).toBe(false);
  expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('session_id=? AND jumpserver_job_id=?'), ['other', 'job']);
});

it.each([['SUCCESS', true], ['FAILED', true], ['RUNNING', false], ['PENDING', false]] as const)(
  'sets completion time only for terminal results (%s)', async (status, finished) => {
    const { repo, pool, execute } = setup();
    await repo.init(pool);
    await repo.updateExecutionResult('session', 'job', status, 'output');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('finished_at=IF(?, COALESCE(finished_at, NOW(3)), finished_at)'),
      [status, 'output', finished, 'session', 'job', status, status]);
  },
);

it('loads chronological executions with native or serialized JSON and renders audit references', async () => {
  const { repo, pool, execute } = setup();
  await repo.init(pool);
  execute.mockResolvedValueOnce([[row, { ...row, id: 'next', targetAssets: '["web02"]' }]]);
  const rows = await repo.listSessionExecutions(record.sessionId);
  expect(rows).toEqual([row, { ...row, id: 'next', targetAssets: ['web02'] }]);
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE session_id=? ORDER BY created_at ASC'), [record.sessionId]);
  const markdown = formatDeliveryExecutionsStatus(rows)!;
  expect(markdown.split('\n')).toHaveLength(3);
  for (const field of ['### 交付执行记录', row.agentProfile, row.playbookPath, row.commitSha.slice(0, 8),
    row.status, row.jumpserverJobUrl, row.approvalId]) expect(markdown).toContain(field);
  expect(markdown).not.toContain(row.commitSha);
  expect(formatDeliveryExecutionsStatus([])).toBeNull();
});

it('scans only the oldest 50 unfinished rows and completes them by session-scoped compare-and-set', async () => {
  const { repo, pool, execute } = setup();
  await repo.init(pool);
  execute.mockResolvedValueOnce([[{ ...row, targetAssets: '["web01"]' }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 0 }]);
  expect(await repo.listPendingExecutions()).toEqual([row]);
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("WHERE status IN ('PENDING', 'RUNNING') OR callback_pending=TRUE ORDER BY created_at ASC LIMIT 50"), []);
  expect(await repo.completeExecution('session', 'job', 'SUCCESS', 'ok')).toBe(true);
  expect(await repo.completeExecution('session', 'job', 'FAILED', 'late')).toBe(false);
  expect(execute).toHaveBeenLastCalledWith(expect.stringContaining(
    "finished_at=COALESCE(finished_at, NOW(3)) WHERE session_id=? AND jumpserver_job_id=? AND status IN ('PENDING', 'RUNNING')",
  ), ['FAILED', 'late', 'session', 'job']);
});

it('upgrades the scan index on existing installations and tolerates a second Pod creating it first', async () => {
  const { repo, pool, query } = setup();
  query.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[], []])
    .mockRejectedValueOnce(Object.assign(Error('duplicate index'), { code: 'ER_DUP_KEYNAME' }));
  await repo.init(pool);
  expect(query).toHaveBeenCalledWith('ALTER TABLE delivery_executions ADD INDEX pending_executions (status, created_at)');
  query.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[], []]).mockRejectedValueOnce(Error('DDL denied'));
  await expect(repo.init(pool)).rejects.toThrow('DDL denied');
});
