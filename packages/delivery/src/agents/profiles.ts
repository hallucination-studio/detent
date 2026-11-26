import {
  buildTriageSystemPrompt, escapeMarkdownCell, findMatchingHubAgents, loadHubAgents, matchHubAgent, redactGitUrl,
  renderAgentSystemPrompt, resolveHubAgentCapabilities, routeHubAgent,
  type AgentRouteResult, type DecisionClient, type DetentCapabilityPack, type TurnProfile, type TurnProfileResolver, type WorkflowApproverTier,
} from '@detent/core';
import type { DeliveryConfig } from '../config.js';

export type AgentProfileName = string;

const prodTools = new Set(['jms_run_ansible_job', 'detent_create_release']);
const inspectTools = ['jms_list_assets', 'jms_readonly_inspect'];

type WorkflowProfile = TurnProfile & { approverTier?: WorkflowApproverTier };
type ResolverContext = Parameters<TurnProfileResolver>[0];
interface ProfileOptions {
  hubDefaultBranch?: string;
  capabilities?: readonly DetentCapabilityPack[];
  decisionClient?: DecisionClient;
  resolveTurnProfile?: TurnProfileResolver;
  canCloseIssue?: TurnProfile['canCloseIssue'];
}

function blocked(name: string, blockedMessage: string): WorkflowProfile {
  return { name, blockedMessage, readonly: true, disableBash: true, enabledExtensionTools: [] };
}

