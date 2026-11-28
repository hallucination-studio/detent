import { resolveSecretRef, type HubCapabilityEntry } from '@detent/core';
import { z } from 'zod';
import { ownerSetupHint, type DeliveryConfig } from './config.js';
import type { JumpServerAuth } from './jumpserver/client.js';

const tier = z.enum(['standard', 'prod']).default('prod');
const username = z.string().trim().regex(/^@?[\p{L}\p{N}_.-]+$/u).transform(s => s.replace(/^@/, '').toLowerCase());
const owner = z.union([username, z.array(username).nonempty()]).transform(value => [...new Set([value].flat())]);
export const releaseSettings = z.object({ approver_tier: tier, block_failed_pipeline: z.boolean().optional() });
const settings = z.object({
  base_url: z.string().trim().url().refine(raw => {
    if (!URL.canParse(raw)) return false;
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(raw);
  }),
  auth: z.union([z.object({ access_key_id: z.string().min(1), access_key_secret: z.string().min(1) }).strict(),
    z.object({ token: z.string().min(1) }).strict()]),
  default_account: z.string().trim().optional(),
  org_id: z.string().trim().min(1).optional(),
  inspect_allow_prefixes: z.array(z.string().trim().min(1)).optional(),
  blocked_assets: z.array(z.string().trim().min(1)).optional(),
  environments: z.record(z.string().trim().min(1).max(64), z.object({
    match: z.array(z.string().trim().min(1)).nonempty(), approver_tier: tier, owner: owner.optional(),
  })).optional(),
  block_failed_pipeline: z.boolean().optional(),
});

export function resolveJumpServerSettings(entry: HubCapabilityEntry, vault: Record<string, string>, fallback: DeliveryConfig, botUsername?: string):
  { config: DeliveryConfig; defaultAccount?: string } | { setupHint: string } {
  if (entry.enabled === false) return { setupHint: 'Hub capabilities.json 已禁用此能力' };
  if (!entry.base_url) return { setupHint: '请在 Hub 仓库 capabilities.json 配置 jumpserver.base_url' };
  const parsed = settings.safeParse(entry);
  if (!parsed.success) return { setupHint: '请检查 Hub capabilities.json 中的 jumpserver 配置' };
  const hub = parsed.data;
  const environments = hub.environments && Object.fromEntries(Object.entries(hub.environments).map(([name, env]) =>
    [name, { match: env.match, approverTier: env.approver_tier, owners: env.owner }]));
  const setupHint = ownerSetupHint(environments, botUsername);
  if (setupHint) return { setupHint };
  const missing = new Set<string>();
  function resolve(value: string) {
    const result = resolveSecretRef(value, vault);
    if (result.ok) return result.value;
    missing.add(result.missing);
    return '';
  }
  const auth: JumpServerAuth = 'token' in hub.auth ? { kind: 'bearer', token: resolve(hub.auth.token) }
    : { kind: 'signature', accessKeyId: resolve(hub.auth.access_key_id), accessKeySecret: resolve(hub.auth.access_key_secret) };
  if (missing.size) return { setupHint: '服务端缺少密钥 ' + [...missing].join('、') };

  const config: DeliveryConfig = { ...fallback, jumpserverBaseUrl: hub.base_url, jumpserverOrgId: hub.org_id,
    jumpserverReadonlyAuth: auth, jumpserverJobAuth: auth, jumpserverReadonlyAccount: undefined,
    inspectAllowPrefixes: hub.inspect_allow_prefixes ?? fallback.inspectAllowPrefixes,
    environments,
    blockedAssets: hub.blocked_assets ?? fallback.blockedAssets, blockFailedPipeline: hub.block_failed_pipeline ?? fallback.blockFailedPipeline };
  return { config, defaultAccount: hub.default_account || undefined };
}
