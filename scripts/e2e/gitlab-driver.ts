import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

type Actor = 'dev' | 'sre' | 'reporter';
type Issue = { iid: number; state: string; labels: string[] };
type Note = { id: number; body: string };
type DiffRefs = { base_sha: string; start_sha: string; head_sha: string };
type InlinePosition = DiffRefs & { position_type: 'text'; old_path: string; new_path: string; new_line: number };
type MR = { iid: number; state: string; labels: string[]; source_project_id: number; target_project_id: number; sha: string; source_branch: string; assignees: { id: number; username: string }[];
  diff_refs: DiffRefs | null };
type Discussion = { id: string; notes: (Note & { author: { username: string }; type?: string })[] };
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
  const mr = (id: number, iid: number) => project(id) + '/merge_requests/' + iid;
  const file = (id: number, path: string) => project(id) + '/repository/files/' + encodeURIComponent(path);
  async function awardIssueEmoji(id: number, iid: number, noteId: number, actor: Actor, name: 'thumbsup' | 'thumbsdown') {
    await api.request(issues(id, iid) + '/notes/' + noteId + '/award_emoji', 'POST', { name }, tokens[actor]);
  }
  return {
    async ensureLabel(id: number, name: string) {
      const path = project(id) + '/labels';
      const labels = await api.json<{ name: string }[]>(path + '?search=' + encodeURIComponent(name));
      if (!labels.some(label => label.name === name)) await api.request(path, 'POST', { name, color: '#356288' });
    },
    async upsertFile(id: number, path: string, content: string, message: string, branch = 'main', startBranch?: string) {
      const url = file(id, path);
      const existing = await api.lookup(url + '?ref=' + encodeURIComponent(startBranch ?? branch));
      await api.request(url, existing ? 'PUT' : 'POST', { branch, start_branch: startBranch, content, commit_message: message });
    },
    async removeFile(id: number, path: string, message: string) {
      await api.request(file(id, path), 'DELETE', { branch: 'main', commit_message: message });
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
    async openIssue(id: number, opts: { title: string; description: string; labels: string[] }) {
      const issue = await api.json<Issue>(project(id) + '/issues', 'POST', { ...opts, labels: opts.labels.join(',') }, tokens.dev);
      return issue.iid;
    },
    getIssue(id: number, iid: number) { return api.json<Issue>(issues(id, iid)); },
    setIssueState(id: number, iid: number, state_event: 'close' | 'reopen') {
      return api.json<Issue>(issues(id, iid), 'PUT', { state_event }, tokens.dev);
    },
    listIssueNotes(id: number, iid: number) { return api.json<Note[]>(issues(id, iid) + '/notes?per_page=100'); },
    awardIssueEmoji,
    awardThumbsUp(id: number, iid: number, noteId: number, actor: Actor) {
      return awardIssueEmoji(id, iid, noteId, actor, 'thumbsup');
    },
    async postNote(id: number, iid: number, body: string, actor: Actor = 'dev') {
      await api.request(issues(id, iid) + '/notes', 'POST', { body }, tokens[actor]);
    },
    getMr(id: number, iid: number) { return api.json<MR>(mr(id, iid)); },
    openMr(id: number, branch: string, title: string, botId?: number) {
      return api.json<MR>(project(id) + '/merge_requests', 'POST', {
        source_branch: branch, target_branch: 'main', title, assignee_ids: botId ? [botId] : [],
      }, tokens.dev);
    },
    async openExternalMr(id: number, branch: string, title = 'External contribution') {
      await api.request(file(id, 'feature.txt'), 'POST', { branch, start_branch: 'main',
        content: 'External contribution\n', commit_message: 'Add external feature' }, tokens.dev);
      return api.json<MR>(project(id) + '/merge_requests', 'POST', {
        source_branch: branch, target_branch: 'main', title,
      }, tokens.dev);
    },
    async assignMr(id: number, iid: number, userId: number) {
      await api.request(mr(id, iid), 'PUT', { assignee_ids: [userId] }, tokens.dev);
    },
    async unassignMr(id: number, iid: number) {
      await api.request(mr(id, iid), 'PUT', { assignee_ids: [] }, tokens.dev);
    },
    reopenMr(id: number, iid: number) {
      return api.json<MR>(mr(id, iid), 'PUT', { state_event: 'reopen' }, tokens.dev);
    },
    async closeMr(id: number, iid: number) {
      await api.request(mr(id, iid), 'PUT', { state_event: 'close' }, tokens.dev);
    },
    async awardMrThumbsUp(id: number, iid: number, noteId: number, actor: Actor) {
      await api.request(mr(id, iid) + '/notes/' + noteId + '/award_emoji', 'POST', { name: 'thumbsup' }, tokens[actor]);
    },
    listMrNotes(id: number, iid: number) { return api.json<Note[]>(mr(id, iid) + '/notes?per_page=100'); },
    listMrDiscussions(id: number, iid: number) {
      return api.json<Discussion[]>(mr(id, iid) + '/discussions?per_page=100');
    },
    openDiscussion(id: number, iid: number, body: string, position?: InlinePosition, actor: Actor = 'dev') {
      return api.json<Discussion>(mr(id, iid) + '/discussions', 'POST', { body, position }, tokens[actor]);
    },
    getDiscussion(id: number, iid: number, discussion: string) {
      return api.json<Discussion>(mr(id, iid) + '/discussions/' + encodeURIComponent(discussion));
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
  readonly reporterUsername: string;
  readonly podHost: string;
  readonly synthetic?: {
    checkNoteWrites(botId: number, check: (body: string) => void): void;
    failPipeline(project: number, iid: number, botId: number, sha?: string, trace?: string): Promise<number>;
    succeedPipeline(project: number, iid: number, botId: number): Promise<number>;
    openReadonlyForkMr(project: number, botId: number): Promise<MR>;
    pushAttempts(project: number): number;
    failDeployment(project: number): Promise<void>;
  };
  detentPublicUrl(port: number): string;
  ensureUsers(): Promise<void>;
  close(): Promise<void>;
}
