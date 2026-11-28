import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'mysql2/promise';

export const STACK_STATE_PATH = '/tmp/detent-real-e2e-stack.json';
export interface RealE2EStackState {
  gitlabUrl: string;
  gitlabAdminToken: string;
  jumpserverUrl: string;
  jumpserverAccessKeyId: string;
  jumpserverAccessKeySecret: string;
  mysql: { host: string; port: number; user: string; password: string; database: string };
  targetAssetName: string;
  targetAssetAddress: string;
  targetAssetId: string;
  stagingAssetId: string;
  targetContainerName: string;
}

const composeFile = fileURLToPath(new URL('./docker-compose.e2e.yml', import.meta.url));
const target = 'target-node-01';
const targetContainer = 'detent-e2e-' + target;

export function loadStackState(): RealE2EStackState {
  return JSON.parse(readFileSync(STACK_STATE_PATH, 'utf8'));
}

// Bootstrap output contains credentials. Only stream stdout for operator-facing commands.
function compose(args: string[], options: { input?: string; stream?: boolean; timeout?: number } = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, '-p', 'detent-e2e', ...args], {
    encoding: 'utf8', input: options.input, timeout: options.timeout,
    stdio: ['pipe', options.stream ? 'inherit' : 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`docker compose ${args.join(' ')} failed (${result.signal ?? result.status})`);
  return result.stdout ?? '';
}

export function resetTargetNode(): void {
  compose(['exec', '-T', target, 'detent-target', 'reset-config'], { timeout: 15_000 });
}

const gitlabBootstrap = `
ApplicationSetting.current.update!(
  allow_local_requests_from_web_hooks_and_services: true,
  outbound_local_requests_whitelist: %w[host.docker.internal 127.0.0.1 localhost]
)
root = User.find_by!(username: 'root')
root.with_lock do
  pat = root.personal_access_tokens.active.find_or_create_by!(name: 'detent-e2e-admin') do |record|
    record.scopes = [:api, :sudo]
    record.expires_at = 1.month.from_now.to_date
  end
  # GitLab stores only a digest. Derive this fixture's token from this installation's
  # private Rails key and token ID so losing the host state file needs no rotation.
  secret = Rails.application.key_generator.generate_key("detent-e2e-admin/#{pat.id}", 32).unpack1('H*')
  value = PersonalAccessToken.token_prefix + secret
  pat.set_token(value)
  pat.scopes = [:api, :sudo]
  pat.save! if pat.changed?
  puts "DETENT_STATE=" + {token: value}.to_json
end
`;

const jumpserverBootstrap = `
import json
from django.db import transaction
from accounts.models import Account
from assets.models import Host, Node, Platform, Protocol
from authentication.models import AccessKey
from labels.models import Label
from orgs.utils import set_to_default_org
from perms.const import ActionChoices
from perms.models import AssetPermission
from users.models import User

def provision_host(name, address, platform, node, labels):
    host, _ = Host.objects.update_or_create(name=name, defaults={
        "address": address, "platform": platform, "is_active": True,
    })
    host.nodes.set([node])
    # v4 stores LabeledResource rows against the parent Asset.
    host.res_labels.exclude(label__in=labels).delete()
    for label in labels:
        host.res_labels.get_or_create(label=label)
    Protocol.objects.update_or_create(asset=host, name="ssh", defaults={"port": 22})
    Account.objects.update_or_create(asset=host, username="ops", name="ops", defaults={
        "secret": "detent-e2e-ops", "secret_type": "password", "is_active": True,
    })
    return host

set_to_default_org()
with transaction.atomic():
    admin = User.objects.select_for_update().get(username="admin")
    key = AccessKey.objects.filter(user=admin, is_active=True).first()
    if key is None:
        key = AccessKey.objects.create(user=admin)
    prod_node = Node.create_node_by_full_value("/DEFAULT/prod/app")
    staging_node = Node.create_node_by_full_value("/DEFAULT/staging/app")
    env_prod, _ = Label.objects.get_or_create(name="env", value="prod")
    env_staging, _ = Label.objects.get_or_create(name="env", value="staging")
    svc_kafka, _ = Label.objects.get_or_create(name="service", value="demo-kafka")
    linux = Platform.objects.get(name="Linux")
    host = provision_host("target-node-01", "target-node-01", linux, prod_node, [env_prod, svc_kafka])
    staging_host = provision_host("staging-node-01", "127.0.0.2", linux, staging_node, [env_staging, svc_kafka])
    perm, _ = AssetPermission.objects.update_or_create(name="detent-e2e-perm", defaults={
        "accounts": ["ops"], "protocols": ["ssh"], "is_active": True,
        "actions": ActionChoices.connect | ActionChoices.upload | ActionChoices.download,
    })
    perm.users.set([admin])
    perm.nodes.set([prod_node, staging_node])
    perm.assets.set([host, staging_host])
print("DETENT_STATE=" + json.dumps({
    "accessKeyId": str(key.id), "accessKeySecret": key.secret,
    "targetAssetId": str(host.id), "stagingAssetId": str(staging_host.id),
}))
`;

