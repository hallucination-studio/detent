import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  podId: z
    .string()
    .default(process.env.HOSTNAME || `detent-pod-${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`),
  ephemeralRoot: z.string().default('/tmp/detent-sandboxes'),
  leaseTtlSeconds: z.coerce.number().default(300),
  hotHoldTimeoutMs: z.coerce.number().default(180_000),

  gitlabBaseUrl: z.string().url().default('http://localhost:8080'),
  gitlabToken: z.string().min(1).default('glpat-placeholder'),
  gitlabWebhookSecret: z.string().optional(),
  gitlabHubProjectId: z.coerce.number().int().positive().default(1),
  gitlabHubDefaultBranch: z.string().default('main'),
  gitlabMinAccessLevel: z.coerce.number().int().default(30),
  noteStreamThrottleMs: z.coerce.number().int().default(2000),

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

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    podId: env.POD_ID,
    ephemeralRoot: env.EPHEMERAL_ROOT,
    leaseTtlSeconds: env.LEASE_TTL_SECONDS,
    hotHoldTimeoutMs: env.HOT_HOLD_TIMEOUT_MS,

    gitlabBaseUrl: env.GITLAB_BASE_URL,
    gitlabToken: env.GITLAB_TOKEN,
    gitlabWebhookSecret: env.GITLAB_WEBHOOK_SECRET,
    gitlabHubProjectId: env.GITLAB_HUB_PROJECT_ID,
    gitlabHubDefaultBranch: env.GITLAB_HUB_DEFAULT_BRANCH,
    gitlabMinAccessLevel: env.GITLAB_MIN_ACCESS_LEVEL,
    noteStreamThrottleMs: env.NOTE_STREAM_THROTTLE_MS,

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
    safeBashPrefixes: env.SAFE_BASH_PREFIXES,
  });
}
