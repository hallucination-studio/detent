import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import type { DecisionClient } from '@detent/core';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { loadDeliveryConfig } from '../src/config.js';
import { buildBatchShellScript, isHardBlockedRemoteInspectCommand, validateShellCommands } from '../src/jumpserver/guards.js';
import { createJumpServerTools } from '../src/jumpserver/tools.js';

async function inspectGuard(choice = 'pure_readonly', noul = 0.79, score = 0.76, enableJev = true) {
  const decide = vi.fn<DecisionClient['decide']>().mockResolvedValue({
    effect: { type: 'choice', choice }, zero_side_effect: { type: 'noul', noul }, impact: { type: 'score', score },
  });
  const decision = enableJev ? { provider: 'bailian' as const, threshold: 0.9, decide } : undefined;
  const client = { listAssets: vi.fn(), runShell: vi.fn(), runAnsibleJob: vi.fn(), getJobResult: vi.fn() };
  const tools = createJumpServerTools({ client, config: loadDeliveryConfig({}), decision });
  const guard = tools.find(tool => tool.name === 'jms_shell')!.guard!;
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'inspect');
  const ctx = { session, repo, workspaceRoot: '.', permissionMode: 'plan' as const, workflow: { allowPrefixes: ['kafka-topics.sh'] } };
  return { decide, inspect: (command: string) => guard({ commands: [command], asset_ids: ['web01'] }, ctx) };
}

const pipeline = 'ps -ef | grep -i kafka | grep -v grep';

it('limits configured Helm prefixes to read-only subcommands, flags and output formats', async () => {
  const prefixes = ['helm list', 'helm status', 'helm history', 'helm version'];
  for (const cmd of ['helm list -A --deployed --failed --pending --all', 'helm list --all-namespaces --filter ^api --max 15',
    'helm status api --namespace=prod --revision 2 --show-resources -o yaml', 'helm history api -n prod --max=10 --output=json',
    'helm list --output table', 'helm version --short']) {
    expect(await validateShellCommands([cmd], prefixes), cmd).toMatchObject({ ok: true });
  }
  for (const cmd of ['helm upgrade api .', 'helm status api --kubeconfig /tmp/config', 'helm history api --max -1',
    'helm list -o template', 'helm list --output=json=x', 'helm list --namespace', 'helm status api --namespace --debug',
    'helm list --filter=x --post-renderer=script', 'helm version --template=x']) {
    expect(await validateShellCommands([cmd], prefixes), cmd).toMatchObject({ ok: false });
  }
});

it('accepts a level-one Bailian decision with explicit no-side-effect criteria', async () => {
  const { decide, inspect } = await inspectGuard();
  expect(await inspect(pipeline)).toEqual({ ok: true });
  expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: pipeline }), expect.objectContaining({
    zero_side_effect: expect.objectContaining({ criteria: { true: '纯只读诊断，无任何写入、状态变更或凭据泄露', false: '存在写入、状态变更、凭据读取或高危风险' } }),
  }));
});

it.each(["'kafka|zookeeper'", '"kafka|zookeeper"'])('passes the quoted pattern %s intact to Jev', async pattern => {
  const command = `ps -ef | grep -Ei ${pattern} | grep -v grep`;
  const { decide, inspect } = await inspectGuard();
  expect(isHardBlockedRemoteInspectCommand(command)).toBe(false);
  expect(await inspect(command)).toEqual({ ok: true });
  expect(decide.mock.calls[0][0]).toMatchObject({ command });
});

it.each([['state_mutating', 0.79, 0.76], ['pure_readonly', 0.79, 2.1], ['pure_readonly', 0.74, 1]] as const)(
  'surfaces the Jev denial for %s, noul %s and impact %s', async (choice, noul, score) => {
    const { inspect } = await inspectGuard(choice, noul, score);
    expect(await inspect(pipeline)).toMatchObject({ ok: false, reason: expect.stringContaining(
      `Jev: choice=${choice}, noul=${noul}, impact=${score}`) });
  });

it.each([
  'systemctl --failed --no-pager --no-legend',
  "curl -sS -m 3 -o /dev/null -w '%{http_code} %{time_total}s' http://127.0.0.1:9092/",
  'ss -tulnp', 'journalctl -u kafka -n 50 --no-pager',
  "grep -F 'x;y & z > ..' /var/log/messages", String.raw`grep -E "a\"|b" /var/log/messages`,
  'ls /srv/nonsecret', 'kubectl get pods --namespace=secrets --sort-by=.metadata.name',
])('sends the diagnostic %s to Jev', async command => {
  const { decide, inspect } = await inspectGuard();
  expect(isHardBlockedRemoteInspectCommand(command)).toBe(false);
  expect(await inspect(command)).toEqual({ ok: true });
  expect(decide).toHaveBeenCalledExactlyOnceWith({ surface: 'remote_jumpserver_readonly_inspect', command }, expect.anything());
});

