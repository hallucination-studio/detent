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
import { loadMcpCapabilitiesFile, loadMcpCapabilityPacks } from './extensions/mcp-bridge.js';
import { normalizeHubValue } from './workflows/hub-frontmatter.js';

export function createDetentApp(config: AppConfig, extensions: DetentExtensions = {}): FastifyInstance {
  if (!config.gitlabWebhookSecret) throw Error('GITLAB_WEBHOOK_SECRET is required');
  if (config.leaseTtlSeconds < 1 || config.hotHoldTimeoutMs < 0)
    throw Error('Invalid lease or hold duration');
  const pool = createMySqlPool(config);
  const client = new GitLabClient(config);
  const repo = new MySqlDetentRepository(pool);
  const capabilities = [...(extensions.capabilities ?? [])];
  const orchestrator = new SessionOrchestrator(config, repo, client, new SdkClaudeRunner(config), { ...extensions, capabilities });
  const report = (error: unknown) =>
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error), config.jevApiKey));
  const queue = new WebhookQueue((event) => dispatchWebhook(orchestrator, event), report);
  const app = createWebhookApp(
    config, client, (id, event) => queue.submit(id, event),
    extensions.matchWebhookEvent,
  );
  app.addHook('onReady', async () => {
    if (config.mcpCapabilitiesFile || extensions.mcpCapabilities?.length) {
      const fileConfigs = config.mcpCapabilitiesFile ? await loadMcpCapabilitiesFile(config.mcpCapabilitiesFile) : [];
      const explicitNames = new Set(capabilities.map(pack => normalizeHubValue(pack.name)));
      const configs = [...fileConfigs, ...(extensions.mcpCapabilities ?? [])]
        .filter(cfg => !explicitNames.has(normalizeHubValue(cfg.name)));
      const reservedToolNames = new Set([
        ...(extensions.tools ?? []), ...capabilities.filter(pack => pack.enabled).flatMap(pack => pack.tools),
      ].map(tool => tool.name));
      capabilities.push(...await loadMcpCapabilityPacks(configs, { reservedToolNames }));
    }
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
