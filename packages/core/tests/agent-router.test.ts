import { expect, it, vi } from 'vitest';
import {
  buildTriageSystemPrompt, createDecisionClient, loadConfig, parseHubAgentMarkdown, routeHubAgent,
  type DecisionAnswer, type DecisionClient,
} from '../src/index.js';

const scan = parseHubAgentMarkdown('scan', 'agents/scan/AGENT.md',
  '---\ndescription: Inspect project state\nmode: readonly\n---\nRun checks.', 'agents')!;
const sync = parseHubAgentMarkdown('image-sync', 'agents/image-sync/AGENT.md',
  '---\ndescription: Sync container images\nrouting_hint: |\n  Copy or mirror an exact image tag\n  to a target registry\nrequires: [registry]\n---\nSync procedure.', 'agents')!;
const review = parseHubAgentMarkdown('review', 'agents/review/AGENT.md',
  '---\ndescription: Review merge requests\n---\nReview procedure.', 'agents')!;
const input = { title: 'Sync image', description: 'Copy app:v1 to the staging registry', labels: [] };

function answers(choice = sync.id, confidence = 0.94, ambiguity = 0.3, probabilities?: Record<string, number>): Record<string, DecisionAnswer> {
  return {
    agent: { type: 'choice', choice, probabilities },
    clear_match: { type: 'noul', noul: confidence },
    ambiguity: { type: 'score', score: ambiguity },
  };
}

function client(response = answers()) {
  return { provider: 'custom', threshold: 0.9, decide: vi.fn<DecisionClient['decide']>().mockResolvedValue(response) } satisfies DecisionClient;
}

it('matches at the inclusive routing thresholds independently of the Bash threshold', async () => {
  const decision = client(answers(sync.id, 0.8, 1.2));
  expect(await routeHubAgent(decision, [scan, sync], input)).toEqual({ kind: 'matched', agent: sync, confidence: 0.8, ambiguity: 1.2 });
  expect(decision.decide).toHaveBeenCalledTimes(1);
});

it('triages without calling Jev when there are no registered Agents', async () => {
  const decision = client();
  expect(await routeHubAgent(decision, [], input)).toEqual({ kind: 'triage', reason: 'Hub 仓库尚未定义可用 Agent' });
  expect(decision.decide).not.toHaveBeenCalled();
});

it('triages without a suggestion when Jev chooses __none__', async () => {
  const decision = client(answers('__none__', 1, 0));
  expect(await routeHubAgent(decision, [scan, sync], input)).toEqual({ kind: 'triage', reason: 'Jev 未找到匹配的 Agent' });
});

it('triages a low-confidence choice with the two highest registered candidate probabilities', async () => {
  const decision = client(answers(sync.id, 0.79, 0, { scan: 0.4, __none__: 0.99, review: 0.15, 'image-sync': 0.5, unknown: 0.8 }));
  expect(await routeHubAgent(decision, [scan, sync, review], input)).toMatchObject({
    kind: 'triage', suggestion: { agent: sync, confidence: 0.79 },
    topCandidates: [{ id: sync.id, probability: 0.5 }, { id: scan.id, probability: 0.4 }],
  });
});

it('triages high ambiguity even at high confidence', async () => {
  expect(await routeHubAgent(client(answers(sync.id, 0.99, 1.21)), [scan, sync], input)).toMatchObject({
    kind: 'triage', suggestion: { agent: sync, confidence: 0.99 },
  });
});

it('uses the configured routing threshold on the HTTP client and validates its range', async () => {
  expect(loadConfig({}).jevRoutingThreshold).toBe(0.8);
  for (const [value, parsed] of [['0.5', 0.5], ['0.99', 0.99]] as const)
    expect(loadConfig({ JEV_ROUTING_THRESHOLD: value }).jevRoutingThreshold).toBe(parsed);
  for (const value of ['0.49', '1', 'bad']) expect(() => loadConfig({ JEV_ROUTING_THRESHOLD: value })).toThrow();

  const config = loadConfig({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'https://jev.example', JEV_ROUTING_THRESHOLD: '0.95' });
  const decision = createDecisionClient(config, async () => Response.json({ answers: answers() }))!;
  expect(decision.routingThreshold).toBe(0.95);
  expect(await routeHubAgent(decision, [sync], input)).toMatchObject({ kind: 'triage', suggestion: { agent: sync, confidence: 0.94 } });
});

