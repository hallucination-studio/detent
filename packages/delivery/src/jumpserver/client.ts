import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, redactGitUrl, type AppConfig } from '@detent/core';
import { z } from 'zod';
import { redactSecrets, type DeliveryConfig } from '../config.js';
import { playbookUpload } from './playbook.js';

export type JumpServerAuth =
  | { kind: 'signature'; accessKeyId: string; accessKeySecret: string }
  | { kind: 'bearer'; token: string };

const asset = z.object({ id: z.string(), name: z.string(), address: z.string() });
export type JumpServerAsset = z.infer<typeof asset>;
interface AssetQuery { search?: string; nodeId?: string; limit?: number }
export interface ReadonlyInspectRequest { assetIds: string[]; command: string; account?: string }
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
  runReadonlyInspect(request: ReadonlyInspectRequest): Promise<ReadonlyInspectResult>;
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

class HttpError extends Error {
  constructor(readonly status: number) { super('JumpServer HTTP ' + status); }
}

export class HttpJumpServerClient implements JumpServerClient {
  private readonly base: string;
  constructor(
    private readonly config: DeliveryConfig,
    private readonly gitlab: Pick<AppConfig, 'gitlabBaseUrl' | 'gitlabToken' | 'jevApiKey'> & Partial<Pick<AppConfig, 'secrets'>> = loadConfig(),
  ) {
    if (!config.jumpserverBaseUrl) throw Error('JumpServer base URL is not configured');
    this.base = config.jumpserverBaseUrl.replace(/\/$/, '');
  }

