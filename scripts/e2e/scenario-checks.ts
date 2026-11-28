import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { E2EGitLabDriver } from './gitlab-driver.js';

const run = promisify(execFile);
type MR = Awaited<ReturnType<E2EGitLabDriver['getMr']>>;

async function dockerInput(args: string[], input: string) {
  const process = run('docker', args, { timeout: 15000 });
  const stdin = process.child.stdin!;
  const sent = new Promise<void>((resolve, reject) => {
    stdin.on('error', reject);
    stdin.end(input, resolve);
  });
  const [result] = await Promise.all([process, sent]);
  return result.stdout;
}

export async function ansibleEntryPoints(gl: E2EGitLabDriver, mr: MR, greenfield: boolean) {
  const id = mr.target_project_id;
  const diffs = await gl.mrDiffs(id, mr.iid);
  const files = new Set(diffs.filter(d => !d.deleted_file && /\.ya?ml$/i.test(d.new_path)).map(d => d.new_path));
  assert.ok(files.size, 'Expected a YAML configuration change');
  if (greenfield) {
    assert.ok([...files].some(path => /^roles\/[^/]+\/tasks\//.test(path)), 'Missing top-level role tasks');
  } else {
    // A change confined to vars or a role still runs through an existing playbook.
    for (const entry of await gl.listTree(id, mr.sha)) {
      if (entry.type === 'blob' && /^(?:playbooks\/)?[^/.][^/]*\.ya?ml$/i.test(entry.path)) files.add(entry.path);
    }
  }
  const contents = await Promise.all([...files].map(async path => [path, await gl.getFile(id, path, mr.sha)]));
  const compose = fileURLToPath(new URL('./docker-compose.e2e.yml', import.meta.url));
  const script = await readFile(new URL('./ansible-check.py', import.meta.url), 'utf8');
  const entries: string[] = JSON.parse(await dockerInput(['compose', '-p', 'detent-e2e', '-f', compose,
    'exec', '-T', 'jms-celery', 'python3', '-c', script, greenfield ? 'new' : 'existing'], JSON.stringify(Object.fromEntries(contents))));
  const valid = greenfield ? entries.filter(path => path.startsWith('playbooks/')) : entries;
  assert.ok(valid.length, 'Expected an executable playbook for the changed configuration');
  return valid;
}

type Container = {
  image: string; resources?: { requests?: object; limits?: object }; readinessProbe?: object; livenessProbe?: object;
  ports?: { containerPort: number }[]; volumeMounts?: { name: string; mountPath: string }[];
  envFrom?: { configMapRef?: { name?: string } }[];
  env?: { name?: string; valueFrom?: { configMapKeyRef?: { name?: string } } }[];
};

type Deployment = {
  kind: 'Deployment';
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    replicas: number;
    selector: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels: Record<string, string> };
      spec: { containers: Container[]; volumes?: { name: string; configMap?: { name: string } }[] };
    };
  };
};
type Service = { kind: 'Service'; spec: { selector?: Record<string, string> } };
type ConfigMap = { kind: 'ConfigMap'; metadata: { name: string }; data?: Record<string, string> };
type Resource = Deployment | Service | ConfigMap;
type HelmCase = { namespace: 'demo-e2e'; logLevel: 'info' | 'warn' } | { namespace: 'order-e2e'; replicas: number };

function checkResources(resources: Resource[], scenario: HelmCase) {
  const deployments = resources.filter(r => r.kind === 'Deployment');
  assert.equal(deployments.length, 1, 'Expected the application Deployment');
  const [deployment] = deployments;
  const { template, selector } = deployment.spec;
  const service = resources.find(r => r.kind === 'Service' && Object.keys(r.spec.selector ?? {}).length &&
    Object.entries(r.spec.selector ?? {}).every(([k, v]) => template.metadata.labels[k] === v));
  assert.ok(service, 'Missing Service selecting the application pods');
  const app = template.spec.containers.find(c => c.ports?.some(p => p.containerPort === 8080));
  assert.ok(app, 'Expected an application container serving port 8080');
  if (scenario.namespace === 'demo-e2e') {
    assert.deepEqual(selector.matchLabels, { 'app.kubernetes.io/name': 'demo-api', 'app.kubernetes.io/instance': 'demo-api' });
    assert.equal(deployment.spec.replicas, 2);
    const config = resources.filter(r => r.kind === 'ConfigMap').find(r => r.data?.APP_ENV === 'prod' && r.data.LOG_LEVEL === scenario.logLevel);
    assert.ok(config, 'Missing application ConfigMap with expected production settings');
    const mounted = template.spec.volumes?.some(v => v.configMap?.name === config.metadata.name &&
      app.volumeMounts?.some(m => m.name === v.name && m.mountPath));
    assert.ok(mounted || app.envFrom?.some(e => e.configMapRef?.name === config.metadata.name) ||
      app.env?.some(e => e.valueFrom?.configMapKeyRef?.name === config.metadata.name), 'Application does not consume its ConfigMap');
  } else {
    assert.ok(Object.keys(app.resources?.requests ?? {}).length && Object.keys(app.resources?.limits ?? {}).length, 'Missing requests or limits');
    assert.ok(app.readinessProbe && app.livenessProbe, 'Missing workload probes');
    assert.match(app.image, /(?:^|\/)busybox:1\.36$/);
    assert.equal(deployment.metadata.annotations?.['team.detent.io/owner'], 'platform-ops');
    assert.ok(Object.keys(selector.matchLabels ?? {}).length, 'Missing Deployment selector');
    assert.ok(Object.keys(selector.matchLabels).every(k => !/version/i.test(k)), 'Version in immutable selector');
    assert.equal(deployment.spec.replicas, scenario.replicas);
  }
  return deployment;
}

