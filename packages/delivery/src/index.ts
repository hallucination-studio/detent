import { createHash } from 'node:crypto';
import { releaseSettings, resolveJumpServerSettings } from './hub-config.js';
import {
  createDecisionClient, createDetentApp, createGitLabOnboardingCapability, createGitLabReleaseCapability, GitLabClient, loadConfig, loadHubCapabilities,
  type AppConfig, type DetentCapabilityPack, type DetentExtensions, type ReleaseGitLab, type OnboardingGitLab,
} from '@detent/core';
import { createDeliveryTurnProfileResolver } from './agents/profiles.js';
import { MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus, type DeliveryAuditRepository } from './db/audit.js';
import { authSecrets, loadDeliveryConfig, redactDeliveryOutput, type DeliveryConfig } from './config.js';
import { HttpJumpServerClient, type JobResultResponse, type JumpServerClient } from './jumpserver/client.js';
import { createJumpServerCapability, createJumpServerTools, type DeliveryExecutionTracker } from './jumpserver/tools.js';
import { DeliveryJobPoller } from './jumpserver/job-poller.js';
import { matchMergeRequestWebhook } from './webhooks/merge-request.js';

export { DeliveryJobPoller, createDeliveryTurnProfileResolver, MySqlDeliveryAuditRepository, formatDeliveryExecutionsStatus };
export type { DeliveryAuditRepository, DeliveryExecutionRow } from './db/audit.js';
export { matchMergeRequestWebhook, loadDeliveryConfig, HttpJumpServerClient, createJumpServerTools };
export { buildBatchShellScript, evaluateRemoteInspectCommand, validateShellCommands, validateReadonlyInspectCommand, validatePlaybookPath } from './jumpserver/guards.js';
export type { DeliveryConfig, JumpServerClient, DeliveryExecutionTracker };
export type {
  JumpServerAuth, JumpServerNode, NodeQuery, JumpServerAsset, AssetQuery, ShellRequest, ReadonlyInspectResult, AnsibleJobRequest,
  AnsibleJobSubmission, JobResultResponse,
} from './jumpserver/client.js';
export type { DeliveryExecutionRecord } from './jumpserver/tools.js';

export interface DeliveryOptions extends DetentExtensions {
  deliveryConfig?: DeliveryConfig;
  gitlabClient?: ReleaseGitLab & (OnboardingGitLab | { getBotUser?: never });
  jumpserverClient?: JumpServerClient;
  executionTracker?: DeliveryExecutionTracker & Partial<DeliveryAuditRepository>;
}