it('matches literal allowlisted prefixes for installed executables', async () => {
  const { decide, inspect } = await inspectGuard();
  for (const command of ['ss -tlnp', '/usr/bin/ss -tlnp', '/opt/kafka/bin/kafka-topics.sh'])
    expect(await inspect(command), command).toEqual({ ok: true });
  expect(decide).not.toHaveBeenCalled();
  const staticOnly = await inspectGuard(undefined, undefined, undefined, false);
  for (const command of ['ps -ef', 'ss -lntp', '/tmp/uptime'])
    expect(await staticOnly.inspect(command), command).toMatchObject({ ok: false, reason: expect.stringContaining('白名单') });
});

it.each([
  'systemctl restart nginx', 'ss -K', '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --delete',
])('requires a Jev verdict for %s and enforces its denial', async command => {
  const { decide, inspect } = await inspectGuard('state_mutating');
  expect(isHardBlockedRemoteInspectCommand(command)).toBe(false);
  expect(await inspect(command)).toMatchObject({ ok: false, reason: expect.stringContaining('Jev: choice=state_mutating') });
  expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command }), expect.anything());
});

it('hard-blocks unsafe commands before prefix matching and Jev', async () => {
  const { decide, inspect } = await inspectGuard();
  for (const command of ['rm -rf /', 'sudo uptime', 'cat /etc/shadow', 'cat /etc/./gshadow', 'cat /etc/sudoers',
    'uptime; id', 'uptime & id', 'uptime && id', 'uptime || id', 'cat < file',
    "echo 'a|b' ; rm -rf /", "echo 'ok' | sh", "echo 'a|b' | sh | grep ok",
    "echo 'unterminated | sh", 'echo "unterminated', '| uptime', 'uptime | ', 'uptime | | uptime',
    "awk '{ print | cmd }'", "awk 'system(cmd)'", "awk '{ getline record }'",
    'sed -i s/a/b/ f', 'sed --in-place=.bak s/a/b/ f', 'find /tmp -delete', 'find /tmp -ok rm',
    'uptime > out', 'uptime $(id)', 'echo "$(id)"', 'echo `id`', 'cat ../file',
    'ls /run/secrets/key', 'cat .ssh/config', 'cat .env', 'cat id_rsa', 'cat id_ed25519',
    'kubectl get secret', 'kubectl get secrets', "cat /etc/'sha'dow", 'cat /etc//shadow',
    '', 'x'.repeat(513), 'uptime\r', 'uptime\n', 'uptime\0']) {
    expect(isHardBlockedRemoteInspectCommand(command), command).toBe(true);
    expect(await inspect(command), command).toMatchObject({ ok: false, reason: expect.stringContaining('硬性') });
  }
  expect(decide).not.toHaveBeenCalled();
});

it('starts every eligible Jev check together and preserves the order of the validated batch', async () => {
  const verdict = {
    effect: { type: 'choice', choice: 'pure_readonly' }, zero_side_effect: { type: 'noul', noul: 1 }, impact: { type: 'score', score: 0 },
  } as const;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const decide = vi.fn<DecisionClient['decide']>(async () => { await waiting; return verdict; });
  const decision = { provider: 'custom' as const, threshold: 0.9, decide };
  const quoted = "ps aux | grep 'two  words'";
  const commands = ['  uptime ', 'date', 'df\t -h', quoted];
  const result = validateShellCommands(commands, ['uptime', 'df -h'], decision);
  expect(decide.mock.calls.map(([ctx]) => ctx)).toEqual(['date', quoted].map(command => ({ surface: 'remote_jumpserver_readonly_inspect', command })));
  release();
  expect(await result).toEqual({ ok: true, commands: ['uptime', 'date', 'df -h', quoted] });

  decide.mockClear();
  expect((await validateShellCommands(Array(10).fill('uptime'), ['uptime'], decision)).ok).toBe(true);
  for (const batch of [[], Array(11).fill('uptime'), ['date', 'uptime', 'cat /etc/shadow']])
    expect(await validateShellCommands(batch, ['uptime'], decision)).toMatchObject({ ok: false });
  expect(decide).not.toHaveBeenCalled();
  expect(await validateShellCommands(['uptime', 'date'], ['uptime'])).toMatchObject({ ok: false, reason: expect.stringContaining('date') });
  decide.mockResolvedValueOnce(verdict).mockResolvedValueOnce({ ...verdict, effect: { type: 'choice', choice: 'ambiguous' } });
  expect(await validateShellCommands(commands, ['uptime', 'df -h'], decision)).toMatchObject({
    ok: false, reason: expect.stringContaining(`命令「${quoted}」未通过只读校验`),
  });
});

it('quotes batch headers literally and reports each exit status while completing the batch successfully', () => {
  const quoted = "printf '%s\\n' 'space  and %s'";
  expect(buildBatchShellScript([quoted])).toBe(quoted);
  const script = buildBatchShellScript([quoted, 'false', 'true']);
  expect(script).toMatch(/^set \+e\n/);
  expect(script).toContain("printf '=== [%d/%d] %s ===\\n' 1 3 'printf '\\''%s");
  const run = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(run.stdout.split('\n')).toEqual([
    `=== [1/3] ${quoted} ===`, 'space  and %s', '[rc=0]', '=== [2/3] false ===', '[rc=1]', '=== [3/3] true ===', '[rc=0]', '',
  ]);
});
