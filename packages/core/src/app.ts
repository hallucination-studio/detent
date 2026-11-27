import type { FastifyInstance } from 'fastify';
import type { DetentExtensions } from './extensions.js';
import { configuredSecrets } from './gitlab/redact.js';
import type { AppConfig } from './config.js';
import { createMySqlPool, initMySqlSchema } from './db/mysql.js';
import { MySqlDetentRepository } from './db/repository.js';
import { GitLabClient, redactGitUrl } from './gitlab/client.js';
import { createWebhookApp, dispatchWebhook } from './gitlab/webhook.js';
import { WebhookQueue } from './gitlab/webhook-queue.js';
import { SdkClaudeRunner } from './claude/runner.js';
import { SessionOrchestrator } from './orchestrator/session-orchestrator.js';
import { loadMcpCapabilitiesFile, loadMcpCapabilityPacks } from './extensions/mcp-bridge.js';
import { MergeRequestOrchestrator } from './orchestrator/mr-orchestrator.js';
import { Watchdog } from './orchestrator/watchdog.js';
import { createDecisionClient } from './decision/jev-client.js';
import { matchHubEvent, runHubEvent } from './router/event-policy.js';
import { normalizeHubValue } from './workflows/hub-frontmatter.js';

export function createDetentApp(config: AppConfig, extensions: DetentExtensions = {}): FastifyInstance {
  if (!config.gitlabWebhookSecret) throw Error('GITLAB_WEBHOOK_SECRET is required');
  if (config.leaseTtlSeconds < 1) throw Error('Invalid lease duration');
  const pool = createMySqlPool(config);
  const client = new GitLabClient(config);
  const repo = new MySqlDetentRepository(pool);
  const capabilities = [...(extensions.capabilities ?? [])];
  const decision = extensions.decisionClient ?? createDecisionClient(config);
  const runner = new SdkClaudeRunner(config);
  const orchestrator = new SessionOrchestrator(config, repo, client, runner, { ...extensions, capabilities, decisionClient: decision });
  const report = (error: unknown) =>
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error), configuredSecrets(config)));
  const mrs = new MergeRequestOrchestrator(config, repo, client, runner, { decision, onNotify: extensions.onNotify,
    runHubEvent: (event, body, label) => runHubEvent(client, config, event, body, orchestrator, label) });
  const watchdog = new Watchdog(orchestrator, report, mrs);
  const queue = new WebhookQueue((event, id) => dispatchWebhook(orchestrator, event, id, mrs), report);
  const app = createWebhookApp(
    config, client, async (id, event) => {
      // An existing Issue can receive steering or interrupts while its first webhook still runs.
      const session = 'object_kind' in event && event.object_kind === 'note' && event.issue
        ? await repo.getSessionByIssue(event.project.id, event.issue.iid) : null;
      queue.submit(id, event, !!session, client.getBotIdentity()?.username);
    },
    extensions.matchWebhookEvent,
    event => matchHubEvent(client, config, event, decision, extensions.onNotify),
  );
  let stopExtension: void | (() => void | Promise<void>);
  app.addHook('onReady', async () => {
    if (config.mcpCapabilitiesFile || extensions.mcpCapabilities?.length) {
      const fileConfigs = config.mcpCapabilitiesFile ? await loadMcpCapabilitiesFile(config.mcpCapabilitiesFile) : [];
      const explicitNames = new Set(capabilities.map(pack => normalizeHubValue(pack.name)));
      const configs = [...fileConfigs, ...(extensions.mcpCapabilities ?? [])]
        .filter(cfg => !explicitNames.has(normalizeHubValue(cfg.name)));
      const reservedToolNames = new Set([
        ...(extensions.tools ?? []), ...capabilities.filter(pack => pack.enabled).flatMap(pack => pack.tools),
      ].map(tool => tool.name));
      capabilities.push(...await loadMcpCapabilityPacks(configs, { reservedToolNames, secrets: configuredSecrets(config) }));
    }
    await initMySqlSchema(pool);
    await extensions.onInitSchema?.(pool);
    await client.initBotIdentity();
    watchdog.start();
    try {
      stopExtension = await extensions.onReady?.({ orchestrator, repo, gitlab: client, report });
    } catch (error) {
      await watchdog.stop();
      throw error;
    }
  });
  app.addHook('onClose', async () => {
    queue.stop();
    const stopped = watchdog.stop();
    try {
      await stopExtension?.();
    } finally {
      await Promise.all([stopped, queue.drain()]);
      await mrs.drain();
      await pool.end();
    }
  });
  return app;
}
