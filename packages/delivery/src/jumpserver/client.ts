import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type AppConfig } from '@detent/core';
import { z } from 'zod';
import { redactDeliveryOutput, type DeliveryConfig } from '../config.js';
import { buildBatchShellScript } from './guards.js';
import { playbookUpload } from './playbook.js';
import { readTaskLog } from './ws-log.js';

export type JumpServerAuth =
  | { kind: 'signature'; accessKeyId: string; accessKeySecret: string }
  | { kind: 'bearer'; token: string };

const asset = z.object({ id: z.string(), name: z.string(), address: z.string() });
export type JumpServerAsset = z.infer<typeof asset>;
export interface AssetQuery { search?: string; nodeId?: string; limit?: number }
export interface ShellRequest { assetIds: string[]; commands: string[]; account?: string }
export interface AnsibleJobRequest {
  account?: string;
  assetIds: string[];
  repository: string;
  playbookPath: string;
  commitSha: string;
  extraVars?: Record<string, unknown>;
  comment: string;
}
export interface AnsibleJobSubmission {
  jobId: string;
  jobUrl: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
}
export interface JobResultResponse extends AnsibleJobSubmission { outputSummary: string }
type InspectionGroup = AnsibleJobSubmission & { account: string; assetIds: string[] };
export type ReadonlyInspectResult = JobResultResponse | {
  status: 'SUCCESS' | 'FAILED'; outputSummary: string; groups: InspectionGroup[];
};
export interface JumpServerClient {
  listAssets(query: AssetQuery): Promise<JumpServerAsset[]>;
  runShell(request: ShellRequest): Promise<ReadonlyInspectResult>;
  runAnsibleJob(request: AnsibleJobRequest): Promise<AnsibleJobSubmission>;
  getJobResult(jobId: string): Promise<JobResultResponse>;
}

function requireAuth(auth: JumpServerAuth | undefined, role: string) {
  if (!auth) throw Error('Missing JumpServer ' + role + ' credentials');
  return auth;
}

// Reject dot-segments before URL normalization can change an authorized endpoint.
const segment = (id: string) => {
  if (!id || id === '.' || id === '..') throw Error('Invalid JumpServer resource ID');
  return encodeURIComponent(id);
};
const statusMap = {
  pending: 'PENDING', running: 'RUNNING', success: 'SUCCESS', failed: 'FAILED', timeout: 'FAILED', canceled: 'FAILED', error: 'FAILED',
} as const;
const detail = z.object({
  status: z.union([z.string(), z.object({ value: z.string() }).transform(s => s.value)])
    .pipe(z.enum(['pending', 'running', 'success', 'failed', 'timeout', 'canceled', 'error'])).transform(s => statusMap[s]),
  summary: z.record(z.unknown()).nullable(),
});
const assets = z.array(asset);
const assetPage = z.union([assets, z.object({ results: assets }).transform(page => page.results)]);
const resource = z.object({ id: z.string().min(1) });
const jobDefinition = resource.extend({ variable: z.array(z.unknown()).nullish() });
const task = z.object({ task_id: z.string().min(1) });

const accountItems = z.array(z.union([z.string(), z.object({
  username: z.string().nullish(), name: z.string().nullish(), alias: z.string().nullish(), is_active: z.boolean().optional(),
})]));
const accountPage = z.union([accountItems, z.object({ results: accountItems }).transform(page => page.results)]);
const accountDetail = z.object({ permed_accounts: accountItems.optional(), accounts: accountItems.optional() });

class HttpError extends Error {
  constructor(readonly status: number, snippet: string) {
    super('JumpServer HTTP ' + status + (snippet ? ': ' + snippet : ''));
  }
}

export class HttpJumpServerClient implements JumpServerClient {
  private readonly base: string;
  private useWebSocketLogs = false;
  private accountsEndpointSupported = true;
  private readonly accountCache = new Map<string, { accounts: string[]; expiresAt: number }>();

