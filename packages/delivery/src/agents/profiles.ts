import {
  loadHubAgents, matchHubAgent, missingHubCapabilities, renderAgentSystemPrompt,
  type DetentCapabilityPack, type TurnProfile, type TurnProfileResolver, type WorkflowApproverTier,
} from '@detent/core';
import type { DeliveryConfig } from '../config.js';

const prodTools = new Set(['jms_run_ansible_job', 'detent_create_release', 'detent_onboard_project']);

type WorkflowProfile = TurnProfile & { approverTier?: WorkflowApproverTier };
type ResolverContext = Parameters<TurnProfileResolver>[0];
interface ProfileOptions {
  hubDefaultBranch?: string;
  capabilities?: readonly DetentCapabilityPack[];
  resolveTurnProfile?: TurnProfileResolver;
  canCloseIssue?: TurnProfile['canCloseIssue'];
}

function blocked(name: string, blockedMessage: string): WorkflowProfile {
  return { name, blockedMessage, readonly: true, disableBash: true, enabledExtensionTools: [] };
}

function agentProfile(result: NonNullable<ReturnType<typeof matchHubAgent>>): WorkflowProfile {
  if (result.kind === 'blocked')
    return blocked(result.agent?.id ?? 'unmatched', result.message);
  const { agent, enabledToolNames } = result;
  const readonly = agent.mode === 'readonly';
  // The audit table stores up to 64 characters. The prompt retains the full source path.
  const name = Array.from(agent.id).slice(0, 64).join('');
  return {
    name, readonly, closePolicy: agent.closePolicy,
    workflow: { account: agent.account, allowPrefixes: agent.allowPrefixes },
    disableBash: readonly || !(agent.allowBash ?? (agent.approverTier === 'standard')),
    enabledExtensionTools: enabledToolNames, extraSystemPrompt: renderAgentSystemPrompt(agent),
    sandboxScope: { agentDir: agent.agentDir, sharedSkills: agent.sharedSkills },
    approverTier: agent.approverTier,
  };
}

async function hubProfile({ session, gitlab }: ResolverContext, options: ProfileOptions, capabilities: readonly DetentCapabilityPack[]): Promise<WorkflowProfile> {
  const [issue, { agents, invalidFiles }] = await Promise.all([
    gitlab.getIssue(session.hubProjectId, session.hubIssueIid),
    loadHubAgents(gitlab, session.hubProjectId, options.hubDefaultBranch ?? 'main'),
  ]);
  const matched = matchHubAgent(agents, issue.labels, capabilities);
  if (matched) return agentProfile(matched);
  const unknown = issue.labels.find(label => /^(delivery|agent)::/i.test(label.trim()));
  if (unknown) return blocked('unavailable', '未找到标签 ' + unknown + ' 对应的有效 Hub SOP，请检查 agents/<id>/AGENT.md。');

  const index = agents.map(agent => {
    const missing = missingHubCapabilities(agent, capabilities);
    if (!missing.length) return '- ' + agent.id + '（' + agent.file + '）：' + agent.description;
    const hints = missing.map(name => name + '：' + (capabilities.find(pack => pack.name.trim().toLowerCase() === name)?.setupHint ?? '请配置并启用此能力'));
    return '- ' + agent.id + '（未开通）：' + hints.join('、');
  });
  const audit = agents.find(agent => agent.id === 'audit' && !missingHubCapabilities(agent, capabilities).length);
  return {
    name: 'unified', readonly: false, disableBash: false, closePolicy: 'manual',
    workflow: { allowPrefixes: audit?.allowPrefixes },
    enabledExtensionTools: [...new Set(capabilities.filter(pack => pack.enabled).flatMap(pack => pack.tools.map(tool => tool.name)))],
    extraSystemPrompt: [
      '先用 Read 读取匹配的 AGENT.md，按需读取其中的 Skill。只读诊断和问答直接使用只读工具，简要报告证据。',
      '修改代码、环境变更、发布或接入仓库前，调用 detent_submit_plan 提交简明方案，等待用户在 GitLab 点 👍 批准。',
      '以下为当前 Hub SOP。未开通的能力请说明配置要求。', ...index,
      ...invalidFiles.map(file => '- 无效规范：' + file),
    ].join('\n'),
  };
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
    function approvalTier({ approvalType, toolName }: NonNullable<ResolverContext['approval']>): WorkflowApproverTier | null {
      if (approvalType !== 'TOOL_USE') return 'standard';
      if (toolName === 'detent_close_issue' && selected.closePolicy !== 'approve') return null;
      if (toolName === 'Bash' && (selected.readonly || selected.disableBash)) return null;
      if (toolName !== 'Bash' && toolName !== 'detent_close_issue' &&
          selected.enabledExtensionTools && !selected.enabledExtensionTools.includes(toolName)) return null;
      const packProdTool = packProdTools.has(toolName);
      if (packProdTool || prodTools.has(toolName)) {
        const enabled = selected.enabledExtensionTools?.includes(toolName) ?? false;
        return selected.readonly || !enabled ? null : 'prod';
      }
      return selected.approverTier ?? 'standard';
    }
    // A removed tool cannot be approved by any member. Keep stale cards silent.
    if (ctx.purpose === 'approval' && ctx.approval && !approvalTier(ctx.approval))
      return blocked(selected.name ?? 'unavailable', '该操作已不在当前流程的授权范围内。');
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
        const tier = approvalTier({ approvalType, toolName });
        if (!tier) return false;
        const permitted = tier === 'prod'
          ? await canApproveProd(ctx.gitlab, projectId, userId, username)
          : await ctx.gitlab.hasApprovalPermission(projectId, userId);
        return permitted && (selected.canApprove?.(params) ?? true);
      },
    };
  };
}
