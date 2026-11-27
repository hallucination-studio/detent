import { expect, it, vi } from 'vitest';
import type { DecisionClient } from '@detent/core';
import { InMemoryDetentRepository } from '../../core/tests/memory-repository.js';
import { loadDeliveryConfig } from '../src/config.js';
import { isHardBlockedRemoteInspectCommand } from '../src/jumpserver/guards.js';
import { createJumpServerTools } from '../src/jumpserver/tools.js';

async function inspectGuard(choice = 'pure_readonly', noul = 0.79, score = 0.76, enableJev = true) {
  const decide = vi.fn<DecisionClient['decide']>().mockResolvedValue({
    effect: { type: 'choice', choice }, zero_side_effect: { type: 'noul', noul }, impact: { type: 'score', score },
  });
  const decision = enableJev ? { provider: 'bailian' as const, threshold: 0.9, decide } : undefined;
  const client = { listAssets: vi.fn(), runReadonlyInspect: vi.fn(), runAnsibleJob: vi.fn(), getJobResult: vi.fn() };
  const tools = createJumpServerTools({ client, config: loadDeliveryConfig({}), decision });
  const guard = tools.find(tool => tool.name === 'jms_readonly_inspect')!.guard!;
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'inspect');
  const ctx = { session, repo, workspaceRoot: '.', permissionMode: 'plan' as const, workflow: { allowPrefixes: ['kafka-topics.sh'] } };
  return { decide, inspect: (command: string) => guard({ command, asset_ids: ['web01'] }, ctx) };
}

const pipeline = 'ps -ef | grep -i kafka | grep -v grep';

it('accepts a level-one Bailian decision with explicit no-side-effect criteria', async () => {
  const { decide, inspect } = await inspectGuard();
  expect(await inspect(pipeline)).toEqual({ ok: true });
  expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: pipeline }), expect.objectContaining({
    zero_side_effect: expect.objectContaining({ criteria: { true: '纯只读诊断，无任何写入、状态变更或凭据泄露', false: '存在写入、状态变更、凭据读取或高危风险' } }),
  }));
});

it.each([['state_mutating', 0.79, 0.76], ['pure_readonly', 0.79, 2.1], ['pure_readonly', 0.74, 1]] as const)(
  'surfaces the Jev denial for %s, noul %s and impact %s', async (choice, noul, score) => {
    const { inspect } = await inspectGuard(choice, noul, score);
    expect(await inspect(pipeline)).toMatchObject({ ok: false, reason: expect.stringContaining(
      `Jev: choice=${choice}, noul=${noul}, impact=${score}`) });
  });

it('matches installed executables and equivalent ss flags without consulting Jev', async () => {
  const { decide, inspect } = await inspectGuard();
  for (const command of ['ss -lntp', 'ss -lp -tn', '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list'])
    expect(await inspect(command), command).toEqual({ ok: true });
  expect(decide).not.toHaveBeenCalled();
  const staticOnly = await inspectGuard(undefined, undefined, undefined, false);
  expect(await staticOnly.inspect('ps -ef')).toMatchObject({ ok: false, reason: expect.stringContaining('白名单') });
});

it('hard-blocks unsafe commands before prefix matching and Jev', async () => {
  const { decide, inspect } = await inspectGuard();
  for (const command of ['rm -rf /', 'cat /etc/shadow', 'uptime; id', 'uptime && id', 'uptime || id',
    'uptime > out', 'uptime $(id)', 'ls /run/secrets/key', 'cat .ssh/config', 'cat .env', '/tmp/uptime',
    'ss -K', '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --delete']) {
    expect(isHardBlockedRemoteInspectCommand(command), command).toBe(true);
    expect(await inspect(command), command).toMatchObject({ ok: false, reason: expect.stringContaining('硬性') });
  }
  expect(decide).not.toHaveBeenCalled();
});
