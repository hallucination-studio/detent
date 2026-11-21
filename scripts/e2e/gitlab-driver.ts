import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

type Actor = 'dev' | 'sre';
type Issue = { iid: number; state: string; labels: string[] };
type Note = { id: number; body: string };
type Release = { tag_name: string; name: string; description: string; commit?: { id: string } };

export function gitlabApi(baseUrl: string, adminToken: string) {
  async function request(path: string, method = 'GET', body?: object, token = adminToken, allow: number[] = []) {
    const res = await fetch(baseUrl + '/api/v4' + path, {
      method, headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!res.ok && !allow.includes(res.status)) throw Error(method + ' ' + path + ' returned HTTP ' + res.status);
    return res;
  }
  async function json<T>(path: string, method = 'GET', body?: object, token?: string): Promise<T> {
    return (await request(path, method, body, token)).json();
  }
  async function lookup<T>(path: string): Promise<T | null> {
    const res = await request(path, 'GET', undefined, adminToken, [404]);
    return res.ok ? res.json() : null;
  }
  return { request, json, lookup };
}

// Both targets use these REST operations, including actor-authenticated emoji and merge requests.
export function projectActions(api: ReturnType<typeof gitlabApi>, tokens: Record<Actor, string>) {
  const project = (id: number) => '/projects/' + id;
  const issues = (id: number, iid: number) => project(id) + '/issues/' + iid;
  const file = (id: number, path: string) => project(id) + '/repository/files/' + encodeURIComponent(path);
  return {
    async ensureLabel(id: number, name: string) {
      const path = project(id) + '/labels';
      const labels = await api.json<{ name: string }[]>(path + '?search=' + encodeURIComponent(name));
      if (!labels.some(label => label.name === name)) await api.request(path, 'POST', { name, color: '#356288' });
    },
    async upsertFile(id: number, path: string, content: string, message: string) {
      const url = file(id, path);
      const existing = await api.lookup(url + '?ref=main');
      await api.request(url, existing ? 'PUT' : 'POST', { branch: 'main', content, commit_message: message });
    },
    async getFile(id: number, path: string) {
      const data = await api.json<{ content: string }>(file(id, path) + '?ref=main');
      return Buffer.from(data.content, 'base64').toString('utf8');
    },
    async headSha(id: number) {
      const commit = await api.json<{ id: string }>(project(id) + '/repository/commits/main');
      assert.match(commit.id, /^[a-f0-9]{40}$/);
      return commit.id;
    },
    async openIssue(id: number, opts: { title: string; description: string; labels: string[] }) {
      const issue = await api.json<Issue>(project(id) + '/issues', 'POST', { ...opts, labels: opts.labels.join(',') }, tokens.dev);
      return issue.iid;
    },
    getIssue(id: number, iid: number) { return api.json<Issue>(issues(id, iid)); },
    listIssueNotes(id: number, iid: number) { return api.json<Note[]>(issues(id, iid) + '/notes?per_page=100'); },
    async awardThumbsUp(id: number, iid: number, noteId: number, actor: Actor) {
      await api.request(issues(id, iid) + '/notes/' + noteId + '/award_emoji', 'POST', { name: 'thumbsup' }, tokens[actor]);
    },
    async postNote(id: number, iid: number, body: string, actor: Actor = 'dev') {
      await api.request(issues(id, iid) + '/notes', 'POST', { body }, tokens[actor]);
    },
    async mergeMergeRequest(id: number, iid: number) {
      const path = project(id) + '/merge_requests/' + iid + '/merge';
      const deadline = Date.now() + 20000;
      for (;;) {
        const res = await api.request(path, 'PUT', { should_remove_source_branch: false }, tokens.sre, [405, 409, 422]);
        if (res.ok) {
          const mr = await res.json();
          assert.match(mr.merge_commit_sha, /^[a-f0-9]{40}$/);
          return mr.merge_commit_sha as string;
        }
        if (Date.now() >= deadline) throw Error('Merge timed out at ' + path + ' (HTTP ' + res.status + ')');
        await delay(500);
      }
    },
    async getTagCommit(id: number, tag: string) {
      const data = await api.lookup<{ commit: { id: string } }>(project(id) + '/repository/tags/' + encodeURIComponent(tag));
      return data?.commit.id ?? null;
    },
    async getRelease(id: number, tag: string) {
      const data = await api.lookup<Release>(project(id) + '/releases/' + encodeURIComponent(tag));
      if (!data) return null;
      const { tag_name, name, description, commit } = data;
      return { tag_name, name, description, commitSha: commit?.id };
    },
  };
}

export interface E2EGitLabDriver extends ReturnType<typeof projectActions> {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly hubProjectPath: string;
  readonly targetProjects: { web: string; api: string; ansible: string };
  readonly devUsername: string;
  readonly sreUsername: string;
  readonly podHost: string;
  readonly membershipChecks?: string[];
  detentPublicUrl(port: number): string;
  ensureUsers(): Promise<void>;
  close(): Promise<void>;
}