export function createDeliveryApp(config: AppConfig = loadConfig(), options: DeliveryOptions = {}): ReturnType<typeof createDetentApp> {
  const { deliveryConfig = loadDeliveryConfig(), jumpserverClient, gitlabClient, executionTracker, ...extensions } = options;
  config = { ...config, additionalSecrets: [...(config.additionalSecrets ?? []),
    ...authSecrets(deliveryConfig.jumpserverReadonlyAuth), ...authSecrets(deliveryConfig.jumpserverJobAuth)] };
  const decision = extensions.decisionClient ?? createDecisionClient(config);
  const clients = new Map<string, HttpJumpServerClient>();
  function httpClient(settings: DeliveryConfig) {
    const key = createHash('sha256').update(JSON.stringify([settings.jumpserverBaseUrl?.replace(/\/$/, ''), settings.jumpserverOrgId,
      settings.jumpserverReadonlyAuth, settings.jumpserverJobAuth, settings.jumpserverTimeoutMs])).digest('hex');
    const cached = clients.get(key);
    if (cached) return cached;
    const client = new HttpJumpServerClient(settings, config);
    if (clients.size >= 16) clients.delete(clients.keys().next().value!);
    clients.set(key, client);
    return client;
  }
  const client = jumpserverClient ?? (deliveryConfig.jumpserverBaseUrl ? httpClient(deliveryConfig) : undefined);
  const auditRepo = new MySqlDeliveryAuditRepository();
  const tracker = executionTracker ?? auditRepo;
  let botUsername: string | undefined;
  let poller: DeliveryJobPoller | undefined;
  async function onTerminalResult(sessionId: string, jobId: string, result: JobResultResponse) {
    if (poller && tracker.listSessionExecutions) {
      const row = (await tracker.listSessionExecutions(sessionId)).find(row => row.jumpserverJobId === jobId);
      if (!row) throw Error('未找到当前会话的任务记录');
      await poller.complete(row, result);
    } else {
      await tracker.updateExecutionResult?.(sessionId, jobId, result.status, result.outputSummary);
    }
  }
  const api = gitlabClient ?? new GitLabClient(config);
  const onboarding = createGitLabOnboardingCapability({
    gitlab: api.getBotUser ? api : new GitLabClient(config),
    publicUrl: config.detentPublicUrl, webhookSecret: config.gitlabWebhookSecret,
  });
  const release: DetentCapabilityPack = deliveryConfig.enableReleaseTools
    ? {
        ...createGitLabReleaseCapability({ gitlab: api, blockFailedPipeline: deliveryConfig.blockFailedPipeline }),
        approverTier: 'prod',
        setupHint: '可在服务端设置 DELIVERY_ENABLE_RELEASE_TOOLS=true 启用发版能力包',
      }
    : { name: 'gitlab-release', enabled: false, setupHint: '服务端已禁用 gitlab-release（DELIVERY_ENABLE_RELEASE_TOOLS=false）', tools: [] };
  const jumpserver: DetentCapabilityPack = {
    ...(client ? createJumpServerCapability('jumpserver', { client, config: deliveryConfig, tracker, decision, onTerminalResult, get botUsername() { return botUsername; } })
      : { name: 'jumpserver', enabled: false, tools: [] }),
    setupHint: '请在 Hub capabilities.json 配置 jumpserver.base_url 和 auth，并在服务端提供 DETENT_SECRET_JMS_AK_ID 与 DETENT_SECRET_JMS_AK_SECRET',
  };
  const packs = new Map<string, DetentCapabilityPack>();
  for (const pack of [release, jumpserver, onboarding, ...(extensions.capabilities ?? [])]) packs.set(pack.name.trim().toLowerCase(), pack);
  const capabilities = [...packs.values()];
  return createDetentApp(config, {
    ...extensions, capabilities, decisionClient: decision,
    async resolveCapabilities(ctx) {
      const dynamic: DetentCapabilityPack[] = [];
      for (const [name, entry] of Object.entries(ctx.document.entries)) {
        if (entry.type === 'jumpserver') {
          const resolved = resolveJumpServerSettings(entry, ctx.config.secrets, deliveryConfig, botUsername);
          dynamic.push('setupHint' in resolved ? { name, enabled: false, tools: [], setupHint: resolved.setupHint }
            : createJumpServerCapability(name, { config: resolved.config, tracker, decision, onTerminalResult, defaultAccount: resolved.defaultAccount,
              botUsername, client: httpClient(resolved.config) }));
        } else if (entry.type === 'gitlab-release') {
          const parsed = releaseSettings.safeParse(entry);
          dynamic.push(entry.enabled === false || !parsed.success
            ? { name, enabled: false, tools: [], setupHint: '请检查 Hub capabilities.json 中的 gitlab-release 配置（approver_tier 支持 standard 或 prod）' }
            : { ...createGitLabReleaseCapability({ gitlab: api, approverTier: parsed.data.approver_tier, blockFailedPipeline: parsed.data.block_failed_pipeline ?? deliveryConfig.blockFailedPipeline }),
              name, approverTier: parsed.data.approver_tier });
        }
      }
      return [...dynamic, ...(await extensions.resolveCapabilities?.(ctx) ?? [])];
    },
    resolveTurnProfile: createDeliveryTurnProfileResolver(deliveryConfig, {
      async canCloseIssue({ session }) {
        const rows = await tracker.listSessionExecutions?.(session.id);
        const latest = rows?.at(-1);
        if (latest && latest.status !== 'SUCCESS')
          return { ok: false, reason: '最新交付执行记录状态为 ' + latest.status + '，未成功前禁止关闭工单' };
        return { ok: true };
      },
      hubDefaultBranch: config.gitlabHubDefaultBranch, resolveTurnProfile: extensions.resolveTurnProfile,
    }),
    async onReady(ctx) {
      botUsername = ctx.gitlab.getBotIdentity?.()?.username;
      const cleanup = await extensions.onReady?.(ctx);
      if (!tracker.listPendingExecutions || !tracker.completeExecution || !tracker.acknowledgeCallback) return cleanup;
      // All concurrent lookups in one scan share the live Hub revision.
      let document: ReturnType<typeof loadHubCapabilities> | undefined;
      poller = new DeliveryJobPoller({
        auditRepo: {
          listPendingExecutions: tracker.listPendingExecutions.bind(tracker),
          acknowledgeCallback: tracker.acknowledgeCallback.bind(tracker),
          completeExecution: tracker.completeExecution.bind(tracker),
        },
        report: ctx.report, intervalMs: deliveryConfig.deliveryJobPollIntervalMs,
        async resolveClient(row) {
          document ??= loadHubCapabilities(ctx.gitlab, config.gitlabHubProjectId, config.gitlabHubDefaultBranch)
            .finally(() => { document = undefined; });
          const hub = await document;
          if (hub.invalid) throw Error(hub.error);
          for (const entry of Object.values(hub.entries)) {
            if (entry.type !== 'jumpserver' || typeof entry.base_url !== 'string' ||
                !row.jumpserverJobUrl.startsWith(entry.base_url.trim().replace(/\/$/, '') + '/')) continue;
            const resolved = resolveJumpServerSettings(entry, config.secrets, deliveryConfig, botUsername);
            if ('setupHint' in resolved) throw Error(resolved.setupHint);
            return httpClient(resolved.config);
          }
          if (client && !Object.keys(hub.entries).some(name => name.toLowerCase() === 'jumpserver') &&
              (jumpserverClient || row.jumpserverJobUrl.startsWith(deliveryConfig.jumpserverBaseUrl!.replace(/\/$/, '') + '/'))) return client;
          throw Error('未找到与执行记录匹配的 JumpServer 配置');
        },
        async onCompleted(row, result) {
          const scrub = (value: string) => redactDeliveryOutput(value, deliveryConfig, config);
          const message = scrub([
            `JumpServer 任务 ${row.jumpserverJobId} 已结束（${result.status}）`, row.jumpserverJobUrl,
            `作业 ${row.playbookPath} @ ${row.commitSha}`,
            '请依据任务状态继续核验。以下为远端输出摘要：',
          ].join('\n')) + '\n' + scrub(result.outputSummary).slice(0, 2000);
          await ctx.orchestrator.deliverSystemEvent(row.sessionId, 'jms-job:' + row.jumpserverJobId, message, { sender: 'jumpserver' });
        },
      });
      poller.start();
      return async () => {
        try { await poller?.stop(); }
        finally { await cleanup?.(); }
      };
    },
    async onInitSchema(pool) {
      if (!executionTracker) await auditRepo.init(pool);
      await extensions.onInitSchema?.(pool);
    },
    async renderStatusExtra(session) {
      const rows = await tracker.listSessionExecutions?.(session.id);
      const extra = await extensions.renderStatusExtra?.(session);
      return [rows && formatDeliveryExecutionsStatus(rows), extra?.trim()].filter(Boolean).join('\n\n') || null;
    },
    matchWebhookEvent: event => matchMergeRequestWebhook(event) ?? extensions.matchWebhookEvent?.(event) ?? null,
  });
}
