import { setTimeout as delay } from 'node:timers/promises';
import type { QueuedWebhook } from './webhook.js';
import { SessionBusy } from '../orchestrator/session-orchestrator.js';
import { parseNoteIntent } from './command-parser.js';

function queueKey(event: QueuedWebhook, id: string) {
  if ('handle' in event) return event.key;
  if (event.object_kind === 'pipeline')
    return `pipeline/${event.project.id}/${event.merge_request?.source_branch ?? event.object_attributes.ref}`;
  // A decision or interrupt must reach a running turn even while it holds the issue queue.
  if (event.object_kind === 'emoji') return id;
  if (event.object_kind === 'issue')
    return event.object_attributes.action === 'close'
      ? id
      : `issue/${event.project.id}/${event.object_attributes.iid}`;
  const { type } = parseNoteIntent({
    noteBody: event.object_attributes.note,
    sessionStatus: 'WAITING_TOOL', // Include natural-language approvals. Dispatch checks the actual status.
    userId: event.user.id,
    username: event.user.username,
  });
  return type === 'PROMPT' || type === 'PLAN' ? `issue/${event.project.id}/${event.issue?.iid}` : id;
}

export class WebhookQueue {
  private tails = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private recent = new Set<string>();
  private stopping = new AbortController();

  constructor(
    private dispatch: (event: QueuedWebhook) => Promise<void>,
    private report: (error: unknown) => void,
    private maxRetryWaitMs = 10 * 60 * 1000,
  ) {}

  submit(id: string, event: QueuedWebhook) {
    this.stopping.signal.throwIfAborted();
    if (this.pending.has(id) || this.recent.has(id)) return;
    this.pending.add(id);
    const key = queueKey(event, id);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous
      .then(() => this.run(event, id))
      .catch(this.report)
      .finally(() => {
        this.pending.delete(id);
        if (this.tails.get(key) === task) this.tails.delete(key);
      });
    this.tails.set(key, task);
  }

  private async run(event: QueuedWebhook, id: string) {
    let backoff = 100;
    let deadline: number | undefined;
    const { signal } = this.stopping;
    for (;;) {
      try {
        await this.dispatch(event);
        break;
      } catch (error) {
        if (!(error instanceof SessionBusy)) throw error;
        deadline ??= Date.now() + this.maxRetryWaitMs;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new SessionBusy(`Webhook ${id} timed out waiting for a session lease`);
        await delay(Math.min(backoff, remaining), undefined, { signal });
        backoff = Math.min(2000, backoff * 2);
      }
    }
    this.recent.add(id);
    if (this.recent.size > 1024) this.recent.delete(this.recent.values().next().value!);
  }

  stop() {
    this.stopping.abort();
  }

  async drain() {
    await Promise.all(this.tails.values());
  }
}
