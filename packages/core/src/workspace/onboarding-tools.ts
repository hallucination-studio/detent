import { z } from 'zod';
import { defineExtensionTool, type DetentCapabilityPack } from '../extensions.js';
import { GitLabError, type GitLabClient } from '../gitlab/client.js';
import { escapeTableCell, renderApprovalCard } from '../gitlab/note-streamer.js';

interface TargetProject { id: number; path_with_namespace: string; default_branch?: string; web_url?: string }
export interface OnboardingGitLab extends Pick<GitLabClient, 'getProjectMemberAccess' | 'getGroupMemberAccess' | 'createProject' | 'listProjectHooks' | 'upsertProjectHook'> {
  getProject(ref: number | string): Promise<TargetProject>;
  getGroup(ref: number | string): Promise<{ id: number; full_path?: string }>;
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
  const hookRows: [string, string][] = [['回调地址', escapeTableCell(webhookUrl, 'code')],
    ['订阅事件', eventNames.map(name => escapeTableCell(name, 'code')).join('、')]];
  const approverHint = '生产审批人（Maintainer 或指定负责人）';
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
  async function prepareCreate(input: { group: number | string; path: string }) {
    if (!publicUrl || !webhookSecret) throw Error(setupHint);
    const bot = await gitlab.getBotUser();
    const grp = await gitlab.getGroup(input.group).catch(error => {
      if (error instanceof GitLabError && [403, 404].includes(error.status))
        throw Error(`请核对群组路径 ${input.group}，并在父群组授予 @${bot.username} Maintainer（40）权限。`);
      throw error;
    });
    const groupPath = grp.full_path ?? String(input.group);
    const access = await gitlab.getGroupMemberAccess(grp.id, bot.id).catch(error => {
      if (error instanceof GitLabError && error.status === 403) return null;
      throw error;
    });
    if ((access ?? 0) < 40) throw Error(`请在目标群组 ${groupPath} 授予 @${bot.username} Maintainer（40）权限。`);
    return { bot, grp, groupPath, fullPath: groupPath + '/' + input.path };
  }
  async function findProject(fullPath: string) {
    try {
      return await gitlab.getProject(fullPath);
    } catch (error) {
      if (error instanceof GitLabError && error.status === 404) return null;
      throw error;
    }
  }
  async function requireAvailable(fullPath: string) {
    if (await findProject(fullPath)) throw Error('仓库 ' + fullPath + ' 已存在，请直接检出修改或使用 detent_onboard_project 接入。');
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
      policy: 'always_approve', directExecuteOnApproval: 'resume', schema,
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
        const targets: [string, string][] = [];
        if (input.group !== undefined) targets.push(['群组范围（含子群组）', escapeTableCell(String(input.group), 'code')]);
        targets.push(['目标项目', paths + (rows.length > 12 ? '…（共 ' + rows.length + ' 个）' : '')]);
        return renderApprovalCard({ icon: '🔗', title: 'GitLab 仓库接入审批', approvalId: id, approverHint, rows: [...targets, ...hookRows] });
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
    defineExtensionTool({
      name: 'detent_create_project',
      description: '经生产审批后在指定 GitLab 群组中创建新私有仓库（初始化默认分支 main）并自动配置 Detent Webhook',
      policy: 'always_approve', directExecuteOnApproval: 'resume',
      schema: {
        group: ref,
        path: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
          .refine(path => !path.includes('..') && !/\.(git|atom)$/i.test(path), '无效的 GitLab 项目路径'),
        name: z.string().trim().min(1).max(128).optional(),
        description: z.string().trim().max(500).optional(),
      },
      async guard(input) {
        try {
          const { fullPath } = await prepareCreate(input);
          await requireAvailable(fullPath);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : '无法核验新仓库路径或群组权限。' };
        }
      },
      async renderApprovalCard(id, input) {
        const { groupPath, fullPath } = await prepareCreate(input);
        await requireAvailable(fullPath);
        return renderApprovalCard({ icon: '📁', title: 'GitLab 新建仓库审批', approvalId: id, approverHint, rows: [
          ['目标群组', escapeTableCell(groupPath, 'code')], ['新仓库路径', escapeTableCell(fullPath, 'code')],
          ['默认分支', '`main`（私有仓库，初始化 `README.md`）'], ...hookRows] });
      },
      async execute(input, ctx) {
        if (!ctx.approvalId) throw Error('新建仓库缺少审批单。');
        const { grp, fullPath } = await prepareCreate(input);
        const created = await gitlab.createProject({
          namespace_id: grp.id, name: input.name ?? input.path, path: input.path, description: input.description,
          visibility: 'private', default_branch: 'main', initialize_with_readme: true,
        }).catch(async error => {
          if (!(error instanceof GitLabError) || ![400, 409].includes(error.status)) throw error;
          const existing = await findProject(fullPath);
          if (!existing) throw error;
          return existing;
        });
        await gitlab.upsertProjectHook(created.id, { ...events, url: webhookUrl, token: webhookSecret!,
          push_events: false, issues_events: false, enable_ssl_verification: sslVerify ?? webhookUrl.startsWith('https:') });
        return { projectId: created.id, path: created.path_with_namespace, defaultBranch: created.default_branch || 'main',
          webUrl: created.web_url, webhookUrl, webhookConfigured: true };
      },
    }),
  ];
}

export function createGitLabOnboardingCapability(options: Options): DetentCapabilityPack {
  const enabled = Boolean(options.publicUrl && options.webhookSecret);
  return { name: 'gitlab-onboarding', approverTier: 'prod', enabled, setupHint,
    tools: enabled ? createGitLabOnboardingTools(options) : [] };
}