function agentProfile(result: ReturnType<typeof matchHubAgent>): WorkflowProfile {
  if (result.kind === 'blocked')
    return blocked(result.agent?.file.replace(/^workflows\//, 'workflow:') ?? 'unmatched', result.message);
  const { agent, enabledToolNames } = result;
  const readonly = agent.mode === 'readonly';
  // The audit table stores up to 64 characters. The prompt retains the full source path.
  const name = Array.from(agent.id).slice(0, 64).join('');
  return {
    name, readonly, closePolicy: agent.closePolicy,
    disableBash: readonly || !(agent.allowBash ?? (agent.approverTier === 'standard')),
    enabledExtensionTools: enabledToolNames, extraSystemPrompt: renderAgentSystemPrompt(agent),
    ...(agent.source === 'agents' && { sandboxScope: { agentDir: agent.agentDir, sharedSkills: agent.sharedSkills } }),
    approverTier: agent.approverTier,
  };
}

async function hubProfile(ctx: ResolverContext, options: ProfileOptions, capabilities: readonly DetentCapabilityPack[]): Promise<WorkflowProfile> {
  const { session, gitlab, repo, purpose, prompt } = ctx;
  const issue = await gitlab.getIssue(session.hubProjectId, session.hubIssueIid);
  const { present, agents, invalidFiles } = await loadHubAgents(gitlab, session.hubProjectId, options.hubDefaultBranch ?? 'main');
  if (present) {
    if (purpose === 'approval' || findMatchingHubAgents(agents, issue.labels).length)
      return agentProfile(matchHubAgent(agents, issue.labels, capabilities, invalidFiles));

    const decision = ctx.decision ?? options.decisionClient;
    let routed: AgentRouteResult = { kind: 'triage', reason: 'Jev 意图路由未启用' };
    if (decision) {
      const notes = await gitlab.listIssueNotes?.(session.hubProjectId, session.hubIssueIid).catch(() => []) ?? [];
      const recentMessages = notes.filter(note => !note.system && !gitlab.isBotUser?.(note.author?.id, note.author?.username))
        .map(note => note.body.trim()).filter(Boolean);
      const currentPrompt = prompt?.trim();
      if (currentPrompt && currentPrompt !== recentMessages.at(-1) &&
          currentPrompt !== (issue.title + '\n' + (issue.description ?? '')).trim()) recentMessages.push(currentPrompt);
      routed = await routeHubAgent(decision, agents, { title: issue.title, description: issue.description, labels: issue.labels, recentMessages });
    }
    if (routed.kind === 'matched') {
      const { agent, confidence } = routed;
      const profile = agentProfile(resolveHubAgentCapabilities(agent, agents, capabilities, invalidFiles));
      if (profile.blockedMessage) return profile;

      // A new sticky route starts in Plan even if the Issue had an approved route before.
      await repo.updateSessionState(session.id, { permissionMode: 'plan' });
      session.permissionMode = 'plan';
      await gitlab.updateIssueLabels?.(session.hubProjectId, session.hubIssueIid, { add: [agent.label] });
      return {
        ...profile,
        routingNotice: redactGitUrl(`> 🧭 已由 Jev 自动路由至 Agent ${escapeMarkdownCell(agent.id, 'code')}（置信度 ${confidence.toFixed(2)}，标签 ${escapeMarkdownCell(agent.label, 'code')}）。如需切换，请修改 Issue 标签或回复 \`/use <agent>\`。`),
      };
    }
    if (agents.some(agent => agent.isDefault)) return agentProfile(matchHubAgent(agents, [], capabilities, invalidFiles));

    return {
      name: 'triage', readonly: true, disableBash: true, closePolicy: 'manual', enabledExtensionTools: [], sandboxScope: {},
      extraSystemPrompt: buildTriageSystemPrompt(agents, capabilities, { ...routed, invalidFiles }),
    };
  }

  const labels = issue.labels.map(label => label.trim().toLowerCase());
  const jumpserver = capabilities.find(pack => pack.name.trim().toLowerCase() === 'jumpserver');
  const jumpserverEnabled = jumpserver?.enabled ?? (options.capabilities === undefined);
  if (labels.includes('delivery::audit')) {
    const enabled = jumpserver?.tools.filter(tool => tool.policy === 'readonly').map(tool => tool.name) ?? inspectTools;
    return { name: 'ReadonlyAuditAgent', readonly: true, disableBash: true,
      enabledExtensionTools: jumpserverEnabled ? inspectTools.filter(name => enabled.includes(name)) : [],
      extraSystemPrompt: '按 CLAUDE.md 只读巡检，记录诊断证据与建议。' };
  }
  if (labels.includes('delivery::release') && !labels.includes('delivery::env-change')) {
    const release = capabilities.find(pack => pack.name.trim().toLowerCase() === 'gitlab-release');
    if (!release?.enabled) return blocked('release', '发版缺少 gitlab-release 能力包。' + (release?.setupHint ?? '请在服务端启用发版能力包。'));
    return { name: 'release', readonly: false, disableBash: true,
      enabledExtensionTools: release.tools.map(tool => tool.name), extraSystemPrompt: '按 CLAUDE.md 制订发版方案并申请发版审批。', approverTier: 'prod' };
  }
  if (jumpserverEnabled && (labels.includes('delivery::env-change') || !labels.includes('delivery::code')))
    return { name: 'EnvChangeAgent', readonly: false, disableBash: true,
      enabledExtensionTools: jumpserver?.tools.map(tool => tool.name) ?? [...inspectTools, 'jms_run_ansible_job', 'jms_get_job_result'],
      extraSystemPrompt: '按 CLAUDE.md 规划环境变更、执行审批与验收。' };
  if (labels.includes('delivery::env-change'))
    return blocked('EnvChangeAgent', '环境变更缺少 jumpserver 能力包。' + (jumpserver?.setupHint ?? '请配置 JumpServer。') +
      '也可在 Hub 的 workflows/ 中定义流程，或选择 delivery::code / delivery::release。');
  return { name: 'CodeDeliveryAgent', readonly: false, disableBash: false,
    enabledExtensionTools: [], extraSystemPrompt: '按 CLAUDE.md 规划代码交付，提交 MR 并报告测试结果。' };
}

export function createDeliveryTurnProfileResolver(config: DeliveryConfig, options: ProfileOptions = {}): TurnProfileResolver {
  const { canCloseIssue } = options;
  function canApproveProd(gitlab: ResolverContext['gitlab'], projectId: number, userId: number, username: string) {
    if (config.prodApprovers.length)
      return config.prodApprovers.includes(username.toLowerCase()) && gitlab.hasApprovalPermission(projectId, userId);
    return gitlab.hasApprovalPermission(projectId, userId, config.prodMinAccessLevel);
  }
  return async ctx => {
    const packs = new Map<string, DetentCapabilityPack>();
    for (const pack of [...(options.capabilities ?? []), ...(ctx.capabilities ?? [])]) {
      const name = pack.name.trim().toLowerCase();
      if (!packs.has(name)) packs.set(name, pack);
    }
    const capabilities = [...packs.values()];
    const selected: WorkflowProfile = options.resolveTurnProfile
      ? await options.resolveTurnProfile({ ...ctx, capabilities })
      : await hubProfile(ctx, options, capabilities);
    const packProdTools = new Set(capabilities.filter(pack => pack.enabled && pack.approverTier === 'prod')
      .flatMap(pack => pack.tools.map(tool => tool.name)));
    return {
      ...selected,
      ...(!selected.blockedMessage && canCloseIssue && {
        async canCloseIssue(context) {
          const checked = await canCloseIssue(context);
          if (!checked.ok) return checked;
          return selected.canCloseIssue?.(context) ?? checked;
        },
      }),
      async canApprove(params) {
        if (selected.blockedMessage) return false;
        const { projectId, userId, username, approvalType, toolName } = params;
        const plan = approvalType === 'PLAN' || toolName === 'Plan';
        if (!plan && toolName === 'detent_close_issue' && selected.closePolicy !== 'approve') return false;
        const packProdTool = packProdTools.has(toolName);
        const prodTool = !plan && (packProdTool || prodTools.has(toolName));
        if (prodTool) {
          const enabled = selected.enabledExtensionTools?.includes(toolName) ?? !packProdTool;
          if (selected.readonly || !enabled) return false;
        }
        const prod = prodTool || (!plan && approvalType === 'TOOL_USE' && selected.approverTier === 'prod');
        const permitted = prod
          ? await canApproveProd(ctx.gitlab, projectId, userId, username)
          : await ctx.gitlab.hasApprovalPermission(projectId, userId);
        return permitted && (selected.canApprove?.(params) ?? true);
      },
    };
  };
}
