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

export interface JumpServerNode { id: string; name: string; fullPath: string; assetsAmount: number }
export interface NodeQuery { search?: string; limit?: number }
export interface JumpServerAsset {
  id: string; name: string; address: string;
  nodes?: string[]; labels?: string[]; platform?: string; comment?: string; isActive?: boolean;
}
export interface AssetQuery { search?: string; nodeId?: string; labels?: string[]; limit?: number }
export interface ShellRequest { assetIds: string[]; commands: string[]; account?: string }
export interface AnsibleJobRequest {
  account?: string;
  assetIds: string[];
  repository: string;
  playbookPath?: string;
  command?: string;
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
  listNodes?(query: NodeQuery): Promise<JumpServerNode[]>;
  getAsset?(assetId: string, role?: 'readonly'): Promise<JumpServerAsset | null>;
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
const nodeFields = z.object({
  id: z.string().optional(), name: z.string().nullish(), value: z.string().nullish(), full_value: z.string().nullish(),
});
const nodeRows = z.array(nodeFields.extend({ id: z.string(), assets_amount: z.number().nullish() }));
const nodePage = z.union([
  nodeRows.transform(results => ({ results, next: null })),
  z.object({ results: nodeRows, next: z.string().nullish() }),
]);
const asset = z.object({
  id: z.string(), name: z.string(), address: z.string(),
  nodes: z.array(z.union([z.string(), nodeFields])).nullish(),
  nodes_display: z.array(z.string()).nullish(),
  labels: z.array(z.union([z.string().trim(), z.object({ name: z.string().trim(), value: z.string().trim() })
    .transform(label => label.name + ':' + label.value)])).nullish(),
  platform: z.union([z.string(), z.object({ name: z.string() })]).nullish(),
  comment: z.string().nullish(), is_active: z.boolean().nullish(),
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

function authPrincipal(auth: JumpServerAuth) {
  return auth.kind === 'signature' ? 'key:' + auth.accessKeyId : 'token:' + createHash('sha256').update(auth.token).digest('hex');
}

export class HttpJumpServerClient implements JumpServerClient {
  private readonly base: string;
  private useWebSocketLogs = false;
  private accountsEndpointSupported = true;
  private readonly nodeCache = new Map<string, { tree: Promise<Map<string, JumpServerNode>>; expiresAt: number }>();
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

  private async loadNodeTree(auth: JumpServerAuth) {
    const tree = new Map<string, JumpServerNode>();
    const endpoint = 'perms/users/self/nodes/';
    const signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs);
    const seen = new Set<string>();
    let query = '';
    do {
      if (seen.has(query)) throw Error('Repeated JumpServer node page');
      seen.add(query);
      let page;
      try {
        page = await this.request(auth, endpoint + query, nodePage, undefined, { signal, fallbackOn404: !query });
      } catch (error) {
        // Older installations only expose node names inline on assets.
        if (!query && error instanceof HttpError && error.status === 404) return tree;
        throw error;
      }
      for (const row of page.results) {
        const fullPath = row.full_value?.trim();
        if (row.id !== 'favorite' && fullPath) tree.set(row.id, {
          id: row.id, name: row.name?.trim() || row.value?.trim() || fullPath, fullPath, assetsAmount: row.assets_amount ?? 0,
        });
      }
      // Use only the pagination query. Keep credentials on the original permitted endpoint.
      query = page.next ? new URL(page.next, this.base).search : '';
    } while (query);
    return tree;
  }

  private async nodeTree(auth: JumpServerAuth) {
    const principal = authPrincipal(auth);
    const cached = this.nodeCache.get(principal);
    if (cached && Date.now() < cached.expiresAt) return cached.tree;
    // Parallel asset detail lookups share the same in-flight tree request.
    const tree = this.loadNodeTree(auth);
    this.nodeCache.set(principal, { tree, expiresAt: Date.now() + 60000 });
    try {
      return await tree;
    } catch (error) {
      if (this.nodeCache.get(principal)?.tree === tree) this.nodeCache.delete(principal);
      throw error;
    }
  }

  async listNodes({ search, limit = 100 }: NodeQuery = {}): Promise<JumpServerNode[]> {
    const tree = await this.nodeTree(requireAuth(this.config.jumpserverReadonlyAuth, 'readonly'));
    const needle = search?.trim().toLowerCase();
    return [...tree.values()]
      .filter(node => !needle || node.fullPath.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle))
      .slice(0, limit).map(node => ({
        ...node, id: this.redact(node.id), name: this.redact(node.name), fullPath: this.redact(node.fullPath),
      }));
  }

  private normalizeAsset(raw: z.infer<typeof asset>, tree?: Map<string, JumpServerNode>): JumpServerAsset {
    const nodes = new Set<string>();
    for (const node of raw.nodes ?? []) {
      const path = typeof node === 'string' ? tree?.get(node)?.fullPath || node :
        tree?.get(node.id ?? '')?.fullPath || node.full_value || node.value || node.name || node.id;
      if (path?.trim()) nodes.add(path.trim());
    }
    for (const display of raw.nodes_display ?? []) {
      const path = display.trim();
      if (path) nodes.add(path);
    }
    const leafNames = new Set([...nodes].filter(path => path.startsWith('/')).map(path => path.split('/').at(-1)));
    const paths = [...nodes].filter(path => !leafNames.has(path));
    const platform = (typeof raw.platform === 'string' ? raw.platform : raw.platform?.name)?.trim();
    const comment = raw.comment?.trim();
    return {
      id: this.redact(raw.id), name: this.redact(raw.name), address: this.redact(raw.address), isActive: raw.is_active !== false,
      ...(paths.length > 0 && { nodes: paths.map(path => this.redact(path)) }),
      ...(raw.labels && { labels: raw.labels.map(label => this.redact(label)) }),
      ...(platform && { platform: this.redact(platform) }),
      ...(comment && { comment: this.redact(comment) }),
    };
  }

  async listAssets({ search, nodeId, labels, limit = 50 }: AssetQuery) {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    const query = new URLSearchParams({ limit: String(labels?.length ? Math.max(limit, 200) : limit) });
    if (search) query.set('search', search);
    const scope = nodeId ? 'nodes/' + segment(nodeId) + '/' : '';
    const rows = await this.request(auth, 'perms/users/self/' + scope + 'assets/?' + query, assetPage);
    const required = labels?.map(label => label.trim().toLowerCase()) ?? [];
    const matches = rows.filter(row => row.is_active !== false &&
      required.every(label => row.labels?.some(value => value.toLowerCase() === label))).slice(0, limit);
    const tree = matches.some(row => row.nodes?.length) ? await this.nodeTree(auth) : undefined;
    return matches.map(row => this.normalizeAsset(row, tree));
  }

  async getAsset(assetId: string, auth?: JumpServerAuth | 'readonly') {
    const credential = auth === 'readonly' ? requireAuth(this.config.jumpserverReadonlyAuth, 'readonly') :
      auth ?? requireAuth(this.config.jumpserverJobAuth ?? this.config.jumpserverReadonlyAuth, 'asset');
    let row;
    try {
      row = await this.request(credential, 'perms/users/self/assets/' + segment(assetId) + '/', asset, undefined, { fallbackOn404: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    return this.normalizeAsset(row, row.nodes?.length ? await this.nodeTree(credential) : undefined);
  }

  async listAssetAccounts(assetId: string, auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly'), signal?: AbortSignal): Promise<string[]> {
    const path = 'perms/users/self/assets/' + segment(assetId) + '/';
    const key = JSON.stringify([authPrincipal(auth), assetId]);
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
    const accountsByAsset = await Promise.all([...new Set(assetIds)].map(async id =>
      [id, await this.listAssetAccounts(id, auth, signal)] as const));
    for (const [id, accounts] of accountsByAsset) {
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
