import {
  buildTriageSystemPrompt, escapeMarkdownCell, findMatchingHubAgents, loadHubAgents, matchHubAgent, redactGitUrl,
  renderAgentSystemPrompt, resolveHubAgentCapabilities, routeHubAgent,
  type AgentRouteResult, type HubAgent, type DecisionClient, type DetentCapabilityPack, type TurnProfile, type TurnProfileResolver, type WorkflowApproverTier,
} from '@detent/core';
import type { DeliveryConfig } from '../config.js';

export type AgentProfileName = string;

const prodTools = new Set(['jms_run_ansible_job', 'detent_create_release', 'detent_onboard_project']);
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
    workflow: { account: agent.account, allowPrefixes: agent.allowPrefixes },
    disableBash: readonly || !(agent.allowBash ?? (agent.approverTier === 'standard')),
    enabledExtensionTools: enabledToolNames, extraSystemPrompt: renderAgentSystemPrompt(agent),
    ...(agent.source === 'agents' && { sandboxScope: { agentDir: agent.agentDir, sharedSkills: agent.sharedSkills } }),
    approverTier: agent.approverTier,
  };
}

async function coordinatorProfile(ctx: ResolverContext, agents: HubAgent[], capabilities: readonly DetentCapabilityPack[],
  branch: string): Promise<WorkflowProfile | undefined> {
  const subagents: NonNullable<TurnProfile['subagents']>[number][] = [];
  const unavailable: string[] = [];
  const skills = new Map<string, Promise<string | null>>();
  for (const agent of agents) {
    const result = resolveHubAgentCapabilities(agent, agents, capabilities);
    if (result.kind === 'blocked') {
      const missing = agent.requires.filter(name => !capabilities.some(pack => pack.enabled && pack.name.trim().toLowerCase() === name));
      unavailable.push(agent.id + '：' + missing.map(name => name + '（' +
        (capabilities.find(pack => pack.name.trim().toLowerCase() === name)?.setupHint ?? '请在服务端配置并启用此能力') + '）').join('、'));
      continue;
    }
    if (ctx.coordinatorAgents && ctx.session.permissionMode !== 'plan' && !ctx.coordinatorAgents.includes(agent.id) && agent.mode !== 'readonly') continue;
    const profile = agentProfile(result);
    // The single-agent sandbox projects one private Agent directory. Supply the
    // selected skill bodies directly to each native agent in coordinator turns.
    const instructions = await Promise.all(agent.skills.map(async skill => {
      let read = skills.get(skill.path);
      if (!read) {
        read = ctx.gitlab.getRepositoryFile!(ctx.session.hubProjectId, skill.path, branch);
        skills.set(skill.path, read);
      }
      const body = await read;
      if (body === null) throw Error('无法加载 Skill：' + skill.path);
      return skill.path + '\n' + body;
    }));
    subagents.push({
      id: agent.id, description: agent.description,
      prompt: [renderAgentSystemPrompt({ ...agent, skills: [] }), ...instructions,
        '本轮由协调者委派，完成子任务后返回结果，保持 Issue 开放以便后续交接。'].join('\n\n'),
      readonly: profile.readonly, disableBash: profile.disableBash, enabledExtensionTools: result.enabledToolNames,
      account: agent.account, allowPrefixes: agent.allowPrefixes, approverTier: agent.approverTier, closePolicy: agent.closePolicy,
    });
  }
  if (ctx.coordinatorAgents?.some(id => !subagents.some(agent => agent.id === id)))
    return blocked('coordinator', '本次委派的 Agent 已不可用，请重新规划。');
  if (!subagents.length) return;
  return {
    name: 'coordinator', coordinator: true, readonly: false, disableBash: false, closePolicy: 'manual', sandboxScope: {}, subagents,
    enabledExtensionTools: [...new Set(subagents.flatMap(agent => agent.enabledExtensionTools ?? []))],
    extraSystemPrompt: [
      '你负责协调当前 Issue。按用户需求依次调用 Task，每次等待上一位 Agent 完成。同一 Issue 可先巡检、再修复、再变更或发布。',
      '只读问答直接回答。Kafka、主机、日志等巡检立即委派给已就绪的 audit（Task 的 subagent_type 为 audit），根据证据简短汇报。',
      '修改代码、环境变更、发版和仓库接入分别委派给匹配的 code-delivery、env-change、release、onboarding。方案阶段由受治理 Agent 制订实施方案，交用户审批。',
      '仅从已就绪名单中选择；按 Agent 描述处理自定义流程。缺少关键信息时简短提问。能力状态以下列清单为准。',
      '已就绪：', ...subagents.map(agent => agent.id + ' — ' + agent.description),
      ...(unavailable.length ? ['未开通：', ...unavailable] : []),
    ].join('\n'),
  };
}

