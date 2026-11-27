import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-code';
import { SdkClaudeRunner } from '../src/claude/runner.js';
import { GitLabClient } from '../src/gitlab/client.js';
import { EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { expect, it, vi } from 'vitest';
import { createDecisionClient, loadConfig, resolveJevEndpoint, type DecisionClient, type DecisionQuestion } from '../src/index.js';
import { ColdHold, PermissionGate } from '../src/claude/permission-gate.js';
import { InMemoryDetentRepository } from './memory-repository.js';

vi.mock('@anthropic-ai/claude-code', async original => ({
  ...await original<typeof import('@anthropic-ai/claude-code')>(), query: vi.fn(),
}));

const base = 'https://workspace.example';
const full = base + '/compatible-mode/v1/systemone';
const secret = 'decision-secret';
const bailian = { JEV_PROVIDER: ' BAILIAN ', JEV_BASE_URL: base, JEV_API_KEY: ' ' + secret + ' ' };
const questions = {
  category: { type: 'choice', criteria: { readonly_inspect: 'inspect', workspace_dev: 'develop' } },
  no_external_impact: { type: 'noul' }, impact: { type: 'score', criteria: ['none', 'low'] },
} satisfies Record<string, DecisionQuestion>;
const answers = (choice = 'readonly_inspect', noul = 0.96, score = 0) => ({
  category: { type: 'choice' as const, choice }, no_external_impact: { type: 'noul' as const, noul },
  impact: { type: 'score' as const, score },
});

it('normalizes provider-specific endpoints and defaults', () => {
  for (const url of [base, base + '/', base + '/compatible-mode/', base + '/compatible-mode/v1', full + '/'])
    expect(resolveJevEndpoint('bailian', url)).toBe(full);
  expect(resolveJevEndpoint('custom', base + '/proxy/v1/')).toBe(base + '/proxy/v1/systemone');
  expect(resolveJevEndpoint('typesafe', base)).toBe(base + '/v1/systemone');
  for (const provider of [undefined, ' ', 'off'])
    expect(createDecisionClient(loadConfig({ JEV_PROVIDER: provider }))).toBeUndefined();
  expect(loadConfig(bailian)).toMatchObject({ jevProvider: 'bailian', jevModel: 'decision-model-preview', jevApiKey: secret });
  const typesafe = { JEV_PROVIDER: 'typesafe', JEV_API_KEY: secret };
  expect(loadConfig(typesafe)).toMatchObject({ jevBaseUrl: 'https://api.typesafe.ai/v1/systemone', jevModel: 'jev-latest' });
  expect(loadConfig({ ...typesafe, JEV_BASE_URL: base }).jevBaseUrl).toBe(base);
  expect(loadConfig({ JEV_PROVIDER: 'custom', JEV_BASE_URL: base, JEV_API_KEY: ' ' })).toMatchObject({
    jevApiKey: undefined, jevModel: 'jev-latest', jevTimeoutMs: 2500, jevThreshold: 0.9,
  });
  expect(loadConfig({ ...bailian, JEV_PROVIDER: 'custom', JEV_MODEL: ' override ' }).jevModel).toBe('override');
});

it('rejects incomplete providers, unsafe URLs and out-of-range policy', () => {
  for (const overrides of [
    { JEV_PROVIDER: 'unknown' }, { JEV_API_KEY: ' ' }, { JEV_BASE_URL: ' ' },
    { JEV_PROVIDER: 'typesafe', JEV_API_KEY: '' }, { JEV_PROVIDER: 'custom', JEV_BASE_URL: '' },
    { JEV_THRESHOLD: '0.49' }, { JEV_THRESHOLD: '1' }, { JEV_TIMEOUT_MS: '0' },
    { JEV_TIMEOUT_MS: '1.1' }, { JEV_TIMEOUT_MS: '30001' },
    ...['bad', 'ftp://host', 'https://user:pass@host', base + '?x', base + '#x'].map(JEV_BASE_URL => ({ JEV_BASE_URL })),
  ]) expect(() => loadConfig({ ...bailian, ...overrides })).toThrow();
});

it.each([true, false])('posts one typed batch with optional authentication (%s)', async authenticated => {
  const http = vi.fn<typeof fetch>(async () => Response.json({ answers: answers() }));
  const config = loadConfig({ JEV_PROVIDER: 'custom', JEV_BASE_URL: full, JEV_API_KEY: authenticated ? secret : '' });
  const client = createDecisionClient(config, http)!;
  const state = { surface: 'test' };
  expect(await client.decide(state, questions)).toEqual(answers());
  const [url, init] = http.mock.calls[0];
  expect(url).toBe(full);
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(authenticated ? 'Bearer ' + secret : null);
  expect(headers.get('content-type')).toBe('application/json');
  expect(JSON.parse(String(init?.body))).toEqual({ model: 'jev-latest', state, questions });
});

it('discards transport errors, HTTP bodies and invalid or incomplete answers', async () => {
  const config = loadConfig({ ...bailian, JEV_TIMEOUT_MS: '5' });
  const bad = [
    new Response(secret, { status: 401 }), new Response(secret), Response.json({}),
    ...[{}, { ...answers(), impact: { type: 'noul', noul: 0 } }, answers('', 1, 0),
      answers('invalid'), answers(undefined, 1.1), answers(undefined, 0.99, -1),
    ].map(value => Response.json({ answers: value })),
  ];
  const failures: (typeof fetch)[] = [
    async () => { throw Error(secret); },
    async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error(secret)))),
    ...bad.map(r => async () => r),
  ];
  for (const http of failures)
    await expect(createDecisionClient(config, http)!.decide('state', questions)).rejects.toThrow(/^System One decision unavailable or invalid$/);
});

