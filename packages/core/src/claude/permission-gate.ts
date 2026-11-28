import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-code';
import type { AppConfig } from '../config.js';
import type { DetentRepository } from '../db/repository.js';
import type { AnyDetentExtensionTool, DetentCapabilityPack, ExtensionToolContext, SessionLifecycleHooks, TurnProfile } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { configuredSecrets } from '../gitlab/redact.js';
import { renderNote, renderToolApprovalCard } from '../gitlab/note-streamer.js';
import type { ApprovalRequestRow, IssueSessionRow } from '../types.js';
import { contained } from '../workspace/contained-path.js';
import { validateLocalSandboxBash } from '../decision/bash-guard.js';
import { allowedInPlan, isWorkspaceTool, type ToolName } from '../workspace/mcp-tools.js';

import type { SessionChannel } from '../orchestrator/channel.js';
import { resolveApproval } from '../orchestrator/lifecycle.js';

type Input = Record<string, unknown>;
type GateResult = PermissionResult & { approvalId?: string };
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
export class ToolDenied extends Error {}
export class ColdHold extends Error {
  constructor(pending: ApprovalRequestRow) {
    super(pending.approvalType === 'ASK_USER' ? '💬 需要你的确认，请查看下方问题并直接回复。' :
      '📋 已提交操作审批，请在下方的审批卡中点 👍 放行或 👎 拒绝。');
  }
}
const fileTools = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
const readTools = new Set(['Read', 'Glob', 'Grep']);
type GateChannel = Pick<SessionChannel, 'createNote' | 'syncStatusLabel'>;
type GateContext = ({ channel: GateChannel } |
  { gitlab: Pick<GitLabClient, 'createIssueNote' | 'syncIssueStatusLabel'> }) & {
  allowedWorkspaceTools?: readonly ToolName[];
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
  readonly extensionTools = new Map<string, AnyDetentExtensionTool>();
  readonly readonly: boolean;
  readonly disableBash: boolean;
  private readonly secrets: string[];
  private channel: GateChannel;
  private extensionContext: ExtensionToolContext;
  constructor(private ctx: GateContext) {
    const { session, repo, workspaceRoot, profile } = ctx;
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
  // MCP supplies schema-validated input. Approved tools recheck their guard immediately before execution.
  async invokeExtension(id: string, input: Input) {
    const tool = this.extensionTools.get(id);
    if (!tool) throw Error('未启用此工具');
    const decision = await this.canUseTool(id, input);
    if (decision.behavior === 'deny') throw new ToolDenied(decision.message);
    const ctx = { ...this.extensionContext };
    if (decision.approvalId) ctx.approvalId = decision.approvalId;
    if (tool.policy === 'always_approve') {
      const checked = await tool.guard?.(decision.updatedInput, ctx);
      if (checked && !checked.ok) throw new ToolDenied(checked.reason);
    }
    this.ctx.controller.signal.throwIfAborted();
    return tool.execute(decision.updatedInput, ctx);
  }
  canUseTool(name: string, input: Input): Promise<GateResult> {
    const next = this.queue.then(() => this.decide(name, input));
    this.queue = next.catch(() => {});
    return next;
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
  async preflight(name: string, input: Input): Promise<GateResult | 'ask'> {
    const { session: s, workspaceRoot, controller } = this.ctx;
    controller.signal.throwIfAborted();
    const effectiveReadOnly = s.permissionMode === 'plan' || this.readonly;
    const readOnlyReason = s.permissionMode === 'plan' && !this.readonly && s.sessionKind === 'issue'
      ? '尚未获批实施方案，请先调用 detent_submit_plan 提交方案供用户点 👍 批准。'
      : '当前模式仅允许只读操作';
    if (name === 'Bash' && effectiveReadOnly) return deny(readOnlyReason);
    // Prevent credential-bearing tool arguments from reaching an extension or an approval record.
    const argumentsJson = JSON.stringify(input);
    if (this.secrets.some(secret => argumentsJson.includes(JSON.stringify(secret).slice(1, -1))))
      return deny('工具参数中含有服务端凭证，请移除后再试。');
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    const extension = this.extensionTools.get(name);
    if (extension) {
      const closeApproval = extension.name === 'detent_close_issue' && this.ctx.profile?.closePolicy === 'approve';
      if (effectiveReadOnly && extension.policy !== 'readonly' && !closeApproval) return deny(readOnlyReason);
      if (extension.policy === 'readonly' || extension.policy === 'coding_auto') {
        const checked = await extension.guard?.(input, { ...this.extensionContext });
        return checked && !checked.ok ? deny(checked.reason) : allow;
      }
      if (extension.policy !== 'always_approve') return deny('未知工具策略');
      // Cold replay already has a card. invokeExtension checks its guard at execution.
      if (this.previousDecision(extension.name, input)) return 'ask';
      const checked = await extension.guard?.(input, { ...this.extensionContext });
      return checked && !checked.ok ? deny(checked.reason) : 'ask';
    }
    if (name.startsWith('mcp__detent__')) {
      name = name.slice('mcp__detent__'.length);
      if (!isWorkspaceTool(name) && name !== 'AskUserQuestion') return deny('未启用此工具');
    }
    if (isWorkspaceTool(name) && this.ctx.allowedWorkspaceTools && !this.ctx.allowedWorkspaceTools.includes(name)) return deny('未启用此工具');
    if (name === 'Bash') {
      if (this.disableBash) return deny('当前角色禁用 Bash');
      const reason = await validateLocalSandboxBash(input.command, workspaceRoot);
      return reason ? deny('本地沙箱安全限制：' + reason) : allow;
    }
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
      if (effectiveReadOnly && !readTools.has(name)) return deny(readOnlyReason);
      if (
        !(await contained(
          workspaceRoot,
          lookup ? (input.path ?? '.') : input.file_path,
          !readTools.has(name),
        ))
      )
        return deny('此模式或路径不允许文件操作');
      return allow;
    }
    if (isWorkspaceTool(name) && (!effectiveReadOnly || allowedInPlan(name))) return allow;
    if (effectiveReadOnly && name !== 'AskUserQuestion') return deny(readOnlyReason);
    if (name !== 'AskUserQuestion') return deny('未启用此工具');
    return 'ask';
  }
  private previousDecision(name: string, input: Input) {
    const previous = this.ctx.previousDecision;
    return previous?.toolName === name && isDeepStrictEqual(previous.toolInput, input) ? previous : undefined;
  }
  private async decide(name: string, input: Input): Promise<GateResult> {
    const policy = await this.preflight(name, input);
    if (policy !== 'ask') return policy;
    const { session: s, repo, controller } = this.ctx;
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
      const requireProd = this.ctx.profile?.workflow?.approverTier === 'prod' || !!extension &&
        this.ctx.capabilities?.some(pack => pack.enabled && pack.approverTier === 'prod' && pack.tools.includes(extension));
      const card = await extension?.renderApprovalCard?.(a.id, input, { ...this.extensionContext })
        ?? renderToolApprovalCard(a, requireProd ? '生产审批人' : '项目成员');
      const note = await this.channel.createNote(renderNote(card, this.secrets));
      await repo.updateApprovalNoteId(a.id, note.id);
    } catch (error) {
      await resolveApproval(repo, s, a.id, 'EXPIRED', 'detent', '审批卡片发布失败', this.ctx.onApprovalResolved, this.secrets);
      throw error;
    }
    await repo.updateSessionState(s.id, { status: 'WAITING_TOOL' });
    s.status = 'WAITING_TOOL';
    await this.channel.syncStatusLabel('WAITING_TOOL');
    const hold = new ColdHold(a);
    controller.abort(hold);
    throw hold;
  }
}
