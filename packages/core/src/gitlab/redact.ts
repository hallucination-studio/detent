import type { AppConfig } from '../config.js';

export function redactGitUrl(text: string, secret?: string | readonly string[]) {
  for (const value of typeof secret === 'string' ? [secret] : secret ?? [])
    if (value) text = text.replaceAll(value, '***');
  return text.replace(/(https?:\/\/oauth2:)[^\s/@]+@/gi, '$1***@');
}

export function configuredSecrets(config: AppConfig) {
  return [...new Set([config.jevApiKey, config.gitlabToken, config.anthropicApiKey, config.gitlabWebhookSecret,
    ...(config.additionalSecrets ?? [])].filter((s): s is string => !!s))].sort((a, b) => b.length - a.length);
}
