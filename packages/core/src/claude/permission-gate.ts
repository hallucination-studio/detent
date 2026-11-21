import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-code';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { AnyDetentExtensionTool, ExtensionToolContext, SessionLifecycleHooks, TurnProfile } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { renderNote, renderToolApprovalCard } from '../gitlab/note-streamer.js';
import type { ApprovalRequestRow, IssueSessionRow } from '../types.js';
import { allowedInPlan, isWorkspaceTool } from '../workspace/mcp-tools.js';

import { resolveApproval } from '../orchestrator/lifecycle.js';

type Input = Record<string, unknown>;
type GateResult = PermissionResult & { approvalId?: string };
type Decision = 'APPROVED' | 'REJECTED';
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
export class ColdHold extends Error {
  constructor() {
    super('Waiting for GitLab approval');
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
  return !['claude.md', 'workflows'].includes(parts[0]) &&
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
  let prefix = path.resolve(root, value);
  if (!allowedPath(root, prefix, write)) return false;
  // Walk back only over missing components. A dangling symlink exists for lstat
  // and must fail realpath instead of being treated as a new file.
  while (prefix !== root) {
    try {
      await lstat(prefix);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      prefix = path.dirname(prefix);
    }
  }
  try {
    const suffix = path.relative(prefix, path.resolve(root, value));
    return allowedPath(root, path.join(await realpath(prefix), suffix), write);
  } catch {
    return false;
  }
}
interface GateContext {
  config: AppConfig;
  repo: DetentRepository;
  gitlab: Pick<GitLabClient, 'createIssueNote' | 'syncIssueStatusLabel'>;
  session: IssueSessionRow;
  workspaceRoot: string;
  checkpoint: () => Promise<void>;
  controller: AbortController;
  previousDecision?: ApprovalRequestRow;
  extensionTools?: readonly AnyDetentExtensionTool[];
  profile?: TurnProfile;
  onApprovalResolved?: SessionLifecycleHooks['onApprovalResolved'];
}
export class PermissionGate {
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { id: string; wake: () => void; handled: Promise<boolean> };
  readonly extensionTools = new Map<string, AnyDetentExtensionTool>();
  readonly readonly: boolean;
  readonly disableBash: boolean;
  private extensionContext: ExtensionToolContext;
  constructor(private ctx: GateContext) {
    const { session, repo, workspaceRoot, profile } = ctx;
    this.extensionContext = { session, repo, workspaceRoot, permissionMode: session.permissionMode };
    this.readonly = profile?.readonly ?? false;
    if (profile?.name !== undefined) this.extensionContext.profileName = profile.name;
    this.disableBash = profile?.disableBash ?? false;
    for (const tool of ctx.extensionTools ?? []) {
      if (profile?.enabledExtensionTools && !profile.enabledExtensionTools.includes(tool.name)) continue;
      const id = 'mcp__detent__' + tool.name;
      if (this.extensionTools.has(id) || isWorkspaceTool(tool.name) || ['Bash', 'AskUserQuestion'].includes(tool.name))
        throw Error('Duplicate tool name: ' + tool.name);
      this.extensionTools.set(id, tool);
    }
  }
  // MCP supplies schema-validated input. Both hot and replayed approvals pass through this handler.
  async invokeExtension(id: string, input: Input) {
    const tool = this.extensionTools.get(id);
    if (!tool) throw Error('未启用此工具');
    const decision = await this.canUseTool(id, input);
    if (decision.behavior === 'deny') throw Error(decision.message);
    const ctx = decision.approvalId ? { ...this.extensionContext, approvalId: decision.approvalId } : this.extensionContext;
    if (tool.policy === 'always_approve') {
      const checked = await tool.guard?.(decision.updatedInput, ctx);
      if (checked && !checked.ok) throw Error(checked.reason);
    }
    this.ctx.controller.signal.throwIfAborted();
    return tool.execute(decision.updatedInput, ctx);
  }
  canUseTool(name: string, input: Input): Promise<GateResult> {
    const next = this.queue.then(() => this.decide(name, input));
    this.queue = next.catch(() => {});
    return next;
  }
  async resolvePendingApproval(status: Decision, user = 'GitLab', comment = '') {
    const pending = this.pending;
    if (!pending) return false;
    const { repo, session, onApprovalResolved } = this.ctx;
    if (!(await resolveApproval(repo, session, pending.id, status, user, comment, onApprovalResolved))) return false;
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
  async preflight(name: string, input: Input): Promise<PermissionResult | 'ask'> {
    const { session: s, config, workspaceRoot, controller } = this.ctx;
    controller.signal.throwIfAborted();
    const effectiveReadOnly = s.permissionMode === 'plan' || this.readonly;
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    const extension = this.extensionTools.get(name);
    if (extension) {
      const closeApproval = extension.name === 'detent_close_issue' && this.ctx.profile?.closePolicy === 'approve';
      if (effectiveReadOnly && extension.policy !== 'readonly' && !closeApproval) return deny('当前模式仅允许只读操作');
      if (extension.policy === 'readonly' || extension.policy === 'coding_auto') {
        const checked = await extension.guard?.(input, this.extensionContext);
        return checked && !checked.ok ? deny(checked.reason) : allow;
      }
      if (extension.policy !== 'always_approve') return deny('未知工具策略');
      // Cold replay already has a card. invokeExtension checks its guard at execution.
      if (this.previousDecision(extension.name, input)) return 'ask';
      const checked = await extension.guard?.(input, this.extensionContext);
      return checked && !checked.ok ? deny(checked.reason) : 'ask';
    }
    if (name.startsWith('mcp__detent__')) {
      name = name.slice('mcp__detent__'.length);
      if (!isWorkspaceTool(name) && name !== 'AskUserQuestion') return deny('未启用此工具');
    }
    if (name === 'Bash' && this.disableBash) return deny('当前角色禁用 Bash');
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
    if (name === 'Bash' && await safeCommand(input.command, config.safeBashPrefixes, effectiveReadOnly, workspaceRoot)) return allow;
    if (isWorkspaceTool(name) && (!effectiveReadOnly || allowedInPlan(name))) return allow;
    if (name === 'ExitPlanMode' && effectiveReadOnly) return deny('请直接输出方案，由 GitLab 用户审批。');
    if (effectiveReadOnly && name !== 'AskUserQuestion') return deny('当前模式仅允许只读操作');
    if (name !== 'Bash' && name !== 'AskUserQuestion') return deny('未启用此工具');
    return 'ask';
  }
  private previousDecision(name: string, input: Input) {
    const previous = this.ctx.previousDecision;
    return previous?.toolName === name && isDeepStrictEqual(previous.toolInput, input) ? previous : undefined;
  }
  private async decide(name: string, input: Input): Promise<GateResult> {
    const policy = await this.preflight(name, input);
    if (policy !== 'ask') return policy;
    const { session: s, config, repo, gitlab, controller } = this.ctx;
    const plan = s.permissionMode === 'plan';
    const extension = this.extensionTools.get(name);
    name = name.replace(/^mcp__detent__/, '');
    const previous = this.previousDecision(name, input);
    if (previous) {
      this.ctx.previousDecision = undefined;
      return this.result(previous, input, extension);
    }
    await this.ctx.checkpoint();
    const a = await repo.createApprovalRequest(
      s.id,
      name === 'AskUserQuestion' ? 'ASK_USER' : 'TOOL_USE',
      name,
      input,
    );
    try {
      const card = await extension?.renderApprovalCard?.(a.id, input, this.extensionContext)
        ?? renderToolApprovalCard(a, this.ctx.workspaceRoot);
      const note = await gitlab.createIssueNote(s.hubProjectId, s.hubIssueIid, renderNote(card));
      await repo.updateApprovalNoteId(a.id, note.id);
    } catch (error) {
      await resolveApproval(repo, s, a.id, 'EXPIRED', 'detent', '审批卡片发布失败', this.ctx.onApprovalResolved);
      throw error;
    }
    await repo.updateSessionState(s.id, { status: 'WAITING_TOOL' });
    s.status = 'WAITING_TOOL';
    await gitlab.syncIssueStatusLabel(s.hubProjectId, s.hubIssueIid, 'WAITING_TOOL');
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
          await gitlab.syncIssueStatusLabel(s.hubProjectId, s.hubIssueIid, status);
          consumed = true;
          return this.result(stored, input, extension);
        }
        if (Date.now() >= deadline) {
          const hold = new ColdHold();
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
