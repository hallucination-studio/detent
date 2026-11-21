import type { FastifyInstance } from 'fastify';
import type { DetentExtensions } from './extensions.js';
import type { AppConfig } from './config.js';
import { createMySqlPool, initMySqlSchema } from './db/mysql.js';
import { MySqlDetentRepository } from './db/repository.js';
import { GitLabClient, redactGitUrl } from './gitlab/client.js';
import { createWebhookApp, dispatchWebhook } from './gitlab/webhook.js';
import { WebhookQueue } from './gitlab/webhook-queue.js';
import { SdkClaudeRunner } from './claude/runner.js';
import { SessionOrchestrator } from './orchestrator/session-orchestrator.js';

export function createDetentApp(config: AppConfig, extensions: DetentExtensions = {}): FastifyInstance {
  if (!config.gitlabWebhookSecret) throw Error('GITLAB_WEBHOOK_SECRET is required');
  if (config.leaseTtlSeconds < 1 || config.hotHoldTimeoutMs < 0)
    throw Error('Invalid lease or hold duration');
  const pool = createMySqlPool(config);
  const client = new GitLabClient(config);
  const repo = new MySqlDetentRepository(pool);
  const orchestrator = new SessionOrchestrator(config, repo, client, new SdkClaudeRunner(config), extensions);
  const report = (error: unknown) =>
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error)));
  const queue = new WebhookQueue((event) => dispatchWebhook(orchestrator, event), report);
  const app = createWebhookApp(
    config, client, (id, event) => queue.submit(id, event),
    extensions.matchWebhookEvent,
  );
  app.addHook('onReady', async () => {
    await initMySqlSchema(pool);
    await extensions.onInitSchema?.(pool);
    await client.initBotIdentity();
  });
  app.addHook('onClose', async () => {
    queue.stop();
    await queue.drain();
    await pool.end();
  });
  return app;
}
