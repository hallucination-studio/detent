import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { gitlabApi, projectActions, type E2EGitLabDriver } from './gitlab-driver.js';

interface User { id: number; username: string }
interface Hook { id: number; url: string; token: string; issues_events: boolean; emoji_events: boolean;
  note_events: boolean; merge_requests_events: boolean; pipeline_events: boolean; deployment_events: boolean; push_events: boolean }
interface MR { iid: number; source_project_id: number; title: string; description: string; web_url: string; source_branch: string;
  target_project_id: number; target_branch: string; state: string; labels: string[]; assignees: User[]; threads: Thread[] }
interface Thread { id: string; notes: MrNote[] }
interface MrNote { id: number; body: string; author: User; discussion_id: string; type: string | null;
  position?: { old_path: string; new_path: string; new_line: number }; resolvable: boolean; resolved: boolean }
interface Pipeline { id: number; project_id: number; ref: string; sha: string; status: string }
interface Project {
  id: number; path_with_namespace: string; http_url_to_repo: string; default_branch: string;
}
interface Issue {
  id: number; iid: number; project_id: number; state: string; title: string; description: string; labels: string[];
}
interface Release {
  tag_name: string; name: string; description: string; commit: { id: string }; _links: { self: string };
}
const absent = () => new Response(null, { status: 404 });
const forbidden = () => new Response(null, { status: 403 });
const reply = (data: unknown) => data === undefined ? absent() : Response.json(data);
const safePart = /^[\w-][\w.-]*$/;
function safePath(path: string) {
  if (path.includes('..') || /[\\\p{Cc}]/u.test(path)) return false;
  return path.split('/').every(part => part && part !== '.' && part.toLowerCase() !== '.git');
}
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'GitLab', GIT_AUTHOR_EMAIL: 'gitlab@localhost', GIT_COMMITTER_NAME: 'GitLab',
  GIT_COMMITTER_EMAIL: 'gitlab@localhost' };

