import type { SessionOrchestrator } from './session-orchestrator.js';
import { SessionBusy } from './turn-runtime.js';

export class Watchdog {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private sessions: Pick<SessionOrchestrator, 'config' | 'repo' | 'wakeSession'>, private report: (error: unknown) => void,
    private mrs?: Pick<SessionOrchestrator, 'wakeSession'>) {}
  start() {
    const ms = this.sessions.config.watchdogIntervalMs;
    if (!ms || this.timer) return;
    const interval = Math.max(15000, ms);
    this.timer = setInterval(() => {
      this.running ??= this.scan().catch(this.report).finally(() => { this.running = undefined; });
    }, Math.min(2 ** 31 - 1, interval + Math.floor(Math.random() * interval * 0.1)));
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async scan() {
    const { repo } = this.sessions;
    for (const reason of ['expired', 'inbox'] as const) {
      const candidates = reason === 'expired' ? await repo.listExpiredActiveSessions() : await repo.listSessionsWithPendingInbox();
      for (const s of candidates) {
        try {
          // Expired active leases always go through the bounded recovery path.
          const expired = s.lockExpiresAt && ['PLANNING', 'CODING'].includes(s.status);
          const worker = s.sessionKind === 'mr' ? this.mrs : this.sessions;
          await worker?.wakeSession(s, expired ? 'expired' : reason);
        } catch (error) {
          if (!(error instanceof SessionBusy)) this.report(error);
        }
      }
    }
  }
}
