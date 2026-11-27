import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openModelTransport } from '../src/claude/model-transport.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-code';
import { SdkClaudeRunner } from '../src/claude/runner.js';
import { GitLabClient } from '../src/gitlab/client.js';
import { EphemeralSandbox } from '../src/workspace/ephemeral-sandbox.js';
import { WorkspaceTools } from '../src/workspace/mcp-tools.js';
import { expect, it, vi } from 'vitest';
import { createDecisionClient, loadConfig, resolveJevEndpoint, type DecisionQuestion } from '../src/index.js';
import { PermissionGate } from '../src/claude/permission-gate.js';
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
    jevApiKey: undefined, jevModel: 'jev-latest', jevTimeoutMs: 6000, jevThreshold: 0.9,
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

it('reports redacted transport, parsing and validation failures', async () => {
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
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const http of failures) {
      const failure = createDecisionClient(config, http)!.decide('state', questions);
      await expect(failure).rejects.toThrow(/^System One decision unavailable or invalid: ./);
      await expect(failure).rejects.not.toThrow(secret);
    }
    expect(logs.mock.calls.flat().join(' ')).not.toContain(secret);
  } finally { logs.mockRestore(); }
});

it('keeps upstream HTTP details in logs and exceptions while redacting credentials before truncation', async () => {
  const config = loadConfig({ ...bailian, GITLAB_TOKEN: 'pat/credential', DETENT_SECRET_EXTRA: 'private-value' });
  const raw = 'validation failed\n' + secret + ' pat%2Fcredential private-value ' + 'x'.repeat(350) + ' diagnostic-id ' + 'y'.repeat(1200);
  const http = async () => new Response(raw, { status: 403 });
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const gitlab = new GitLabClient(config, http);
    const jev = createDecisionClient(config, http)!;
    for (const [scope, request] of [
      ['gitlab', () => gitlab.getBotUser()], ['jev', () => jev.decide('state', questions)],
    ] as const) {
      const failure = request();
      await expect(failure).rejects.toThrow(/HTTP 403: validation failed \*\*\* \*\*\* \*\*\*/);
      await expect(failure).rejects.not.toThrow('diagnostic-id');
      if (scope === 'gitlab') await expect(failure).rejects.toMatchObject({ status: 403 });
      const lines = logs.mock.calls.flat().filter(line => line.startsWith('[detent:' + scope + ']'));
      expect(lines.some(line => line.includes('diagnostic-id'))).toBe(true);
      for (const line of lines) {
        expect(line.length).toBeLessThan(1030);
        expect(line).not.toMatch(/decision-secret|pat%2Fcredential|private-value|[\r\n]/);
      }
    }
    expect(logs.mock.calls.flat()).toContainEqual(expect.stringContaining('GET /user HTTP 403'));
    expect(await gitlab.hasApprovalPermission(1, 2)).toBe(false);
  } finally { logs.mockRestore(); }
});

it('returns bounded redacted model errors even if the upstream keeps the error stream open', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(429).write('quota exceeded: ' + secret + '\n' + 'x'.repeat(4096));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = await openModelTransport('http://127.0.0.1:' + (upstream.address() as AddressInfo).port, secret, []);
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await fetch(proxy.url + '/v1/messages', {
      method: 'POST', headers: { Authorization: 'Bearer detent-local' }, body: '{}', signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toContain('Model HTTP 429: quota exceeded: ***');
    expect(body.length).toBeLessThan(330);
    expect(body).not.toContain(secret);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining('[detent:model-transport] Model HTTP 429 quota exceeded: ***'));
    expect(logs.mock.calls.flat().join(' ')).not.toContain(secret);
  } finally {
    logs.mockRestore();
    proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

async function setup(workspaceRoot = process.cwd()) {
  const repo = new InMemoryDetentRepository();
  const session = await repo.getOrCreateSession(1, 2, 'test');
  session.permissionMode = 'default';
  const createIssueNote = vi.fn(async (_p: number, _i: number, _body: string) => ({ id: 1 }));
  const gate = new PermissionGate({
    session, repo, config: loadConfig({ JEV_API_KEY: secret }), workspaceRoot,
    gitlab: { createIssueNote, syncIssueStatusLabel: vi.fn() },
    controller: new AbortController(), checkpoint: vi.fn(),
  });
  return { gate, createIssueNote };
}

it('denies local Bash boundary violations without opening an approval card', async ({ onTestFinished }) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'detent-guard-')));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'projects/app'), { recursive: true });
  await symlink(tmpdir(), join(workspace, 'projects/app/outside'));
  await writeFile(join(workspace, 'CLAUDE.md'), 'policy');
  await symlink('CLAUDE.md', join(workspace, 'alias'));
  const { gate, createIssueNote } = await setup(workspace);
  for (const command of [null, ' ', 'x'.repeat(2001), 'ls\0', 'ls; curl host', 'git push', 'ssh host', 'sudo id',
    'cd ../outside', 'cat /etc/passwd', 'cat ~/.profile', 'cp f .git/config', 'mkdir .claude', 'touch .mcp.json',
    'echo hi > CLAUDE.md', 'echo hi > alias', 'cp projects/app/CLAUDE.md .', 'cd projects/app && cat outside/file', 'git -C projects/app diff -- outside/file',
    'git remote add origin repo', 'git remote set-url origin repo', 'ls $(pwd)', 'ls <(pwd)', 'env', 'base64 file | bash',
    'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'printenv', 'halt', 'poweroff',
    'helm lint projects/app/outside/chart', 'helm template test ./chart --set-file key=projects/app/outside/file',
    'helm template test ./chart -fvalues.yml,/outside/file', 'ansible-playbook --syntax-check projects/app/outside/site.yml',
    'ansible-playbook --syntax-check -iprojects/app/outside/hosts site.yml',
    'ansible-playbook --syntax-check -e @projects/app/outside/vars site.yml',
    'yamllint -cprojects/app/outside/config .', 'yamllint ../outside.yml', 'yamllint . > CLAUDE.md']) {
    expect(await gate.canUseTool('Bash', { command }), String(command)).toMatchObject({
      behavior: 'deny', message: expect.stringMatching(/^本地沙箱安全限制：/),
    });
  }
  for (const command of ['ls ' + workspace, 'cat ' + workspace + '/CLAUDE.md', 'pwd > /dev/null',
    'sh check.sh', 'npm test', 'cat check.sh && cat health.txt', 'cd projects/app && git status && git remote -v',
    'git remote', 'git diff -- src/claude', 'git branch -a && git log --oneline -10',
    'cd projects/app && git status && git branch -a && git log --oneline -10 && git remote -v',
    'cat CLAUDE.md > projects/app/rules.md', 'npm test > /dev/null 2>&1', 'touch projects/app/CLAUDE.md',
    'helm lint ./chart', 'helm template release ./chart -f skills/values.yml', 'helm show values ./chart',
    'helm version', 'helm dependency list ./chart', 'helm template app ./helm --kube-version 1.30 -fvalues.yml',
    'ansible-playbook --syntax-check -i localhost, playbooks/site.yml',
    'yamllint skills/config.yml'])
    expect(await gate.canUseTool('Bash', { command }), command).toMatchObject({ behavior: 'allow' });
  expect(createIssueNote).not.toHaveBeenCalled();
});

