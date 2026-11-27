import {
  createDecisionClient, createDetentApp, createGitLabOnboardingCapability, createGitLabReleaseCapability, GitLabClient, loadConfig,
  type AppConfig, type DetentCapabilityPack, type DetentExtensions, type ReleaseGitLab, type OnboardingGitLab,
} from '@detent/core';
import { createDeliveryTurnProfileResolver } from './agents/profiles.js';
import { MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus, type DeliveryAuditRepository } from './db/audit.js';
import { authSecrets, loadDeliveryConfig, type DeliveryConfig } from './config.js';
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
  gitlabClient?: ReleaseGitLab & (OnboardingGitLab | { getBotUser?: never });
  jumpserverClient?: JumpServerClient;
  executionTracker?: DeliveryExecutionTracker & Partial<Pick<DeliveryAuditRepository, 'listSessionExecutions'>>;
}

export function createDeliveryApp(config: AppConfig = loadConfig(), options: DeliveryOptions = {}): ReturnType<typeof createDetentApp> {
  const { deliveryConfig = loadDeliveryConfig(), jumpserverClient, gitlabClient, executionTracker, ...extensions } = options;
  config = { ...config, additionalSecrets: [...(config.additionalSecrets ?? []),
    ...authSecrets(deliveryConfig.jumpserverReadonlyAuth), ...authSecrets(deliveryConfig.jumpserverJobAuth)] };
  const decision = extensions.decisionClient ?? createDecisionClient(config);
  const client = jumpserverClient ?? (deliveryConfig.jumpserverBaseUrl ? new HttpJumpServerClient(deliveryConfig, config) : undefined);
  const auditRepo = executionTracker ? undefined : new MySqlDeliveryAuditRepository();
  const tracker = executionTracker ?? auditRepo;
  const api = gitlabClient ?? new GitLabClient(config);
  const onboarding = createGitLabOnboardingCapability({
    gitlab: api.getBotUser ? api : new GitLabClient(config),
    publicUrl: config.detentPublicUrl, webhookSecret: config.gitlabWebhookSecret,
  });
  const release: DetentCapabilityPack = deliveryConfig.enableReleaseTools
    ? {
        ...createGitLabReleaseCapability({ gitlab: api, blockFailedPipeline: deliveryConfig.blockFailedPipeline }),
        setupHint: '可在服务端设置 DELIVERY_ENABLE_RELEASE_TOOLS=true 启用发版能力包',
      }
    : { name: 'gitlab-release', enabled: false, setupHint: '服务端已禁用 gitlab-release（DELIVERY_ENABLE_RELEASE_TOOLS=false）', tools: [] };
  const jumpserver: DetentCapabilityPack = {
    name: 'jumpserver', enabled: !!client,
    setupHint: '请配置 JUMPSERVER_BASE_URL 及独立的只读/任务中心凭证（JUMPSERVER_READONLY_* 与 JUMPSERVER_JOB_*）',
    tools: client ? createJumpServerTools({ client, config: deliveryConfig, tracker, decision }) : [],
  };
  const packs = new Map<string, DetentCapabilityPack>();
  for (const pack of [release, jumpserver, onboarding, ...(extensions.capabilities ?? [])]) packs.set(pack.name.trim().toLowerCase(), pack);
  const capabilities = [...packs.values()];
  return createDetentApp(config, {
    ...extensions, capabilities, decisionClient: decision,
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, {
      async canCloseIssue({ session }) {
        const rows = await tracker?.listSessionExecutions?.(session.id);
        const latest = rows?.at(-1);
        if (latest && latest.status !== 'SUCCESS')
          return { ok: false, reason: '最新交付执行记录状态为 ' + latest.status + '，未成功前禁止关闭工单' };
        return { ok: true };
      },
      hubDefaultBranch: config.gitlabHubDefaultBranch, capabilities, resolveTurnProfile: extensions.resolveTurnProfile,
    }),
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