  private async request<S extends z.ZodTypeAny>(
    auth: JumpServerAuth, path: string, schema: S, body?: object, signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs),
  ): Promise<z.output<S>> {
    const method = body ? 'POST' : 'GET';
    try {
      const url = new URL(this.base + '/api/v1/' + path);
      const date = new Date().toUTCString();
      const headers = new Headers({ Accept: 'application/json', Date: date });
      if (this.config.jumpserverOrgId) headers.set('X-JMS-ORG', this.config.jumpserverOrgId);
      if (auth.kind === 'signature') {
        const target = method.toLowerCase() + ' ' + url.pathname + url.search;
        const signature = createHmac('sha256', auth.accessKeySecret)
          .update('(request-target): ' + target + '\naccept: application/json\ndate: ' + date).digest('base64');
        headers.set('Authorization', `Signature keyId="${auth.accessKeyId}",algorithm="hmac-sha256",headers="(request-target) accept date",signature="${signature}"`);
      } else headers.set('Authorization', 'Bearer ' + auth.token);

      if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
      const response = await fetch(url, {
        method, headers, signal, redirect: 'error', body: body instanceof FormData ? body : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(response.status);
      }
      const parsed = schema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw Error('Invalid JumpServer response');
      return parsed.data;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw Error(redactSecrets(error instanceof Error ? error.message : 'JumpServer request failed', this.config));
    }
  }

  async listAssets({ search, nodeId, limit = 50 }: AssetQuery) {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    const query = new URLSearchParams({ limit: String(limit) });
    if (search) query.set('search', search);
    const scope = nodeId ? 'nodes/' + segment(nodeId) + '/' : '';
    const rows = await this.request(auth, 'perms/users/self/' + scope + 'assets/?' + query, assetPage);
    return rows.slice(0, limit).map(({ id, name, address }) => ({
      id: redactSecrets(id, this.config), name: redactSecrets(name, this.config), address: redactSecrets(address, this.config),
    }));
  }

  async listAssetAccounts(assetId: string, auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly')): Promise<string[]> {
    const path = 'perms/users/self/assets/' + segment(assetId) + '/';
    const items = z.array(z.union([z.string(), z.object({
      username: z.string().nullish(), name: z.string().nullish(), alias: z.string().nullish(), is_active: z.boolean().optional(),
    })]));
    let accounts: z.infer<typeof items>;
    try {
      accounts = await this.request(auth, path + 'accounts/', z.union([items, z.object({ results: items }).transform(page => page.results)]));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      const detail = await this.request(auth, path, z.object({ permed_accounts: items.optional(), accounts: items.optional() }));
      accounts = detail.permed_accounts ?? detail.accounts ?? [];
    }
    const usernames = accounts.map(item => typeof item === 'string' ? item.trim() :
      item.is_active === false ? '' : item.username?.trim() || item.name?.trim() || item.alias?.trim());
    return [...new Set(usernames.filter((name): name is string => !!name && !name.startsWith('@')))];
  }

  private async resolveAccountGroups(assetIds: string[], account: string | undefined, auth: JumpServerAuth) {
    if (!assetIds.length) throw Error('必须指定目标资产');
    const groups = new Map<string, string[]>();
    for (const id of new Set(assetIds)) {
      const accounts = await this.listAssetAccounts(id, auth);
      if (!accounts.length) throw Error(`资产 ${id} 没有可用的真实授权账号`);
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
    if (variables && Object.keys(variables).length) {
      // Definitions exposing the variable relation use native parameter objects.
      // Older Job Centers consume JSON text. Keep their variables in the same jms_ namespace.
      const job = await this.request(auth, 'ops/jobs/', jobDefinition, { ...body, name: 'detent-' + randomUUID() }, signal);
      const namespaced = Object.fromEntries(Object.entries(variables).map(([name, value]) =>
        [name.startsWith('jms_') ? name : 'jms_' + name, value]));
      execution = await this.request(auth, 'ops/job-executions/', task, {
        job: job.id, parameters: job.variable === undefined ? JSON.stringify(namespaced) : namespaced,
      }, signal);
    } else {
      execution = await this.request(auth, 'ops/jobs/', task, { ...body, instant: true }, signal);
    }
    const jobId = execution.task_id;
    if (redactSecrets(jobId, this.config) !== jobId) throw Error('Unsafe JumpServer execution ID');
    return { jobId, jobUrl: this.jobUrl(jobId), status: 'PENDING' };
  }

  async runReadonlyInspect(request: ReadonlyInspectRequest): Promise<ReadonlyInspectResult> {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    const groups = await this.resolveAccountGroups(request.assetIds, request.account, auth);
    const results: InspectionGroup[] = [];
    const summaries: string[] = [];
    for (const [account, assetIds] of groups) {
      const result = await this.inspectGroup(auth, assetIds, account, request.command);
      if (groups.size === 1) return result;
      const { outputSummary, ...job } = result;
      results.push({ account, assetIds, ...job });
      summaries.push(`[${account} · ${assetIds.join(', ')}]\n${outputSummary}`);
    }
    return { status: results.some(job => job.status === 'FAILED') ? 'FAILED' : 'SUCCESS',
      groups: results, outputSummary: summaries.join('\n\n') };
  }

  private async inspectGroup(auth: JumpServerAuth, assetIds: string[], account: string, command: string) {
    const signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs);
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
      const groups = await this.resolveAccountGroups(request.assetIds, request.account, auth);
      if (groups.size !== 1) throw Error('目标资产的首个授权账号不同，请指定共同的 account 或按账号分组执行');
      const [account] = groups.keys();
      const form = await playbookUpload(request, this.gitlab, signal);
      const playbook = await this.request(auth, 'ops/playbooks/', resource, form, signal);
      return await this.submit(auth, { type: 'playbook', playbook: playbook.id,
        runas: account, runas_policy: 'skip', assets: request.assetIds, comment: request.comment }, signal, request.extraVars);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'JumpServer submission failed';
      throw Error(redactSecrets(message, this.config, this.gitlab.gitlabToken));
    }
  }

  private async result(auth: JumpServerAuth, jobId: string, signal: AbortSignal): Promise<JobResultResponse> {
    const id = segment(jobId);
    const { status, summary } = await this.request(auth, 'ops/job-execution/task-detail/' + id + '/', detail, undefined, signal);
    let output = JSON.stringify(summary ?? {});
    if (status === 'SUCCESS' || status === 'FAILED') {
      // Newer releases expose structured results. Earlier v3/v4 installations expose a log tail.
      try {
        const reply = await this.request(auth, 'ops/job-execution/result/' + id + '/',
          z.object({ result: z.record(z.unknown()).nullable() }), undefined, signal);
        output += '\n' + JSON.stringify(reply.result);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        const log = await this.request(auth, 'ops/ansible/job-execution/' + id + '/log/', z.object({ data: z.string() }), undefined, signal);
        output += '\n' + log.data;
      }
    }
    const safe = redactSecrets(redactGitUrl(output), this.config, this.gitlab.gitlabToken, this.gitlab.jevApiKey ?? '', ...Object.values(this.gitlab.secrets ?? {}));
    return { jobId, jobUrl: this.jobUrl(jobId), status, outputSummary: safe.slice(0, 16000) };
  }

  async getJobResult(jobId: string) {
    const auth = requireAuth(this.config.jumpserverJobAuth ?? this.config.jumpserverReadonlyAuth, 'result');
    return this.result(auth, jobId, AbortSignal.timeout(this.config.jumpserverTimeoutMs));
  }
}