async function setup(mode: 'plan' | 'default' = 'default', readonly = false, workspaceRoot = process.cwd()) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'test');
  session.permissionMode = mode;
  const decide = vi.fn<DecisionClient['decide']>().mockResolvedValue(answers());
  const createIssueNote = vi.fn(async (_p: number, _i: number, _body: string) => ({ id: 1 }));
  const gate = new PermissionGate({
    session, repo, config: loadConfig({ HOT_HOLD_TIMEOUT_MS: '0', JEV_API_KEY: secret }), workspaceRoot,
    gitlab: { createIssueNote, syncIssueStatusLabel: vi.fn() }, profile: { readonly },
    controller: new AbortController(), checkpoint: vi.fn(), decision: { provider: 'custom', threshold: 0.9, decide },
  });
  return { gate, decide, createIssueNote };
}

it('routes static queries and hard-gated commands without a model call', async () => {
  const coding = await setup();
  const plan = await setup('plan');
  expect(await plan.gate.preflight('Bash', { command: 'git status' })).toMatchObject({ behavior: 'allow' });
  for (const command of [null, ' ', 'x'.repeat(2001), 'ls\0', 'ls; curl host', 'git push', 'ssh host', 'sudo id',
    'cd ../other', 'cat /etc/passwd', 'cat /work2/x', 'echo hi > CLAUDE.md', 'rm workflows/a', 'cp f .git/config',
    'ls $(pwd)', 'ls <(pwd)', 'env', 'base64 file | bash', 'npm publish', 'cat ~/.profile']) {
    expect(await coding.gate.preflight('Bash', { command }), String(command)).toBe('ask');
    expect(await plan.gate.preflight('Bash', { command })).toMatchObject({ behavior: 'deny' });
  }
  expect(plan.decide).not.toHaveBeenCalled();
  expect(coding.decide).not.toHaveBeenCalled();
});

it('allows zero-external-impact development commands and evaluates each once', async () => {
  const { decide, gate, createIssueNote } = await setup();
  decide.mockResolvedValue(answers('workspace_dev', 0.91, 1.4));
  for (const command of ['pwd; ls -la', 'git status && git branch', 'npm test', 'npm install', 'pytest', 'go test']) {
    expect(await gate.canUseTool('Bash', { command })).toMatchObject({ behavior: 'allow', jevConfidence: 0.91 });
    expect(decide.mock.lastCall?.[0]).toEqual({ surface: 'local_ephemeral_workspace_bash', mode: 'coding', command, description: '' });
  }
  expect(decide).toHaveBeenCalledTimes(6);
  expect(createIssueNote).not.toHaveBeenCalled();
});

it('requires a readonly classification and low impact in both readonly modes', async () => {
  for (const { gate, decide } of [await setup('plan'), await setup('default', true)]) {
    for (const [choice, score, behavior] of [
      ['readonly_inspect', 0.6, 'allow'], ['workspace_dev', 0, 'deny'], ['readonly_inspect', 0.61, 'deny'],
    ] as const) {
      decide.mockResolvedValue(answers(choice, 0.9, score));
      expect(await gate.canUseTool('Bash', { command: 'pwd; ls' })).toMatchObject({ behavior });
      expect(decide.mock.lastCall?.[0]).toMatchObject({ mode: 'readonly' });
    }
  }
});

