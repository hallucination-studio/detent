import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';

export function offlineJumpServer() {
  const readonly = randomUUID(), job = randomUUID();
  const inspections: string[] = [], executions: string[] = [], uploads: string[] = [];
  let definition: string | undefined;
  const tasks = new Map<string, string>();
  const forbidden = () => new Response(null, { status: 403 });
  function execute(role: string) {
    const id = randomUUID();
    tasks.set(id, role);
    (role === job ? executions : inspections).push(id);
    return Response.json({ task_id: id });
  }
  const roles = new Map([['Bearer ' + readonly, readonly], ['Bearer ' + job, job]]);
  async function handle(req: Request) {
    const path = new URL(req.url).pathname;
    const role = roles.get(req.headers.get('authorization') ?? '');
    if (!role) return new Response(null, { status: 401 });
    if (req.method === 'GET' && path === '/api/v1/perms/users/self/assets/')
      return role !== readonly ? forbidden() : Response.json([{ id: 'web01', name: 'web01', address: '127.0.0.1' }]);
    if (req.method === 'POST' && path === '/api/v1/ops/playbooks/') {
      if (role !== job) return forbidden();
      const form = await req.formData();
      const zip = form.get('path');
      assert.ok(zip && typeof zip !== 'string' && zip.name === 'playbook.zip');
      const comment = String(form.get('comment'));
      const [, sha] = /^ops\/ansible-infra@([a-f0-9]{40}) deploy\/nginx-reload\.yml$/.exec(comment) ?? [];
      assert.ok(sha, 'Expected a commit-pinned playbook');
      const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
      const path = 'ansible-infra-' + sha + '/deploy/nginx-reload.yml';
      assert.deepEqual(JSON.parse(strFromU8(files['main.yml'])), [{ import_playbook: path }]);
      assert.match(strFromU8(files[path]), /state: reloaded/);
      uploads.push(sha);
      return Response.json({ id: 'playbook-' + sha });
    }
    if (req.method === 'POST' && path === '/api/v1/ops/jobs/') {
      const body = await req.json();
      if (role !== (body.type === 'adhoc' ? readonly : job)) return forbidden();
      assert.deepEqual(body.assets, ['web01']);
      if (body.type === 'adhoc') {
        assert.equal(body.module, 'shell');
        assert.equal(body.runas, 'readonly');
        assert.equal(body.args, 'systemctl status nginx');
        assert.equal(body.instant, true);
        return execute(role);
      }
      assert.equal(body.type, 'playbook');
      assert.ok(uploads.length && body.playbook === 'playbook-' + uploads.at(-1));
      if (body.instant) return execute(role);
      definition = randomUUID();
      return Response.json({ id: definition, variable: [] });
    }
    if (req.method === 'POST' && path === '/api/v1/ops/job-executions/') {
      if (role !== job) return forbidden();
      const body = await req.json();
      assert.ok(definition && body.job === definition);
      assert.deepEqual(body.parameters, { jms_service: 'nginx' });
      return execute(role);
    }
    const match = /^\/api\/v1\/ops\/job-execution\/(task-detail|result)\/([^/]+)\/$/.exec(path);
    if (req.method === 'GET' && match) {
      if (tasks.get(match[2]) !== role) return forbidden();
      return Response.json(match[1] === 'task-detail' ? { status: 'success', summary: { success: 1 } } :
        { result: { web01: role === job ? 'nginx reloaded' : 'nginx active' } });
    }
    return new Response(null, { status: 404 });
  }
  return { handle, readonly, job, inspections, uploads, executions };
}
