import { z } from 'zod';
import { redactGitUrl, type AppConfig, type WorkflowApproverTier } from '@detent/core';
import type { JumpServerAuth } from './jumpserver/client.js';

const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
const enabledByDefault = z.string().default('true').transform(value => !['false', '0'].includes(value.trim().toLowerCase()));
const auth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signature'), accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1) }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1) }),
]);
const schema = z.object({
  jumpserverBaseUrl: z.string().url().refine(value => {
    const url = URL.canParse(value) && new URL(value);
    return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'Expected an HTTP(S) service URL').optional(),
  jumpserverOrgId: z.string().trim().min(1).optional(),
  jumpserverTimeoutMs: z.coerce.number().int().positive().max(2147483647).default(60000),
  deliveryJobPollIntervalMs: z.coerce.number().int().min(0).max(2147483647).default(3000),
  jumpserverReadonlyAccount: z.string().trim().min(1).regex(/^[\w.@-]+$/).optional(),
  jumpserverReadonlyAuth: auth.optional(),
  jumpserverJobAuth: auth.optional(),
  inspectAllowPrefixes: z.string().default('systemctl status,nginx -t,df -h,free -m,uptime,ss -tlnp,kubectl get,cat /etc/nginx').transform(list),
  prodApprovers: z.string().default('').transform(value => list(value.toLowerCase())),
  prodMinAccessLevel: z.coerce.number().int().positive().default(40),
  blockedAssets: z.string().default('').transform(list),
  blockFailedPipeline: enabledByDefault,
  enableReleaseTools: enabledByDefault,
});

export type DeliveryConfig = z.infer<typeof schema> & {
  environments?: Record<string, { match: string[]; approverTier: WorkflowApproverTier; owners?: string[] }>;
};

export function environmentConfig(environments: DeliveryConfig['environments'], name: unknown) {
  return typeof name === 'string' && environments && Object.hasOwn(environments, name) ? environments[name] : undefined;
}
export function isProdEnv(name: unknown, tier?: WorkflowApproverTier) {
  return tier !== 'standard' || (typeof name === 'string' && /^(prod|production)$/i.test(name.trim()));
}
export function isBotName(owner: string, botUsername?: string) {
  const name = owner.trim().replace(/^@/, '').toLowerCase();
  return name === botUsername?.toLowerCase() || name === 'detent-bot' || name === 'bot';
}
export const mentionOwners = (owners: readonly string[]) => owners.map(name => '@' + name).join('、');
export function ownerSetupHint(environments: DeliveryConfig['environments'], botUsername?: string) {
  if (Object.entries(environments ?? {}).some(([name, env]) => isProdEnv(name, env.approverTier) && env.owners?.some(o => isBotName(o, botUsername))))
    return '生产环境严禁将 Bot 配置为环境负责人';
}
function credential(env: NodeJS.ProcessEnv, role: 'READONLY' | 'JOB'): JumpServerAuth | undefined {
  const prefix = 'JUMPSERVER_' + role;
  const accessKeyId = env[prefix + '_ACCESS_KEY_ID'];
  const accessKeySecret = env[prefix + '_ACCESS_KEY_SECRET'];
  if (accessKeyId || accessKeySecret) {
    if (!accessKeyId || !accessKeySecret) throw Error(prefix + ' requires both access key ID and secret');
    return { kind: 'signature', accessKeyId, accessKeySecret };
  }
  const token = env[prefix + '_TOKEN'];
  return token ? { kind: 'bearer', token } : undefined;
}

export function loadDeliveryConfig(env: NodeJS.ProcessEnv = process.env): DeliveryConfig {
  return schema.parse({
    jumpserverBaseUrl: env.JUMPSERVER_BASE_URL,
    jumpserverOrgId: env.JUMPSERVER_ORG_ID,
    deliveryJobPollIntervalMs: env.DELIVERY_JOB_POLL_INTERVAL_MS,
    jumpserverTimeoutMs: env.JUMPSERVER_TIMEOUT_MS,
    jumpserverReadonlyAccount: env.JUMPSERVER_READONLY_ACCOUNT,
    jumpserverReadonlyAuth: credential(env, 'READONLY'),
    jumpserverJobAuth: credential(env, 'JOB'),
    inspectAllowPrefixes: env.JUMPSERVER_INSPECT_ALLOW_PREFIXES,
    prodApprovers: env.DELIVERY_PROD_APPROVERS,
    prodMinAccessLevel: env.DELIVERY_PROD_MIN_ACCESS_LEVEL,
    blockedAssets: env.JUMPSERVER_BLOCKED_ASSETS,
    blockFailedPipeline: env.JUMPSERVER_BLOCK_FAILED_PIPELINE,
    enableReleaseTools: env.DELIVERY_ENABLE_RELEASE_TOOLS,
  });
}

export function authSecrets(auth?: JumpServerAuth) {
  if (!auth) return [];
  return auth.kind === 'bearer' ? [auth.token] : [auth.accessKeyId, auth.accessKeySecret];
}

export function redactSecrets(value: string, config: DeliveryConfig, ...additionalSecrets: string[]) {
  return redactValues(value, [...authSecrets(config.jumpserverReadonlyAuth), ...authSecrets(config.jumpserverJobAuth), ...additionalSecrets]);
}

export function redactDeliveryOutput(value: string, config: DeliveryConfig, app: Partial<AppConfig>, truncated = false) {
  if (truncated) value = value.replace(/(https?:\/\/oauth2:)[^\s/@]+$/i, '$1***');
  return redactValues(redactGitUrl(value), [...authSecrets(config.jumpserverReadonlyAuth), ...authSecrets(config.jumpserverJobAuth),
    app.gitlabToken ?? '', app.gitlabWebhookSecret ?? '', app.mysqlPassword ?? '', app.jevApiKey ?? '', app.anthropicApiKey ?? '', ...Object.values(app.secrets ?? {}), ...(app.additionalSecrets ?? [])], truncated);
}

export function redactValues(value: string, values: string[], truncated = false) {
  const forms = [...new Set(values.filter(Boolean).flatMap(secret =>
    [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]))].sort((a, b) => b.length - a.length);
  // Reserve enough lookahead to recognize a credential straddling the retained prefix.
  // Track that boundary through replacements, including any mask spanning the boundary.
  let end = truncated ? Math.max(0, value.length - (forms[0]?.length ?? 0)) : value.length;
  for (const form of forms) {
    if (!truncated) {
      value = value.replaceAll(form, '***');
      continue;
    }
    const previousEnd = end;
    value = value.replaceAll(form, (_match, offset: number) => {
      if (offset < previousEnd) end += 3 - Math.min(form.length, previousEnd - offset);
      return '***';
    });
  }
  return truncated ? value.slice(0, end) : value;
}
