import { bashOperands, bashWriteOperation, evaluateLocalBash, isHardGatedLocalBash } from '../decision/bash-guard.js';
import type { DecisionClient } from '../decision/jev-client.js';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-code';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { AnyDetentExtensionTool, DetentCapabilityPack, ExtensionToolContext, SessionLifecycleHooks, SubagentDefinition, TurnProfile } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { configuredSecrets } from '../gitlab/redact.js';
import { renderNote, renderStatus, renderToolApprovalCard } from '../gitlab/note-streamer.js';
import type { ApprovalRequestRow, IssueSessionRow } from '../types.js';
import { isHubScopePath } from '../workspace/hub-paths.js';
import { allowedInPlan, isWorkspaceTool, type ToolName } from '../workspace/mcp-tools.js';

import type { SessionChannel } from '../orchestrator/channel.js';
import { resolveApproval } from '../orchestrator/lifecycle.js';

type Input = Record<string, unknown>;
type GateResult = PermissionResult & { approvalId?: string; jevConfidence?: number };
type Decision = 'APPROVED' | 'REJECTED';
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
export class ToolDenied extends Error {}
export class ColdHold extends Error {
  constructor(pending: ApprovalRequestRow) {
    super(renderStatus('WAITING_TOOL', pending));
  }
}
const fileTools = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
const readTools = new Set(['Read', 'Glob', 'Grep']);
const branchQueryFlags = new Set(['--list', '-a', '--all', '--show-current', '-r', '--remotes', '-v', '-vv']);
async function safeCommand(command: unknown, prefixes: string[], plan: boolean, workspaceRoot: string) {
  // Only literal shell words qualify for automatic approval.
  if (typeof command !== 'string' || /[^\w ./=:@%+,~^\t-]/.test(command)) return false;
  const words = command.trim().split(/[ \t]+/);
  if (words[0] === 'git' && words[1] === '-C') {
    const [, , dir, subcommand] = words;
    if (!dir || !/^[\w./-]+$/.test(dir) || dir.startsWith('/') || dir.includes('..')) return false;
    if (!['status', 'diff', 'log', 'branch'].includes(subcommand) || !(await contained(workspaceRoot, dir, false)))
      return false;
    words.splice(1, 2); // Apply the configured prefix and argument checks to the same Git query.
  }
  const cmd = words.join(' ');
  if (!prefixes.some((prefix) => cmd === prefix || cmd.startsWith(prefix + ' '))) return false;

  const [program, subcommand, ...args] = words;
  if (program === 'git') {
    if (subcommand === 'branch') return args.every((arg) => branchQueryFlags.has(arg));
    if (['diff', 'log', 'status'].includes(subcommand)) {
      if (args.some((arg) => arg.startsWith('/') || arg.startsWith('~') || arg.split('/').includes('..')))
        return false;
      const separator = args.indexOf('--');
      const options = separator < 0 ? args : args.slice(0, separator);
      // Git accepts abbreviated long options. Keep file output and external helpers gated.
      const unsafe = ['--output', '--ext-diff', '--textconv', '--no-index'];
      return !options.some((arg) => {
        const flag = arg.split('=', 1)[0];
        return flag.startsWith('--') && unsafe.some((option) => option.startsWith(flag));
      });
    }
  }
  return !plan || cmd === 'ls' || cmd === 'pwd';
}

function allowedPath(root: string, target: string, write: boolean) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  if (!write) return true;
  const parts = rel.toLowerCase().split(path.sep);
  return !isHubScopePath(rel) && !['claude.md', 'workflows'].includes(parts[0]) &&
    !parts.some(part => ['.git', '.claude', '.mcp.json'].includes(part));
}

async function contained(root: string, value: unknown, write: boolean) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.startsWith('~') ||
    value.split(path.sep).includes('..')
  )
    return false;
  const target = path.resolve(root, value);
  if (!allowedPath(root, target, write)) return false;
  const resolved = await resolveWorkspacePath(root, target);
  return resolved !== undefined && allowedPath(root, resolved, write);
}

