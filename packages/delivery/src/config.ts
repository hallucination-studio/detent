import { z } from 'zod';
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
  jumpserverTimeoutMs: z.coerce.number().int().positive().max(2147483647).default(30000),
  jumpserverReadonlyAccount: z.string().trim().min(1).regex(/^[\w.@-]+$/).default('readonly'),
  jumpserverReadonlyAuth: auth.optional(),
  jumpserverJobAuth: auth.optional(),
  inspectAllowPrefixes: z.string().default('systemctl status,nginx -t,df -h,free -m,uptime,ss -tlnp,kubectl get,cat /etc/nginx').transform(list),
  prodApprovers: z.string().default('').transform(value => list(value.toLowerCase())),
  prodMinAccessLevel: z.coerce.number().int().positive().default(40),
  blockedAssets: z.string().default('').transform(list),
  blockFailedPipeline: enabledByDefault,
  enableReleaseTools: enabledByDefault,
});

export type DeliveryConfig = z.infer<typeof schema>;

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
  const config = schema.parse({
    jumpserverBaseUrl: env.JUMPSERVER_BASE_URL,
    jumpserverOrgId: env.JUMPSERVER_ORG_ID,
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
  assertSeparateCredentials(config);
  return config;
}

function secrets(auth?: JumpServerAuth) {
  if (!auth) return [];
  return auth.kind === 'bearer' ? [auth.token] : [auth.accessKeyId, auth.accessKeySecret];
}

export function assertSeparateCredentials(config: DeliveryConfig) {
  const readonly = secrets(config.jumpserverReadonlyAuth);
  if (secrets(config.jumpserverJobAuth).some(secret => readonly.includes(secret)))
    throw Error('JumpServer readonly and job-center credentials must be separate');
}

export function redactSecrets(value: string, config: DeliveryConfig, ...additionalSecrets: string[]) {
  return redactValues(value, [...secrets(config.jumpserverReadonlyAuth), ...secrets(config.jumpserverJobAuth), ...additionalSecrets]);
}

export function redactValues(value: string, values: string[]) {
  const forms = values.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
  for (const form of [...new Set(forms)].sort((a, b) => b.length - a.length))
    value = value.replaceAll(form, '***');
  return value;
}