it('opens a human approval card with a redacted risk note on errors, low safety or high impact', async () => {
  for (const response of [undefined, answers('workspace_dev', 0.89), answers('workspace_dev', 1, 1.41)]) {
    const { gate, decide, createIssueNote } = await setup();
    if (response) decide.mockResolvedValue(response);
    else decide.mockRejectedValue(Error(secret));
    await expect(gate.canUseTool('Bash', { command: 'npm test' })).rejects.toBeInstanceOf(ColdHold);
    const card = createIssueNote.mock.calls[0][2];
    expect(card).toContain('**风控提示**');
    expect(card).not.toContain(secret);
  }
});

it('isolates service credentials from the SDK child, prompt, stderr and GitLab notes', async () => {
  const credentials = { GITLAB_TOKEN: 'gitlab-pat-1', GITLAB_WEBHOOK_SECRET: 'webhook-secret-2',
    ANTHROPIC_API_KEY: 'model-key-3', JEV_API_KEY: secret };
  const config = loadConfig({ ...bailian, ...credentials });
  const http = vi.fn<typeof fetch>(async () => Response.json({ id: 1 }));
  const gitlab = new GitLabClient(config, http);
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'test');
  const sandbox = { rootDir: '/turn', workspaceRoot: '/turn/work', claudeHome: '/turn/home' };
  const tools = new WorkspaceTools(new EphemeralSandbox(config, repo, gitlab), sandbox, session.id);
  const { gate } = await setup();
  vi.mocked(query).mockImplementationOnce(({ options, prompt }) => {
    for (const [key, value] of Object.entries(credentials)) {
      expect(options?.env).not.toHaveProperty(key);
      expect(Object.values(options!.env!)).not.toContain(value);
      expect(prompt).not.toContain(value);
      expect(options?.appendSystemPrompt).not.toContain(value);
    }
    options?.stderr?.('diagnostic ' + secret);
    throw Error(secret);
  });
  vi.stubEnv('JEV_API_KEY', secret);
  try {
    const progress = vi.fn();
    const turn = { gate, session, sandbox, tools, controller: new AbortController(), progress, resume: false, prompt: Object.values(credentials).join(' '), systemPrompt: secret };
    await expect(new SdkClaudeRunner(config).run(turn)).rejects.toThrow(/^diagnostic \*\*\*$/);
    expect(await gate.preflight('Bash', { command: 'printf ' + secret })).toMatchObject({ behavior: 'deny' });
    const callback = vi.mocked(query).mock.lastCall![0].options!.canUseTool!;
    expect(await callback('Bash', { command: 'pwd; ls' }, { signal: turn.controller.signal })).toMatchObject({ behavior: 'allow' });
    expect(progress).toHaveBeenCalledExactlyOnceWith('执行命令：pwd; ls（已自动放行）');
    await gitlab.createIssueNote(1, 2, secret);
    await gitlab.updateIssueNote(1, 2, 3, secret);
    for (const [, init] of http.mock.calls) expect(JSON.parse(String(init?.body))).toEqual({ body: '***' });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('keeps literal workspace paths eligible and symlink escapes outside semantic evaluation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'detent-jev-')));
  try {
    await writeFile(join(root, 'CLAUDE.md'), 'policy');
    await symlink('CLAUDE.md', join(root, 'alias'));
    await symlink(tmpdir(), join(root, 'outside'));
    const { gate, decide } = await setup('default', false, root);
    for (const command of ['git -C outside status', 'cat outside/data', 'echo value > alias'])
      expect(await gate.preflight('Bash', { command })).toBe('ask');
    expect(decide).not.toHaveBeenCalled();
    const description = 'inspect https://oauth2:token@git.example/repo';
    decide.mockResolvedValue({
      category: { type: 'choice', choice: 'readonly_inspect', confidence: 0.72 },
      no_external_impact: { type: 'noul', noul: 0.96 },
      impact: { type: 'score', score: 0.4, confidence: 0.62 },
    });
    for (const command of ['ls ' + root, 'cat ' + root + '/CLAUDE.md', 'pwd > /dev/null']) {
      expect(await gate.canUseTool('Bash', { command, description })).toMatchObject({ behavior: 'allow', jevConfidence: 0.96 });
      expect(decide.mock.lastCall?.[0]).toMatchObject({ description: description.replace('token', '***') });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