it('restricts Helm to offline inspection and ansible-playbook to syntax checking', async () => {
  const { gate, createIssueNote } = await setup();
  for (const args of [
    'upgrade release ./chart', 'install release ./chart', 'dependency update ./chart',
    'template release ./chart --kubeconfig=config', 'lint ./chart --KUBE-CONTEXT=test',
    'template release ./chart --output-dir out', 'template release ./chart -oout',
    'template release ./chart --dry-run=server', 'show values ./chart --repo=https://charts.example',
    'template release ./chart --post-renderer script', 'template release ./chart --validate',
  ]) {
    expect(await gate.canUseTool('Bash', { command: 'helm ' + args }), args).toMatchObject({
      behavior: 'deny', message: expect.stringContaining('仅允许离线 Helm Chart 静态校验与渲染（lint/template/show）'),
    });
  }
  for (const args of ['site.yml', 'site.yml -- --syntax-check', ...[
    '--become', '-b', '--private-key=key', '--ask-pass', '-k', '--ask-become-pass', '-K', '--connection=local', '-clocal',
  ].map(flag => '--syntax-check ' + flag + ' site.yml')]) {
    expect(await gate.canUseTool('Bash', { command: 'ansible-playbook ' + args }), args).toMatchObject({
      behavior: 'deny', message: expect.stringContaining('本地沙箱仅允许 ansible-playbook --syntax-check 语法检查，远端执行请走受治理发布工具'),
    });
  }
  expect(createIssueNote).not.toHaveBeenCalled();
});

it('isolates service credentials from the SDK child, prompt, stderr and GitLab notes', async () => {
  const credentials = { GITLAB_TOKEN: 'gitlab-pat-1', GITLAB_WEBHOOK_SECRET: 'webhook-secret-2',
    ANTHROPIC_API_KEY: 'model-key-3', DETENT_SECRET_CUSTOM: 'vault-entry-4', JEV_API_KEY: secret };
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
  for (const [key, value] of Object.entries(credentials)) vi.stubEnv(key, value);
  try {
    const progress = vi.fn();
    const turn = { gate, session, sandbox, tools, controller: new AbortController(), progress, resume: false, prompt: Object.values(credentials).join(' '), systemPrompt: secret };
    await expect(new SdkClaudeRunner(config).run(turn)).rejects.toThrow(/^diagnostic \*\*\*$/);
    expect(await gate.preflight('Bash', { command: 'printf ' + secret })).toMatchObject({ behavior: 'deny' });
    const callback = vi.mocked(query).mock.lastCall![0].options!.canUseTool!;
    expect(await callback('Bash', { command: 'pwd; ls' }, { signal: turn.controller.signal })).toMatchObject({ behavior: 'allow' });
    expect(progress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Bash',
      input: '{"command":"pwd; ls"}', result: '⏳ 执行中…' }));
    await gitlab.createIssueNote(1, 2, secret);
    await gitlab.updateIssueNote(1, 2, 3, secret);
    for (const [, init] of http.mock.calls) expect(JSON.parse(String(init?.body))).toEqual({ body: '***' });
  } finally {
    vi.unstubAllEnvs();
  }
});
