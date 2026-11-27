export { loadHubCapabilities, resolveSecretRef, resolveSecretTemplate, resolveHubMcpCapabilities,
  type HubCapabilitiesDocument, type HubCapabilityEntry } from './workflows/hub-capabilities.js';
export { createDetentApp } from './app.js';
export { defineExtensionTool } from './extensions.js';
export {
  connectMcpCapabilityPack, jsonSchemaToZodShape, loadMcpCapabilitiesFile, loadMcpCapabilityPacks,
  parseMcpCapabilitiesConfig, type McpCapabilityConfig,
} from './extensions/mcp-bridge.js';
export { loadConfig, type AppConfig } from './config.js';
export { formatHttpError, logError } from './gitlab/redact.js';
export { GitLabClient, redactGitUrl, type IssueNote, type MergeRequestDiscussion, type MergeRequestNote } from './gitlab/client.js';
export { createGitLabOnboardingCapability, createGitLabOnboardingTools, type OnboardingGitLab } from './workspace/onboarding-tools.js';
export { createGitLabReleaseTools, createGitLabReleaseCapability, type ReleaseGitLab } from './workspace/release-tools.js';
export {
  parseHubWorkflowMarkdown, loadHubWorkflows, matchHubWorkflow, findMatchingHubDefinitions as findMatchingHubAgents,
  type HubWorkflow, type WorkflowMode, type WorkflowApproverTier,
} from './workflows/hub-workflows.js';
export {
  parseHubAgentMarkdown, parseHubSkillMarkdown, loadHubAgents, matchHubAgent, resolveHubAgentCapabilities, renderAgentSystemPrompt,
  type HubAgent, type HubSkill,
} from './workflows/hub-agents.js';
export { escapeTableCell as escapeMarkdownCell, neutralizeQuickActions } from './gitlab/note-streamer.js';
export { createWebhookApp, normalizeGitLabEvent } from './gitlab/webhook.js';
export { SessionOrchestrator, SessionBusy } from './orchestrator/session-orchestrator.js';
export type { DetentRepository } from './db/repository.js';
export type { ApprovalRequestRow, ApprovalType, IssueSessionRow, SessionKind, SessionInboxRow, InboxStatus, NormalizedGitLabEvent, PermissionMode, SessionMergeRequestRow } from './types.js';
export type {
  AnyDetentExtensionTool, ExtensionToolContext, ExtensionWebhookEvent, DetentCapabilityPack, DetentExtensions, DetentExtensionTool, SessionLifecycleHooks,
  EventNotification, IssueClosePolicy, SandboxScope, ToolGovernancePolicy, TurnProfile, TurnProfileResolver, WebhookExtension,
} from './extensions.js';
export { createDecisionClient, resolveJevEndpoint, type DecisionClient, type DecisionQuestion, type DecisionAnswer, type JevProvider } from './decision/jev-client.js';
export { routeHubAgent, buildTriageSystemPrompt, type AgentRouteResult, type AgentRoutingCandidate } from './decision/agent-router.js';