export async function checkChart(gl: E2EGitLabDriver, mr: MR, scenario: HelmCase, helmPath: string, target: string) {
  const tree = await gl.listTree(mr.target_project_id, mr.sha);
  const dir = await mkdtemp(join(tmpdir(), 'detent-chart-'));
  try {
    const blobs = tree.filter(entry => entry.type === 'blob');
    if (scenario.namespace === 'order-e2e') {
      const charts = blobs.filter(b => /(?:^|\/)Chart\.yaml$/.test(b.path) && !b.path.startsWith('charts/'));
      assert.deepEqual(charts.map(b => b.path), ['Chart.yaml'], 'Expected one application chart at the repository root');
    }
    for (const path of ['Chart.yaml', 'values.yaml', 'values-prod.yaml', 'templates/_helpers.tpl', 'templates/deployment.yaml', 'templates/service.yaml']) {
      assert.ok(blobs.some(entry => entry.path === path), 'Missing ' + path);
    }
    for (const blob of blobs) {
      assert.ok(!blob.path.split('/').some(part => !part || ['.', '..', '.git'].includes(part)), 'Invalid tree path');
      assert.ok(['100644', '100755'].includes(blob.mode), 'Expected a regular file at ' + blob.path);
      const dest = join(dir, blob.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await gl.fileBytes(mr.target_project_id, blob.path, mr.sha));
    }
    const options = { cwd: dir, env: { ...process.env, PATH: helmPath }, timeout: 15000 };
    const prod = ['-f', 'values-prod.yaml'];
    await run('helm', ['lint', '.', '--strict', ...prod], options);
    const name = scenario.namespace === 'demo-e2e' ? 'demo-api' : 'order-service';
    const { stdout } = await run('helm', ['template', name, '.', '-n', scenario.namespace, ...prod], options);
    const documents: Resource[] = JSON.parse(await dockerInput(['exec', '-i', target, 'python3', '-c',
      'import sys,json,yaml; print(json.dumps([doc for doc in yaml.safe_load_all(sys.stdin) if doc]))'], stdout));
    checkResources(documents, scenario);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function targetCommand(container: string, ...args: string[]) {
  const { stdout } = await run('docker', ['exec', '-u', 'ops', '-e', 'HOME=/home/ops', container, ...args], { timeout: 30000 });
  return stdout.trim();
}

export async function checkImageValues(target: string, base: string, override: string, tag: string) {
  const values = JSON.parse(await dockerInput(['exec', '-i', target, 'python3', '-c',
    'import json, sys, yaml; print(json.dumps([yaml.safe_load(v) for v in json.load(sys.stdin)]))'], JSON.stringify([base, override])));
  assert.equal(String(values[1]?.image?.tag ?? values[0]?.image?.tag), tag, 'Wrong effective image.tag in the environment MR');
}

export async function checkRelease(target: string, scenario: HelmCase) {
  const resources: { items: Resource[] } = JSON.parse(await targetCommand(target, 'kubectl', 'get', 'deploy,svc,cm', '-n', scenario.namespace, '-o', 'json'));
  const deployment = checkResources(resources.items, scenario);
  const release = deployment.metadata.annotations?.['meta.helm.sh/release-name'];
  assert.ok(release, 'Deployment has no Helm release owner');
  const status = JSON.parse(await targetCommand(target, 'helm', 'status', release, '-n', scenario.namespace, '-o', 'json'));
  assert.equal(status.info.status, 'deployed');
  assert.equal(status.namespace, scenario.namespace);
}
