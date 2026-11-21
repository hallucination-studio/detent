import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface User { id: number; username: string }
interface Hook { id: number; url: string; token: string; issues_events: boolean; emoji_events: boolean;
  note_events: boolean; merge_requests_events: boolean; pipeline_events: boolean; push_events: boolean }
interface MR { iid: number; source_project_id: number; title: string; web_url: string; source_branch: string;
  target_branch: string; state: string }
interface Project {
  id: number; path_with_namespace: string; http_url_to_repo: string; default_branch: string;
}
const absent = () => new Response(null, { status: 404 });
const forbidden = () => new Response(null, { status: 403 });
const reply = (data: unknown) => data === undefined ? absent() : Response.json(data);
const safePart = /^[\w-][\w.-]*$/;
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'GitLab', GIT_AUTHOR_EMAIL: 'gitlab@localhost', GIT_COMMITTER_NAME: 'GitLab',
  GIT_COMMITTER_EMAIL: 'gitlab@localhost' };

export function offlineGitLab(root: string) {
  const users = ['root', 'dev', 'sre'].map((username, i) => ({ id: i + 1, username }));
  const admin = randomUUID();
  const tokens = new Map<string, User>([[admin, users[0]]]);
  const groups: { id: number; full_path: string }[] = [];
  const projects: Project[] = [];
  const firstProjectId = randomInt(1, 2 ** 31 - 1);
  const members = new Map<string, number>();
  const membershipChecks: string[] = [];
  const labels = new Map<number, { name: string; color: string }[]>();
  const hooks = new Map<number, Hook[]>();
  const mrs = new Map<number, MR[]>();
  const notes = new Map<number, string>();
  const issue = { id: 1, iid: 1, project_id: 0, title: 'Reload nginx on web01', state: 'opened',
    description: 'Prepare and verify a reviewed nginx reload.', labels: ['delivery::env-change'] };
  const find = (ref: string | number) => projects.find(p => String(p.id) === String(ref) || p.path_with_namespace === ref);
  const repo = (p: Project) => join(root, p.path_with_namespace + '.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const backend = join(git(root, '--exec-path').toString().trim(), 'git-http-backend');

  async function commitFile(p: Project, file: string, content: string, message: string) {
    const work = await mkdtemp(join(root, 'seed-'));
    try {
      git(root, 'clone', '--', repo(p), work);
      await writeFile(join(work, file), content);
      git(work, 'add', '--', file);
      git(work, 'commit', '-m', message);
      git(work, 'push', 'origin', 'HEAD:refs/heads/' + p.default_branch);
    } finally { await rm(work, { recursive: true, force: true }); }
  }

  async function dispatch(project: Project, kind: string, enabled: keyof Hook, user: User, attrs: object) {
    for (const hook of hooks.get(project.id)!.filter(h => h[enabled])) {
      const response = await fetch(hook.url, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': hook.token,
          'X-Gitlab-Event-UUID': randomUUID() },
        body: JSON.stringify({ object_kind: kind, project, project_id: project.id, user, issue, object_attributes: attrs }),
      });
      assert.ok(response.ok, kind + ' webhook HTTP ' + response.status);
    }
  }
  async function note(project: Project, actor: User, body: string) {
    const id = notes.size + 1;
    notes.set(id, body);
    await dispatch(project, 'note', 'note_events', actor, { id, noteable_type: 'Issue', action: 'create', note: body });
    return { id, body };
  }

  async function smartHttp(req: Request, url: URL) {
    const match = /^\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    const p = match && find(match[1]);
    if (!p) return absent();
    const auth = req.headers.get('authorization') ?? '';
    const basic = /^Basic (.+)$/i.exec(auth);
    const [login, pat] = Buffer.from(basic?.[1] ?? '', 'base64').toString().split(':');
    if (login !== 'oauth2' || !tokens.has(pat) || pat === admin)
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="GitLab"' } });
    const push = match[2] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
    if ((members.get(p.id + '/' + tokens.get(pat)!.id) ?? 0) < (push ? 30 : 20)) return forbidden();
    const input = Buffer.from(await req.arrayBuffer());
    const bytes = execFileSync(backend, [], { input, env: { ...gitEnv, GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: login, PATH_INFO: url.pathname, REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(input.length), HTTP_GIT_PROTOCOL: req.headers.get('git-protocol') ?? '',
      HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
    } });
    const split = bytes.indexOf('\r\n\r\n');
    assert.ok(split >= 0, 'Invalid CGI response');
    const headers = new Headers();
    let status = 200;
    for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
      const sep = line.indexOf(':');
      const key = line.slice(0, sep), value = line.slice(sep + 1).trim();
      if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
      else headers.append(key, value);
    }
    return new Response(bytes.subarray(split + 4), { status, headers });
  }

  async function handle(req: Request) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/v4/')) return smartHttp(req, url);
    const credential = req.headers.get('private-token') ?? '';
    const actor = tokens.get(credential);
    if (!actor) return new Response(null, { status: 401 });
    const [resource, ref, section, item, sub, child] = url.pathname.slice(8).split('/').map(decodeURIComponent);
    const get = req.method === 'GET', post = req.method === 'POST', put = req.method === 'PUT';
    const body = get ? {} : await req.json();
    if (get && resource === 'user') return reply(actor);
    if (resource === 'users') {
      if (get && !ref) {
        const name = url.searchParams.get('username');
        return reply(name ? users.filter(u => u.username === name) : users);
      }
      if (credential !== admin) return forbidden();
      if (post && !ref) {
        const user = { id: users.length + 1, username: body.username };
        users.push(user);
        return reply(user);
      }
      if (post && section === 'personal_access_tokens') {
        const user = users.find(u => u.id === Number(ref));
        if (!user) return absent();
        assert.deepEqual(body.scopes, ['api', 'read_repository', 'write_repository']);
        assert.match(String(body.expires_at ?? ''), /^\d{4}-\d{2}-\d{2}$/);
        const token = 'glpat-' + randomUUID();
        tokens.set(token, user);
        return reply({ token });
      }
    }
    if (resource === 'namespaces' && get) {
      return reply(ref ? groups.find(g => g.full_path === ref) : groups);
    }
    if (resource === 'groups') {
      if (get) return reply(ref ? groups.find(g => g.full_path === ref) : groups);
      if (post) {
        assert.match(body.path, safePart);
        const parent = groups.find(g => g.id === body.parent_id);
        const group = { id: groups.length + 1, full_path: (parent ? parent.full_path + '/' : '') + body.path };
        groups.push(group);
        return reply(group);
      }
    }
    if (resource !== 'projects') return absent();
    if (!ref && get) return reply(projects.filter(p => p.path_with_namespace.includes(url.searchParams.get('search') ?? '')));
    if (!ref && post) {
      assert.match(body.path, safePart);
      const group = groups.find(g => g.id === body.namespace_id)!;
      const path = group.full_path + '/' + body.path;
      const p = { id: firstProjectId + projects.length, path_with_namespace: path, http_url_to_repo: url.origin + '/' + path + '.git',
        default_branch: body.default_branch };
      assert.equal(body.initialize_with_readme, true);
      await mkdir(dirname(repo(p)), { recursive: true });
      git(root, 'init', '--bare', '-b', p.default_branch, repo(p));
      git(repo(p), 'config', 'http.receivepack', 'true');
      await commitFile(p, 'README.md', '# ' + body.name + '\n', 'Initialize repository');
      projects.push(p);
      labels.set(p.id, []); hooks.set(p.id, []); mrs.set(p.id, []);
      return reply(p);
    }
    const p = find(ref);
    if (!p) return absent();
    if (!section && get) return reply(p);
    if (section === 'members') {
      const key = p.id + '/' + (sub ?? item ?? body.user_id);
      if (item === 'all') membershipChecks.push(key);
      if (post || put) members.set(key, body.access_level);
      const member = (id: number) => ({ id, access_level: members.get(p.id + '/' + id) });
      if (get && !item) return reply(users.map(u => member(u.id)).filter(u => u.access_level));
      return members.has(key) ? reply(member(Number(key.split('/')[1]))) : absent();
    }
    if (section === 'labels') {
      const rows = labels.get(p.id)!;
      if (post) rows.push(body);
      return reply(get ? rows : body);
    }
    if (section === 'hooks') {
      const rows = hooks.get(p.id)!;
      if (get) return reply(rows.map(({ token, ...hook }) => hook));
      if (post) rows.push({ ...body, id: rows.length + 1 });
      const hook = post ? rows.at(-1) : rows.find(h => h.id === Number(item));
      if (hook && put) Object.assign(hook, body);
      return reply(hook);
    }
    if (section === 'repository' && item === 'files' && safePart.test(sub)) {
      if (get) {
        const ref = url.searchParams.get('ref');
        if (!git(repo(p), 'ls-tree', '--name-only', ref!, '--', sub).length) return absent();
        return reply({ file_path: sub, encoding: 'base64', content: git(repo(p), 'show', ref + ':' + sub).toString('base64') });
      }
      if (post) {
        assert.equal(body.branch, p.default_branch);
        await commitFile(p, sub, body.content, body.commit_message);
        return reply({ file_path: sub, branch: body.branch });
      }
    }
    if (section === 'repository' && item === 'archive.zip' && get) {
      const sha = url.searchParams.get('sha')!;
      assert.match(sha, /^[a-f0-9]{40}$/);
      const prefix = p.path_with_namespace.split('/').pop() + '-' + sha + '/';
      return new Response(new Uint8Array(git(repo(p), 'archive', '--format=zip', '--prefix=' + prefix, sha)), {
        headers: { 'Content-Type': 'application/zip' },
      });
    }
    if (section === 'issues' && p.id === issue.project_id && Number(item) === issue.iid) {
      if (!sub && put) {
        const remove = body.remove_labels.split(',');
        issue.labels = [...new Set([...issue.labels.filter(l => !remove.includes(l)), body.add_labels])];
      }
      if (!sub) return reply(issue);
      if (sub === 'notes' && post) return reply(await note(p, actor, body.body));
      if (sub === 'notes' && put && notes.has(Number(child))) {
        notes.set(Number(child), body.body);
        return reply({ id: Number(child), body: body.body });
      }
    }
    if (section === 'merge_requests') {
      const rows = mrs.get(p.id)!;
      if (get && sub === 'pipelines') return reply([]);
      if (get && !item) return reply(rows);
      if (post && !item) {
        git(repo(p), 'rev-parse', '--verify', 'refs/heads/' + body.source_branch);
        const iid = rows.length + 1;
        const mr = { ...body, iid, source_project_id: p.id, state: 'opened',
          web_url: url.origin + '/' + p.path_with_namespace + '/-/merge_requests/' + iid };
        rows.push(mr);
        return reply(mr);
      }
    }
    return absent();
  }

  return { handle, admin, notes, membershipChecks,
    async openIssue(hub: number) {
      issue.project_id = hub;
      await dispatch(find(hub)!, 'issue', 'issues_events', users[1], { ...issue, action: 'open' });
    },
    async awardEmoji(noteId: number, username: string) {
      assert.ok(notes.has(noteId));
      await dispatch(find(issue.project_id)!, 'emoji', 'emoji_events', users.find(u => u.username === username)!,
        { name: 'thumbsup', awardable_type: 'Note', awardable_id: noteId, action: 'award' });
    },
    postNote(body: string) { return note(find(issue.project_id)!, users[1], body); },
    async mergeMergeRequest(project: number, iid: number) {
      const p = find(project)!;
      const mr = mrs.get(p.id)!.find(m => m.iid === iid)!;
      const bare = repo(p);
      const target = git(bare, 'rev-parse', mr.target_branch).toString().trim();
      git(bare, 'merge-base', '--is-ancestor', target, mr.source_branch);
      // The target is an ancestor, so the reviewed source tree is the exact merge result.
      const sha = git(bare, 'commit-tree', mr.source_branch + '^{tree}', '-p', target, '-p', mr.source_branch,
        '-m', 'Merge !' + iid).toString().trim();
      git(bare, 'update-ref', 'refs/heads/' + mr.target_branch, sha, target);
      mr.state = 'merged';
      await dispatch(p, 'merge_request', 'merge_requests_events', users[2], { ...mr, action: 'merge', merge_commit_sha: sha });
      return sha;
    },
  };
}
