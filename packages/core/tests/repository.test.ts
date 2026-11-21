import { expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { createMySqlPool } from '../src/db/mysql.js';
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
  const updated = await repo.upsertMergeRequest({ ...row, mrState: 'merged', mrTitle: 'New title' });
  expect(updated).toMatchObject({ ...merged, mrTitle: 'New title', updatedAt: expect.any(Date) });
});
