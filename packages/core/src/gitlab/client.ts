import { renderNote } from './note-streamer.js';
import { redactGitUrl } from './redact.js';
import type { AppConfig } from '../config.js';
import type { GitLabUser, SessionStatus } from '../types.js';

interface Project {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  default_branch: string;
}
interface Issue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  state: 'opened' | 'closed';
}
export interface IssueNote {
  id: number;
  body: string;
  system?: boolean;
  author?: { id: number; username: string };
}
interface MergeRequest {
  iid: number;
  title: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: 'opened' | 'closed' | 'merged';
}
interface Pipeline {
  id: number;
  ref: string;
  status: string;
}
interface TreeEntry {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
}
interface Tag {
  name: string;
  message: string | null;
  commit: { id: string; title?: string };
}
interface Release {
  tag_name: string;
  name: string;
  description: string;
  commit?: { id: string };
  _links?: { self?: string };
}
const labels: Record<SessionStatus, string> = {
  PLANNING: 'claude::planning',
  WAITING_PLAN: 'claude::waiting-approval',
  WAITING_TOOL: 'claude::waiting-approval',
  CODING: 'claude::coding',
  IDLE: 'claude::idle',
  DONE: 'claude::done',
  FAILED: 'claude::failed',
};
export { redactGitUrl };
class GitLabError extends Error {
  constructor(readonly status: number) {
    super('GitLab HTTP ' + status);
  }
}
async function onNotFound<T, F>(request: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GitLabError && error.status === 404) return fallback;
    throw error;
  }
}
export class GitLabClient {
  private identity?: GitLabUser;
  constructor(
    private config: AppConfig,
    private http: typeof fetch = fetch,
  ) {}
  private async request(path: string, method = 'GET', body?: object) {
    const response = await this.http(this.config.gitlabBaseUrl.replace(/\/$/, '') + '/api/v4' + path, {
      method,
      headers: { 'PRIVATE-TOKEN': this.config.gitlabToken, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw new GitLabError(response.status);
    return response;
  }
  private async json<T>(path: string, method = 'GET', body?: object): Promise<T> {
    return (await this.request(path, method, body)).json();
  }
  private project(id: string | number) {
    return '/projects/' + encodeURIComponent(id);
  }
  async initBotIdentity() {
    this.identity = await this.json<GitLabUser>('/user');
  }
  isBotUser(id?: number, name?: string) {
    return Boolean(this.identity && (id === this.identity.id || name === this.identity.username));
  }
  async hasApprovalPermission(project: number, user: number, minAccessLevel = this.config.gitlabMinAccessLevel): Promise<boolean> {
    try {
      const member = await this.json<{ access_level: number }>(
        this.project(project) + '/members/all/' + user,
      );
      return member.access_level >= minAccessLevel;
    } catch (error) {
      if (error instanceof GitLabError && [403, 404].includes(error.status)) return false;
      throw error;
    }
  }
  private notes(p: number, i: number) {
    return this.project(p) + '/issues/' + i + '/notes';
  }
  getIssue(project: number, iid: number) {
    return this.json<Issue>(this.project(project) + '/issues/' + iid);
  }
  async closeIssue(project: number, iid: number): Promise<void> {
    await this.request(this.project(project) + '/issues/' + iid, 'PUT', { state_event: 'close' });
  }
  async listIssueNotes(project: number, iid: number, limit = 20): Promise<IssueNote[]> {
    const perPage = Number.isNaN(limit) ? 20 : Math.min(100, Math.max(1, Math.trunc(limit)));
    const query = new URLSearchParams({ sort: 'desc', per_page: String(perPage) });
    const notes = await this.json<IssueNote[]>(this.notes(project, iid) + '?' + query);
    return notes.slice(0, perPage).reverse();
  }
  createIssueNote(p: number, i: number, body: string) {
    return this.json<{ id: number }>(this.notes(p, i), 'POST', { body: renderNote(body, this.config.jevApiKey) });
  }
  async updateIssueNote(p: number, i: number, n: number, body: string) {
    await this.request(this.notes(p, i) + '/' + n, 'PUT', { body: renderNote(body, this.config.jevApiKey) });
  }
  async updateIssueLabels(project: number, iid: number, changes: { add?: readonly string[]; remove?: readonly string[] }): Promise<void> {
    const clean = (values: readonly string[] = []) => [...new Set(values.map(label => label.trim()).filter(Boolean))];
    const add = clean(changes.add);
    const remove = clean(changes.remove);
    if (!add.length && !remove.length) return;
    await this.request(this.project(project) + '/issues/' + iid, 'PUT', {
      ...(add.length && { add_labels: add.join(',') }),
      ...(remove.length && { remove_labels: remove.join(',') }),
    });
  }
  async syncIssueStatusLabel(p: number, i: number, status: SessionStatus) {
    const label = labels[status];
    await this.updateIssueLabels(p, i, {
      add: [label],
      remove: Object.values(labels).filter(l => l !== label),
    });
  }
  getProject(p: string | number) {
    return this.json<Project>(this.project(p));
  }
  private async pages<T>(resource: string, params: Record<string, string> = {}) {
    const rows: T[] = [];
    let page = '1';
    while (page) {
      const query = new URLSearchParams({ ...params, per_page: '100', page });
      const res = await this.request(resource + '?' + query);
      const batch: T[] = await res.json();
      rows.push(...batch);
      page = res.headers.get('x-next-page') ?? '';
    }
    return rows;
  }
  listProjects(search = '') {
    return this.pages<Project>('/projects', { membership: 'true', search });
  }
  listRepositoryTree(project: number, dirPath: string, ref: string, recursive = false): Promise<TreeEntry[]> {
    return onNotFound(this.pages<TreeEntry>(this.project(project) + '/repository/tree', {
      path: dirPath, ref, ...(recursive && { recursive: 'true' }),
    }), []);
  }
  async getRepositoryFile(project: number, filePath: string, ref: string) {
    const path = this.project(project) + '/repository/files/' + encodeURIComponent(filePath);
    const file = await onNotFound(this.json<{ content: string }>(path + '?ref=' + encodeURIComponent(ref)), null);
    return file && Buffer.from(file.content, 'base64').toString('utf8');
  }
  listTags(project: number, search?: string) {
    const query = new URLSearchParams({ per_page: '100' });
    if (search) query.set('search', search);
    return this.json<Tag[]>(this.project(project) + '/repository/tags?' + query);
  }
  getTag(project: number, tagName: string) {
    return onNotFound(this.json<Tag>(this.project(project) + '/repository/tags/' + encodeURIComponent(tagName)), null);
  }
  getCommit(project: number, sha: string) {
    const path = this.project(project) + '/repository/commits/' + encodeURIComponent(sha);
    return onNotFound(this.json<{ id: string; title: string }>(path), null);
  }
  listPipelinesBySha(project: number, sha: string) {
    return this.json<Pipeline[]>(this.project(project) + '/pipelines?sha=' + encodeURIComponent(sha));
  }
  createTag(project: number, input: { tag_name: string; ref: string; message?: string }) {
    return this.json<Tag>(this.project(project) + '/repository/tags', 'POST', input);
  }
  createRelease(project: number, input: { tag_name: string; ref: string; name?: string; description?: string }) {
    return this.json<Release>(this.project(project) + '/releases', 'POST', input);
  }
  async createMergeRequest(
    p: number,
    input: { source_branch: string; target_branch: string; title: string; description: string },
  ) {
    const { source_branch, target_branch, title, description } = input;
    const resource = this.project(p) + '/merge_requests';
    try {
      return await this.json<MergeRequest>(resource, 'POST', {
        source_branch,
        target_branch,
        title,
        description,
      });
    } catch (error) {
      // GitLab may already have created the MR before the previous turn lost its response.
      if (!(error instanceof GitLabError) || ![400, 409].includes(error.status)) throw error;
      const matches = await this.pages<MergeRequest & { source_project_id: number }>(resource, {
        scope: 'all',
        state: 'opened',
        source_branch,
        target_branch,
      });
      const existing = matches.find(
        (m) =>
          m.source_project_id === p && m.source_branch === source_branch && m.target_branch === target_branch,
      );
      if (!existing) throw error;
      return existing;
    }
  }
  listPipelines(p: number, ref: string | number) {
    const path =
      typeof ref === 'number'
        ? '/merge_requests/' + ref + '/pipelines'
        : '/pipelines?ref=' + encodeURIComponent(ref);
    return this.json<Pipeline[]>(this.project(p) + path);
  }
  getPipelineJobs(p: number, id: number) {
    return this.pages<{ id: number; name: string; status: string }>(
      this.project(p) + '/pipelines/' + id + '/jobs',
    );
  }
  async getJobTrace(p: number, id: number) {
    return redactGitUrl(
      (await (await this.request(this.project(p) + '/jobs/' + id + '/trace')).text()).slice(-16000),
    );
  }
  buildAuthenticatedCloneUrl(httpUrl: string) {
    const url = new URL(httpUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.origin !== new URL(this.config.gitlabBaseUrl).origin ||
      url.username ||
      url.password
    )
      throw Error('Unexpected GitLab clone origin');
    url.username = 'oauth2';
    url.password = this.config.gitlabToken;
    return url.href;
  }
}
