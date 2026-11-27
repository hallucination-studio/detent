// Run inside the delivery image with: node scripts/smoke-live.mjs
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

const started = performance.now();
const secretForms = new Set();

function registerSecrets(values) {
  for (const value of values.filter(Boolean)) {
    secretForms.add(value);
    secretForms.add(JSON.stringify(value).slice(1, -1));
    secretForms.add(encodeURIComponent(value.toWellFormed()));
  }
}
registerSecrets(Object.entries(process.env)
  .filter(([key]) => /^(DETENT_SECRET_|.*(?:PASSWORD|TOKEN|SECRET|API_KEY|ACCESS_KEY_ID)$)/.test(key))
  .flatMap(([, value]) => [value, value.trim()]));

function redact(message) {
  let text = String(message);
  for (const secret of [...secretForms].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '***');
  return text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ');
}

function check(condition, message) {
  if (!condition) throw Error(message);
}

// The supervisor owns the temporary directory and the entire worker process group.
// A stuck SDK, git clone, or sandbox preparation can outlive an AbortController.
async function supervise() {
  const timeout = Number(process.env.SMOKE_TIMEOUT_MS ?? '90000');
  check(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2147483647, 'Invalid SMOKE_TIMEOUT_MS');
  const root = mkdtempSync(join(tmpdir(), 'detent-smoke-'));
  let child, timer, interrupted, completed = false;
  let stage = 'startup';
  const stop = () => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const cancel = signal => { interrupted = signal; stop(); };
  try {
    child = fork(new URL(import.meta.url), ['--smoke-worker'], {
      detached: true, execArgv: [], env: { ...process.env, EPHEMERAL_ROOT: root },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    timer = setTimeout(() => cancel('hard timeout (' + timeout + ' ms)'), timeout);
    child.on('message', message => {
      if (message.done) completed = true;
      if (message.line) {
        if (message.line.startsWith('Stage ')) stage = message.line;
        print(message.line);
      }
    });
    const [code, signal] = await once(child, 'exit');
    check(!interrupted && completed && code === 0, (interrupted || 'worker exit ' + (code ?? signal)) + ' during ' + stage);
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    try { stop(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

function print(message) {
  console.log('[+' + ((performance.now() - started) / 1000).toFixed(1) + 's] ' + redact(message));
}

async function smoke(log) {
  const issues = new Set();
  const scan = text => {
    for (const marker of ['Model not exist', 'Request timeout', '⛔']) {
      if (text.toLowerCase().includes(marker.toLowerCase())) issues.add(marker);
    }
  };
  console.error = (...args) => {
    const message = format(...args);
    scan(message);
    log(message);
  };
  const { loadConfig, GitLabClient, createDecisionClient, loadHubCapabilities, defineExtensionTool } =
    await import('../packages/core/dist/index.js');
  const { configuredSecrets } = await import('../packages/core/dist/gitlab/redact.js');
  const { loadDeliveryConfig, createDeliveryTurnProfileResolver, HttpJumpServerClient, createJumpServerTools } =
    await import('../packages/delivery/dist/index.js');
  const { authSecrets } = await import('../packages/delivery/dist/config.js');
  const { resolveJumpServerSettings } = await import('../packages/delivery/dist/hub-config.js');
  const { EphemeralSandbox } = await import('../packages/core/dist/workspace/ephemeral-sandbox.js');
  const { WorkspaceTools } = await import('../packages/core/dist/workspace/mcp-tools.js');
  const { SdkClaudeRunner } = await import('../packages/core/dist/claude/runner.js');
  const { PermissionGate } = await import('../packages/core/dist/claude/permission-gate.js');
  const { buildSystemPrompt } = await import('../packages/core/dist/claude/prompts.js');
  const { z } = await import('zod');

  const config = loadConfig();
  const fallback = loadDeliveryConfig();
  registerSecrets(configuredSecrets(config));
  const target = process.env.SMOKE_TARGET_ASSET ?? 'paas-develop-kafka-1';
  check(target.trim() && target.length <= 128 && !/[\x00-\x1f\x7f]/.test(target), 'Invalid SMOKE_TARGET_ASSET');
  log('Stage 1 /healthz' + (process.env.SMOKE_SKIP_HEALTHZ === '1' ? ' skipped' : ''));
  if (process.env.SMOKE_SKIP_HEALTHZ !== '1') {
    const response = await fetch('http://127.0.0.1:' + config.port + '/healthz', { redirect: 'error' });
    check(response.status === 200, '/healthz returned HTTP ' + response.status);
    check((await response.json()).ok === true, '/healthz did not return ok=true');
    log('Healthy (HTTP 200, ok=true)');
  }

  log('Stage 2 Hub capabilities and Jev read-only probe');
  const realGitLab = new GitLabClient(config, (url, init) => {
    check(init?.method === 'GET', 'Smoke GitLab transport permits only GET');
    return fetch(url, init);
  });
  const doc = await loadHubCapabilities(realGitLab, config.gitlabHubProjectId, config.gitlabHubDefaultBranch);
  check(doc.present && !doc.invalid, 'Missing or invalid Hub capabilities.json');
  const packs = Object.entries(doc.entries).filter(([, entry]) => entry.type === 'jumpserver' && entry.enabled !== false);
  const pack = packs.find(([name]) => name.toLowerCase() === 'jumpserver') ?? (packs.length === 1 && packs[0]);
  check(pack, 'Expected an identifiable enabled JumpServer capability, found ' + packs.length);
  const [packName, entry] = pack;
  const settings = resolveJumpServerSettings(entry, config.secrets, fallback);
  check(settings.config, settings.setupHint);
  config.additionalSecrets = [fallback, settings.config].flatMap(c =>
    [...authSecrets(c.jumpserverReadonlyAuth), ...authSecrets(c.jumpserverJobAuth)]);
  registerSecrets(configuredSecrets(config));
  // Include escaped forms before the runner truncates any tool preview.
  config.additionalSecrets = [...secretForms];

  const decision = createDecisionClient(config);
  check(decision, 'Jev is disabled');
  const { readonly } = await decision.decide({ command: 'uptime' }, {
    readonly: { type: 'choice', instructions: 'Classify this command by its effect on the host.',
      criteria: { read: 'Reads state without changing it', write: 'Changes host state' } },
  });
  check(readonly?.choice === 'read', 'Jev did not classify uptime as read-only');
  log('JumpServer enabled and Jev classified uptime as read-only');

  log('Stage 3 direct jms_list_assets for ' + target);
  const http = new HttpJumpServerClient(settings.config, config);
  let targetId;
  const completedCommands = [];
  const client = {
    listAssets: query => http.listAssets(query),
    async runShell(request) {
      check(targetId && request.assetIds.length === 1 && request.assetIds[0] === targetId,
        'jms_shell requested an asset outside the smoke target');
      const result = await http.runShell(request);
      scan(result.outputSummary);
      if (result.status !== 'SUCCESS') {
        const message = 'JumpServer inspection status=' + result.status;
        issues.add(message);
        throw Error(message);
      }
      completedCommands.push(...request.commands);
      return result;
    },
  };
  const tools = createJumpServerTools({ client, config: settings.config, defaultAccount: settings.defaultAccount, decision })
    .filter(tool => ['jms_list_assets', 'jms_shell'].includes(tool.name) && tool.policy === 'readonly');
  check(tools.length === 2, 'Missing production jms_list_assets or jms_shell read-only tool');
  const before = performance.now();
  const assets = await tools.find(tool => tool.name === 'jms_list_assets').execute({ search: target });
  log('jms_list_assets count=' + assets.length + ' latency=' + Math.round(performance.now() - before) + 'ms');
  const exact = assets.filter(asset => [asset.name, asset.address, asset.id].includes(target));
  check(exact.length === 1, 'Expected one exact target asset, found ' + exact.length);
  targetId = exact[0].id;

  log('Stage 4 unified SDK turn');
  const prompt = '只读巡检：检查 ' + target + ' 上的服务进程、端口监听和系统运行状态，给出简明证据。不要修改任何配置。';
  const issue = { iid: 1, title: 'Live smoke inspection', description: prompt, labels: [], state: 'opened' };
  const session = { id: randomUUID(), sessionKind: 'issue', hubProjectId: config.gitlabHubProjectId,
    hubIssueIid: issue.iid, issueTitle: issue.title, claudeSessionId: randomUUID(), permissionMode: 'plan',
    status: 'PLANNING', lastMessageSeq: 0 };
  const notes = new Map();
  const gitlab = Object.assign(Object.create(realGitLab), {
    getIssue: async () => issue,
    async createIssueNote(_project, _iid, body) {
      const id = notes.size + 1;
      notes.set(id, body);
      return { id, body };
    },
    async updateIssueNote(_project, _iid, id, body) { notes.set(id, body); },
    async syncIssueStatusLabel(_project, _iid, status) { issue.labels = [status]; },
    hasApprovalPermission: async () => false,
  });

  const calls = new Map();
  const repo = {
    listActiveWorktrees: async () => [],
    async createApprovalRequest() {
      issues.add('Unexpected approval request');
      throw Error('Unexpected approval request');
    },
  };
  const capabilities = [{ name: packName, enabled: true, tools }];
  const resolveProfile = createDeliveryTurnProfileResolver(settings.config, { hubDefaultBranch: config.gitlabHubDefaultBranch });
  const profile = await resolveProfile({ session, repo, gitlab, capabilities, purpose: 'turn' });
  log('Resolved profile=' + profile.name);
  check(profile.name === 'unified' && !profile.blockedMessage, 'Expected an available unified profile');
  const planTool = defineExtensionTool({
    name: 'detent_submit_plan', policy: 'readonly', description: '提交本轮实施方案供 GitLab 用户审批。',
    schema: { plan: z.string().trim().min(1).max(16000) },
    async execute() { issues.add('detent_submit_plan called'); return { submitted: true }; },
  });
  const controller = new AbortController();
  const host = new EphemeralSandbox(config, repo, gitlab);
  const sandbox = await host.prepareTurnSandbox(session, profile.sandboxScope);
  const count = name => [...calls.values()].filter(tool => tool === name).length;
  const checkedTools = ['jms_list_assets', 'jms_shell', 'Task', 'detent_submit_plan'];
  try {
    const gate = new PermissionGate({
      config, session, gitlab, repo, decision, controller, capabilities, workspaceRoot: sandbox.workspaceRoot,
      checkpoint: async () => {}, extensionTools: [planTool], allowedWorkspaceTools: [],
      profile: { ...profile, disableBash: true, enabledExtensionTools: [...profile.enabledExtensionTools, planTool.name] },
    });
    let tail = '';
    const result = await new SdkClaudeRunner(config).run({
      controller, session, sandbox, resume: false, prompt, gate, allowedWorkspaceTools: [],
      tools: new WorkspaceTools(host, sandbox, session.id, true),
      systemPrompt: [buildSystemPrompt(session, [], [], gate.readonly), profile.extraSystemPrompt].filter(Boolean).join('\n'),
      progress({ id, name, input, result }) {
        calls.set(id, name);
        scan(input);
        scan(result);
        if (result.startsWith('❌')) issues.add(name + ' failed');
        log('STEP ' + name + ' => ' + redact(result).slice(0, 300));
      },
      appendText(delta) {
        scan(tail + delta);
        tail = (tail + delta).slice(-32);
      },
    });
    scan(result);
    check(result.trim(), 'Empty SDK result');
    log('RESULT ' + redact(result).slice(0, 1000));
    for (const name of checkedTools) {
      const n = count(name);
      if (name.startsWith('jms_') ? n < 1 : n > 0) issues.add('Unexpected ' + name + ' count=' + n);
    }
    if (completedCommands.length < 2) issues.add('Expected at least two successful inspection commands');
    check(!issues.size, [...issues].join(', '));
  } finally {
    try {
      const counts = Object.fromEntries(checkedTools.map(name => [name, count(name)]));
      log('Turn summary ' + JSON.stringify({ counts, completedCommandCount: completedCommands.length, completedCommands, errors: [...issues] }));
    } finally { await host.destroy(sandbox); }
  }
}

if (process.argv[2] === '--smoke-worker' && process.send) {
  const log = line => process.send({ line: redact(line) });
  // Libraries also report service errors. Only sanitized messages cross the IPC boundary.
  try {
    await smoke(log);
    process.send({ done: true }, () => process.exit(0));
  } catch (error) {
    process.send({ line: redact(error.stack ?? error) }, () => process.exit(1));
  }
} else {
  try {
    await supervise();
    print('LIVE_SMOKE_OK');
  } catch (error) {
    print('LIVE_SMOKE_FAILED ' + error.message);
    process.exitCode = 1;
  }
}
