import { defineExtensionTool, escapeMarkdownCell, logError, neutralizeQuickActions, redactGitUrl, type AnyDetentExtensionTool, type ExtensionToolContext, type DecisionClient } from '@detent/core';
import { z } from 'zod';
import { authSecrets, redactSecrets, type DeliveryConfig } from '../config.js';
import type { JobResultResponse, JumpServerClient } from './client.js';
import { findBlockedAssets, normalizeShellCommand, validatePlaybookPath, validateShellCommands } from './guards.js';

export interface DeliveryExecutionRecord {
  sessionId: string;
  mrId: string;
  approvalId: string;
  agentProfile: string;
  jumpserverJobId: string;
  jumpserverJobUrl: string;
  playbookPath: string;
  commitSha: string;
  targetAssets: string[];
  status: JobResultResponse['status'];
}
export interface DeliveryExecutionTracker {
  recordExecution(record: DeliveryExecutionRecord): Promise<void>;
  hasSessionJob(sessionId: string, jobId: string): Promise<boolean>;
  updateExecutionResult?(sessionId: string, jobId: string, status: JobResultResponse['status'], outputSummary: string): Promise<void>;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const assets = (max: number) => z.array(z.string().trim().min(1)).min(1).max(max);
const id = z.number().int().positive();
const jobSchema = {
  target_project_id: id, mr_iid: id, commit_sha: text(64).min(7), playbook_path: text(255), asset_ids: assets(100),
  extra_vars: z.record(z.unknown()).optional(), reason: text(500).optional(),
};
type JobInput = z.infer<z.ZodObject<typeof jobSchema>>;
const deny = (reason: string) => ({ ok: false as const, reason });
const allow = { ok: true } as const;

async function verifyMerge(input: JobInput, ctx: ExtensionToolContext, blockFailedPipeline: boolean) {
  const rows = await ctx.repo.listSessionMergeRequests(ctx.session.id);
  const mr = rows.find(row => row.targetProjectId === input.target_project_id && row.mrIid === input.mr_iid);
  if (!mr) return deny('MR 不属于当前变更会话');
  if (mr.mrState !== 'merged') return deny('MR 尚未合并，禁止执行');
  if (!mr.mergeCommitSha?.trim() || mr.mergeCommitSha !== input.commit_sha) return deny('提交 SHA 与 MR 合并提交不一致');
  if (blockFailedPipeline && mr.latestPipelineStatus === 'failed') return deny('MR 最新流水线失败，禁止执行');
  return { ok: true as const, mr };
}

export function createJumpServerTools({ client, config, tracker, decision, defaultAccount, onTerminalResult }: {
  client: JumpServerClient; config: DeliveryConfig; tracker?: DeliveryExecutionTracker; decision?: DecisionClient; defaultAccount?: string;
  onTerminalResult?: (sessionId: string, jobId: string, result: JobResultResponse) => Promise<void>;
}): AnyDetentExtensionTool[] {
  const checkAssets = (ids: string[]) => findBlockedAssets(ids, config.blockedAssets).length
    ? deny('目标资产在黑名单中，禁止操作') : allow;

  return [
    defineExtensionTool({
      name: 'jms_list_assets', description: '查询当前凭证获授权的 JumpServer 资产', policy: 'readonly',
      schema: { search: text(128).optional(), node_id: text(128).optional(), limit: id.max(200).optional() },
      execute: input => client.listAssets({ search: input.search, nodeId: input.node_id, limit: input.limit }),
    }),
    defineExtensionTool({
      name: 'jms_shell', description: '在授权资产上批量执行只读巡检命令（一次可传入多条命令合并执行）', policy: 'readonly',
      // Validate raw characters/length before trim can discard a newline or an oversized suffix.
      schema: {
        asset_ids: assets(50),
        commands: z.array(z.string().max(512).regex(/^[^\r\n\0]+$/).trim().min(1)).min(1).max(10)
          .describe('待执行的只读命令列表（每项为单条非交互式只读命令，如 ps/ss/df/uptime/free，勿用 top/htop 等终端交互程序；多条命令请拆成数组元素，勿用 ; 或 && 拼接）'),
      },
      async guard(input, ctx) {
        const targets = checkAssets(input.asset_ids);
        if (!targets.ok) return targets;
        const prefixes = [...config.inspectAllowPrefixes, ...(ctx.workflow?.allowPrefixes ?? [])];
        const checked = await validateShellCommands(input.commands, prefixes, decision);
        return checked.ok ? allow : checked;
      },
      execute(input, ctx) {
        return client.runShell({
          assetIds: input.asset_ids, commands: input.commands.map(normalizeShellCommand),
          account: ctx.workflow?.account ?? defaultAccount ?? config.jumpserverReadonlyAccount,
        });
      },
    }),
    defineExtensionTool({
      name: 'jms_job', description: '审批后异步执行当前会话已合并的 Ansible Playbook，终态自动唤醒本会话', policy: 'always_approve',
      schema: jobSchema,
      async guard(input, ctx) {
        if (!tracker) return deny('未配置交付执行追踪仓储');
        const path = validatePlaybookPath(input.playbook_path);
        if (!path.ok) return path;
        const targets = checkAssets(input.asset_ids);
        if (!targets.ok) return targets;
        return verifyMerge(input, ctx, config.blockFailedPipeline);
      },
      async renderApprovalCard(approvalId, input, ctx) {
        const verified = await verifyMerge(input, ctx, config.blockFailedPipeline);
        if (!verified.ok) throw Error(verified.reason);
        const { mr } = verified;
        const url = new URL(mr.mrWebUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('无效的 MR 链接');
        const cell = (value: string, format: 'text' | 'code' = 'text') =>
          escapeMarkdownCell(redactSecrets(value, config), format);
        const ref = cell(mr.targetProjectPath + '!' + mr.mrIid);
        const mergedBy = mr.mergedBy ? '@' + mr.mergedBy.replace(/^@/, '') : '未知';
        const table = [
          '| 项目 | 内容 |', '| :--- | :--- |',
          '| 已合并 MR | [' + ref + '](<' + url.href.replaceAll('|', '%7C') + '>)（由 ' + cell(mergedBy, 'code') + ' 合并） |',
          '| 提交 SHA | ' + cell(input.commit_sha, 'code') + ' |',
          '| 目标资产 | ' + cell(JSON.stringify(input.asset_ids), 'code') + ' |',
          '| Ansible 仓库 | ' + cell(mr.targetProjectPath, 'code') + ' |',
          '| Playbook | ' + cell(input.playbook_path, 'code') + ' |',
          input.extra_vars && '| 变更变量 | ' + cell(JSON.stringify(input.extra_vars), 'code') + ' |',
          '| 变更原因 | ' + cell(input.reason ?? '未提供') + ' |',
        ].filter(Boolean).join('\n');
        return neutralizeQuickActions(redactSecrets(redactGitUrl([
          '### 🚀 生产变更执行审批', table,
          '> 请运维负责人点 👍 或回复 `/approve` 放行 · 👎 或 `/reject <原因>` 拒绝 · <sub>审批单 `' + approvalId + '`</sub>',
        ].join('\n\n')), config));
      },
      async execute(input, ctx) {
        const { approvalId } = ctx;
        if (!tracker) throw Error('未配置交付执行追踪仓储');
        if (!approvalId) throw Error('生产变更缺少审批单');
        const verified = await verifyMerge(input, ctx, config.blockFailedPipeline);
        if (!verified.ok) throw Error(verified.reason);
        const { mr } = verified;
        const job = await client.runAnsibleJob({
          account: ctx.workflow?.account ?? defaultAccount, assetIds: input.asset_ids, repository: mr.targetProjectPath, playbookPath: input.playbook_path,
          commitSha: input.commit_sha, extraVars: input.extra_vars,
          comment: `Detent ${ctx.session.id} / ${mr.targetProjectPath}!${mr.mrIid} / ${input.commit_sha} / ${approvalId}`,
        });
        try {
          await tracker.recordExecution({
            sessionId: ctx.session.id, mrId: mr.id, approvalId, agentProfile: ctx.profileName ?? 'unified',
            jumpserverJobId: job.jobId, jumpserverJobUrl: job.jobUrl,
            playbookPath: input.playbook_path, commitSha: input.commit_sha, targetAssets: input.asset_ids,
            status: job.status === 'PENDING' ? 'PENDING' : 'RUNNING',
          });
        } catch (error) {
          const detail = logError('delivery-audit', error, [...authSecrets(config.jumpserverJobAuth), ...authSecrets(config.jumpserverReadonlyAuth)]);
          throw Error(redactSecrets(`任务 ${job.jobId} 已提交（${job.jobUrl}），审批单 ${approvalId} 的追踪记录写入失败：${detail}。请核对已有任务，避免重复提交。`, config));
        }
        return {
          jobId: job.jobId, status: job.status, approved: true, asyncCallback: true,
          nextAction: '任务已获批并在 JumpServer 后台异步执行。请简要告知用户任务链接后直接结束本轮，切勿轮询等待；任务到达终态后系统将自动回调唤醒本会话进行后续核验。',
          jobUrl: job.jobUrl, mrId: mr.id, approvalId, commitSha: input.commit_sha,
        };
      },
    }),
    defineExtensionTool({
      name: 'jms_job_status', description: '查询当前会话已登记的任务结果', policy: 'readonly',
      schema: { job_id: text(128) },
      async guard(input, ctx) {
        if (!tracker) return deny('未配置交付执行追踪仓储，禁止查询任务结果');
        return await tracker.hasSessionJob(ctx.session.id, input.job_id)
          ? allow : deny('该 JumpServer 任务不属于当前变更会话，禁止查询');
      },
      async execute(input, ctx) {
        const result = await client.getJobResult(input.job_id);
        if (result.status === 'SUCCESS' || result.status === 'FAILED') {
          if (onTerminalResult) await onTerminalResult(ctx.session.id, input.job_id, result);
          else await tracker?.updateExecutionResult?.(ctx.session.id, input.job_id, result.status, result.outputSummary);
        }
        return result;
      },
    }),
  ];
}
