import {
  loadHubAgents, matchHubAgent, missingHubCapabilities, renderAgentSystemPrompt,
  type DetentCapabilityPack, type TurnProfile, type TurnProfileResolver, type WorkflowApproverTier,
} from '@detent/core';
import { environmentConfig, isBotName, isProdEnv, mentionOwners, ownerSetupHint, type DeliveryConfig } from '../config.js';
import type { JumpServerCapability } from '../jumpserver/tools.js';

const governedTools = new Set(['jms_job', 'detent_create_release', 'detent_onboard_project', 'detent_create_project']);

type ResolverContext = Parameters<TurnProfileResolver>[0];
interface ProfileOptions {
  hubDefaultBranch?: string;
  capabilities?: readonly DetentCapabilityPack[];
  resolveTurnProfile?: TurnProfileResolver;
  canCloseIssue?: TurnProfile['canCloseIssue'];
}

function blocked(name: string, blockedMessage: string): TurnProfile {
  return { name, blockedMessage, readonly: true, disableBash: true, enabledExtensionTools: [] };
}

function agentProfile(result: NonNullable<ReturnType<typeof matchHubAgent>>, capabilities: readonly DetentCapabilityPack[]): TurnProfile {
  if (result.kind === 'blocked')
    return blocked(result.agent?.id ?? 'unmatched', result.message);
  const { agent, enabledToolNames } = result;
  const readonly = agent.mode === 'readonly';
  // The audit table stores up to 64 characters. The prompt retains the full source path.
  const name = Array.from(agent.id).slice(0, 64).join('');
  let extraSystemPrompt = renderAgentSystemPrompt(agent);
  if (agent.uses?.length) {
    const packs = new Map(capabilities.map(pack => [pack.name.trim().toLowerCase(), pack.enabled]));
    const optional = new Set(agent.uses.flatMap(name => name === '*' ? [...packs.keys()] : [name]));
    const enabled = [...optional].filter(name => packs.get(name));
    const disabled = [...optional].filter(name => !packs.get(name));
    extraSystemPrompt += '\n当前已启用扩展能力：' + (enabled.join('、') || '无') + '；未启用：' + (disabled.join('、') || '无');
  }
  return {
    name, readonly, closePolicy: agent.closePolicy,
    workflow: { account: agent.account, allowPrefixes: agent.allowPrefixes, approverTier: agent.approverTier },
    disableBash: readonly || !(agent.allowBash ?? (agent.approverTier === 'standard')),
    enabledExtensionTools: enabledToolNames, extraSystemPrompt,
    sandboxScope: { agentDir: agent.agentDir, sharedSkills: agent.sharedSkills },
  };
}

