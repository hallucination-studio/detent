import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type AppConfig } from '@detent/core';
import { z } from 'zod';
import { assertSeparateCredentials, redactSecrets, type DeliveryConfig } from '../config.js';
import { playbookUpload } from './playbook.js';

export type JumpServerAuth =
  | { kind: 'signature'; accessKeyId: string; accessKeySecret: string }
  | { kind: 'bearer'; token: string };

const asset = z.object({ id: z.string(), name: z.string(), address: z.string() });
export type JumpServerAsset = z.infer<typeof asset>;
interface AssetQuery { search?: string; nodeId?: string; limit?: number }
export interface ReadonlyInspectRequest { assetIds: string[]; command: string; account: string }
export interface AnsibleJobRequest {
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
export type ReadonlyInspectResult = JobResultResponse;
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
    private readonly gitlab: Pick<AppConfig, 'gitlabBaseUrl' | 'gitlabToken'> = loadConfig(),
  ) {
    assertSeparateCredentials(config);
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
      if (!response.ok) throw new HttpError(response.status);
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

  async runReadonlyInspect(request: ReadonlyInspectRequest) {
    const auth = requireAuth(this.config.jumpserverReadonlyAuth, 'readonly');
    if (request.account !== this.config.jumpserverReadonlyAccount) throw Error('Inspection requires the configured readonly account');
    const signal = AbortSignal.timeout(this.config.jumpserverTimeoutMs);
    const job = await this.submit(auth, {
      type: 'adhoc', module: 'shell', args: request.command, assets: request.assetIds,
      runas: request.account, runas_policy: 'skip', timeout: Math.ceil(this.config.jumpserverTimeoutMs / 1000),
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
      const form = await playbookUpload(request, this.gitlab, signal);
      const playbook = await this.request(auth, 'ops/playbooks/', resource, form, signal);
      return await this.submit(auth, { type: 'playbook', playbook: playbook.id, assets: request.assetIds, comment: request.comment }, signal, request.extraVars);
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
    return { jobId, jobUrl: this.jobUrl(jobId), status, outputSummary: redactSecrets(output, this.config).slice(0, 16000) };
  }

  async getJobResult(jobId: string) {
    const auth = requireAuth(this.config.jumpserverJobAuth ?? this.config.jumpserverReadonlyAuth, 'result');
    return this.result(auth, jobId, AbortSignal.timeout(this.config.jumpserverTimeoutMs));
  }
}
