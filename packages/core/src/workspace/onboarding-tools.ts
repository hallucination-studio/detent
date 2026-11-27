import { z } from 'zod';
import { defineExtensionTool, type DetentCapabilityPack } from '../extensions.js';
import { GitLabError, type GitLabClient } from '../gitlab/client.js';
import { escapeTableCell } from '../gitlab/note-streamer.js';

interface TargetProject { id: number; path_with_namespace: string }
export interface OnboardingGitLab extends Pick<GitLabClient, 'getProjectMemberAccess' | 'listProjectHooks' | 'upsertProjectHook'> {
  getProject(ref: number | string): Promise<TargetProject>;
  getGroup(ref: number | string): Promise<{ id: number }>;
  listGroupProjects(id: number): Promise<TargetProject[]>;
  getBotUser(): Promise<{ id: number; username: string }>;
}
interface Options {
  gitlab: OnboardingGitLab;
  publicUrl?: string;
  webhookSecret?: string;
  sslVerify?: boolean;
}
const ref = z.union([z.number().int().positive(), z.string().trim().min(1).max(255)]);
const schema = { project: ref.optional(), group: ref.optional() };
type Targets = { project?: number | string; group?: number | string };
const events = { note_events: true, emoji_events: true, merge_requests_events: true, pipeline_events: true, deployment_events: true } as const;
const eventNames = Object.keys(events) as (keyof typeof events)[];
const setupHint = '请配置 DETENT_PUBLIC_URL 与 GITLAB_WEBHOOK_SECRET 以启用 GitLab 仓库自助接入能力包';

export function createGitLabOnboardingTools({ gitlab, publicUrl, webhookSecret, sslVerify }: Options) {
  const webhookUrl = publicUrl + '/webhooks/gitlab';
  async function inspect({ project, group }: Targets) {
    if (!publicUrl || !webhookSecret) throw Error(setupHint);
    if (project === undefined && group === undefined) throw Error('请填写目标项目或群组的路径或 ID。');
    const bot = await gitlab.getBotUser();
    const grant = (paths: string[]) => '请先在以下项目或父群组的“管理 → 成员”中授予 @' + bot.username +
      ' Maintainer（40）权限：' + paths.join('、');
    let projects: TargetProject[];
    try {
      projects = group === undefined ? [] : await gitlab.listGroupProjects((await gitlab.getGroup(group)).id);
      if (project !== undefined) projects = [...projects, await gitlab.getProject(project)];
    } catch (error) {
      if (error instanceof GitLabError && [403, 404].includes(error.status))
        throw Error('无法读取目标，请核对路径。' + grant([project, group].filter(ref => ref !== undefined).map(String)));
      throw error;
    }
    if (!projects.length) throw Error('目标群组中没有可接入的活跃项目。');
    const rows = [];
    for (const p of new Map(projects.map(p => [p.id, p])).values()) {
      const botAccessLevel = await gitlab.getProjectMemberAccess(p.id, bot.id).catch(error => {
        if (error instanceof GitLabError && error.status === 403) return null;
        throw error;
      });
      rows.push({ projectId: p.id, path: p.path_with_namespace, botAccessLevel, canManageWebhooks: (botAccessLevel ?? 0) >= 40 });
    }
    return { rows, grant };
  }
  async function writable(input: Targets) {
    const targets = await inspect(input);
    const denied = targets.rows.filter(row => !row.canManageWebhooks);
    if (denied.length) throw Error(targets.grant(denied.map(row => row.path)));
    return targets;
  }
  return [
    defineExtensionTool({
      name: 'detent_check_project_onboarding', description: '检查项目或群组中各仓库的 Bot 权限与 Webhook 事件',
      policy: 'readonly', schema,
      async execute(input) {
        const { rows, grant } = await inspect(input);
        const projects = [];
        for (const row of rows) {
          // GitLab hides project hooks below Maintainer. Do not request a privileged endpoint for those members.
          const hook = row.canManageWebhooks && (await gitlab.listProjectHooks(row.projectId)).find(h => h.url === webhookUrl);
          const missingEvents = eventNames.filter(key => !hook || !hook[key]);
          const webhookConfigured = !missingEvents.length;
          const nextStep = !row.canManageWebhooks ? grant([row.path]) + '，以便核验 Webhook。'
            : webhookConfigured ? '已接入。' : '使用 detent_onboard_project 申请生产审批。';
          projects.push({ ...row, webhookConfigured, missingEvents, nextStep });
        }
        return { projects };
      },
    }),
    defineExtensionTool({
      name: 'detent_onboard_project', description: '经生产审批后为项目或群组中的活跃项目配置 GitLab Webhook',
      policy: 'always_approve', schema,
      async guard(input) {
        try {
          await writable(input);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : '无法核验目标项目权限。' };
        }
      },
      async renderApprovalCard(id, input) {
        const { rows } = await writable(input);
        const paths = rows.slice(0, 12).map(p => escapeTableCell(p.path, 'code')).join('、');
        return [
          '### GitLab 仓库接入审批',
          input.group !== undefined && '群组范围（含子群组，执行时复核活跃项目）：' + escapeTableCell(String(input.group), 'code'),
          '目标项目：' + paths + (rows.length > 12 ? '…（共 ' + rows.length + ' 个）' : ''),
          '回调地址：' + escapeTableCell(webhookUrl, 'code'),
          '订阅事件：' + eventNames.map(name => escapeTableCell(name, 'code')).join('、'),
          '> 👍 或 `/approve` 放行 · 👎 或 `/reject` 拒绝 · <sub>审批单 `' + id + '`</sub>',
        ].filter(Boolean).join('\n\n');
      },
      async execute(input, ctx) {
        if (!ctx.approvalId) throw Error('仓库接入缺少审批单。');
        const { rows, grant } = await writable(input);
        const onboarded = [];
        for (const { projectId, path } of rows) {
          try {
            const { action } = await gitlab.upsertProjectHook(projectId, { ...events, url: webhookUrl, token: webhookSecret!,
              push_events: false, issues_events: projectId === ctx.session.hubProjectId,
              enable_ssl_verification: sslVerify ?? webhookUrl.startsWith('https:') });
            onboarded.push({ projectId, path, action });
          } catch (error) {
            if (error instanceof GitLabError && error.status === 403) throw Error(grant([path]));
            throw error;
          }
        }
        return { webhookUrl, onboarded };
      },
    }),
  ];
}

export function createGitLabOnboardingCapability(options: Options): DetentCapabilityPack {
  const enabled = Boolean(options.publicUrl && options.webhookSecret);
  return { name: 'gitlab-onboarding', approverTier: 'prod', enabled, setupHint,
    tools: enabled ? createGitLabOnboardingTools(options) : [] };
}