  constructor(
    private readonly config: DeliveryConfig,
    private readonly gitlab: Pick<AppConfig, 'gitlabBaseUrl' | 'gitlabToken'> & Partial<AppConfig> = loadConfig(),
  ) {
    if (!config.jumpserverBaseUrl) throw Error('JumpServer base URL is not configured');
    this.base = config.jumpserverBaseUrl.replace(/\/$/, '');
  }

  private redact(value: string) {
    return redactDeliveryOutput(value, this.config, this.gitlab);
  }

  private requestSignal(budget?: AbortSignal) {
    const timeout = AbortSignal.timeout(Math.min(15000, this.config.jumpserverTimeoutMs));
    return budget ? AbortSignal.any([budget, timeout]) : timeout;
  }

  private authHeaders(auth: JumpServerAuth, method: string, url: URL) {
    const date = new Date().toUTCString();
    const headers = new Headers({ Accept: 'application/json', Date: date });
    if (this.config.jumpserverOrgId) headers.set('X-JMS-ORG', this.config.jumpserverOrgId);
    if (auth.kind === 'signature') {
      const target = method.toLowerCase() + ' ' + url.pathname + url.search;
      const signature = createHmac('sha256', auth.accessKeySecret)
        .update('(request-target): ' + target + '\naccept: application/json\ndate: ' + date).digest('base64');
      headers.set('Authorization', `Signature keyId="${auth.accessKeyId}",algorithm="hmac-sha256",headers="(request-target) accept date",signature="${signature}"`);
    } else headers.set('Authorization', 'Bearer ' + auth.token);
    return headers;
  }

  private async request<S extends z.ZodTypeAny>(
    auth: JumpServerAuth, path: string, schema: S, body?: object,
    { signal, fallbackOn404 = false }: { signal?: AbortSignal; fallbackOn404?: boolean } = {},
  ): Promise<z.output<S>> {
    const method = body ? 'POST' : 'GET';
    try {
      const url = new URL(this.base + '/api/v1/' + path);
      const headers = this.authHeaders(auth, method, url);

      if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
      const response = await fetch(url, {
        method, headers, signal: this.requestSignal(signal), redirect: 'error', body: body instanceof FormData ? body : JSON.stringify(body),
      });
      if (!response.ok) {
        const safeSnippet = this.redact(await response.text().catch(error => {
          console.error('[detent:jumpserver]', method, this.redact(path), response.status, this.redact(String(error)));
          return '';
        })).slice(0, 1000);
        if (!(fallbackOn404 && response.status === 404))
          console.error('[detent:jumpserver]', method, this.redact(path), response.status, safeSnippet);
        throw new HttpError(response.status, safeSnippet.slice(0, 300));
      }
      const json = await response.json().catch(error => {
        if (error instanceof SyntaxError) throw Error('Invalid JumpServer JSON');
        throw error;
      });
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw Error('Invalid JumpServer response: ' + parsed.error.message);
      return parsed.data;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const detail = this.redact(error instanceof Error ? error.message : String(error));
      console.error('[detent:jumpserver]', method, this.redact(path), detail.slice(0, 1000));
      throw Error(detail.slice(0, 300));
    }
  }

  async listAssets({ search, nodeId, limit = 50 }: AssetQuery) {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    const query = new URLSearchParams({ limit: String(limit) });
    if (search) query.set('search', search);
    const scope = nodeId ? 'nodes/' + segment(nodeId) + '/' : '';
    const rows = await this.request(auth, 'perms/users/self/' + scope + 'assets/?' + query, assetPage);
    return rows.slice(0, limit).map(({ id, name, address }) => ({
      id: this.redact(id), name: this.redact(name), address: this.redact(address),
    }));
  }

