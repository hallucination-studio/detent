import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';

const serviceUrl = z.string().url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(value);
}, 'Expected an HTTP(S) service URL without credentials, query or fragment');

const ConfigSchema = z.object({
  secrets: z.record(z.string()),
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  podId: z
    .string()
    .default(process.env.HOSTNAME || `detent-pod-${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`),
  ephemeralRoot: z.string().default('/tmp/detent-sandboxes'),
  leaseTtlSeconds: z.coerce.number().default(300),
  mrMaxAutoFixAttempts: z.coerce.number().int().min(0).max(10).default(3),
  watchdogIntervalMs: z.coerce.number().int().refine(ms => ms === 0 || ms >= 15000).default(30000),
  watchdogMaxRecoveries: z.coerce.number().int().min(0).max(5).default(1),

  gitlabBaseUrl: z.string().url().default('http://localhost:8080'),
  detentPublicUrl: serviceUrl.transform(value => new URL(value).href.replace(/\/+$/, '').replace(/\/webhooks\/gitlab$/, '').replace(/\/+$/, '')).optional(),
  gitlabToken: z.string().min(1).default('glpat-placeholder'),
  gitlabWebhookSecret: z.string().optional(),
  gitlabHubProjectId: z.coerce.number().int().positive().default(1),
  gitlabHubDefaultBranch: z.string().default('main'),
  gitlabMinAccessLevel: z.coerce.number().int().default(30),
  noteStreamThrottleMs: z.coerce.number().int().default(2000),
  mcpCapabilitiesFile: z.string().trim().min(1).optional(),

  mysqlHost: z.string().default('127.0.0.1'),
  mysqlPort: z.coerce.number().int().default(3306),
  mysqlUser: z.string().default('root'),
  mysqlPassword: z.string().default(''),
  mysqlDatabase: z.string().default('detent'),
  mysqlConnectionLimit: z.coerce.number().int().default(10),

  anthropicApiKey: z.string().default(''),
  anthropicBaseUrl: z.string().optional(),
  claudeModel: z.string().default('claude-sonnet-4-20250514'),
  claudeMaxTurns: z.coerce.number().int().default(40),
  jevProvider: z.enum(['off', 'bailian', 'typesafe', 'custom']).default('off'),
  jevBaseUrl: serviceUrl.optional(),
  jevApiKey: z.string().optional(),
  jevModel: z.string().optional(),
  jevThreshold: z.coerce.number().min(0.5).max(0.99).default(0.9),
  jevTimeoutMs: z.coerce.number().int().positive().max(30000).default(6000),
  safeBashPrefixes: z
    .string()
    .default('git status,git diff,git log,git branch')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type AppConfig = z.infer<typeof ConfigSchema> & { additionalSecrets?: readonly string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secrets = Object.fromEntries(Object.entries(env).flatMap(([key, raw]) => {
    const name = /^DETENT_SECRET_([A-Z0-9_]+)$/.exec(key)?.[1];
    const value = raw?.trim();
    return name && value ? [[name, value]] : [];
  }));
  const config = ConfigSchema.parse({
    secrets,
    port: env.PORT,
    host: env.HOST,
    podId: env.POD_ID,
    ephemeralRoot: env.EPHEMERAL_ROOT,
    leaseTtlSeconds: env.LEASE_TTL_SECONDS,
    mrMaxAutoFixAttempts: env.MR_MAX_AUTO_FIX_ATTEMPTS?.trim() || undefined,
    watchdogIntervalMs: env.WATCHDOG_INTERVAL_MS?.trim() || undefined,
    watchdogMaxRecoveries: env.WATCHDOG_MAX_RECOVERIES?.trim() || undefined,

    gitlabBaseUrl: env.GITLAB_BASE_URL,
    detentPublicUrl: env.DETENT_PUBLIC_URL?.trim() || undefined,
    gitlabToken: env.GITLAB_TOKEN,
    gitlabWebhookSecret: env.GITLAB_WEBHOOK_SECRET,
    gitlabHubProjectId: env.GITLAB_HUB_PROJECT_ID,
    gitlabHubDefaultBranch: env.GITLAB_HUB_DEFAULT_BRANCH,
    gitlabMinAccessLevel: env.GITLAB_MIN_ACCESS_LEVEL,
    noteStreamThrottleMs: env.NOTE_STREAM_THROTTLE_MS,
    mcpCapabilitiesFile: env.DETENT_MCP_CAPABILITIES_FILE?.trim() || undefined,

    mysqlHost: env.MYSQL_HOST,
    mysqlPort: env.MYSQL_PORT,
    mysqlUser: env.MYSQL_USER,
    mysqlPassword: env.MYSQL_PASSWORD,
    mysqlDatabase: env.MYSQL_DATABASE,
    mysqlConnectionLimit: env.MYSQL_CONNECTION_LIMIT,

    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    claudeModel: env.CLAUDE_MODEL,
    claudeMaxTurns: env.CLAUDE_MAX_TURNS,
    jevProvider: env.JEV_PROVIDER?.trim().toLowerCase() || 'off',
    jevBaseUrl: env.JEV_BASE_URL?.trim() || undefined,
    jevApiKey: env.JEV_API_KEY?.trim() || undefined,
    jevModel: env.JEV_MODEL?.trim() || undefined,
    jevThreshold: env.JEV_THRESHOLD,
    jevTimeoutMs: env.JEV_TIMEOUT_MS,
    safeBashPrefixes: env.SAFE_BASH_PREFIXES,
  });
  if (config.jevProvider === 'off') return config;
  if (config.jevProvider === 'typesafe') config.jevBaseUrl ??= 'https://api.typesafe.ai/v1/systemone';
  if (!config.jevBaseUrl) throw Error('JEV_BASE_URL is required for this provider');
  if (config.jevProvider !== 'custom' && !config.jevApiKey) throw Error('JEV_API_KEY is required for this provider');
  config.jevModel ??= config.jevProvider === 'bailian' ? 'decision-model-preview' : 'jev-latest';
  return config;
}
