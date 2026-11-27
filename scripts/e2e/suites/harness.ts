import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { E2EGitLabDriver, gitlabApi } from '../gitlab-driver.js';
import type { createOfflineAnthropic } from '../offline-anthropic.js';
import type { offlineJev } from '../offline-jev.js';

type Mr = Awaited<ReturnType<E2EGitLabDriver['getMr']>>;
type MrStatus = 'IDLE' | 'DONE' | 'WAITING_PLAN' | 'WAITING_TOOL' | 'FAILED';
export interface Harness {
  gitlab: E2EGitLabDriver;
  admin: ReturnType<typeof gitlabApi>;
  db: Pool;
  until<T>(label: string, probe: () => Promise<T> | T): Promise<NonNullable<T>>;
  rows(sql: string, params?: (string | number)[]): Promise<RowDataPacket[]>;
  records(session: string, table: string): Promise<RowDataPacket[]>;
  mrState(project: number, iid: number, status: MrStatus, afterSeq?: number): Promise<RowDataPacket>;
  state(iid: number, status: string, afterSeq?: number): Promise<RowDataPacket>;
  openIssue(title: string, description: string, label: string): Promise<number>;
  pendingCard(iid: number, tool: string, fields: string[]): Promise<RowDataPacket>;
  trackMr<T extends Mr>(mr: T): T;
  observeGet(path: string, act: () => Promise<unknown>): Promise<void>;
  checkSecrets(value: unknown): void;
  startPod(id: string, overrides?: NodeJS.ProcessEnv): Promise<void>;
  stopPod(): Promise<void>;
  anthropic: ReturnType<typeof createOfflineAnthropic>;
  jev: ReturnType<typeof offlineJev>;
  bot: { id: number; username: string };
  hub: number;
  api: number;
  sandbox: string;
}

export async function checkSession(h: Pick<Harness, 'records' | 'gitlab' | 'checkSecrets' | 'sandbox'>, session: RowDataPacket) {
  const { hub_project_id: project, hub_issue_iid: iid } = session;
  h.checkSecrets(session);
  for (const table of ['session_messages', 'session_inbox', 'session_worktrees', 'session_merge_requests', 'approval_requests'])
    h.checkSecrets(await h.records(session.id, table));
  h.checkSecrets(session.session_kind === 'mr' ? await h.gitlab.listMrDiscussions(project, iid) : await h.gitlab.listIssueNotes(project, iid));
  assert.deepEqual(await readdir(h.sandbox), [], 'A completed turn left a sandbox');
}
