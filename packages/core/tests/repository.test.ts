import { expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { createMySqlPool, initMySqlSchema } from '../src/db/mysql.js';
import { MySqlDetentRepository } from '../src/db/repository.js';
import { InMemoryDetentRepository } from './memory-repository.js';

async function setup() {
  const repo = new InMemoryDetentRepository();
  const { id } = await repo.getOrCreateSession(1, 42, 'Example');
  return { repo, id };
}
it('reads approval inputs from native MySQL JSON and JSON strings', async () => {
  const pool = createMySqlPool(loadConfig({}));
  try {
    const query = vi.spyOn(pool, 'query');
    const repo = new MySqlDetentRepository(pool);
    const input = { questions: [{ question: '目标分支？' }] };
    for (const value of [input, JSON.stringify(input)]) {
      query.mockResolvedValue([[{ tool_input: value } as RowDataPacket], []]);
      const rows = await Promise.all([
        repo.getApproval('a'), repo.getApprovalByNoteId('s', 1),
        repo.getLatestApproval('s'), repo.getLatestPendingApproval('s'),
      ]);
      for (const row of rows) expect(row?.toolInput).toEqual(input);
    }
  } finally {
    await pool.end();
  }
});
it('appends overlaps once and advances only over contiguous messages', async () => {
  const { repo, id } = await setup();
  const batch = (start: number) =>
    Array.from({ length: 5 }, (_, i) => ({
      seq: start + i,
      messageUuid: null,
      messageType: 'user',
      rawJsonLine: JSON.stringify({ start, i }),
    }));
  await repo.appendIncrementalMessages(id, batch(1));
  await repo.appendIncrementalMessages(id, batch(4));
  expect(await repo.getSessionMessages(id)).toHaveLength(8);
  expect((await repo.getSessionMessages(id, 3))[0].rawJsonLine).toBe(batch(1)[3].rawJsonLine);
  await expect(repo.appendIncrementalMessages(id, batch(10))).rejects.toThrow();
  expect((await repo.getSession(id))?.lastMessageSeq).toBe(8);
});
it('checks lease ownership on renew, release and expiry', async () => {
  vi.useFakeTimers();
  try {
    const { repo, id } = await setup();
    expect(await repo.acquireSessionLease(id, 'A', 2)).toBe(true);
    expect(await repo.acquireSessionLease(id, 'B', 2)).toBe(false);
    vi.advanceTimersByTime(2001);
    expect(await repo.renewSessionLease(id, 'A', 2)).toBe(false);
    expect(await repo.acquireSessionLease(id, 'B', 2)).toBe(true);
    await repo.releaseSessionLease(id, 'A');
    expect(await repo.acquireSessionLease(id, 'A', 2)).toBe(false);
    await repo.releaseSessionLease(id, 'B');
    expect(await repo.acquireSessionLease(id, 'A', 2)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('clears messages and restarts sequencing only for the reset session', async () => {
  const { repo, id } = await setup();
  const other = await repo.getOrCreateSession(1, 43, 'Other issue');
  const first = { seq: 1, messageUuid: null, messageType: 'user', rawJsonLine: '{"old":true}' };
  for (const sessionId of [id, other.id]) await repo.appendIncrementalMessages(sessionId, [first]);
  await repo.resetTranscript(id);
  expect(await repo.getSession(id)).toMatchObject({ lastMessageSeq: 0, claudeSessionId: null });
  expect(await repo.getSessionMessages(id)).toEqual([]);
  await repo.appendIncrementalMessages(id, [{ ...first, rawJsonLine: '{"new":true}' }]);
  expect((await repo.getSessionMessages(id))[0].rawJsonLine).toBe('{"new":true}');
  expect((await repo.getSessionMessages(other.id))[0]).toMatchObject(first);
});

it('looks up each issue tracking a project MR and records the first merge only', async () => {
  const { repo, id } = await setup();
  const row = {
    sessionId: id, worktreeId: null, targetProjectId: 2, targetProjectPath: 'org/repo',
    mrIid: 4, mrTitle: 'Feature', mrWebUrl: 'https://git/org/repo/-/merge_requests/4',
    mrState: 'opened' as const, sourceBranch: 'feature', targetBranch: 'main',
    latestPipelineId: null, latestPipelineStatus: null,
  };
  const first = await repo.upsertMergeRequest(row);
  const other = await repo.getOrCreateSession(1, 43, 'Other issue');
  const second = await repo.upsertMergeRequest({ ...row, sessionId: other.id });
  await repo.upsertMergeRequest({ ...row, mrIid: 5 });
  await repo.upsertMergeRequest({ ...row, targetProjectId: 3 });
  expect(await repo.findMergeRequest(2, 4)).toEqual([first, second]);
  expect(first).toMatchObject({ mergeCommitSha: null, mergedAt: null, mergedBy: null });
  expect(await repo.markMergeRequestMerged('missing', null, 'dev')).toBe(false);
  expect(await repo.markMergeRequestMerged(first.id, 'abc', 'dev')).toBe(true);
  const [merged] = await repo.findMergeRequest(2, 4);
  expect(merged).toMatchObject({ mrState: 'merged', mergeCommitSha: 'abc', mergedBy: 'dev', mergedAt: expect.any(Date) });
  expect(await repo.markMergeRequestMerged(first.id, null, 'other')).toBe(false);
  expect(await repo.findMergeRequest(2, 4)).toEqual([merged, second]);
  expect(await repo.markMergeRequestClosed(first.id)).toBe(false);
  expect(await repo.markMergeRequestClosed(second.id)).toBe(true);
  expect(await repo.markMergeRequestClosed(second.id)).toBe(false);
  const updated = await repo.upsertMergeRequest({ ...row, mrState: 'merged', mrTitle: 'New title' });
  expect(updated).toMatchObject({ ...merged, mrTitle: 'New title', updatedAt: expect.any(Date) });
});

it('isolates Issue #1 and MR !1, including defaults and transcript resets', async () => {
  const repo = new InMemoryDetentRepository();
  const [issue, mr] = await Promise.all([repo.getOrCreateSession(7, 1, 'Issue'), repo.getOrCreateMrSession(7, 1, 'MR')]);
  expect(issue.id).not.toBe(mr.id);
  expect(await repo.getSessionByIssue(7, 1)).toEqual(issue);
  expect(await repo.getSessionByMr(7, 1)).toEqual(mr);
  expect(await repo.getOrCreateMrSession(7, 1, 'retry')).toEqual(mr);
  for (const s of [issue, mr]) {
    expect(s).toMatchObject({ autoFixAttempts: 0, lastFailedPipelineId: null, recoveryAttempts: 0 });
    await repo.updateSessionState(s.id, { status: 'FAILED', permissionMode: 'acceptEdits' });
    await repo.resetTranscript(s.id);
    expect(await repo.getSession(s.id)).toMatchObject(s.id === mr.id
      ? { sessionKind: 'mr', status: 'CODING', permissionMode: 'default' }
      : { sessionKind: 'issue', status: 'PLANNING', permissionMode: 'plan' });
  }
});

it('deduplicates deliveries per session and consumes an ordered batch only once', async () => {
  const { repo, id } = await setup();
  const other = await repo.getOrCreateMrSession(1, 42, 'MR');
  const input = { sessionId: id, eventId: 'one', sourceKind: 'note', content: 'hello' };
  expect(await Promise.all([repo.enqueueSessionInbox(input), repo.enqueueSessionInbox(input)])).toEqual([true, false]);
  await repo.enqueueSessionInbox({ ...input, sessionId: other.id });
  await repo.enqueueSessionInbox({ ...input, eventId: 'two' });
  const batches = await Promise.all([repo.drainSessionInbox(id), repo.drainSessionInbox(id)]);
  expect(batches.map(batch => batch.map(row => row.eventId))).toEqual([['one', 'two'], []]);
  expect(await repo.enqueueSessionInbox(input)).toBe(false);
  expect(await repo.drainSessionInbox(other.id)).toHaveLength(1);
});

it('consumes only the locked IDs on one connection and rolls back a failed write', async () => {
  const pool = createMySqlPool(loadConfig({}));
  const cx = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query: vi.fn() };
  vi.spyOn(pool, 'getConnection').mockImplementation(async () => cx as unknown as Awaited<ReturnType<typeof pool.getConnection>>);
  const repo = new MySqlDetentRepository(pool);
  try {
    const pending = [[{ id: 3, session_id: 's' }, { id: 8, session_id: 's' }], []];
    cx.query.mockResolvedValueOnce(pending).mockResolvedValueOnce([{}, []]);
    expect(await repo.drainSessionInbox('s')).toEqual([{ id: 3, sessionId: 's' }, { id: 8, sessionId: 's' }]);
    expect(cx.query.mock.calls[0]).toEqual([expect.stringContaining("status='PENDING' ORDER BY id ASC FOR UPDATE"), ['s']]);
    expect(cx.query.mock.calls[1]).toEqual([expect.stringContaining("consumed_at=NOW(3) WHERE id IN (?)"), [[3, 8]]]);
    cx.query.mockResolvedValueOnce(pending).mockRejectedValueOnce(Error('write failed'));
    await expect(repo.drainSessionInbox('s')).rejects.toThrow('write failed');
    expect(cx.commit).toHaveBeenCalledOnce();
    expect(cx.rollback).toHaveBeenCalledOnce();
    expect(cx.release).toHaveBeenCalledTimes(2);
  } finally {
    await pool.end();
  }
});

it('upgrades the legacy resource key in one ALTER and skips it on subsequent starts', async () => {
  const pool = createMySqlPool(loadConfig({}));
  const query = vi.spyOn(pool, 'query').mockResolvedValue([[], []]);
  try {
    for (let i = 0; i < 6; i++) query.mockResolvedValueOnce([[], []]);
    query.mockResolvedValueOnce([[{ Key_name: 'hub_project_id' } as RowDataPacket], []]);
    await initMySqlSchema(pool);
    await initMySqlSchema(pool);
    const ddl = query.mock.calls.map(([sql]) => String(sql));
    expect(ddl.filter(sql => sql.startsWith('ALTER'))).toEqual([expect.stringMatching(
      /DROP INDEX hub_project_id, ADD session_kind.*ADD recovery_attempts.*UNIQUE KEY session_resource\(session_kind, hub_project_id, hub_issue_iid\)/,
    )]);
    expect(ddl.find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS session_inbox')))
      .toContain('UNIQUE(session_id, event_id), INDEX(session_id, status, id)');
    const repo = new MySqlDetentRepository(pool);
    query.mockClear();
    await repo.listExpiredActiveSessions(4);
    await repo.listSessionsWithPendingInbox(3);
    for (const [sql] of query.mock.calls) expect(sql).not.toContain('FOR UPDATE');
    expect(query.mock.calls.map(([, params]) => params)).toEqual([[4], [3]]);
  } finally {
    await pool.end();
  }
});
