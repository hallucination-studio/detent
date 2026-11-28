import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import type { AppConfig } from '../config.js';

export function redactGitUrl(text: string, secret?: string | readonly string[]) {
  for (const value of typeof secret === 'string' ? [secret] : secret ?? [])
    if (value) text = text.replaceAll(value, '***');
  return text.replace(/(https?:\/\/oauth2:)[^\s/@]+@/gi, '$1***@');
}

// Resumed transcripts may mention an earlier turn on the same host.
export function workspacePathFilter(workspaceRoot?: string): (text: string) => string {
  if (!workspaceRoot) return text => text;
  const roots = new Set([path.resolve(workspaceRoot)]);
  if (existsSync(workspaceRoot)) roots.add(realpathSync(workspaceRoot));
  if (process.platform === 'darwin') {
    for (const root of [...roots]) roots.add(root.replace(/^\/private(?=\/var\/|\/tmp\/)/, ''));
  }
  const patterns = [...roots].sort((a, b) => b.length - a.length).map(root =>
    root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/turn-[0-9a-f-]{36}\/workspace$/, '/turn-[0-9a-f-]{36}/workspace'));
  const prefix = new RegExp('(?:' + patterns.join('|') + ')(/|(?![\\w-]))', 'g');
  return text => text.replace(prefix, (_match, slash: string) => slash ? '' : '.');
}

type Secrets = string | readonly string[];

// Some fallback guards receive only a DecisionClient. Include credentials from
// live app configurations there too, without keeping retired configs alive.
const knownConfigs = new WeakSet<AppConfig>();
const liveConfigs = new Set<WeakRef<AppConfig>>();

function *liveConfigSecrets() {
  for (const ref of liveConfigs) {
    const config = ref.deref();
    if (config) yield* configuredSecrets(config);
    else liveConfigs.delete(ref);
  }
}

function errorSnippet(text: string, limit: number, secrets?: Secrets) {
  const values = new Set([...liveConfigSecrets(), ...(typeof secrets === 'string' ? [secrets] : secrets ?? [])]);
  const forms = [...values].filter(Boolean).flatMap(value => [
    value, encodeURIComponent(value.replace(/[\uD800-\uDFFF]/gu, '�')), JSON.stringify(value).slice(1, -1),
  ]);
  const line = redactGitUrl(text, [...new Set(forms)].sort((a, b) => b.length - a.length))
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').trim();
  return line.length > limit ? line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : line;
}

export function logError(scope: string, error: unknown, secrets?: Secrets, extra?: string) {
  // JSON.parse may quote a fragment of a credential, which literal replacement cannot recognize.
  const message = error instanceof SyntaxError && /not valid JSON/.test(error.message) ? 'Invalid JSON input' :
    error instanceof Error ? error.message || error.name : typeof error === 'string' ? error : inspect(error);
  const detail = errorSnippet(extra ? message + ' ' + extra : message, 1000, secrets);
  console.error('[detent:' + scope + '] ' + detail);
  return detail;
}

export function formatHttpError(service: string, status: number, body: string, secrets?: Secrets) {
  const detail = errorSnippet(body, 300, secrets);
  return service + ' HTTP ' + status + (detail ? ': ' + detail : '');
}

export function configuredSecrets(config: AppConfig) {
  if (!knownConfigs.has(config)) {
    knownConfigs.add(config);
    liveConfigs.add(new WeakRef(config));
    for (const ref of liveConfigs) if (!ref.deref()) liveConfigs.delete(ref);
  }
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
