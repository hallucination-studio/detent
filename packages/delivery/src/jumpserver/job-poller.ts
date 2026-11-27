import { logError } from '@detent/core';
import type { DeliveryAuditRepository, DeliveryExecutionRow } from '../db/audit.js';
import type { JobResultResponse, JumpServerClient } from './client.js';

interface PollerOptions {
  auditRepo: Pick<DeliveryAuditRepository, 'listPendingExecutions' | 'completeExecution' | 'acknowledgeCallback'>;
  resolveClient(row: DeliveryExecutionRow): JumpServerClient | Promise<JumpServerClient>;
  onCompleted(row: DeliveryExecutionRow, result: JobResultResponse): Promise<void>;
  intervalMs?: number;
  report(error: unknown): void;
}

export class DeliveryJobPoller {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(private readonly options: PollerOptions) {}

  start() {
    const interval = this.options.intervalMs ?? 3000;
    if (this.timer || interval === 0) return;
    this.timer = setInterval(() => {
      if (!this.active) this.active = this.pollOnce().catch(this.options.report).finally(() => { this.active = undefined; });
    }, interval);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async pollOnce() {
    const rows = await this.options.auditRepo.listPendingExecutions();
    await Promise.all(rows.map(async row => {
      try {
        if (row.status === 'SUCCESS' || row.status === 'FAILED') {
          await this.notify(row, { jobId: row.jumpserverJobId, jobUrl: row.jumpserverJobUrl, status: row.status, outputSummary: row.outputSummary ?? '' });
          return;
        }
        const client = await this.options.resolveClient(row);
        const result = await client.getJobResult(row.jumpserverJobId);
        await this.complete(row, result);
      } catch (error) {
        logError('delivery-job-poller', error, undefined, `job=${row.jumpserverJobId} session=${row.sessionId}`);
      }
    }));
  }

  async complete(row: DeliveryExecutionRow, result: JobResultResponse) {
    if (result.status !== 'SUCCESS' && result.status !== 'FAILED') return;
    const won = await this.options.auditRepo.completeExecution(row.sessionId, row.jumpserverJobId, result.status, result.outputSummary);
    if (won) await this.notify(row, result);
  }

  private async notify(row: DeliveryExecutionRow, result: JobResultResponse) {
    await this.options.onCompleted(row, result);
    await this.options.auditRepo.acknowledgeCallback(row.sessionId, row.jumpserverJobId);
  }
}
