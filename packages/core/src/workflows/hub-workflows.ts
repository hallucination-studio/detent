import type { DetentCapabilityPack, IssueClosePolicy } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { normalizeHubValue as normalize, readHubFrontmatter, readHubList, type HubFrontmatter } from './hub-frontmatter.js';

export type WorkflowMode = 'readonly' | 'governed';
export type WorkflowApproverTier = 'standard' | 'prod';

export interface HubWorkflow {
  file: string;
  label: string;
  mode: WorkflowMode;
  requires: string[];
  approverTier: WorkflowApproverTier;
  closePolicy: IssueClosePolicy;
  allowBash?: boolean;
  isDefault: boolean;
  description: string;
  body: string;
}

export const workflowKeys = new Set(['label', 'mode', 'requires', 'approver_tier', 'close_policy', 'allow_bash', 'default', 'description']);

export function parseHubWorkflowMarkdown(file: string, raw: string): HubWorkflow | null {
  const frontmatter = readHubFrontmatter(raw, workflowKeys, false);
  return frontmatter && parseWorkflowFields(file, frontmatter);
}

export function parseWorkflowFields(file: string, { fields, body }: HubFrontmatter, defaultLabel?: string): HubWorkflow | null {
  const label = normalize(fields.get('label') ?? defaultLabel ?? '');
  const mode = fields.get('mode') ?? 'governed';
  const approverTier = fields.get('approver_tier') ?? 'standard';
  const closePolicy = fields.get('close_policy') ?? 'manual';
  if (closePolicy !== 'manual' && closePolicy !== 'auto' && closePolicy !== 'approve') return null;
  const allowBash = fields.get('allow_bash');
  const byDefault = fields.get('default') ?? 'false';
  if (!label || (mode !== 'readonly' && mode !== 'governed')) return null;
  if (approverTier !== 'standard' && approverTier !== 'prod') return null;
  if (![undefined, 'true', 'false'].includes(allowBash) || !['true', 'false'].includes(byDefault)) return null;

  // Legacy workflow files also accepted lists with empty slots.
  const requires = readHubList(fields.get('requires'), defaultLabel === undefined);
  if (!requires) return null;
  return {
    file, label, mode, approverTier, closePolicy, requires: [...new Set(requires.map(normalize))],
    ...(allowBash !== undefined && { allowBash: allowBash === 'true' }),
    isDefault: byDefault === 'true', description: fields.get('description') || file, body,
  };
}

