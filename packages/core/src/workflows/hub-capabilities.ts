import { z } from 'zod';
import { logError } from '../gitlab/redact.js';
import type { DetentCapabilityPack } from '../extensions.js';
import { connectMcpCapabilityPack } from '../extensions/mcp-bridge.js';
import type { GitLabClient } from '../gitlab/client.js';
import { isHubPathSegment } from '../workspace/hub-paths.js';

export interface HubCapabilityEntry {
  type: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface HubCapabilitiesDocument {
  present: boolean;
  entries: Record<string, HubCapabilityEntry>;
  invalid: boolean;
  error?: string;
}

const entriesSchema = z.record(z.string().refine(isHubPathSegment), z.object({
  type: z.string().trim().min(1), enabled: z.boolean().optional(),
}).passthrough());

export async function loadHubCapabilities(
  gitlab: Partial<Pick<GitLabClient, 'getRepositoryFile'>>, hubProjectId: number, ref: string,
): Promise<HubCapabilitiesDocument> {
  const raw = await gitlab.getRepositoryFile?.(hubProjectId, 'capabilities.json', ref);
  if (raw == null) return { present: false, entries: {}, invalid: false };
  try {
    const entries = entriesSchema.parse(JSON.parse(raw));
    const names = Object.keys(entries).map(name => name.toLowerCase());
    if (new Set(names).size === names.length) return { present: true, entries, invalid: false };
  } catch (error) {
    logError('hub-capabilities', error);
  }
  return { present: true, entries: {}, invalid: true, error: 'Hub capabilities.json 格式无效' };
}

export function resolveSecretRef(value: string, secrets: Record<string, string>) {
  const name = /^\$secret:([A-Z0-9_]+)$/.exec(value)?.[1];
  if (!name) return { ok: true, value } as const;
  return Object.hasOwn(secrets, name) && secrets[name] ? { ok: true, value: secrets[name] } as const
    : { ok: false, missing: 'DETENT_SECRET_' + name } as const;
}

export function resolveSecretTemplate(template: string, secrets: Record<string, string>) {
  const missing = new Set<string>();
  const value = template.replace(/\$\{secret:([A-Z0-9_]+)\}/g, (_, name: string) => {
    const resolved = resolveSecretRef('$secret:' + name, secrets);
    if (resolved.ok) return resolved.value;
    missing.add(resolved.missing);
    return '';
  });
  return missing.size ? { ok: false, missing: [...missing] } as const : { ok: true, value } as const;
}

const mcpSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(value);
  }),
  headers: z.record(z.string()).optional(),
  approver_tier: z.enum(['standard', 'prod']).optional(),
  readonly_tools: z.array(z.string().min(1)).optional(),
});

export async function resolveHubMcpCapabilities(
  doc: HubCapabilitiesDocument, secrets: Record<string, string>, connect = connectMcpCapabilityPack,
): Promise<DetentCapabilityPack[]> {
  return Promise.all(Object.entries(doc.entries).filter(([, entry]) => entry.type === 'mcp').map(async ([name, entry]) => {
    const disabled = (setupHint: string) => ({ name, enabled: false, setupHint, tools: [] });
    if (entry.enabled === false) return disabled('Hub capabilities.json 已禁用此能力');
    const parsed = mcpSchema.safeParse(entry);
    if (!parsed.success) return disabled('请检查 Hub capabilities.json 中的 MCP 配置');
    const { transport, url, headers, readonly_tools, approver_tier } = parsed.data;
    const missing = new Set<string>();
    const resolved = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => {
      const result = resolveSecretTemplate(value, secrets);
      if (!result.ok) for (const variable of result.missing) missing.add(variable);
      return [key, result.ok ? result.value : ''];
    }));
    if (missing.size) return disabled('服务端缺少密钥 ' + [...missing].join('、'));
    return connect({ name, transport: { type: transport === 'http' ? 'streamable-http' : 'sse', url, headers: resolved },
      approverTier: approver_tier, toolPolicies: Object.fromEntries((readonly_tools ?? []).map(tool => [tool, 'readonly'])) },
    { resolvedHeaders: true, secrets: Object.values(secrets), scoped: true });
  }));
}
