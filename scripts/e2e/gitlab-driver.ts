import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

type Actor = 'dev' | 'sre' | 'reporter';
type Issue = { iid: number; state: string; labels: string[] };
type Note = { id: number; body: string; author: { username: string }; system: boolean; type?: string };
type DiffRefs = { base_sha: string; start_sha: string; head_sha: string };
type InlinePosition = DiffRefs & { position_type: 'text'; old_path: string; new_path: string; new_line: number };
type MR = {
  iid: number; state: string; source_project_id: number; target_project_id: number; sha: string;
  source_branch: string; target_branch: string; assignees: { id: number; username: string }[]; diff_refs: DiffRefs | null;
};
type Discussion = { id: string; notes: Note[] };
type Project = { id: number; path_with_namespace: string };

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
  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let page = '1';
    while (page) {
      const res = await request(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
      items.push(...await res.json() as T[]);
      page = res.headers.get('x-next-page') ?? '';
    }
    return items;
  }
  async function lookup<T>(path: string): Promise<T | null> {
    const res = await request(path, 'GET', undefined, adminToken, [404]);
    return res.ok ? res.json() : null;
  }
  return { request, json, all, lookup };
}

export function projectActions(api: ReturnType<typeof gitlabApi>, tokens: Record<Actor, string>) {
  const project = (id: number) => '/projects/' + id;
  const issues = (id: number, iid: number) => project(id) + '/issues/' + iid;
  const mr = (id: number, iid: number) => project(id) + '/merge_requests/' + iid;
  const file = (id: number, path: string) => project(id) + '/repository/files/' + encodeURIComponent(path);
  return {
    project(path: string) { return api.json<Project>('/projects/' + encodeURIComponent(path)); },
    async upsertFile(id: number, path: string, content: string, message: string, branch = 'main', startBranch?: string) {
      const url = file(id, path);
      const existing = await api.lookup(url + '?ref=' + encodeURIComponent(startBranch ?? branch));
      await api.request(url, existing ? 'PUT' : 'POST', { branch, start_branch: startBranch, content, commit_message: message });
    },
    async getFile(id: number, path: string, ref = 'main') {
      const data = await api.json<{ content: string }>(file(id, path) + '?ref=' + encodeURIComponent(ref));
      return Buffer.from(data.content, 'base64').toString('utf8');
    },
    async headSha(id: number) {
      const commit = await api.json<{ id: string }>(project(id) + '/repository/commits/main');
      assert.match(commit.id, /^[a-f0-9]{40}$/);
      return commit.id;
    },
    async openIssue(id: number, title: string, description: string, label?: string) {
      const issue = await api.json<Issue>(project(id) + '/issues', 'POST', { title, description, labels: label ?? '' }, tokens.dev);
      assert.equal(issue.state, 'opened');
      assert.deepEqual(issue.labels, label ? [label] : []);
      return issue.iid;
    },
    getIssue(id: number, iid: number) { return api.json<Issue>(issues(id, iid)); },
    listIssueNotes(id: number, iid: number) { return api.all<Note>(issues(id, iid) + '/notes?order_by=created_at&sort=desc'); },
    async awardThumbsUp(id: number, iid: number, noteId: number, actor: Actor) {
      await api.request(issues(id, iid) + '/notes/' + noteId + '/award_emoji', 'POST', { name: 'thumbsup' }, tokens[actor]);
    },
    async postNote(id: number, iid: number, body: string) {
      await api.request(issues(id, iid) + '/notes', 'POST', { body }, tokens.dev);
    },
    getMr(id: number, iid: number) { return api.json<MR>(mr(id, iid)); },
    mrDiffs(id: number, iid: number) {
      return api.all<{ new_path: string; deleted_file: boolean }>(mr(id, iid) + '/diffs');
    },
    openMr(id: number, branch: string, title: string, botId: number) {
      return api.json<MR>(project(id) + '/merge_requests', 'POST', {
        source_branch: branch, target_branch: 'main', title, assignee_ids: [botId],
      }, tokens.dev);
    },
    listMrNotes(id: number, iid: number) { return api.all<Note>(mr(id, iid) + '/notes'); },
    openDiscussion(id: number, iid: number, body: string, position: InlinePosition) {
      return api.json<Discussion>(mr(id, iid) + '/discussions', 'POST', { body, position }, tokens.sre);
    },
    getDiscussion(id: number, iid: number, discussion: string) {
      return api.json<Discussion>(mr(id, iid) + '/discussions/' + encodeURIComponent(discussion));
    },
    async mergeMergeRequest(id: number, iid: number) {
      const path = mr(id, iid) + '/merge';
      const deadline = Date.now() + 30000;
      for (;;) {
        const res = await api.request(path, 'PUT', { should_remove_source_branch: false }, tokens.sre, [405, 409, 422]);
        if (res.ok) {
          const merged: { state: string; merge_commit_sha: string } = await res.json();
          assert.equal(merged.state, 'merged');
          assert.match(merged.merge_commit_sha, /^[a-f0-9]{40}$/);
          return merged.merge_commit_sha;
        }
        if (Date.now() >= deadline) throw Error('Merge timed out at ' + path + ' (HTTP ' + res.status + ')');
        await delay(500);
      }
    },
    getTag(id: number, tag: string) {
      return api.lookup<{ commit: { id: string } }>(project(id) + '/repository/tags/' + encodeURIComponent(tag));
    },
    getRelease(id: number, tag: string) {
      return api.lookup<{ tag_name: string; commit: { id: string } }>(project(id) + '/releases/' + encodeURIComponent(tag));
    },
    hooks(id: number) {
      return api.all<{ url: string; merge_requests_events: boolean; note_events: boolean }>(project(id) + '/hooks');
    },
    async auditNotes(id: number, check: (body: string, location: string) => void) {
      let count = 0;
      for (const resource of ['issues', 'merge_requests']) {
        const path = project(id) + '/' + resource;
        for (const { iid } of await api.all<{ iid: number }>(path + '?scope=all')) {
          const ref = path + '/' + iid;
          const notes = await api.all<Note>(ref + '/notes');
          const seen = new Set<number>();
          function inspect(note: Note) {
            if (seen.has(note.id)) return;
            check(note.body, ref + ' note ' + note.id);
            seen.add(note.id);
            count++;
          }
          notes.forEach(inspect);
          for (const thread of await api.all<Discussion>(ref + '/discussions')) thread.notes.forEach(inspect);
        }
      }
      return count;
    },
  };
}

export interface E2EGitLabDriver extends ReturnType<typeof projectActions> {
  readonly hubProjectPath: string;
  readonly targetProjects: { web: string; api: string; ansible: string };
  readonly credentials: readonly string[];
  detentPublicUrl(port: number): string;
  ensureUsers(): Promise<{ botId: number; botToken: string }>;
  createPayment(botId: number): Promise<Project>;
  listProjects(): Promise<Project[]>;
  close(): Promise<void>;
}
