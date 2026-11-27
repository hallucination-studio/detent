import type { AppConfig } from '../config.js';

export function redactGitUrl(text: string, secret?: string | readonly string[]) {
  for (const value of typeof secret === 'string' ? [secret] : secret ?? [])
    if (value) text = text.replaceAll(value, '***');
  return text.replace(/(https?:\/\/oauth2:)[^\s/@]+@/gi, '$1***@');
}

export function configuredSecrets(config: AppConfig) {
  return [...new Set([config.mysqlPassword, config.jevApiKey, config.gitlabToken, config.anthropicApiKey, config.gitlabWebhookSecret,
    ...Object.values(config.secrets ?? {}), ...(config.additionalSecrets ?? [])].filter((s): s is string => !!s))].sort((a, b) => b.length - a.length);
}

export function scrubJson(value: unknown, scrub: (value: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => scrubJson(item, scrub));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), scrubJson(item, scrub)]));
  // A service can echo a numeric credential as a JSON number.
  const literal = JSON.stringify(value);
  const cleaned = literal === undefined ? literal : scrub(literal);
  return cleaned === literal ? value : cleaned;
}
