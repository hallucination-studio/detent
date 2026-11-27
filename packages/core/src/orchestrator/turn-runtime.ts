import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { ApprovalRequestRow, IssueSessionRow, ParsedUserIntent, SessionInboxRow } from '../types.js';
import type { PermissionGate } from '../claude/permission-gate.js';
import type { SessionLifecycleHooks } from '../extensions.js';
import { configuredSecrets, redactGitUrl } from '../gitlab/redact.js';
import { resolveApproval } from './lifecycle.js';

import type { SessionChannel } from './channel.js';

export class SessionBusy extends Error {}
export class StopTurn extends Error {}
export type Active = { owner: string; controller: AbortController; ownsLease: boolean; gate?: PermissionGate };

export function formatInboxMessages(items: SessionInboxRow[], secret?: string) {
  return redactGitUrl(items.map(item => `@${item.senderUsername ?? 'GitLab'}: ${item.content}`).join('\n\n'), secret);
}

export class TurnRuntime {
  protected active = new Map<string, Active>();
  constructor(readonly config: AppConfig, readonly repo: DetentRepository, private hooks?: SessionLifecycleHooks) {}
  protected drainInbox(id: string, active: Active, sourceKind?: string) {
    active.controller.signal.throwIfAborted();
    return this.repo.drainSessionInbox(id, active.owner, sourceKind);
  }
  protected async withLease(
    s: IssueSessionRow,
    fn: (s: IssueSessionRow, a: Active) => Promise<void>,
    shouldWait?: () => Promise<boolean>,
    expiredAt?: Date,
  ) {
    const owner = this.config.podId + '/' + randomUUID();
    const ttl = this.config.leaseTtlSeconds;
    while (!(await this.repo.acquireSessionLease(s.id, owner, ttl, expiredAt))) {
      if (!shouldWait) throw new SessionBusy('Session has an active turn');
      await delay(500);
      if (!(await shouldWait())) return;
    }
    const active: Active = { owner, controller: new AbortController(), ownsLease: true };
    this.active.set(s.id, active);
    let checking = false;
    const timer = setInterval(
      async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await this.repo.renewSessionLease(s.id, owner, ttl))) {
            active.ownsLease = false;
            active.controller.abort(Error('Turn lease expired'));
          } else if (await this.repo.stopRequested(s.id, owner)) active.controller.abort(new StopTurn());
        } catch (error) {
          active.ownsLease = false;
          active.controller.abort(error);
        } finally {
          checking = false;
        }
      },
      Math.max(25, Math.min(15000, (ttl * 1000) / 3)),
    );
    try {
      await fn((await this.repo.getSession(s.id))!, active);
    } finally {
      clearInterval(timer);
      if (this.active.get(s.id) === active) this.active.delete(s.id);
      if (active.ownsLease) await this.repo.releaseSessionLease(s.id, owner);
    }
  }
  protected async recover(s: IssueSessionRow, channel: SessionChannel) {
    if (!['PLANNING', 'CODING'].includes(s.status)) return false;
    await this.expire(s);
    if (s.recoveryAttempts >= this.config.watchdogMaxRecoveries) {
      await this.repo.failRecovery(s.id);
      await channel.createNote('自动恢复次数已用尽，请检查会话并重新发送待处理的指示。');
      await channel.syncStatusLabel('FAILED');
      return false;
    }
    s.recoveryAttempts += 1;
    await this.repo.updateSessionState(s.id, { recoveryAttempts: s.recoveryAttempts });
    return true;
  }
  protected async applyApproval(s: IssueSessionRow, pending: ApprovalRequestRow, intent: ParsedUserIntent,
    run: (session: IssueSessionRow, active: Active, prompt: string, previous?: ApprovalRequestRow) => Promise<void>) {
    const status = intent.type === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const comment = intent.comment && redactGitUrl(intent.comment, configuredSecrets(this.config));
    if (!(await resolveApproval(
      this.repo, s, pending.id, status, intent.username, comment, this.hooks?.onApprovalResolved, this.config.jevApiKey,
    ))) return;
    if (await this.active.get(s.id)?.gate?.notify(pending.id)) return;
    const expected = pending.approvalType === 'PLAN' ? 'WAITING_PLAN' : 'WAITING_TOOL';
    const stillWaiting = async (session: IssueSessionRow | null) =>
      session?.status === expected && (await this.repo.getLatestApproval(s.id))?.id === pending.id;
    await this.withLease(s, async (session, active) => {
      if (!(await stillWaiting(session))) return;
      if (pending.approvalType === 'PLAN') {
        const approved = status === 'APPROVED';
        session.permissionMode = approved ? 'default' : 'plan';
        const instruction = approved ? '实施方案已获批准，请按方案开始实施。' : '实施方案未获批准，请重新调整方案。';
        const feedback = approved ? '附加说明：' : '修改意见：';
        await run(session, active, comment ? instruction + '\n' + feedback + comment : instruction);
      } else {
        const decision = (await this.repo.getApproval(pending.id))!;
        const prompt = `GitLab 审批结果 ${status}，工具 ${decision.toolName}，参数 ${JSON.stringify(decision.toolInput)}。审批说明：${comment ?? ''}`;
        await run(session, active, prompt, decision);
      }
    }, async () => stillWaiting(await this.repo.getSession(s.id)));
  }
  protected async expire(s: IssueSessionRow) {
    for (let pending = await this.repo.getLatestPendingApproval(s.id); pending; pending = await this.repo.getLatestPendingApproval(s.id)) {
      await resolveApproval(this.repo, s, pending.id, 'EXPIRED', 'detent', '轮次已结束', this.hooks?.onApprovalResolved, this.config.jevApiKey);
    }
  }
  protected async stop(s: IssueSessionRow) {
    if (!s.lockedByPod) return;
    // The database evaluates lease expiry. The caller then acquires the lease or retries on SessionBusy.
    await this.repo.requestStop(s.id, s.lockedByPod);
    const active = this.active.get(s.id);
    if (active?.owner === s.lockedByPod) active.controller.abort(new StopTurn());
  }
  protected async archiveWorktrees(sessionId: string) {
    for (const tree of await this.repo.listActiveWorktrees(sessionId)) await this.repo.archiveWorktree(tree.id);
  }
}
