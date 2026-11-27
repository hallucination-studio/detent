import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gitlabApi, projectActions, type E2EGitLabDriver } from './gitlab-driver.js';

const run = promisify(execFile);

export function liveGitLab(baseUrl: string, adminToken: string): E2EGitLabDriver {
  const api = gitlabApi(baseUrl.replace(/\/$/, ''), adminToken);
  const namespace = 'e2e-' + randomUUID();
  const tokens = { dev: '', sre: '', reporter: '' };
  const pats = new Map<number, string>();
  let group: { id: number } | undefined;
  let started = false;
  let botCredentials: { botId: number; botToken: string } | undefined;

  async function identity(username: string) {
    const path = '/users?username=' + encodeURIComponent(username);
    const found = (await api.json<{ id: number }[]>(path))[0];
    if (found) return found;
    // Another isolated run can have created this shared identity after our lookup.
    const res = await api.request('/users', 'POST', {
      username, name: username, email: username + '@detent.local', force_random_password: true, skip_confirmation: true,
    }, adminToken, [409]);
    if (res.ok) return await res.json() as { id: number };
    const winner = (await api.json<{ id: number }[]>(path))[0];
    assert.ok(winner, 'Could not provision ' + username);
    return winner;
  }

  async function createPat(userId: number) {
    const pat = await api.json<{ id: number; token: string }>('/users/' + userId + '/personal_access_tokens', 'POST', {
      name: namespace, scopes: ['api', 'read_repository', 'write_repository'],
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    });
    pats.set(pat.id, pat.token);
    return pat.token;
  }

  async function deleteGroup(id: number) {
    const path = '/groups/' + id;
    await api.request(path, 'DELETE', undefined, adminToken, [404]);
    // GitLab CE 18.3's REST API only schedules top-level groups for deletion.
    // Complete the scheduled deletion in the same Compose stack and verify
    // both the ID and the run-specific namespace before invoking GitLab's service.
    const compose = fileURLToPath(new URL('./docker-compose.e2e.yml', import.meta.url));
    await run('docker', ['compose', '-f', compose, '-p', 'detent-e2e', 'exec', '-T', 'gitlab', 'gitlab-rails', 'runner',
      'g = Group.find_by(id: ARGV[0]); exit unless g; ' +
      'abort "unexpected group" unless g.parent_id.nil? && g.self_deletion_scheduled? && ' +
      '(g.full_path == ARGV[1] || g.full_path.start_with?(ARGV[1] + "-")); ' +
      'Groups::DestroyService.new(g, g.deletion_schedule.deleting_user).execute; ' +
      'abort "group retained" if Group.exists?(ARGV[0])',
      String(id), namespace], { timeout: 180000 });
    assert.equal(await api.lookup(path), null, 'GitLab retained the run group after deletion');
  }

  return {
    ...projectActions(api, tokens),
    groupPath: namespace,
    hubProjectPath: namespace + '/workspace-hub',
    targetProjects: { web: namespace + '/web', api: namespace + '/api', ansible: namespace + '/ansible-infra', helm: namespace + '/helm-charts' },
    get credentials() { return [...pats.values()]; },
    detentPublicUrl: port => (process.env.E2E_DETENT_PUBLIC_URL || 'http://host.docker.internal:' + port)
      .replace(/\/+$/, '').replace(/\/webhooks\/gitlab$/, ''),
    async ensureUsers() {
      started = true;
      group ??= await api.lookup<{ id: number }>('/groups/' + namespace) ??
        await api.json<{ id: number }>('/groups', 'POST', { name: namespace, path: namespace, visibility: 'private' });
      const roles = { dev: 30, sre: 40, reporter: 20 } as const;
      for (const actor of ['dev', 'sre', 'reporter'] as const) {
        if (tokens[actor]) continue;
        const user = await identity('e2e-' + actor);
        const members = '/groups/' + group.id + '/members';
        const member: { access_level: number } = await api.lookup<{ access_level: number }>(members + '/' + user.id) ??
          await api.json(members, 'POST', { user_id: user.id, access_level: roles[actor] });
        assert.equal(member.access_level, roles[actor]);
        tokens[actor] = await createPat(user.id);
      }
      if (!botCredentials) {
        const bot = await identity('detent-bot');
        const members = '/groups/' + group.id + '/members';
        const member = await api.lookup<{ access_level: number }>(members + '/' + bot.id) ??
          await api.json<{ access_level: number }>(members, 'POST', { user_id: bot.id, access_level: 40 });
        assert.equal(member.access_level, 40);
        // Track the token even when bootstrap fails before writing --env-out.
        botCredentials = { botId: bot.id, botToken: await createPat(bot.id) };
      }
      return botCredentials;
    },
    async createPayment(botId) {
      assert.ok(group);
      const project = await api.json<{ id: number; path_with_namespace: string }>('/projects', 'POST', {
        namespace_id: group.id, name: 'payment', path: 'payment', initialize_with_readme: true, default_branch: 'main',
      });
      const members = '/projects/' + project.id + '/members';
      const member = await api.lookup<{ access_level: number }>(members + '/all/' + botId) ??
        await api.json<{ access_level: number }>(members, 'POST', { user_id: botId, access_level: 40 });
      assert.equal(member.access_level, 40);
      return project;
    },
    async listProjects() {
      if (!group) return [];
      return api.all<{ id: number; path_with_namespace: string }>('/groups/' + group.id + '/projects?with_shared=false');
    },
    async close() {
      if (!started) return;
      const errors: unknown[] = [];
      // A timed-out POST may already have committed. Recover only resources
      // bearing this run's UUID before revoking credentials and removing the group.
      const ids = new Set(pats.keys());
      try {
        const active = await api.all<{ id: number; name: string }>('/personal_access_tokens?state=active&search=' + namespace);
        for (const pat of active) if (pat.name === namespace) ids.add(pat.id);
      } catch (error) { errors.push(error); }
      for (const id of ids) {
        try {
          await api.request('/personal_access_tokens/' + id, 'DELETE', undefined, adminToken, [404]);
          pats.delete(id);
        } catch (error) { errors.push(error); }
      }
      try {
        const created = group ?? await api.lookup<{ id: number }>('/groups/' + namespace);
        if (created) await deleteGroup(created.id);
        group = undefined;
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'GitLab cleanup failed');
    },
  };
}