export async function offlineGitLab(root: string, serve: (handle: (req: Request) => Promise<Response>) =>
  Promise<{ baseUrl: string; close(): Promise<void> }>): Promise<E2EGitLabDriver> {
  const users = ['root', 'dev', 'sre', 'reporter'].map((username, i) => ({ id: i + 1, username }));
  const admin = randomUUID();
  const tokens = new Map<string, User>([[admin, users[0]]]);
  const actors = { dev: randomUUID(), sre: randomUUID(), reporter: randomUUID() };
  tokens.set(actors.dev, users[1]);
  tokens.set(actors.sre, users[2]);
  tokens.set(actors.reporter, users[3]);
  const pushes = new Map<number, number>();
  const groups: { id: number; full_path: string }[] = [];
  const projects: Project[] = [];
  const firstProjectId = randomInt(1, 2 ** 31 - 1);
  const members = new Map<string, number>();
  const namespaceMaintainers = new Map<number, Set<number>>();
  const labels = new Map<number, { name: string; color: string }[]>();
  const hooks = new Map<number, Hook[]>();
  const mrs = new Map<number, MR[]>();
  const pipelines: Pipeline[] = [];
  let noteCheck: { botId: number; check: (body: string) => void } | undefined;
  const traces = new Map<number, string>();
  const commitComments = new Map<string, { note: string }[]>();
  let nextNoteId = 1;
  const issues = new Map<number, Issue>();
  const notes = new Map<number, { issueIid: number; body: string; author: User }>();
  const releases = new Map<number, Release[]>();
  const find = (ref: string | number) => projects.find(p => String(p.id) === String(ref) || p.path_with_namespace === ref);
  const repo = (p: Project) => join(root, p.path_with_namespace + '.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const backend = join(git(root, '--exec-path').toString().trim(), 'git-http-backend');

  function register(p: Project) {
    projects.push(p);
    releases.set(p.id, []);
    labels.set(p.id, []);
    hooks.set(p.id, []);
    mrs.set(p.id, []);
    members.set(p.id + '/' + users[3].id, 20);
  }
  function commitSha(p: Project, ref: string) {
    try { return git(repo(p), 'rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}').toString().trim(); }
    catch { return null; }
  }
  function tag(p: Project, name: string) {
    const ref = 'refs/tags/' + name;
    try { git(repo(p), 'check-ref-format', ref); } catch { return; }
    const id = commitSha(p, ref);
    if (!id) return;
    const annotated = git(repo(p), 'cat-file', '-t', ref).toString().trim() === 'tag';
    const message = annotated ? git(repo(p), 'tag', '--list', '--format=%(contents)', '--', name).toString().trimEnd() : null;
    return { name, message, commit: { id } };
  }
  async function commitFile(p: Project, file: string, content: string | Buffer, message: string, branch = p.default_branch, start = branch) {
    assert.ok(safePath(file), 'Expected a relative repository file path');
    const work = await mkdtemp(join(root, 'seed-'));
    try {
      git(root, 'clone', '-c', 'core.symlinks=false', '--', repo(p), work);
      if (start !== p.default_branch) git(work, 'checkout', '--detach', 'refs/remotes/origin/' + start);
      git(work, 'check-ref-format', 'refs/heads/' + branch);
      await mkdir(dirname(join(work, file)), { recursive: true });
      await writeFile(join(work, file), content);
      git(work, '--literal-pathspecs', 'add', '--', file);
      git(work, 'commit', '-m', message);
      git(work, 'push', 'origin', 'HEAD:refs/heads/' + branch);
    } finally { await rm(work, { recursive: true, force: true }); }
  }

  async function dispatch(project: Project, kind: string, enabled: keyof Hook, user: User, attrs: object, extra: object = {}) {
    for (const hook of hooks.get(project.id)!.filter(h => h[enabled])) {
      const response = await fetch(hook.url, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': hook.token,
          'X-Gitlab-Event-UUID': randomUUID() },
        body: JSON.stringify({ object_kind: kind, project, project_id: project.id, user, object_attributes: attrs, ...extra }),
      });
      assert.ok(response.ok, kind + ' webhook HTTP ' + response.status);
    }
  }
  async function note(issue: Issue, actor: User, body: string) {
    const id = nextNoteId++;
    const author = { id: actor.id, username: actor.username };
    notes.set(id, { issueIid: issue.iid, body, author });
    await dispatch(find(issue.project_id)!, 'note', 'note_events', actor, { id, noteable_type: 'Issue', action: 'create', note: body }, { issue });
    return { id, body, author };
  }

  function mrResource(p: Project, { threads, ...mr }: MR) {
    const source = find(mr.source_project_id)!;
    const sha = commitSha(source, 'refs/heads/' + mr.source_branch)!;
    const target = commitSha(p, 'refs/heads/' + mr.target_branch)!;
    const base = git(repo(source), 'merge-base', target, sha).toString().trim();
    let conflicted = false;
    if (base !== target && base !== sha) {
      try { git(repo(source), 'merge-tree', '--write-tree', target, sha); }
      catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
        conflicted = true;
      }
    }
    return { ...mr, sha, diff_refs: { base_sha: base, start_sha: target, head_sha: sha }, draft: false, has_conflicts: conflicted,
      head_pipeline: pipelines.find(pipe => pipe.project_id === p.id && pipe.ref === mr.source_branch && pipe.sha === sha) ?? null };
  }

  async function smartHttp(req: Request, url: URL) {
    const match = /^\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    const p = match && find(match[1]);
    if (!p) return absent();
    const push = match[2] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
    if (push) pushes.set(p.id, (pushes.get(p.id) ?? 0) + 1);
    const auth = req.headers.get('authorization') ?? '';
    const basic = /^Basic (.+)$/i.exec(auth);
    const [login, pat] = Buffer.from(basic?.[1] ?? '', 'base64').toString().split(':');
    if (login !== 'oauth2' || !tokens.has(pat) || pat === admin)
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="GitLab"' } });
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
    const [resource, ref, section, item, sub, child, operation, noteId] = url.pathname.slice(8).split('/').map(decodeURIComponent);
    const get = req.method === 'GET', post = req.method === 'POST', put = req.method === 'PUT';
    const body = get || req.method === 'DELETE' ? {} : await req.json();
    if (actor.id === noteCheck?.botId && ['issues', 'merge_requests'].includes(section) &&
        ['notes', 'discussions'].includes(sub) && typeof body.body === 'string') noteCheck.check(body.body);
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
      if (post && ref && section === 'members') {
        if (credential !== admin || body.access_level !== 40) return forbidden();
        const users = namespaceMaintainers.get(Number(ref)) ?? new Set<number>();
        users.add(body.user_id);
        namespaceMaintainers.set(Number(ref), users);
        return reply({ id: body.user_id, access_level: 40 });
      }
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
      if (credential !== admin && !namespaceMaintainers.get(group.id)?.has(actor.id)) return forbidden();
      const path = group.full_path + '/' + body.path;
      const p = { id: firstProjectId + projects.length, path_with_namespace: path, http_url_to_repo: url.origin + '/' + path + '.git',
        default_branch: body.default_branch ?? 'main' };

      await mkdir(dirname(repo(p)), { recursive: true });
      git(root, 'init', '--bare', '-b', p.default_branch, repo(p));
      git(repo(p), 'config', 'http.receivepack', 'true');
      if (body.initialize_with_readme) await commitFile(p, 'README.md', '# ' + body.name + '\n', 'Initialize repository');
      register(p);
      members.set(p.id + '/' + actor.id, 40);
      return reply(p);
    }
    const p = find(ref);
    if (!p) return absent();
    if (!section && get) return reply({ ...p, empty_repo: !commitSha(p, p.default_branch) });
    if (section === 'members') {
      const key = p.id + '/' + (sub ?? item ?? body.user_id);
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
      if (credential !== admin && (members.get(p.id + '/' + actor.id) ?? 0) < 40) return forbidden();
      const rows = hooks.get(p.id)!;
      if (get) return reply(rows.map(({ token, ...hook }) => hook));
      if (post) rows.push({ ...body, id: rows.length + 1 });
      const hook = post ? rows.at(-1) : rows.find(h => h.id === Number(item));
      if (hook && put) Object.assign(hook, body);
      return reply(hook);
    }
    if (section === 'repository' && (item === 'files' || item === 'tree')) {
      if (child !== undefined || (item === 'files' && !sub)) return absent();
      const path = item === 'files' ? sub : url.searchParams.get('path') ?? '';
      if (path && !safePath(path)) return absent();
      if (get) {
        const sha = commitSha(p, url.searchParams.get('ref') ?? p.default_branch);
        if (!sha) return absent();
        const object = sha + ':' + path;
        let type: string;
        try { type = git(repo(p), 'cat-file', '-t', object).toString().trim(); } catch { return absent(); }
        if (item === 'files') {
          if (type !== 'blob') return absent();
          return reply({ file_path: path, encoding: 'base64', content: git(repo(p), 'cat-file', 'blob', object).toString('base64') });
        }
        if (type !== 'tree') return absent();
        const flags = url.searchParams.get('recursive') === 'true' ? ['-r', '-t', '-z'] : ['-z'];
        const entries = git(repo(p), 'ls-tree', ...flags, object).toString().split('\0').filter(Boolean);
        return reply(entries.map(entry => {
          const tab = entry.indexOf('\t');
          const [, type, id] = entry.slice(0, tab).split(' ');
          const rel = entry.slice(tab + 1);
          return { id, name: posix.basename(rel), type, path: path ? path + '/' + rel : rel };
        }));
      }
      if ((post || put) && item === 'files') {
        const start = body.start_branch ?? body.branch;
        const exists = !!commitSha(p, start) && git(repo(p), 'ls-tree', '--name-only', 'refs/heads/' + start, '--', sub).length > 0;
        if (exists !== put) return new Response(null, { status: exists ? 400 : 404 });
        const content = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : body.content;
        await commitFile(p, sub, content, body.commit_message, body.branch, start);
        return reply({ file_path: sub, branch: body.branch });
      }
    }
    if (section === 'repository' && item === 'commits' && child === 'comments') {
      if (!commitSha(p, sub)) return absent();
      const key = p.id + '/' + sub;
      const comments = commitComments.get(key) ?? [];
      if (get) return reply(comments);
      if (post) {
        const comment = { note: body.note };
        comments.push(comment);
        commitComments.set(key, comments);
        return reply(comment);
      }
    }
    if (section === 'repository' && item === 'commits' && sub && get) {
      const id = commitSha(p, sub);
      return id ? reply({ id, parent_ids: git(repo(p), 'show', '-s', '--format=%P', id).toString().trim().split(' ').filter(Boolean),
        title: git(repo(p), 'show', '-s', '--format=%s', id).toString().trimEnd() }) : absent();
    }
    const projectPipelines = pipelines.filter(pipe => pipe.project_id === p.id);
    const job = (pipeline: Pipeline) => ({ id: pipeline.id + 1000, name: 'verify-ready', status: pipeline.status, pipeline });
    if (section === 'jobs' && get) {
      const pipeline = projectPipelines.find(pipe => job(pipe).id === Number(item));
      if (!pipeline) return absent();
      if (sub === 'trace') return new Response(traces.get(pipeline.id) ?? 'Missing ci/ready.txt: expected ready');
      return sub ? absent() : reply(job(pipeline));
    }
    if (section === 'pipelines' && get) {
      if (sub === 'jobs') {
        const pipeline = projectPipelines.find(pipe => pipe.id === Number(item));
        return pipeline ? reply([job(pipeline)]) : absent();
      }
      const ref = url.searchParams.get('ref');
      if (ref) return reply(projectPipelines.filter(pipe => pipe.ref === ref));
      const sha = url.searchParams.get('sha');
      const matches = projectPipelines.filter(pipe => pipe.sha === sha);
      if (matches.length) return reply(matches);
      return reply(sha && commitSha(p, sha) ? [{ id: 1, ref: p.default_branch, status: 'success' }] : []);
    }
    if (section === 'repository' && item === 'tags' && get) {
      if (sub) return reply(tag(p, sub));
      const names = git(repo(p), 'tag', '--list').toString().split('\n').filter(Boolean);
      const search = url.searchParams.get('search') ?? '';
      const needle = search.replace(/^\^|\$$/g, '');
      return reply(names.filter(name => {
        if (search.startsWith('^') && !name.startsWith(needle)) return false;
        if (search.endsWith('$') && !name.endsWith(needle)) return false;
        if (search.startsWith('^') && search.endsWith('$')) return name === needle;
        return name.includes(needle);
      }).map(name => tag(p, name)));
    }
    if (post && ((section === 'repository' && item === 'tags') || section === 'releases')) {
      const name: string = body.tag_name;
      const rows = releases.get(p.id)!;
      let existing = tag(p, name);
      if ((section === 'repository' && existing) || (section === 'releases' && rows.some(r => r.tag_name === name)))
        return new Response(null, { status: 409 });
      if (!existing) {
        const sha = commitSha(p, body.ref ?? p.default_branch);
        if (!sha) return absent();
        git(repo(p), 'tag', ...(body.message ? ['-m', body.message] : []), '--', name, sha);
        existing = tag(p, name)!;
      }
      if (section === 'repository') return reply(existing);
      const release = { tag_name: name, name: body.name, description: body.description, commit: existing.commit,
        _links: { self: url.origin + '/' + p.path_with_namespace + '/-/releases/' + encodeURIComponent(name) } };
      rows.push(release);
      return reply(release);
    }
    if (section === 'repository' && item === 'archive.zip' && get) {
      if (['cors', 'no-cors', 'websocket'].includes(req.headers.get('sec-fetch-mode') ?? ''))
        return new Response(JSON.stringify({ message: '406 Not Acceptable' }), { status: 406 });
      const sha = url.searchParams.get('sha')!;
      assert.match(sha, /^[a-f0-9]{40}$/);
      const prefix = p.path_with_namespace.split('/').pop() + '-' + sha + '/';
      return new Response(new Uint8Array(git(repo(p), 'archive', '--format=zip', '--prefix=' + prefix, sha)), {
        headers: { 'Content-Type': 'application/zip' },
      });
    }
    if (section === 'releases' && get) return reply(releases.get(p.id)!.find(r => r.tag_name === item));
    if (section === 'issues') {
      if (get && !item) return reply([...issues.values()].filter(i => i.project_id === p.id &&
        i.title.includes(url.searchParams.get('search') ?? '')));
      if (post && !item) {
        const iid = issues.size + 1;
        const issue = { id: iid, iid, project_id: p.id, state: 'opened', title: body.title, description: body.description,
          labels: (body.labels ?? '').split(',').filter(Boolean) };
        issues.set(iid, issue);
        await dispatch(p, 'issue', 'issues_events', actor, { ...issue, action: 'open' });
        return reply(issue);
      }
      const issue = issues.get(Number(item));
      if (!issue || p.id !== issue.project_id) return absent();
      if (!sub && req.method === 'DELETE' && credential === admin) {
        issues.delete(issue.iid);
        for (const [id, note] of notes) if (note.issueIid === issue.iid) notes.delete(id);
        return new Response(null, { status: 204 });
      }
      if (!sub && put) {
        if (['close', 'reopen'].includes(body.state_event)) {
          issue.state = body.state_event === 'close' ? 'closed' : 'opened';
          await dispatch(p, 'issue', 'issues_events', actor, { ...issue, action: body.state_event });
        }
        const remove = (body.remove_labels ?? '').split(',');
        const add = (body.add_labels ?? '').split(',').filter(Boolean);
        issue.labels = [...new Set([...issue.labels.filter(l => !remove.includes(l)), ...add])];
      }
      if (!sub) return reply(issue);
      if (sub === 'notes' && post && !child) return reply(await note(issue, actor, body.body));
      if (sub === 'notes' && get && !child) {
        const issueNotes = [...notes].filter(([, n]) => n.issueIid === issue.iid);
        if (url.searchParams.get('sort') !== 'asc') issueNotes.reverse();
        const perPage = Number(url.searchParams.get('per_page') ?? 20);
        return reply(issueNotes.slice(0, perPage).map(([id, { body, author }]) => ({ id, body, author })));
      }
      const saved = notes.get(Number(child));
      if (sub === 'notes' && post && operation === 'award_emoji' && saved?.issueIid === issue.iid) {
        await dispatch(p, 'emoji', 'emoji_events', actor,
          { name: body.name, awardable_type: 'Note', awardable_id: Number(child), action: 'award' }, { issue });
        return reply({ name: body.name });
      }
      if (sub === 'notes' && put && saved?.issueIid === issue.iid) {
        saved.body = body.body;
        return reply({ id: Number(child), body: saved.body, author: saved.author });
      }
    }
    if (section === 'merge_requests') {
      const rows = mrs.get(p.id)!;
      if (!item && get) {
        const filters = ['source_branch', 'target_branch', 'state'] as const;
        const matches = rows.filter(m => filters.every(key => !url.searchParams.has(key) || m[key] === url.searchParams.get(key)));
        return reply(matches.map(m => mrResource(p, m)));
      }
      const assignees = () => users.filter(u => body.assignee_ids?.includes(u.id));
      if (!item && post) {
        const target = find(body.target_project_id ?? p.id)!;
        const targetMrs = mrs.get(target.id)!;
        const mr: MR = { iid: targetMrs.length + 1, title: body.title, description: body.description ?? '', source_project_id: p.id, target_project_id: target.id,
          source_branch: body.source_branch, target_branch: body.target_branch, state: 'opened', labels: (body.labels ?? '').split(',').filter(Boolean), assignees: assignees(), threads: [],
          web_url: url.origin + '/' + target.path_with_namespace + '/-/merge_requests/' + (targetMrs.length + 1) };
        const resource = mrResource(target, mr);
        targetMrs.push(mr);
        await dispatch(target, 'merge_request', 'merge_requests_events', actor, { ...resource, action: 'open' }, { assignees: mr.assignees });
        return reply(resource);
      }
      const iid = Number(item);
      const mr = rows.find(m => m.iid === iid);
      if (!mr) return absent();
      if (!sub && req.method === 'DELETE' && credential === admin) {
        rows.splice(rows.indexOf(mr), 1);
        return new Response(null, { status: 204 });
      }
      const resource = mrResource(p, mr);
      if (!sub && get) return reply(resource);
      if (!sub && put && ['close', 'reopen'].includes(body.state_event)) {
        mr.state = body.state_event === 'close' ? 'closed' : 'opened';
        const closed = mrResource(p, mr);
        await dispatch(p, 'merge_request', 'merge_requests_events', actor, { ...closed, action: body.state_event });
        return reply(closed);
      }
      if (!sub && put && ('title' in body || 'labels' in body || 'add_labels' in body || 'remove_labels' in body)) {
        mr.title = body.title ?? mr.title;
        const current: string[] = typeof body.labels === 'string' ? body.labels.split(',') : mr.labels;
        mr.labels = [...new Set([...current, ...(body.add_labels ?? '').split(',')].filter(l => l && !(body.remove_labels ?? '').split(',').includes(l)))];
        return reply(mrResource(p, mr));
      }
      if (!sub && put && Array.isArray(body.assignee_ids)) {
        const previous = mr.assignees;
        mr.assignees = assignees();
        const updated = mrResource(p, mr);
        await dispatch(p, 'merge_request', 'merge_requests_events', actor, { ...updated, action: 'update' },
          { assignees: mr.assignees, changes: { assignees: { previous, current: mr.assignees } } });
        return reply(updated);
      }
      if (put && sub === 'merge') {
        const bare = repo(p);
        const target = git(bare, 'rev-parse', mr.target_branch).toString().trim();
        git(bare, 'merge-base', '--is-ancestor', target, mr.source_branch);
        // The target is an ancestor, so the reviewed source tree is the exact merge result.
        const sha = git(bare, 'commit-tree', mr.source_branch + '^{tree}', '-p', target, '-p', mr.source_branch,
          '-m', 'Merge !' + iid).toString().trim();
        git(bare, 'update-ref', 'refs/heads/' + mr.target_branch, sha, target);
        mr.state = 'merged';
        await dispatch(p, 'merge_request', 'merge_requests_events', actor, { ...resource, state: mr.state, action: 'merge', merge_commit_sha: sha });
        return reply({ ...resource, state: mr.state, merge_commit_sha: sha });
      }
      if (get && sub === 'pipelines') return reply(projectPipelines.filter(pipe => pipe.ref === mr.source_branch));
      if (get && sub === 'commits') {
        const range = resource.diff_refs.base_sha + '..' + resource.sha;
        return reply(git(repo(find(mr.source_project_id)!), 'rev-list', range).toString().trim().split('\n').filter(Boolean).map(id => ({ id })));
      }
      if (get && sub === 'diffs') {
        const { base_sha, head_sha } = resource.diff_refs;
        const diff = (...args: string[]) => git(repo(find(mr.source_project_id)!), 'diff', '--no-renames', ...args).toString();
        const files = diff('--name-only', '-z', base_sha, head_sha).split('\0').filter(Boolean);
        return reply(files.map(path => ({ old_path: path, new_path: path, diff: diff(base_sha, head_sha, '--', path) })));
      }
      if (sub === 'notes' || sub === 'discussions') {
        const inThread = sub === 'discussions';
        const allNotes = mr.threads.flatMap(thread => thread.notes);
        let thread = inThread ? mr.threads.find(t => t.id === child) : undefined;
        if (inThread && child && !thread) return absent();
        const saved = inThread ? thread?.notes.find(n => n.id === Number(noteId)) : allNotes.find(n => n.id === Number(child));
        if (get) {
          if (!child) return reply(inThread ? mr.threads : allNotes);
          if (thread && !operation) return reply(thread);
          if (thread && operation === 'notes' && !noteId) return reply(thread.notes);
          return reply(saved);
        }
        if (post && !inThread && saved && operation === 'award_emoji') {
          await dispatch(p, 'emoji', 'emoji_events', actor,
            { name: body.name, awardable_type: 'Note', awardable_id: saved.id, action: 'award' },
            { merge_request: resource, note: { noteable_type: 'MergeRequest', noteable_iid: iid, discussion_id: saved.discussion_id } });
          return reply({ name: body.name });
        }
        const emitNote = (n: MrNote, action: string) => dispatch(p, 'note', 'note_events', actor,
          { ...n, note: n.body, action, noteable_type: 'MergeRequest' }, { merge_request: resource });
        if (put && thread && !operation && typeof body.resolved === 'boolean') {
          for (const n of thread.notes) if (n.resolvable) n.resolved = body.resolved;
          return reply(thread);
        }
        if (put && saved) {
          saved.body = body.body;
          await emitNote(saved, 'update');
          return reply(saved);
        }
        if (post && (!child || (inThread && operation === 'notes' && !noteId))) {
          if (!thread) { thread = { id: randomUUID(), notes: [] }; mr.threads.push(thread); }
          const n = { id: nextNoteId++, author: actor, body: body.body, discussion_id: thread.id, position: body.position,
            type: body.position ? 'DiffNote' : inThread ? 'DiscussionNote' : null, resolvable: !!body.position, resolved: false };
          thread.notes.push(n);
          await emitNote(n, 'create');
          return reply(inThread && !child ? thread : n);
        }
      }
    }
    return absent();
  }

  const server = await serve(handle);
  const baseUrl = server.baseUrl;
  const api = gitlabApi(baseUrl, admin);
  async function pipelineEvent(id: number, iid: number, botId: number, status: string, sha?: string, trace?: string) {
    const p = find(id)!;
    const mr = mrResource(p, mrs.get(id)!.find(m => m.iid === iid)!);
    const pipeline = { id: pipelines.length + 1, project_id: id, ref: mr.source_branch, sha: sha ?? mr.sha, status };
    if (trace) traces.set(pipeline.id, trace);
    pipelines.unshift(pipeline);
    const bot = users.find(u => u.id === botId);
    assert.ok(bot, 'Expected the provisioned bot as the pipeline actor');
    await dispatch(p, 'pipeline', 'pipeline_events', bot, pipeline, { merge_request: mr });
    return pipeline.id;
  }
  return {
    ...projectActions(api, actors), baseUrl, adminToken: admin,
    hubProjectPath: 'ai/workspace-hub', targetProjects: { web: 'apps/web', api: 'apps/api', ansible: 'ops/ansible-infra' },
    devUsername: 'dev', sreUsername: 'sre', reporterUsername: 'reporter', podHost: '127.0.0.1',
    detentPublicUrl: port => 'http://127.0.0.1:' + port,
    synthetic: {
      checkNoteWrites(botId, check) { noteCheck = { botId, check }; },
      failPipeline: (id, iid, bot, sha, trace) => pipelineEvent(id, iid, bot, 'failed', sha, trace),
      succeedPipeline: (id, iid, bot) => pipelineEvent(id, iid, bot, 'success'),
      pushAttempts: id => pushes.get(id) ?? 0,
      async openReadonlyForkMr(id, botId) {
        const target = find(id)!;
        const path = target.path_with_namespace + '-fork';
        const fork = { ...target, id: firstProjectId + projects.length, path_with_namespace: path,
          http_url_to_repo: baseUrl + '/' + path + '.git' };
        git(root, 'clone', '--bare', repo(target), repo(fork));
        git(repo(fork), 'config', 'http.receivepack', 'true');
        register(fork);
        members.set(fork.id + '/' + botId, 20);
        members.set(fork.id + '/' + users[1].id, 30);
        await commitFile(fork, 'config.ini', 'timeout=0\n', 'Disable timeout', 'fork-timeout', 'main');
        return api.json<Awaited<ReturnType<E2EGitLabDriver['getMr']>>>('/projects/' + fork.id + '/merge_requests', 'POST', {
          source_branch: 'fork-timeout', target_branch: 'main', target_project_id: id, title: 'Review the fork timeout', assignee_ids: [botId],
        }, actors.dev);
      },
      async failDeployment(id) {
        const p = find(id)!;
        await dispatch(p, 'deployment', 'deployment_events', users[2], {}, {
          status: 'failed', ref: p.default_branch, environment: 'staging', sha: commitSha(p, p.default_branch),
        });
      },
    },
    async ensureUsers() {}, close: server.close,
  };
}
