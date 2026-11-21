import type { z } from 'zod';
import type { Pool } from 'mysql2/promise';
import type { DetentRepository } from './db/repository.js';
import type { GitLabClient } from './gitlab/client.js';
import type { SessionOrchestrator } from './orchestrator/session-orchestrator.js';
import type { ApprovalRequestRow, ApprovalType, IssueSessionRow, PermissionMode } from './types.js';

export type ToolGovernancePolicy = 'readonly' | 'coding_auto' | 'always_approve';

export interface ExtensionToolContext {
  session: IssueSessionRow;
  repo: DetentRepository;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  approvalId?: string;
  profileName?: string;
}

type ToolInput<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export interface DetentExtensionTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  policy: ToolGovernancePolicy;
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
  tools: readonly AnyDetentExtensionTool[];
}

export interface TurnProfile {
  blockedMessage?: string;
  name?: string;
  readonly?: boolean;
  extraSystemPrompt?: string;
  enabledExtensionTools?: readonly string[];
  disableBash?: boolean;
  canApprove?(params: {
    projectId: number;
    userId: number;
    username: string;
    approvalType: ApprovalType;
    toolName: string;
  }): Promise<boolean>;
}

export type TurnProfileResolver = (ctx: {
  session: IssueSessionRow;
  repo: DetentRepository;
  gitlab: Pick<GitLabClient, 'getIssue' | 'hasApprovalPermission'> &
    Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile'>>;
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

export interface DetentExtensions {
  tools?: readonly AnyDetentExtensionTool[];
  capabilities?: readonly DetentCapabilityPack[];
  renderStatusExtra?(session: IssueSessionRow): Promise<string | null | undefined>;
  onInitSchema?(pool: Pool): Promise<void>;
  resolveTurnProfile?: TurnProfileResolver;
  hooks?: SessionLifecycleHooks;
  matchWebhookEvent?: WebhookExtension;
}