async function resolveWorkspacePath(root: string, target: string) {
  let prefix = target;
  // Walk back only over missing components. A dangling symlink exists for lstat
  // and must fail realpath instead of being treated as a new file.
  while (prefix !== root) {
    try {
      await lstat(prefix);
      break;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      // A linked Git worktree has a .git file. Resolve that existing prefix
      // as well when a descendant cannot exist beneath a regular file.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      prefix = path.dirname(prefix);
    }
  }
  try {
    return path.join(await realpath(prefix), path.relative(prefix, target));
  } catch {
    return undefined;
  }
}

async function blockedBashWrite(command: string, root: string) {
  if (!bashWriteOperation.test(command)) return false;
  for (const operand of new Set(bashOperands(command))) {
    if (!operand) continue;
    const target = path.resolve(root, operand);
    if (isHubScopePath(path.relative(root, target))) return true;
    if (!allowedPath(root, target, false)) continue;
    const resolved = await resolveWorkspacePath(root, target);
    if (resolved === undefined || isHubScopePath(path.relative(root, resolved))) return true;
  }
  return false;
}
// A rejected static path check (including a symlink into the host) must not
// become eligible through the semantic fallback. Check quoted operands intact.
async function bashOperandsContained(command: string, root: string) {
  const write = bashWriteOperation.test(command);
  for (const operand of new Set(bashOperands(command))) {
    if (operand && operand !== '/dev/null' && !await contained(root, operand, write)) return false;
  }
  return true;
}

type GateChannel = Pick<SessionChannel, 'createNote' | 'syncStatusLabel'>;
type GateContext = ({ channel: GateChannel } |
  { gitlab: Pick<GitLabClient, 'createIssueNote' | 'syncIssueStatusLabel'> }) & {
  allowedWorkspaceTools?: readonly ToolName[];
  decision?: DecisionClient;
  config: AppConfig;
  repo: DetentRepository;
  session: IssueSessionRow;
  workspaceRoot: string;
  checkpoint: () => Promise<void>;
  controller: AbortController;
  previousDecision?: ApprovalRequestRow;
  extensionTools?: readonly AnyDetentExtensionTool[];
  capabilities?: readonly DetentCapabilityPack[];
  profile?: TurnProfile;
  onApprovalResolved?: SessionLifecycleHooks['onApprovalResolved'];
}
export class PermissionGate {
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { id: string; wake: () => void; handled: Promise<boolean> };
  readonly extensionTools = new Map<string, AnyDetentExtensionTool>();
  readonly readonly: boolean;
  readonly disableBash: boolean;
  private readonly secrets: string[];
  private subagents = new Map<string, SubagentDefinition>();
  private activeSubagent?: SubagentDefinition;
  readonly governedAgents = new Set<string>();
  requestedMutation = false;