async function hubProfile({ session, gitlab }: ResolverContext, options: ProfileOptions, capabilities: readonly DetentCapabilityPack[]): Promise<TurnProfile> {
  const [issue, { agents, invalidFiles }] = await Promise.all([
    gitlab.getIssue(session.hubProjectId, session.hubIssueIid),
    loadHubAgents(gitlab, session.hubProjectId, options.hubDefaultBranch ?? 'main'),
  ]);
  const matched = matchHubAgent(agents, issue.labels, capabilities);
  if (matched) return agentProfile(matched, capabilities);
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
    const selected = options.resolveTurnProfile
      ? await options.resolveTurnProfile({ ...ctx, capabilities })
      : await hubProfile(ctx, options, capabilities);
    const owners = new Map(capabilities.filter(pack => pack.enabled).flatMap(pack => pack.tools.map(tool => [tool.name, pack] as const)));
    const jobs = owners.get('jms_job') as Partial<JumpServerCapability> | undefined;
    const bot = ctx.gitlab.getBotIdentity?.();
    const environments = jobs && ('environments' in jobs ? jobs.environments : config.environments);
    const invalid = ownerSetupHint(environments, bot?.username);
    if (invalid) return blocked(selected.name ?? 'unavailable', invalid);
    const index = Object.entries(environments ?? {}).filter(([, env]) => env.owners?.length)
      .map(([name, env]) => name + '=' + mentionOwners(env.owners!));
    type Approval = NonNullable<ResolverContext['approval']>;
    const isJob = (a: Approval) => a.approvalType === 'TOOL_USE' && a.toolName === 'jms_job';
    const jobEnv = (a: Approval) => isJob(a) ? environmentConfig(environments, a.toolInput?.environment) : undefined;
    const botOwner = (name: unknown) => {
      const env = environmentConfig(environments, name);
      return !isProdEnv(name, env?.approverTier) && !!env?.owners?.some(o => isBotName(o, bot?.username));
    };
    function authorized({ approvalType, toolName }: Approval) {
      if (approvalType !== 'TOOL_USE') return true;
      if (toolName === 'detent_close_issue') return selected.closePolicy === 'approve';
      if (toolName === 'Bash') return !selected.readonly && !selected.disableBash;
      const enabled = selected.enabledExtensionTools?.includes(toolName);
      if (governedTools.has(toolName) || owners.get(toolName)?.approverTier === 'prod') return !selected.readonly && enabled === true;
      return enabled !== false;
    }
    async function autoApproveJob(a: Approval) {
      if (!isJob(a) || selected.blockedMessage || !authorized(a) || !botOwner(a.toolInput?.environment) ||
          selected.workflow?.approverTier === 'prod' || jobs?.approverTier === 'prod' || !await jobs?.validJobTargets?.(a.toolInput)) return false;
      return !selected.canApprove || !!bot && selected.canApprove({ ...a, projectId: ctx.session.hubProjectId, userId: bot.id, username: bot.username });
    }
    async function approvalTier({ approvalType, toolName, toolInput }: Approval): Promise<WorkflowApproverTier> {
      if (approvalType !== 'TOOL_USE') return 'standard';
      const pack = owners.get(toolName);
      if (selected.workflow?.approverTier === 'prod' || pack?.approverTier === 'prod') return 'prod';
      if (toolName === 'detent_create_release') return pack?.approverTier ?? 'prod';
      if (toolName === 'jms_job') {
        const env = environmentConfig(environments, toolInput?.environment);
        if (env?.owners?.length) return 'standard'; // Membership and assets are checked in canApprove.
        if (!isProdEnv(toolInput?.environment, env?.approverTier) && await jobs?.validJobTargets?.(toolInput)) return 'standard';
        return 'prod';
      }
      return governedTools.has(toolName) ? 'prod' : 'standard';
    }
    // A removed tool cannot be approved by any member. Keep stale cards silent.
    if (ctx.purpose === 'approval' && ctx.approval && !authorized(ctx.approval))
      return blocked(selected.name ?? 'unavailable', '该操作已不在当前流程的授权范围内。');
    return {
      ...selected,
      extraSystemPrompt: [selected.extraSystemPrompt, index.length && '已配置环境负责人：' + index.join('；'),
        index.length && bot && `你使用 GitLab 账号 @${bot.username}。方案获批后，由本 Bot 负责的非生产环境在创建配置 MR 的同一轮调用 detent_merge_mr，用合并 SHA 提交执行审批。`,
      ].filter(Boolean).join('\n'),
      async canBotMergeMr({ diffs, environment, mr }) {
        if (selected.blockedMessage || selected.readonly || !botOwner(environment))
          return { ok: false, reason: '请由目标环境负责人合并 MR' };
        const productionPath = /(^|[/._-])prod(uction)?([/._-]|$)/i;
        if (!diffs.length || diffs.some(d => [d.old_path, d.new_path].some(path => !path || productionPath.test(path))))
          return { ok: false, reason: '差异为空或涉及生产文件，禁止 Bot 合并' };
        return selected.canBotMergeMr?.({ diffs, environment, mr }) ?? { ok: true };
      },
      shouldAutoApproveAsBot: autoApproveJob,
      formatApprovalDenial(params) {
        const owners = jobEnv(params)?.owners;
        if (owners?.length && !botOwner(params.toolInput?.environment) && !owners.includes(params.username.toLowerCase()))
          return '> 🔒 该操作需要环境负责人（' + mentionOwners(owners) + '）在审批卡上点 👍 放行。';
        return selected.formatApprovalDenial?.(params);
      },
      ...(!selected.blockedMessage && canCloseIssue && {
        async canCloseIssue(context) {
          const checked = await canCloseIssue(context);
          if (!checked.ok) return checked;
          return selected.canCloseIssue?.(context) ?? checked;
        },
      }),
      async canApprove(params) {
        if (selected.blockedMessage || !authorized(params)) return false;
        const { projectId, userId, username } = params;
        const env = jobEnv(params);
        if (isJob(params) && (ctx.gitlab.isBotUser?.(userId, username) ?? bot?.id === userId)) return autoApproveJob(params);
        if (env?.owners?.length) {
          if (!botOwner(params.toolInput?.environment) && !env.owners.includes(username.toLowerCase())) return false;
          if (!await jobs?.validJobTargets?.(params.toolInput)) return false;
        }
        const tier = await approvalTier(params);
        const permitted = tier === 'prod'
          ? await canApproveProd(ctx.gitlab, projectId, userId, username)
          : await ctx.gitlab.hasApprovalPermission(projectId, userId);
        return permitted && (selected.canApprove?.(params) ?? true);
      },
    };
  };
}
