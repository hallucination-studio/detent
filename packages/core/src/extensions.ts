import type { AppConfig } from './config.js';
import type { HubCapabilitiesDocument } from './workflows/hub-capabilities.js';
import type { DecisionClient } from './decision/jev-client.js';
import type { z } from 'zod';
import type { Pool } from 'mysql2/promise';
import type { DetentRepository } from './db/repository.js';
import type { GitLabClient } from './gitlab/client.js';
import type { SessionOrchestrator } from './orchestrator/session-orchestrator.js';
import type { McpCapabilityConfig } from './extensions/mcp-bridge.js';
import type { WorkflowApproverTier } from './workflows/hub-agents.js';
import type { ApprovalRequestRow, ApprovalType, IssueSessionRow, PermissionMode, SessionMergeRequestRow } from './types.js';

export type ToolGovernancePolicy = 'readonly' | 'coding_auto' | 'always_approve';

export interface WorkflowToolConfig {
  approverTier?: WorkflowApproverTier;
  account?: string;
  allowPrefixes?: readonly string[];
}

export interface ExtensionToolContext {
  workflow?: WorkflowToolConfig;
  session: IssueSessionRow;
  repo: DetentRepository;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  approvalId?: string;
  approvedBy?: string;
  profileName?: string;
}

type ToolInput<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export interface DetentExtensionTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  policy: ToolGovernancePolicy;
  directExecuteOnApproval?: 'handoff' | 'resume';
  formatDirectResult?: (result: unknown, input: ToolInput<S>, ctx: ExtensionToolContext) => string;
  guard?: (input: ToolInput<S>, ctx: ExtensionToolContext) => Promise<{ ok: true } | { ok: false; reason: string }>;
  renderApprovalCard?: (approvalId: string, input: ToolInput<S>, ctx: ExtensionToolContext) => string | Promise<string>;
  execute: (input: ToolInput<S>, ctx: ExtensionToolContext) => Promise<unknown>;
}

// The MCP server validates input against each tool's own schema before dispatch.
export type AnyDetentExtensionTool = DetentExtensionTool<z.ZodRawShape>;

export function defineExtensionTool<S extends z.ZodRawShape>(tool: DetentExtensionTool<S>): AnyDetentExtensionTool {
  return tool as AnyDetentExtensionTool;
}

export interface DetentCapabilityPack {
  name: string;
  setupHint?: string;
  enabled: boolean;
  approverTier?: WorkflowApproverTier;
  tools: readonly AnyDetentExtensionTool[];
}

export type IssueClosePolicy = 'manual' | 'auto' | 'approve';

export interface SandboxScope {
  agentDir?: string;
  sharedSkills?: readonly string[];
}

interface ApprovalVote {
  projectId: number;
  userId: number;
  username: string;
  approvalType: ApprovalType;
  toolName: string;
  toolInput?: Record<string, unknown>;
}
export interface TurnProfile {
  canBotMergeMr?(params: {
    mr: SessionMergeRequestRow; diffs: readonly { old_path: string; new_path: string }[]; environment?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  shouldAutoApproveAsBot?(approval: Pick<ApprovalRequestRow, 'approvalType' | 'toolName' | 'toolInput'>): boolean | Promise<boolean>;
  formatApprovalDenial?(params: ApprovalVote): string | undefined | Promise<string | undefined>;
  workflow?: WorkflowToolConfig;
  closePolicy?: IssueClosePolicy;
  canCloseIssue?(ctx: { session: IssueSessionRow; repo: DetentRepository }): Promise<{ ok: true } | { ok: false; reason: string }>;
  blockedMessage?: string;
  name?: string;
  readonly?: boolean;
  extraSystemPrompt?: string;
  sandboxScope?: SandboxScope;
  enabledExtensionTools?: readonly string[];
  disableBash?: boolean;
  canApprove?(params: ApprovalVote): Promise<boolean>;
}

export type TurnProfileResolver = (ctx: {
  session: IssueSessionRow;
  repo: DetentRepository;
  gitlab: Pick<GitLabClient, 'getIssue' | 'hasApprovalPermission'> &
    Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile' | 'getBotIdentity' | 'isBotUser'>>;
  capabilities?: readonly DetentCapabilityPack[];
  purpose?: 'turn' | 'approval';
  approval?: Pick<ApprovalRequestRow, 'approvalType' | 'toolName'> & Partial<Pick<ApprovalRequestRow, 'toolInput'>>;
}) => TurnProfile | Promise<TurnProfile>;

export interface SessionLifecycleHooks {
  onApprovalResolved?(approval: ApprovalRequestRow, session: IssueSessionRow): void | Promise<void>;
  onTurnCompleted?(session: IssueSessionRow, result: string): void | Promise<void>;
}

export type ExtensionWebhookEvent = Readonly<Record<string, unknown>> & { object_kind: string };
export type WebhookExtension = (event: ExtensionWebhookEvent) => {
  key: string;
  handle(orchestrator: SessionOrchestrator): Promise<void>;
} | null;

export interface EventNotification {
  eventId: string;
  projectId?: number;
  issueIid?: number;
  mrIid?: number;
  sha?: string;
  target: 'resource' | 'hub_issue' | 'commit';
  hubIssueLabel?: string;
  body: string;
}

export interface DetentExtensions {
  resolveCapabilities?(ctx: {
    gitlab: Partial<Pick<GitLabClient, 'getRepositoryFile'>>;
    hubProjectId: number;
    hubDefaultBranch: string;
    config: AppConfig;
    document: HubCapabilitiesDocument;
  }): Promise<readonly DetentCapabilityPack[]>;
  onNotify?(notification: EventNotification): void | Promise<void>;
  decisionClient?: DecisionClient;
  tools?: readonly AnyDetentExtensionTool[];
  capabilities?: readonly DetentCapabilityPack[];
  mcpCapabilities?: readonly McpCapabilityConfig[];
  renderStatusExtra?(session: IssueSessionRow): Promise<string | null | undefined>;
  onReady?(ctx: {
    orchestrator: SessionOrchestrator;
    repo: DetentRepository;
    gitlab: GitLabClient;
    report: (error: unknown) => void;
  }): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  onInitSchema?(pool: Pool): Promise<void>;
  resolveTurnProfile?: TurnProfileResolver;
  hooks?: SessionLifecycleHooks;
  matchWebhookEvent?: WebhookExtension;
}