function bootstrap(args: string[], input: string, keys: string[]): Record<string, string> {
  const output = compose(['exec', '-T', ...args], { input, timeout: 180_000 });
  const record = output.split('\n').find(line => line.startsWith('DETENT_STATE='));
  if (!record) throw Error(`${args[0]} bootstrap returned no credentials`);
  const credentials = JSON.parse(record.slice('DETENT_STATE='.length));
  for (const key of keys) {
    if (typeof credentials?.[key] !== 'string' || !credentials[key]) throw Error(`Missing ${args[0]} ${key}`);
  }
  return credentials;
}

function publishedPort(service: string, containerPort: number) {
  const binding = compose(['port', service, String(containerPort)], { timeout: 10_000 }).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  if (!match) throw Error('Expected a loopback port binding for ' + service);
  return Number(match[1]);
}

function checkGitlabContainer() {
  const state = compose(['ps', '--all', '--format', '{{.Service}} {{.State}}', 'gitlab'], { timeout: 10_000 }).trim();
  if (state === 'gitlab exited' || state === 'gitlab dead') {
    throw Error(`GitLab container failed during startup (${state}). Inspect docker compose -f "${composeFile}" -p detent-e2e logs gitlab`);
  }
}

async function waitFor(name: string, seconds: number, check: () => Promise<void> | void, checkContainer?: () => void) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    checkContainer?.();
    try {
      await check();
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error(`${name} did not become ready within ${seconds}s: ${error}`);
      await delay(Math.min(2000, remaining));
    }
  }
}

async function get(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw Error(`GET ${url} returned HTTP ${response.status}`);
  }
  return response;
}

async function checkMysql(mysql: RealE2EStackState['mysql']) {
  const db = await createConnection({ ...mysql, connectTimeout: 5000 });
  try {
    await db.query({ sql: 'SELECT 1', timeout: 5000 });
  } finally {
    await db.end();
  }
}

async function checkGitlab(state: RealE2EStackState) {
  const response = await get(state.gitlabUrl + '/api/v4/user', { 'PRIVATE-TOKEN': state.gitlabAdminToken });
  if ((await response.json()).username !== 'root') throw Error('GitLab token did not authenticate as root');
}

async function permissionRows<T>(state: RealE2EStackState, resource: 'assets' | 'nodes'): Promise<T[]> {
  const path = '/api/v1/perms/users/self/' + resource + '/';
  const date = new Date().toUTCString();
  const signature = createHmac('sha256', state.jumpserverAccessKeySecret)
    .update(`(request-target): get ${path}\naccept: application/json\ndate: ${date}`).digest('base64');
  const response = await get(state.jumpserverUrl + path, {
    Accept: 'application/json', Date: date,
    Authorization: `Signature keyId="${state.jumpserverAccessKeyId}",algorithm="hmac-sha256",headers="(request-target) accept date",signature="${signature}"`,
  });
  const data = await response.json();
  const rows = Array.isArray(data) ? data : data.results;
  if (!Array.isArray(rows)) throw Error('Unexpected JumpServer response for ' + path);
  return rows;
}

