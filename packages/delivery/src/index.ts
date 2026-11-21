import { createDetentApp, loadConfig, type AppConfig, type DetentExtensions } from '@detent/core';
import { createDeliveryTurnProfileResolver } from './agents/profiles.js';
import { MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus, type DeliveryAuditRepository } from './db/audit.js';
import { loadDeliveryConfig, type DeliveryConfig } from './config.js';
import { HttpJumpServerClient, type JumpServerClient } from './jumpserver/client.js';
import { createJumpServerTools, type DeliveryExecutionTracker } from './jumpserver/tools.js';
import { matchMergeRequestWebhook } from './webhooks/merge-request.js';

export { createDeliveryTurnProfileResolver, MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus };
export type { AgentProfileName } from './agents/profiles.js';
export type { DeliveryAuditRepository, DeliveryExecutionRow } from './db/audit.js';
export { matchMergeRequestWebhook, loadDeliveryConfig, HttpJumpServerClient, createJumpServerTools };
export { validateReadonlyInspectCommand, validatePlaybookPath } from './jumpserver/guards.js';
export type { DeliveryConfig, JumpServerClient, DeliveryExecutionTracker };
export type {
  JumpServerAuth, JumpServerAsset, ReadonlyInspectRequest, ReadonlyInspectResult, AnsibleJobRequest,
  AnsibleJobSubmission, JobResultResponse,
} from './jumpserver/client.js';
export type { DeliveryExecutionRecord } from './jumpserver/tools.js';

export interface DeliveryOptions extends DetentExtensions {
  deliveryConfig?: DeliveryConfig;
  jumpserverClient?: JumpServerClient;
  executionTracker?: DeliveryExecutionTracker & Partial<Pick<DeliveryAuditRepository, 'listSessionExecutions'>>;
}

export function createDeliveryApp(config: AppConfig = loadConfig(), options: DeliveryOptions = {}): ReturnType<typeof createDetentApp> {
  const { deliveryConfig = loadDeliveryConfig(), jumpserverClient, executionTracker, ...extensions } = options;
  const client = jumpserverClient ?? (deliveryConfig.jumpserverBaseUrl ? new HttpJumpServerClient(deliveryConfig, config) : undefined);
  const auditRepo = executionTracker ? undefined : new MySqlDeliveryAuditRepository();
  const tracker = executionTracker ?? auditRepo;
  const tools = client
    ? [...createJumpServerTools({ client, config: deliveryConfig, tracker }), ...(extensions.tools ?? [])]
    : extensions.tools;
  return createDetentApp(config, {
    ...extensions, tools,
    resolveTurnProfile: extensions.resolveTurnProfile ?? createDeliveryTurnProfileResolver(deliveryConfig),
    async onInitSchema(pool) {
      await auditRepo?.init(pool);
      await extensions.onInitSchema?.(pool);
    },
    async renderStatusExtra(session) {
      const rows = await tracker?.listSessionExecutions?.(session.id);
      const extra = await extensions.renderStatusExtra?.(session);
      return [rows && formatDeliveryExecutionsStatus(rows), extra?.trim()].filter(Boolean).join('\n\n') || null;
    },
    matchWebhookEvent: event => matchMergeRequestWebhook(event) ?? extensions.matchWebhookEvent?.(event) ?? null,
  });
}
