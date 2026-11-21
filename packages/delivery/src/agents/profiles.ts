import {
  loadHubWorkflows, matchHubWorkflow,
  type DetentCapabilityPack, type TurnProfile, type TurnProfileResolver, type WorkflowApproverTier,
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
  resolveTurnProfile?: TurnProfileResolver;
  canCloseIssue?: TurnProfile['canCloseIssue'];
}

function blocked(name: string, blockedMessage: string): WorkflowProfile {
  return { name, blockedMessage, readonly: true, disableBash: true, enabledExtensionTools: [] };
}

async function hubProfile({ session, gitlab }: ResolverContext, options: ProfileOptions): Promise<WorkflowProfile> {
  const issue = await gitlab.getIssue(session.hubProjectId, session.hubIssueIid);
  const loaded = await loadHubWorkflows(gitlab, session.hubProjectId, options.hubDefaultBranch ?? 'main');
  const capabilities = options.capabilities ?? [];
  if (loaded.present) {
    const result = matchHubWorkflow(loaded.workflows, issue.labels, capabilities, loaded.invalidFiles);
    if (result.kind === 'blocked')
      return blocked(result.workflow ? 'workflow:' + result.workflow.file : 'unmatched', result.message);
    const { workflow, enabledToolNames } = result;
    const readonly = workflow.mode === 'readonly';
    // The audit table stores up to 64 characters. The prompt retains the full source path.
    const name = Array.from(workflow.file.replace(/\.md$/i, '')).slice(0, 64).join('');
    return {
      name, readonly, closePolicy: workflow.closePolicy,
      disableBash: readonly || !(workflow.allowBash ?? (workflow.approverTier === 'standard')),
      enabledExtensionTools: enabledToolNames, extraSystemPrompt: '当前工作流：workflows/' + workflow.file + '\n\n' + workflow.body,
      approverTier: workflow.approverTier,
    };
  }

  const labels = issue.labels.map(label => label.trim().toLowerCase());
  const jumpserver = capabilities.find(pack => pack.name.trim().toLowerCase() === 'jumpserver');
  const jumpserverEnabled = options.capabilities === undefined || jumpserver?.enabled;
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
    const selected: WorkflowProfile = options.resolveTurnProfile ? await options.resolveTurnProfile(ctx) : await hubProfile(ctx, options);
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
        const prodTool = !plan && prodTools.has(toolName);
        if (prodTool && (selected.readonly || (selected.enabledExtensionTools !== undefined && !selected.enabledExtensionTools.includes(toolName))))
          return false;
        const prod = prodTool || (!plan && approvalType === 'TOOL_USE' && selected.approverTier === 'prod');
        const permitted = prod
          ? await canApproveProd(ctx.gitlab, projectId, userId, username)
          : await ctx.gitlab.hasApprovalPermission(projectId, userId);
        return permitted && (selected.canApprove?.(params) ?? true);
      },
    };
  };
}