export async function loadHubWorkflows(
  gitlab: Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile'>>, hubProjectId: number, ref: string,
) {
  const workflows: HubWorkflow[] = [];
  const invalidFiles: string[] = [];
  if (!gitlab.listRepositoryTree || !gitlab.getRepositoryFile) return { present: false, workflows, invalidFiles };
  const entries = (await gitlab.listRepositoryTree(hubProjectId, 'workflows', ref))
    .filter(entry => entry.type === 'blob' && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const contents = await Promise.all(entries.map(entry => gitlab.getRepositoryFile!(hubProjectId, entry.path, ref)));
  for (const [i, entry] of entries.entries()) {
    const raw = contents[i];
    const workflow = raw === null ? null : parseHubWorkflowMarkdown(entry.name, raw);
    if (workflow) workflows.push(workflow);
    else invalidFiles.push(entry.name);
  }
  return { present: entries.length > 0, workflows, invalidFiles };
}

type WorkflowMatch<T extends HubWorkflow = HubWorkflow> =
  | { kind: 'matched'; workflow: T; enabledToolNames: string[] }
  | { kind: 'blocked'; message: string; workflow?: T };

const workflowGuidance = { term: '工作流', pathPrefix: 'workflows/', template: '`workflows/<name>.md`' };

export function matchHubWorkflow(
  workflows: readonly HubWorkflow[], issueLabels: readonly string[], capabilities: readonly DetentCapabilityPack[],
  invalidFiles: readonly string[] = [],
): WorkflowMatch {
  return matchHubDefinitions(workflows, issueLabels, capabilities, invalidFiles, workflowGuidance);
}

export function findMatchingHubDefinitions<T extends HubWorkflow>(workflows: readonly T[], issueLabels: readonly string[]): T[] {
  const labels = new Set(issueLabels.map(normalize));
  return workflows.filter(workflow => labels.has(workflow.label));
}

export function missingHubCapabilities(workflow: HubWorkflow, capabilities: readonly DetentCapabilityPack[]): string[] {
  return workflow.requires.filter(name => !capabilities.some(pack => pack.enabled && normalize(pack.name) === name));
}

export function matchHubDefinitions<T extends HubWorkflow>(
  workflows: readonly T[], issueLabels: readonly string[], capabilities: readonly DetentCapabilityPack[],
  invalidFiles: readonly string[], { term, pathPrefix, template }: typeof workflowGuidance,
): WorkflowMatch<T> {
  const matched = findMatchingHubDefinitions(workflows, issueLabels);
  const candidates = matched.length ? matched : workflows.filter(w => w.isDefault);
  const readonly = matched.filter(w => w.mode === 'readonly');
  if (candidates.length > 1 && readonly.length !== 1) {
    const conflicts = candidates.map(w => w.label + ' (' + w.file + ')').join('、');
    const action = matched.length ? `请只保留一个${term}标签。` : `请在 Hub 只保留一个默认${term}，或指定一个${term}标签。`;
    return { kind: 'blocked', message: term + '冲突：' + conflicts + '。' + action };
  }

  const workflow = readonly[0] ?? candidates[0];
  if (!workflow) {
    const menu = workflows.map(w => {
      const needs = missingHubCapabilities(w, capabilities);
      const status = needs.length ? '缺少能力包：' + needs.join('、') : '已就绪';
      return '- ' + w.label + ' (' + pathPrefix + w.file + ') — ' + w.description + ' [' + status + ']';
    });
    const invalid = invalidFiles.length
      ? [`以下${term}文件格式无效已忽略：` + invalidFiles.map(f => pathPrefix + f).join('、')]
      : [];
    return { kind: 'blocked', message: [
      `未匹配到${term}。请给 Issue 添加以下任一${term}标签，或在 Hub 仓库新增 ${template}。`, ...menu, ...invalid,
    ].join('\n') };
  }
  return resolveHubDefinitionCapabilities(workflow, workflows, capabilities, { term, pathPrefix });
}

export function resolveHubDefinitionCapabilities<T extends HubWorkflow>(
  workflow: T, workflows: readonly T[], capabilities: readonly DetentCapabilityPack[],
  { term, pathPrefix }: Pick<typeof workflowGuidance, 'term' | 'pathPrefix'>,
): WorkflowMatch<T> {
  const needs = missingHubCapabilities(workflow, capabilities);
  if (needs.length) {
    const message = [pathPrefix + workflow.file + ' 缺少能力包，请补齐服务端配置：'];
    for (const name of needs) {
      const pack = capabilities.find(pack => normalize(pack.name) === name);
      const hint = pack ? pack.setupHint || '请在服务端启用该能力包' : '服务端未注册该能力包';
      message.push('- ' + name + '：' + hint);
    }
    message.push('也可编辑 Hub 仓库的 ' + pathPrefix + workflow.file + '，调整 requires 和流程步骤。');
    const alternatives = workflows.filter(w => !missingHubCapabilities(w, capabilities).length).map(w => w.label);
    if (alternatives.length) message.push(`可切换到已就绪的${term}标签：` + alternatives.join('、'));
    return { kind: 'blocked', workflow, message: message.join('\n') };
  }
  const tools = capabilities.filter(pack => pack.enabled && workflow.requires.includes(normalize(pack.name))).flatMap(pack => pack.tools);
  const enabled = tools.filter(tool => workflow.mode !== 'readonly' || tool.policy === 'readonly');
  return { kind: 'matched', workflow, enabledToolNames: [...new Set(enabled.map(tool => tool.name))] };
}