async function hubProfile(ctx: ResolverContext, options: ProfileOptions, capabilities: readonly DetentCapabilityPack[]): Promise<WorkflowProfile> {
  const { session, gitlab, repo, purpose, prompt } = ctx;
  const issue = await gitlab.getIssue(session.hubProjectId, session.hubIssueIid);
  const { present, agents, invalidFiles } = await loadHubAgents(gitlab, session.hubProjectId, options.hubDefaultBranch ?? 'main');
  if (present) {
    const labeled = findMatchingHubAgents(agents, issue.labels).length > 0;
    if (ctx.coordinatorAgents) {
      if (labeled) return blocked('coordinator', '当前标签已变更，请重新规划。');
      if (purpose === 'approval' && ctx.approval?.approvalType !== 'PLAN' && ctx.coordinatorAgents.length === 1) {
        const agent = agents.find(agent => agent.id === ctx.coordinatorAgents![0]);
        if (!agent) return blocked('coordinator', '本次委派的 Agent 已不可用。');
        const profile = agentProfile(resolveHubAgentCapabilities(agent, agents, capabilities));
        const name = ctx.approval?.toolName;
        if (name !== 'AskUserQuestion' && !(name === 'Bash' && !profile.readonly && !profile.disableBash) &&
            !profile.enabledExtensionTools?.includes(name ?? '')) return blocked('coordinator', '此 Agent 已不再授权使用该工具。');
        return profile;
      }
      return await coordinatorProfile(ctx, agents, capabilities, options.hubDefaultBranch ?? 'main')
        ?? blocked('coordinator', '没有可用的 Agent。');
    }
    if (purpose === 'approval' || labeled)
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
      routed = await routeHubAgent(decision, agents, { title: issue.title, description: issue.description, labels: issue.labels, recentMessages }, capabilities);
    }
    if (routed.kind === 'matched') {
      const { agent } = routed;
      const profile = agentProfile(resolveHubAgentCapabilities(agent, agents, capabilities, invalidFiles));
      if (profile.blockedMessage) return profile;

      // A new sticky route starts in Plan even if the Issue had an approved route before.
      await repo.updateSessionState(session.id, { permissionMode: 'plan' });
      session.permissionMode = 'plan';
      await gitlab.updateIssueLabels?.(session.hubProjectId, session.hubIssueIid, { add: [agent.label] });
      return {
        ...profile,
        routingNotice: redactGitUrl(`> 🧭 已进入 **${escapeMarkdownCell(agent.description)}** 流程（发 \`/help\` 可查看或切换其他能力）`),
      };
    }
    if (routed.suggestion) {
      const result = resolveHubAgentCapabilities(routed.suggestion.agent, agents, capabilities, invalidFiles);
      if (result.kind === 'blocked') return agentProfile(result);
    }
    const coordinator = await coordinatorProfile(ctx, agents, capabilities, options.hubDefaultBranch ?? 'main');
    if (coordinator) return coordinator;

    return {
      name: 'triage', readonly: true, disableBash: true, closePolicy: 'manual', enabledExtensionTools: [], sandboxScope: {},
      extraSystemPrompt: buildTriageSystemPrompt(agents, capabilities, { ...routed, invalidFiles }),
    };
  }

  if (ctx.coordinatorAgents) return blocked('coordinator', '没有可用的 Agent。');
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
    function approvalTier({ approvalType, toolName }: NonNullable<ResolverContext['approval']>): WorkflowApproverTier | null {
      if (approvalType === 'PLAN' || toolName === 'Plan') return 'standard';
      if (toolName === 'detent_close_issue' && selected.closePolicy !== 'approve') return null;
      if (approvalType === 'TOOL_USE' && toolName.includes('__') && selected.enabledExtensionTools &&
          !selected.enabledExtensionTools.includes(toolName)) return null;
      const packProdTool = packProdTools.has(toolName);
      if (packProdTool || prodTools.has(toolName)) {
        const enabled = selected.enabledExtensionTools?.includes(toolName) ?? !packProdTool;
        return selected.readonly || !enabled ? null : 'prod';
      }
      return approvalType === 'TOOL_USE' && selected.approverTier === 'prod' ? 'prod' : 'standard';
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