  registerSubagents(agents: readonly SubagentDefinition[] = []) {
    this.subagents = new Map(agents.map(agent => [agent.id, agent]));
  }
  setActiveSubagent(id: string) {
    const agent = this.subagents.get(id);
    if (!agent || this.activeSubagent) return false;
    this.activeSubagent = agent;
    if (!agent.readonly) this.governedAgents.add(id);
    return true;
  }
  clearActiveSubagent(id: string) {
    if (this.activeSubagent?.id === id) this.activeSubagent = undefined;
  }
  private channel: GateChannel;
  private extensionContext: ExtensionToolContext;
  constructor(private ctx: GateContext) {
    const { session, repo, workspaceRoot, profile } = ctx;
    this.registerSubagents(profile?.subagents);
    this.secrets = configuredSecrets(ctx.config);
    this.channel = 'channel' in ctx ? ctx.channel : {
      createNote: body => ctx.gitlab.createIssueNote(session.hubProjectId, session.hubIssueIid, body),
      syncStatusLabel: status => ctx.gitlab.syncIssueStatusLabel(session.hubProjectId, session.hubIssueIid, status),
    };
    this.extensionContext = { workflow: profile?.workflow, session, repo, workspaceRoot, permissionMode: session.permissionMode };
    this.readonly = profile?.readonly ?? false;
    if (profile?.name !== undefined) this.extensionContext.profileName = profile.name;
    this.disableBash = profile?.disableBash ?? false;
    const packTools = ctx.capabilities?.filter(pack => pack.enabled).flatMap(pack => pack.tools) ?? [];
    for (const tool of [...(ctx.extensionTools ?? []), ...packTools]) {
      if (profile?.enabledExtensionTools && !profile.enabledExtensionTools.includes(tool.name)) continue;
      const id = 'mcp__detent__' + tool.name;
      if (this.extensionTools.has(id) || isWorkspaceTool(tool.name) || ['Bash', 'Task', 'AskUserQuestion'].includes(tool.name))
        throw Error('Duplicate tool name: ' + tool.name);
      this.extensionTools.set(id, tool);
    }
  }
  get readonlyWorkspace() {
    return this.readonly || this.activeSubagent?.readonly || (this.ctx.profile?.coordinator && !this.activeSubagent);
  }
  private toolContext(agent?: SubagentDefinition): ExtensionToolContext {
    if (!agent) return { ...this.extensionContext };
    return {
      ...this.extensionContext, profileName: Array.from(agent.id).slice(0, 64).join(''),
      permissionMode: agent.readonly ? 'plan' : this.extensionContext.permissionMode,
      workflow: { ...this.extensionContext.workflow, account: agent.account ?? this.extensionContext.workflow?.account,
        allowPrefixes: agent.allowPrefixes ?? this.extensionContext.workflow?.allowPrefixes },
    };
  }
  private approvalInput(input: Input, agent?: SubagentDefinition) {
    if (!this.ctx.profile?.coordinator) return input;
    const agents = [...this.subagents.values()].filter(candidate => !candidate.readonly).map(candidate => candidate.id);
    return { ...input, __detentCoordinator: { agents, ...(agent && { issuer: agent.id }), ...(agent?.account && { account: agent.account }) } };
  }
  // MCP supplies schema-validated input. Both hot and replayed approvals pass through this handler.
  async invokeExtension(id: string, input: Input) {
    const tool = this.extensionTools.get(id);
    if (!tool) throw Error('未启用此工具');
    const agent = this.activeSubagent;
    const decision = await this.canUseTool(id, input);
    if (decision.behavior === 'deny') throw new ToolDenied(decision.message);
    const ctx = this.toolContext(agent);
    if (decision.approvalId) ctx.approvalId = decision.approvalId;
    if (tool.policy === 'always_approve') {
      const checked = await tool.guard?.(decision.updatedInput, ctx);
      if (checked && !checked.ok) throw new ToolDenied(checked.reason);
    }
    this.ctx.controller.signal.throwIfAborted();
    return tool.execute(decision.updatedInput, ctx);
  }
  canUseTool(name: string, input: Input): Promise<GateResult> {
    const agent = this.activeSubagent;
    const next = this.queue.then(() => this.decide(name, input, agent));
    this.queue = next.catch(() => {});
    return next;
  }
  async resolvePendingApproval(status: Decision, user = 'GitLab', comment = '') {
    const pending = this.pending;
    if (!pending) return false;
    const { repo, session, onApprovalResolved } = this.ctx;
    if (!(await resolveApproval(repo, session, pending.id, status, user, comment, onApprovalResolved, this.secrets))) return false;
    pending.wake();
    return true;
  }
  notify(id: string) {
    if (this.pending?.id !== id) return false;
    this.pending.wake();
    return this.pending.handled;
  }
  private result(a: ApprovalRequestRow, input: Input, extension?: AnyDetentExtensionTool): GateResult {
    if (a.status !== 'APPROVED') return deny(a.decisionComment || '操作已拒绝');
    if (extension) return { behavior: 'allow', updatedInput: input, approvalId: a.id };
    if (a.approvalType === 'ASK_USER') {
      const answers = Object.fromEntries(
        (Array.isArray(input.questions) ? input.questions : []).flatMap((q) =>
          typeof q?.question === 'string' ? [[q.question, a.decisionComment ?? '']] : [],
        ),
      );
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    return { behavior: 'allow', updatedInput: input };
  }
  preflight(name: string, input: Input) {
    return this.check(name, input, this.activeSubagent);
  }
  private async check(name: string, input: Input, agent?: SubagentDefinition): Promise<GateResult | 'ask' | { riskNote: string }> {
    const { session: s, config, workspaceRoot, controller } = this.ctx;
    controller.signal.throwIfAborted();
    // Prevent credential-bearing tool arguments from reaching an extension or an approval record.
    const argumentsJson = JSON.stringify(input);
    if (this.secrets.some(secret => argumentsJson.includes(JSON.stringify(secret).slice(1, -1))))
      return deny('工具参数中含有服务端凭证，请移除后再试。');
    if (Object.hasOwn(input, '__detentCoordinator')) return deny('无效的工具参数');
    const coordinatorOnly = this.ctx.profile?.coordinator && !agent;
    const effectiveReadOnly = coordinatorOnly || agent?.readonly || s.permissionMode === 'plan' || this.readonly;
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (name === 'Task') {
      const target = typeof input.subagent_type === 'string' && this.subagents.get(input.subagent_type);
      return target && (!this.readonly || target.readonly) && (!agent || target.id === agent.id) ? allow : deny('未启用此 Agent');
    }
    const extension = this.extensionTools.get(name);
    if (extension) {
      if (extension.policy !== 'readonly') this.requestedMutation = true;
      if (coordinatorOnly || (agent && !agent.enabledExtensionTools?.includes(extension.name))) {
        return deny('请委派给已启用此工具的 Agent');
      }
      const closeApproval = extension.name === 'detent_close_issue' && this.ctx.profile?.closePolicy === 'approve';
      if (effectiveReadOnly && extension.policy !== 'readonly' && !closeApproval) return deny('当前模式仅允许只读操作');
      if (extension.policy === 'readonly' || extension.policy === 'coding_auto') {
        const checked = await extension.guard?.(input, this.toolContext(agent));
        return checked && !checked.ok ? deny(checked.reason) : allow;
      }
      if (extension.policy !== 'always_approve') return deny('未知工具策略');
      // Cold replay already has a card. invokeExtension checks its guard at execution.
      if (this.previousDecision(extension.name, input, agent)) return 'ask';
      const checked = await extension.guard?.(input, this.toolContext(agent));
      return checked && !checked.ok ? deny(checked.reason) : 'ask';
    }
    if (name.startsWith('mcp__detent__')) {
      name = name.slice('mcp__detent__'.length);
      if (!isWorkspaceTool(name) && name !== 'AskUserQuestion') return deny('未启用此工具');
    }
    if (isWorkspaceTool(name) && this.ctx.allowedWorkspaceTools && !this.ctx.allowedWorkspaceTools.includes(name)) return deny('未启用此工具');
    if (name === 'Edit' || name === 'Write' || (isWorkspaceTool(name) && !allowedInPlan(name)))
      this.requestedMutation = true;
    if (name === 'Bash' && (this.disableBash || agent?.disableBash)) return deny('当前角色禁用 Bash');
    if (fileTools.has(name)) {
      const lookup = name === 'Glob' || name === 'Grep';
      if (
        name === 'Glob' &&
        (typeof input.pattern !== 'string' ||
          path.isAbsolute(input.pattern) ||
          input.pattern.split('/').includes('..'))
      )
        return deny('搜索范围超出工作区');
      if (
        lookup &&
        typeof input.glob === 'string' &&
        (path.isAbsolute(input.glob) || input.glob.split('/').includes('..'))
      )
        return deny('无效的搜索范围');
      if (
        (effectiveReadOnly && !readTools.has(name)) ||
        !(await contained(
          workspaceRoot,
          lookup ? (input.path ?? '.') : input.file_path,
          !readTools.has(name),
        ))
      )
        return deny('此模式或路径不允许文件操作');
      return allow;
    }
    if (name === 'Bash') {
      const { command, description } = input;
      if (typeof command === 'string' && await blockedBashWrite(command, workspaceRoot)) {
        this.requestedMutation = true;
        return deny('此路径不允许 Bash 写入');
      }
      if (!effectiveReadOnly && this.previousDecision(name, input, agent)) return 'ask';
      if (typeof command === 'string' && !isHardGatedLocalBash(command, workspaceRoot)) {
        if (await safeCommand(command, config.safeBashPrefixes, effectiveReadOnly, workspaceRoot)) return allow;
        if (this.ctx.decision && await bashOperandsContained(command, workspaceRoot)) {
          const evaluation = await evaluateLocalBash(this.ctx.decision, command, description, effectiveReadOnly);
          controller.signal.throwIfAborted();
          if (evaluation.allowed) return { ...allow, jevConfidence: evaluation.confidence };
          if (!effectiveReadOnly) return { riskNote: evaluation.riskNote };
          this.requestedMutation = true;
          return deny(evaluation.riskNote);
        }
      }
      if (effectiveReadOnly) this.requestedMutation = true;
    }
    if (isWorkspaceTool(name) && (!effectiveReadOnly || allowedInPlan(name))) return allow;
    if (name === 'ExitPlanMode' && effectiveReadOnly) return deny('请直接输出方案，由 GitLab 用户审批。');
    if (effectiveReadOnly && name !== 'AskUserQuestion') return deny('当前模式仅允许只读操作');
    if (name !== 'Bash' && name !== 'AskUserQuestion') return deny('未启用此工具');
    return 'ask';
  }
  private previousDecision(name: string, input: Input, agent?: SubagentDefinition) {
    const previous = this.ctx.previousDecision;
    return previous?.toolName === name && isDeepStrictEqual(previous.toolInput, this.approvalInput(input, agent)) ? previous : undefined;
  }
  private async decide(name: string, input: Input, agent?: SubagentDefinition): Promise<GateResult> {
    const policy = await this.check(name, input, agent);
    if (policy !== 'ask' && !('riskNote' in policy)) return policy;
    const { session: s, config, repo, controller } = this.ctx;
    const plan = s.permissionMode === 'plan';
    const extension = this.extensionTools.get(name);
    name = name.replace(/^mcp__detent__/, '');
    const previous = this.previousDecision(name, input, agent);
    if (previous) {
      this.ctx.previousDecision = undefined;
      return this.result(previous, input, extension);
    }
    await this.ctx.checkpoint();
    const a = await repo.createApprovalRequest(
      s.id,
      name === 'AskUserQuestion' ? 'ASK_USER' : 'TOOL_USE',
      name,
      this.approvalInput(input, agent),
    );
    try {
      const card = await extension?.renderApprovalCard?.(a.id, input, this.toolContext(agent))
        ?? renderToolApprovalCard({ ...a, toolInput: input }, this.ctx.workspaceRoot, policy === 'ask' ? undefined : policy.riskNote);
      const note = await this.channel.createNote(renderNote(card, this.secrets));
      await repo.updateApprovalNoteId(a.id, note.id);
    } catch (error) {
      await resolveApproval(repo, s, a.id, 'EXPIRED', 'detent', '审批卡片发布失败', this.ctx.onApprovalResolved, this.secrets);
      throw error;
    }
    await repo.updateSessionState(s.id, { status: 'WAITING_TOOL' });
    s.status = 'WAITING_TOOL';
    await this.channel.syncStatusLabel('WAITING_TOOL');
    const deadline = Date.now() + config.hotHoldTimeoutMs;
    let finish!: (handled: boolean) => void;
    const handled = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let consumed = false;
    let wake!: () => void;
    this.pending = { id: a.id, wake: () => wake(), handled };
    try {
      while (true) {
        controller.signal.throwIfAborted();
        // Latch notifications before reading so a local decision during the query wakes us too.
        const notified = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const stored = await repo.getApproval(a.id);
        if (stored && stored.status !== 'PENDING') {
          const status = plan ? 'PLANNING' : 'CODING';
          await repo.updateSessionState(s.id, { status });
          s.status = status;
          await this.channel.syncStatusLabel(status);
          consumed = true;
          return this.result(stored, input, extension);
        }
        if (Date.now() >= deadline) {
          const hold = new ColdHold(a);
          controller.abort(hold);
          throw hold;
        }
        const timer = setTimeout(wake, Math.min(2000, deadline - Date.now()));
        controller.signal.addEventListener('abort', wake, { once: true });
        if (controller.signal.aborted) wake();
        await notified;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', wake);
      }
    } finally {
      this.pending = undefined;
      finish(consumed);
    }
  }
}
