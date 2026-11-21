import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gitlabApi, projectActions, type E2EGitLabDriver } from './gitlab-driver.js';

export function liveGitLab(url: string): E2EGitLabDriver {
  const adminToken = process.env.E2E_GITLAB_ADMIN_TOKEN;
  assert.ok(adminToken, 'Live GitLab requires E2E_GITLAB_ADMIN_TOKEN');
  const baseUrl = url.replace(/\/$/, '');
  const api = gitlabApi(baseUrl, adminToken);
  const namespace = 'e2e-' + randomUUID().slice(0, 8);
  const tokens = { dev: '', sre: '' };
  const patIds: number[] = [];
  let group: { id: number } | undefined;
  return {
    ...projectActions(api, tokens), baseUrl, adminToken,
    hubProjectPath: namespace + '/workspace-hub',
    targetProjects: { web: namespace + '/web', api: namespace + '/api', ansible: namespace + '/ansible-infra' },
    devUsername: 'e2e-dev', sreUsername: 'e2e-sre', podHost: '0.0.0.0',
    detentPublicUrl: port => process.env.E2E_DETENT_PUBLIC_URL?.replace(/\/$/, '') ?? 'http://host.docker.internal:' + port,
    async ensureUsers() {
      group ??= await api.json<{ id: number }>('/groups', 'POST', { name: namespace, path: namespace });
      for (const actor of ['dev', 'sre'] as const) {
        if (tokens[actor]) continue;
        const username = 'e2e-' + actor;
        const users = await api.json<{ id: number }[]>('/users?username=' + username);
        const user = users[0] ?? await api.json<{ id: number }>('/users', 'POST', {
          username, name: username, email: username + '@detent.local', force_random_password: true, skip_confirmation: true,
        });
        // The maintainer merges to protected main in all three targets.
        if (actor === 'sre') await api.request('/groups/' + group.id + '/members', 'POST', { user_id: user.id, access_level: 40 });
        const pat = await api.json<{ id: number; token: string }>('/users/' + user.id + '/personal_access_tokens', 'POST', {
          name: namespace, scopes: ['api'], expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        });
        tokens[actor] = pat.token;
        patIds.push(pat.id);
      }
    },
    async close() {
      await Promise.all(patIds.map(id => api.request('/personal_access_tokens/' + id, 'DELETE')));
    },
  };
}