async function checkAsset(state: RealE2EStackState) {
  type Asset = { id: string; name: string; address: string; labels: { name: string; value: string }[] };
  const [nodes, assets] = await Promise.all([
    permissionRows<{ full_value: string }>(state, 'nodes'), permissionRows<Asset>(state, 'assets'),
  ]);
  for (const [env, name, address, id] of [
    ['prod', state.targetAssetName, state.targetAssetAddress, state.targetAssetId],
    ['staging', 'staging-node-01', '127.0.0.2', state.stagingAssetId],
  ]) {
    const path = '/DEFAULT/' + env + '/app';
    if (!nodes.some(node => node.full_value === path)) throw Error('Missing authorized JumpServer node ' + path);
    const asset = assets.find(a => a.id === id && a.name === name && a.address === address);
    if (!asset) throw Error('Missing authorized JumpServer asset ' + name);
    for (const [key, value] of [['env', env], ['service', 'demo-kafka']]) {
      if (!asset.labels?.some(label => label.name === key && label.value === value))
        throw Error(`JumpServer asset ${name} lacks label ${key}:${value}`);
    }
  }
}

function checkServices() {
  const rows = compose(['ps', '--status', 'running', '--format', '{{.Service}} {{.Health}}'],
    { timeout: 10_000 }).trim().split('\n');
  for (const service of ['k3s', 'jms-celery', target]) {
    if (!rows.includes(service + ' healthy')) throw Error(service + ' is not healthy');
  }
}

async function up() {
  compose(['up', '-d', '--build'], { stream: true });
  const gitlabUrl = 'http://127.0.0.1:' + publishedPort('gitlab', 80);
  const jumpserverUrl = 'http://127.0.0.1:' + publishedPort('jms-core', 8080);
  const mysql = { host: '127.0.0.1', port: publishedPort('mysql', 3306), user: 'detent',
    password: 'detent-e2e-mysql', database: 'detent' };

  console.log('Waiting for MySQL, GitLab, JumpServer, K3s and the managed host.');
  await Promise.all([
    waitFor('MySQL', 120, async () => {
      compose(['exec', '-T', 'mysql', 'mysqladmin', 'ping', '--protocol=tcp', '--silent'], { timeout: 5000 });
      await checkMysql(mysql);
    }),
    waitFor('GitLab', 360, async () => {
      // The sign-in page is reachable from the host even when monitoring endpoints are IP restricted.
      await (await get(gitlabUrl + '/users/sign_in')).body?.cancel();
    }, checkGitlabContainer),
    waitFor('JumpServer', 240, async () => {
      const health = await (await get(jumpserverUrl + '/api/health/')).json();
      if (!health.status) throw Error('JumpServer database or Redis health check failed');
    }),
    waitFor('K3s, JumpServer worker and managed host', 240, checkServices),
  ]);

  console.log('Provisioning the GitLab token and JumpServer asset permission.');
  const gitlab = bootstrap(['gitlab', 'gitlab-rails', 'runner', '-'], gitlabBootstrap, ['token']);
  const jms = bootstrap(['jms-core', 'python3', '/opt/jumpserver/apps/manage.py', 'shell'], jumpserverBootstrap,
    ['accessKeyId', 'accessKeySecret', 'targetAssetId', 'stagingAssetId']);
  const state: RealE2EStackState = { gitlabUrl, gitlabAdminToken: gitlab.token, jumpserverUrl,
    jumpserverAccessKeyId: jms.accessKeyId, jumpserverAccessKeySecret: jms.accessKeySecret,
    targetAssetId: jms.targetAssetId, stagingAssetId: jms.stagingAssetId,
    mysql, targetAssetName: target, targetAssetAddress: target, targetContainerName: targetContainer };
  await checkGitlab(state);
  await waitFor('JumpServer signed asset lookup', 30, () => checkAsset(state));

  const temp = STACK_STATE_PATH + '.' + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, STACK_STATE_PATH);
  } finally {
    rmSync(temp, { force: true });
  }
  console.log('Stack ready. Credentials saved in ' + STACK_STATE_PATH);
}

async function main(command: string | undefined) {
  switch (command) {
    case 'up':
      return up();
    case 'down':
      compose(['down', '-v', '--remove-orphans'], { stream: true });
      rmSync(STACK_STATE_PATH, { force: true });
      return;
    case 'status': {
      compose(['ps', '-a'], { stream: true });
      const state = loadStackState();
      await Promise.all([checkMysql(state.mysql), checkGitlab(state), checkAsset(state)]);
      checkServices();
      console.log('MySQL, the GitLab root token, JumpServer, K3s and the managed host are ready.');
      return;
    }
    default:
      throw Error('Usage: tsx scripts/e2e/stack.ts up|down|status');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
