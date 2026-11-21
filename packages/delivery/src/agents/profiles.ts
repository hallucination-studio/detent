import type { TurnProfile, TurnProfileResolver } from '@detent/core';
import type { DeliveryConfig } from '../config.js';

export type AgentProfileName = 'EnvChangeAgent' | 'ReadonlyAuditAgent' | 'CodeDeliveryAgent';

const runJob = 'jms_run_ansible_job';

export function createDeliveryTurnProfileResolver(config: DeliveryConfig): TurnProfileResolver {
  return async ({ session, gitlab }) => {
    const inspectTools = ['jms_list_assets', 'jms_readonly_inspect'];
    const issue = await gitlab.getIssue(session.hubProjectId, session.hubIssueIid);
    const labels = issue.labels.map(label => label.trim().toLowerCase());
    let name: AgentProfileName = 'EnvChangeAgent';
    if (labels.includes('delivery::audit')) name = 'ReadonlyAuditAgent';
    else if (labels.includes('delivery::code') && !labels.includes('delivery::env-change')) name = 'CodeDeliveryAgent';

    const canApprove: NonNullable<TurnProfile['canApprove']> = async ({ projectId, userId, username, toolName }) => {
      if (toolName !== runJob) return gitlab.hasApprovalPermission(projectId, userId);
      // A label change while a production card is pending must not relax its approval policy.
      if (name !== 'EnvChangeAgent') return false;
      if (config.prodApprovers.length)
        return config.prodApprovers.includes(username.toLowerCase()) && gitlab.hasApprovalPermission(projectId, userId);
      return gitlab.hasApprovalPermission(projectId, userId, config.prodMinAccessLevel);
    };

    switch (name) {
      case 'ReadonlyAuditAgent':
        return { name, canApprove, readonly: true, disableBash: true, enabledExtensionTools: inspectTools,
          extraSystemPrompt: '仅做只读巡检和排障。用已授权资产、只读命令和仓库证据输出诊断报告，说明现状、证据与建议，直接结束本轮。' };
      case 'CodeDeliveryAgent':
        return { name, canApprove, readonly: false, disableBash: false, enabledExtensionTools: [],
          extraSystemPrompt: '按工作区 CLAUDE.md 规划多项目代码交付。方案获批后分别检出分支、提交变更并创建 MR，报告测试与流水线结果。' };
      case 'EnvChangeAgent':
        return { name, canApprove, readonly: false, disableBash: true,
          enabledExtensionTools: [...inspectTools, runJob, 'jms_get_job_result'],
          extraSystemPrompt: [
            '1. 用 jms_list_assets 确认目标，用 jms_readonly_inspect 记录环境基线。',
            '2. 提交方案，列明影响范围、验收标准和回滚步骤，等待方案批准。',
            '3. 获批后在 Ansible 仓库分支编写 Playbook 并提交 MR。',
            '4. 在 Issue 贴出 MR 链接，结束本轮，等待人工审查合并。',
            '5. 合并事件恢复会话后，用准确的合并 SHA、Playbook 和资产请求 jms_run_ansible_job，等待生产审批。',
            '6. 用 jms_get_job_result 查询至终态，再用 jms_readonly_inspect 核验，报告 MR、审批、任务链接和实测结果。',
          ].join('\n') };
    }
  };
}