  async listAssetAccounts(assetId: string, auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly'), signal?: AbortSignal): Promise<string[]> {
    const path = 'perms/users/self/assets/' + segment(assetId) + '/';
    const principal = auth.kind === 'signature' ? 'key:' + auth.accessKeyId : 'token:' + createHash('sha256').update(auth.token).digest('hex');
    const key = JSON.stringify([principal, assetId]);
    const now = Date.now();
    const cached = this.accountCache.get(key);
    if (cached && now < cached.expiresAt) return [...cached.accounts];
    // Entries are inserted in expiry order. Reclaim expired assets without a timer.
    for (const [id, entry] of this.accountCache) {
      if (entry.expiresAt > now) break;
      this.accountCache.delete(id);
    }
    let accounts;
    if (this.accountsEndpointSupported) {
      try {
        accounts = await this.request(auth, path + 'accounts/', accountPage, undefined, { signal, fallbackOn404: true });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        this.accountsEndpointSupported = false;
      }
    }
    if (!accounts) {
      const detail = await this.request(auth, path, accountDetail, undefined, { signal });
      accounts = detail.permed_accounts ?? detail.accounts ?? [];
    }
    const usernames = accounts.map(item => typeof item === 'string' ? item.trim() :
      item.is_active === false ? '' : item.username?.trim() || item.name?.trim() || item.alias?.trim());
    const active = [...new Set(usernames.filter((name): name is string => !!name && !name.startsWith('@')))];
    this.accountCache.delete(key);
    this.accountCache.set(key, { accounts: active, expiresAt: Date.now() + 60000 });
    return [...active];
  }

  private async resolveAccountGroups(assetIds: string[], account: string | undefined, auth: JumpServerAuth, signal: AbortSignal) {
    if (!assetIds.length) throw Error('必须指定目标资产');
    const groups = new Map<string, string[]>();
    for (const id of new Set(assetIds)) {
      const accounts = await this.listAssetAccounts(id, auth, signal);
      if (!accounts.length) throw Error(`资产 ${id} 在 JumpServer 中未给当前 API Key 授权任何登录账号`);
      const selected = account ?? accounts[0];
      if (!accounts.includes(selected))
        throw Error(`资产 ${id} 未授权账号 ${selected}；可用授权账号：${accounts.join('、')}`);
      const group = groups.get(selected);
      if (group) group.push(id);
      else groups.set(selected, [id]);
    }
    return groups;
  }

  private jobUrl(id: string) { return this.base + '/ui/#/workbench/ops/executions/' + segment(id); }

  private async submit(
    auth: JumpServerAuth, body: object, signal: AbortSignal, variables?: Record<string, unknown>,
  ): Promise<AnsibleJobSubmission> {
    let execution: z.infer<typeof task>;
    const jobBody = { ...body, is_periodic: false };
    if (variables && Object.keys(variables).length) {
      // Definitions exposing the variable relation use native parameter objects.
      // Older Job Centers consume JSON text. Keep their variables in the same jms_ namespace.
      const job = await this.request(auth, 'ops/jobs/', jobDefinition, { ...jobBody, name: 'detent-' + randomUUID() }, { signal });
      const namespaced = Object.fromEntries(Object.entries(variables).map(([name, value]) =>
        [name.startsWith('jms_') ? name : 'jms_' + name, value]));
      execution = await this.request(auth, 'ops/job-executions/', task, {
        job: job.id, parameters: job.variable === undefined ? JSON.stringify(namespaced) : namespaced,
      }, { signal });
    } else {
      execution = await this.request(auth, 'ops/jobs/', task, { ...jobBody, instant: true }, { signal });
    }
    const jobId = execution.task_id;
    if (this.redact(jobId) !== jobId) throw Error('Unsafe JumpServer execution ID');
    return { jobId, jobUrl: this.jobUrl(jobId), status: 'PENDING' };
  }

