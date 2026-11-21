import type { DetentCapabilityPack } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';

export type WorkflowMode = 'readonly' | 'governed';
export type WorkflowApproverTier = 'standard' | 'prod';

export interface HubWorkflow {
  file: string;
  label: string;
  mode: WorkflowMode;
  requires: string[];
  approverTier: WorkflowApproverTier;
  allowBash?: boolean;
  isDefault: boolean;
  description: string;
  body: string;
}

const normalize = (value: string) => value.trim().toLowerCase();
const keys = new Set(['label', 'mode', 'requires', 'approver_tier', 'allow_bash', 'default', 'description']);

// A single plain or quoted scalar, optionally followed by a YAML comment.
function scalar(value: string) {
  if (/^["']/.test(value)) {
    const match = /^(?:"([^"]*)"|'([^']*)')(?:\s+#.*)?$/.exec(value);
    return match?.[1] ?? match?.[2];
  }
  if (/^[\[\]{}|>]/.test(value)) return undefined;
  return value.replace(/(?:^|\s+)#.*$/, '').trim();
}

export function parseHubWorkflowMarkdown(file: string, raw: string): HubWorkflow | null {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.shift()?.trimEnd() !== '---') return null;
  const end = lines.findIndex(line => line.trimEnd() === '---');
  if (end < 0) return null;

  const fields = new Map<string, string>();
  for (const line of lines.slice(0, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = /^([a-z_]+):(?:\s+(.*)|$)/.exec(line);
    if (!field || !keys.has(field[1]) || fields.has(field[1])) return null;
    const rawValue = (field[2] ?? '').trim();
    const value = field[1] === 'requires' ? rawValue : scalar(rawValue);
    if (value === undefined) return null;
    fields.set(field[1], value);
  }
  const label = normalize(fields.get('label') ?? '');
  const mode = fields.get('mode') ?? 'governed';
  const approverTier = fields.get('approver_tier') ?? 'standard';
  const allowBash = fields.get('allow_bash');
  const byDefault = fields.get('default') ?? 'false';
  if (!label || (mode !== 'readonly' && mode !== 'governed')) return null;
  if (approverTier !== 'standard' && approverTier !== 'prod') return null;
  if (![undefined, 'true', 'false'].includes(allowBash) || !['true', 'false'].includes(byDefault)) return null;

  let list = (fields.get('requires') ?? '').replace(/(?:^|\s+)#.*$/, '').trim();
  if (list.startsWith('[') && list.endsWith(']')) list = list.slice(1, -1);
  if (/[\[\]{}]/.test(list)) return null;
  const requires = [];
  for (const item of list.split(',')) {
    const name = scalar(item.trim());
    if (name === undefined) return null;
    if (name.trim()) requires.push(normalize(name));
  }
  return {
    file, label, mode, approverTier, requires: [...new Set(requires)],
    ...(allowBash !== undefined && { allowBash: allowBash === 'true' }),
    isDefault: byDefault === 'true', description: fields.get('description') || file,
    body: lines.slice(end + 1).join('\n').trim(),
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

type WorkflowMatch =
  | { kind: 'matched'; workflow: HubWorkflow; enabledToolNames: string[] }
  | { kind: 'blocked'; message: string; workflow?: HubWorkflow };

export function matchHubWorkflow(
  workflows: readonly HubWorkflow[], issueLabels: readonly string[], capabilities: readonly DetentCapabilityPack[],
  invalidFiles: readonly string[] = [],
): WorkflowMatch {
  const labels = new Set(issueLabels.map(normalize));
  const matched = workflows.filter(w => labels.has(w.label));
  const candidates = matched.length ? matched : workflows.filter(w => w.isDefault);
  const readonly = matched.filter(w => w.mode === 'readonly');
  if (candidates.length > 1 && readonly.length !== 1) {
    const conflicts = candidates.map(w => w.label + ' (' + w.file + ')').join('、');
    const action = matched.length ? '请只保留一个工作流标签。' : '请在 Hub 只保留一个默认工作流，或指定一个工作流标签。';
    return { kind: 'blocked', message: '工作流冲突：' + conflicts + '。' + action };
  }

  const enabledPacks = capabilities.filter(pack => pack.enabled);
  const ready = new Set(enabledPacks.map(pack => normalize(pack.name)));
  const missing = (w: HubWorkflow) => w.requires.filter(name => !ready.has(name));
  const workflow = readonly[0] ?? candidates[0];
  if (!workflow) {
    const menu = workflows.map(w => {
      const needs = missing(w);
      const status = needs.length ? '缺少能力包：' + needs.join('、') : '已就绪';
      return '- ' + w.label + ' (workflows/' + w.file + ') — ' + w.description + ' [' + status + ']';
    });
    const invalid = invalidFiles.length
      ? ['以下工作流文件格式无效已忽略：' + invalidFiles.map(f => 'workflows/' + f).join('、')]
      : [];
    return { kind: 'blocked', message: [
      '未匹配到工作流。请给 Issue 添加以下任一工作流标签，或在 Hub 仓库新增 `workflows/<name>.md`。', ...menu, ...invalid,
    ].join('\n') };
  }
  const needs = missing(workflow);
  if (needs.length) {
    const message = ['workflows/' + workflow.file + ' 缺少能力包，请补齐服务端配置：'];
    for (const name of needs) {
      const pack = capabilities.find(pack => normalize(pack.name) === name);
      const hint = pack ? pack.setupHint || '请在服务端启用该能力包' : '服务端未注册该能力包';
      message.push('- ' + name + '：' + hint);
    }
    message.push('也可编辑 Hub 仓库的 workflows/' + workflow.file + '，调整 requires 和流程步骤。');
    const alternatives = workflows.filter(w => !missing(w).length).map(w => w.label);
    if (alternatives.length) message.push('可切换到已就绪的工作流标签：' + alternatives.join('、'));
    return { kind: 'blocked', workflow, message: message.join('\n') };
  }
  const tools = enabledPacks.filter(pack => workflow.requires.includes(normalize(pack.name))).flatMap(pack => pack.tools);
  const enabled = tools.filter(tool => workflow.mode !== 'readonly' || tool.policy === 'readonly');
  return { kind: 'matched', workflow, enabledToolNames: [...new Set(enabled.map(tool => tool.name))] };
}
