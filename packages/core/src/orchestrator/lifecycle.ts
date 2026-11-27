import type { Decision, DetentRepository } from '../db/repository.js';
import type { SessionLifecycleHooks } from '../extensions.js';
import { redactGitUrl } from '../gitlab/client.js';
import type { IssueSessionRow } from '../types.js';

// An observer failure must not undo a committed decision or strand a waiting turn.
export async function notifyHook(notify: () => void | Promise<void>, secret?: string | readonly string[]) {
  try {
    await notify();
  } catch (error) {
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error), secret));
  }
}

export async function resolveApproval(
  repo: DetentRepository, session: IssueSessionRow, id: string,
  status: Decision, user: string, comment?: string, hook?: SessionLifecycleHooks['onApprovalResolved'], secret?: string | readonly string[],
) {
  if (!(await repo.resolveApprovalRequest(id, status, user, comment))) return false;
  if (hook) await notifyHook(async () => hook((await repo.getApproval(id))!, session), secret);
  return true;
}