  async runShell(request: ShellRequest): Promise<ReadonlyInspectResult> {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    const signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs);
    const groups = await this.resolveAccountGroups(request.assetIds, request.account, auth, signal);
    const script = buildBatchShellScript(request.commands);
    const results: InspectionGroup[] = [];
    const summaries: string[] = [];
    for (const [account, assetIds] of groups) {
      const result = await this.inspectGroup(auth, assetIds, account, script, signal);
      if (groups.size === 1) return result;
      const { outputSummary, ...job } = result;
      results.push({ account, assetIds, ...job });
      summaries.push(`[${account} · ${assetIds.join(', ')}]\n${outputSummary}`);
    }
    return { status: results.some(job => job.status === 'FAILED') ? 'FAILED' : 'SUCCESS',
      groups: results, outputSummary: summaries.join('\n\n') };
  }

  private async inspectGroup(auth: JumpServerAuth, assetIds: string[], account: string, command: string, signal: AbortSignal) {
    const job = await this.submit(auth, {
      type: 'adhoc', module: 'shell', args: command, assets: assetIds,
      runas: account, runas_policy: 'skip', timeout: Math.ceil(this.config.jumpserverTimeoutMs / 1000),
    }, signal);
    for (;;) {
      const result = await this.result(auth, job.jobId, signal);
      if (result.status === 'SUCCESS' || result.status === 'FAILED') return result;
      await delay(1000, undefined, { signal });
    }
  }

  async runAnsibleJob(request: AnsibleJobRequest) {
    const auth = requireAuth(this.config.jumpserverJobAuth, 'job');
    const signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs);
    try {
      const groups = await this.resolveAccountGroups(request.assetIds, request.account, auth, signal);
      if (groups.size !== 1) throw Error('目标资产的首个授权账号不同，请指定共同的 account 或按账号分组执行');
      const [account] = groups.keys();
      const form = await playbookUpload(request, this.gitlab, this.requestSignal(signal)).catch(error => {
        const detail = this.redact(error instanceof Error ? error.message : String(error));
        console.error('[detent:playbook]', detail.slice(0, 1000));
        throw Error(detail.slice(0, 300));
      });
      const playbook = await this.request(auth, 'ops/playbooks/', resource, form, { signal });
      return await this.submit(auth, { type: 'playbook', playbook: playbook.id,
        runas: account, runas_policy: 'skip', assets: request.assetIds, comment: request.comment }, signal, request.extraVars);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : 'JumpServer submission failed';
      throw Error(this.redact(message));
    }
  }

  private async jobLog(auth: JumpServerAuth, jobId: string, signal: AbortSignal) {
    const id = segment(jobId);
    if (!this.useWebSocketLogs) {
      try {
        const reply = await this.request(auth, 'ops/job-execution/result/' + id + '/',
          z.object({ result: z.record(z.unknown()).nullable() }), undefined, { signal, fallbackOn404: true });
        return { output: JSON.stringify(reply.result), truncated: false };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
      try {
        const log = await this.request(auth, 'ops/ansible/job-execution/' + id + '/log/',
          z.object({ data: z.string() }), undefined, { signal, fallbackOn404: true });
        return { output: log.data.replaceAll('\u0000', ''), truncated: false };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        this.useWebSocketLogs = true;
      }
    }

    const url = new URL(this.base + '/ws/ops/tasks/log/');
    try {
      for (const type of ['ansible', 'celery'] as const) {
        const log = await readTaskLog(url, this.authHeaders(auth, 'GET', url), jobId, type, signal);
        if (log) return log;
      }
      throw Error('JumpServer Ansible and Celery task logs unavailable');
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      console.error('[detent:jumpserver]', 'GET', this.redact(url.pathname), message.slice(0, 1000));
      throw Error(message.slice(0, 300));
    }
  }

  private async result(auth: JumpServerAuth, jobId: string, signal: AbortSignal): Promise<JobResultResponse> {
    const id = segment(jobId);
    const { status, summary } = await this.request(auth, 'ops/job-execution/task-detail/' + id + '/', detail, undefined, { signal });
    let output = JSON.stringify(summary ?? {});
    let truncated = false;
    if (status === 'SUCCESS' || status === 'FAILED') {
      const log = await this.jobLog(auth, jobId, signal);
      output += '\n' + log.output;
      truncated = log.truncated;
    }
    const safe = redactDeliveryOutput(output, this.config, this.gitlab, truncated);
    const outputSummary = truncated || safe.length > 16000 ? safe.slice(0, 15999).replace(/[\uD800-\uDBFF]$/, '') + '…' : safe;
    return { jobId, jobUrl: this.jobUrl(jobId), status, outputSummary };
  }

  async getJobResult(jobId: string) {
    const auth = requireAuth(this.config.jumpserverJobAuth ?? this.config.jumpserverReadonlyAuth, 'result');
    return this.result(auth, jobId, AbortSignal.timeout(this.config.jumpserverTimeoutMs));
  }
}