it('falls back cleanly for invalid answers from injected DecisionClients', async () => {
  const valid = answers();
  for (const response of [
    {}, answers('unknown-secret-agent'), answers(sync.id, -0.1), answers(sync.id, 1.1),
    answers(sync.id, NaN), answers(sync.id, 0.99, Infinity), answers(sync.id, 0.99, -1),
    answers(sync.id, 0.99, 0, { [sync.id]: -1 }),
    { ...valid, clear_match: { type: 'score' as const, score: 0.99 } },
    { ...valid, ambiguity: { type: 'noul' as const, noul: 0 } },
  ]) {
    expect(await routeHubAgent(client(response), [sync], input)).toEqual({ kind: 'triage', reason: 'Jev 意图路由暂不可用' });
  }
});

it('discards credential-bearing transport errors, timeouts and invalid HTTP responses', async () => {
  const secret = 'secret-only-for-test';
  const config = loadConfig({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'https://jev.example', JEV_API_KEY: secret, JEV_TIMEOUT_MS: '5' });
  const failures: (typeof fetch)[] = [
    async () => { throw Error(secret); },
    async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error(secret)))),
    async () => new Response(secret, { status: 502 }),
    async () => Response.json({ answers: answers(secret) }),
  ];
  for (const http of failures) {
    const result = await routeHubAgent(createDecisionClient(config, http)!, [sync], input);
    expect(result).toEqual({ kind: 'triage', reason: 'Jev 意图路由暂不可用' });
    expect(JSON.stringify(result)).not.toContain(secret);
  }
});

it('redacts and bounds routing state and sends only recent distinct messages in chronological order', async () => {
  const url = 'https://oauth2:secret@git.example/org/repo';
  const redacted = 'https://oauth2:***@git.example/org/repo';
  const long = 'x'.repeat(2500);
  const decision = client();
  await routeHubAgent(decision, [scan, sync], {
    title: url + long, description: url + long,
    labels: [' Claude::planning ', 'keep', url],
    recentMessages: ['obsolete', 'first', 'second', ' first ', 'third', 'third', '  ', url + long],
  });
  const [state, questions] = decision.decide.mock.calls[0];
  expect(state).toEqual({
    surface: 'hub_agent_routing', issue_title: (redacted + long).slice(0, 300), issue_description: (redacted + long).slice(0, 2000),
    recent_user_messages: ['second', 'first', 'third', (redacted + long).slice(0, 800)], existing_labels: ['keep', redacted],
  });
  expect(questions).toMatchObject({
    agent: { type: 'choice', criteria: { __none__: expect.any(String), scan: scan.description, 'image-sync': sync.description + '；' + sync.routingHint } },
    clear_match: { type: 'noul', criteria: { true: expect.any(String), false: expect.any(String) } },
    ambiguity: { type: 'score', criteria: [expect.stringMatching(/^0:/), expect.stringMatching(/^1:/), expect.stringMatching(/^2:/), expect.stringMatching(/^3:/)] },
  });
});

it('includes new Agents in the choices on the next invocation', async () => {
  const decision = client();
  decision.decide.mockResolvedValueOnce(answers('__none__'));
  await routeHubAgent(decision, [scan], input);
  const extended = { ...sync, routingHint: 'x'.repeat(500) };
  expect(await routeHubAgent(decision, [scan, extended], input)).toMatchObject({ kind: 'matched', agent: extended });
  expect(decision.decide.mock.calls[0][1].agent).not.toHaveProperty('criteria.image-sync');
  expect(decision.decide.mock.calls[1][1].agent).toMatchObject({ criteria: { 'image-sync': (sync.description + '；' + extended.routingHint).slice(0, 400) } });
});

it('guides read-only triage with the Agent catalog, capability readiness and advisory routing hints', () => {
  const prompt = buildTriageSystemPrompt([scan, sync, review], [{ name: 'registry', enabled: false, tools: [] }], {
    reason: '需求含糊', suggestion: { agent: sync, confidence: 0.67 },
    topCandidates: [{ id: sync.id, probability: 0.65 }, { id: scan.id, probability: 0.3 }],
    invalidFiles: ['agents/broken/AGENT.md'],
  });
  const [available, unavailable] = prompt.split('### 未开通');
  expect(available).toContain('### 已就绪');
  expect(available).toContain(scan.description);
  expect(available).toContain(review.description);
  expect(available).not.toContain(sync.description);
  for (const text of [sync.description, '待配置 registry', '2–3 行', '最多 8 行', '最多 3 个简短编号问题', '直接回复即可继续'])
    expect(unavailable).toContain(text);
  expect(prompt).not.toMatch(/Jev|置信度|自动重新路由|AGENT\.md|SKILL\.md|\/use/);
});
