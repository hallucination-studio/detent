import type { DetentCapabilityPack, IssueClosePolicy } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { isHubPathSegment } from '../workspace/hub-paths.js';
import { normalizeHubValue as normalize, readHubFrontmatter, readHubList } from './hub-frontmatter.js';
import { escapeTableCell, renderNote } from '../gitlab/note-streamer.js';

export type WorkflowMode = 'readonly' | 'governed';
export type WorkflowApproverTier = 'standard' | 'prod';

export interface HubAgent {
  id: string;
  agentDir: string;
  sharedSkills: string[];
  skills: HubSkill[];
  file: string;
  label: string;
  mode: WorkflowMode;
  requires: string[];
  uses: string[];
  approverTier: WorkflowApproverTier;
  closePolicy: IssueClosePolicy;
  allowBash?: boolean;
  account?: string;
  allowPrefixes?: string[];
  description: string;
  body: string;
}

export interface HubSkill {
  name: string;
  description: string;
  path: string;
  scope: 'agent' | 'shared';
}

const agentKeys = new Set(['label', 'mode', 'requires', 'uses', 'approver_tier', 'close_policy', 'allow_bash', 'account',
  'allow_prefixes', 'description', 'shared_skills', 'default', 'routing_hint']);
const skillKeys = new Set(['name', 'description']);
const agentDefinition = /^agents\/([^/]+)\/AGENT\.md$/;
const localSkillDefinition = /^agents\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;
const sharedSkillDefinition = /^skills\/([^/]+)\/SKILL\.md$/;

export function parseHubAgentMarkdown(id: string, file: string, raw: string): HubAgent | null {
  const normalizedId = normalize(id);
  const agentDir = agentDefinition.exec(file)?.[1];
  if (!agentDir || !isHubPathSegment(agentDir) || normalizedId !== normalize(agentDir)) return null;
  const frontmatter = readHubFrontmatter(raw, agentKeys);
  if (!frontmatter) return null;
  const { fields, body } = frontmatter;
  const label = normalize(fields.get('label') ?? 'agent::' + normalizedId);
  const mode = fields.get('mode') ?? 'governed';
  const approverTier = fields.get('approver_tier') ?? 'standard';
  const closePolicy = fields.get('close_policy') ?? 'manual';
  if (closePolicy !== 'manual' && closePolicy !== 'auto' && closePolicy !== 'approve') return null;
  const allowBash = fields.get('allow_bash');
  const byDefault = fields.get('default') ?? 'false';
  if (!label || (mode !== 'readonly' && mode !== 'governed')) return null;
  if (approverTier !== 'standard' && approverTier !== 'prod') return null;
  if (![undefined, 'true', 'false'].includes(allowBash) || !['true', 'false'].includes(byDefault)) return null;

  const requires = readHubList(fields.get('requires'));
  const uses = readHubList(fields.get('uses'));
  const allowPrefixes = readHubList(fields.get('allow_prefixes'));
  const sharedSkills = readHubList(fields.get('shared_skills'));
  if (!requires || !uses || !allowPrefixes || !sharedSkills?.every(isHubPathSegment)) return null;
  const account = fields.get('account')?.trim();
  return {
    id: normalizedId, agentDir, file, label, mode, approverTier, closePolicy, requires: [...new Set(requires.map(normalize))],
    uses: [...new Set(uses.map(normalize))],
    ...(account && { account }),
    ...(fields.has('allow_prefixes') && { allowPrefixes }),
    ...(allowBash !== undefined && { allowBash: allowBash === 'true' }),
    sharedSkills: [...new Set(sharedSkills.map(normalize))], skills: [],
    description: fields.get('description') || file, body,
  };
}

export function parseHubSkillMarkdown(filePath: string, raw: string, scope: HubSkill['scope']): HubSkill | null {
  const frontmatter = readHubFrontmatter(raw, skillKeys);
  const name = frontmatter?.fields.get('name')?.trim();
  const description = frontmatter?.fields.get('description')?.trim();
  return name && description ? { name, description, path: filePath, scope } : null;
}

function blobPaths(entries: Awaited<ReturnType<GitLabClient['listRepositoryTree']>>) {
  return [...new Set(entries.filter(entry => entry.type === 'blob').map(entry => entry.path))].sort();
}

export async function loadHubAgents(
  gitlab: Partial<Pick<GitLabClient, 'listRepositoryTree' | 'getRepositoryFile'>>, hubProjectId: number, ref: string,
) {
  if (!gitlab.listRepositoryTree || !gitlab.getRepositoryFile) return { present: false, agents: [], invalidFiles: [] };
  const [agentTree, sharedTree] = await Promise.all([
    gitlab.listRepositoryTree(hubProjectId, 'agents', ref, true),
    gitlab.listRepositoryTree(hubProjectId, 'skills', ref, true),
  ]);

  const agentIds = new Set<string>();
  const definitions: { id: string; file: string }[] = [];
  const localPaths = new Map<string, string[]>();
  for (const file of blobPaths(agentTree)) {
    const dir = agentDefinition.exec(file)?.[1];
    if (dir && isHubPathSegment(dir)) {
      const id = normalize(dir);
      if (!agentIds.has(id)) {
        agentIds.add(id);
        definitions.push({ id, file });
      }
    }
    const skill = localSkillDefinition.exec(file);
    if (skill && isHubPathSegment(skill[1]) && isHubPathSegment(skill[2])) {
      const paths = localPaths.get(skill[1]);
      if (paths) paths.push(file);
      else localPaths.set(skill[1], [file]);
    }
  }
  const sharedPaths = new Map<string, string>();
  for (const file of blobPaths(sharedTree)) {
    const dir = sharedSkillDefinition.exec(file)?.[1];
    if (!dir || !isHubPathSegment(dir)) continue;
    const name = normalize(dir);
    if (!sharedPaths.has(name)) sharedPaths.set(name, file);
  }

  const invalidFiles = new Set<string>();
  const read = gitlab.getRepositoryFile.bind(gitlab, hubProjectId);
  const skillReads = new Map<string, Promise<HubSkill | null>>();
  function readSkill(file: string) {
    const existing = skillReads.get(file);
    if (existing) return existing;
    const pending = read(file, ref).then(raw => {
      const skill = raw === null ? null : parseHubSkillMarkdown(file, raw, file.startsWith('agents/') ? 'agent' : 'shared');
      if (!skill) invalidFiles.add(file);
      return skill;
    });
    skillReads.set(file, pending);
    return pending;
  }

  const loaded = await Promise.all(definitions.map(async ({ id, file }) => {
    const raw = await read(file, ref);
    const agent = raw === null ? null : parseHubAgentMarkdown(id, file, raw);
    if (!agent) {
      invalidFiles.add(file);
      return null;
    }
    const paths = [
      ...(localPaths.get(agent.agentDir) ?? []),
      ...agent.sharedSkills.flatMap(name => sharedPaths.get(name) ?? []),
    ].sort();
    const skills = await Promise.all(paths.map(readSkill));
    agent.skills = skills.filter(skill => skill !== null);
    return agent;
  }));
  const agents = loaded.filter(agent => agent !== null).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { present: definitions.length > 0, agents, invalidFiles: [...invalidFiles].sort() };
}

type AgentMatch =
  | { kind: 'matched'; agent: HubAgent; enabledToolNames: string[] }
  | { kind: 'blocked'; message: string; agent?: HubAgent };

export function missingHubCapabilities(workflow: HubAgent, capabilities: readonly DetentCapabilityPack[]): string[] {
  return workflow.requires.filter(name => !capabilities.some(pack => pack.enabled && normalize(pack.name) === name));
}

export function resolveHubAgentCapabilities(agent: HubAgent, agents: readonly HubAgent[], capabilities: readonly DetentCapabilityPack[]): AgentMatch {
  const needs = missingHubCapabilities(agent, capabilities);
  if (needs.length) {
    const ready = agents.filter(w => !missingHubCapabilities(w, capabilities).length);
    const hints = needs.map(name => {
      const pack = capabilities.find(pack => normalize(pack.name) === name);
      return '- ' + escapeTableCell(name) + '：' + (pack?.setupHint || '请在服务端配置并启用此能力。');
    });
    const message = [
      '### ⚪ 当前能力尚未开通',
      `「${escapeTableCell(agent.description)}」需要 ${needs.map(name => escapeTableCell(name, 'code')).join('、')}，当前尚未接入。`,
      ready.length && ['可通过以下标签使用已就绪的能力：',
        ...ready.map(w => '- ' + escapeTableCell(w.description) + ' · ' + escapeTableCell(w.label, 'code'))].join('\n'),
      ['<details><summary>管理员如何开通？</summary>', '', ...hints, '', '</details>'].join('\n'),
    ].filter(Boolean).join('\n\n');
    return { kind: 'blocked', agent, message: renderNote(message) };
  }
  const selected = new Set([...agent.requires, ...agent.uses]);
  const allEnabled = agent.uses.includes('*');
  const tools = capabilities.filter(pack => pack.enabled && (allEnabled || selected.has(normalize(pack.name)))).flatMap(pack => pack.tools);
  const enabled = tools.filter(tool => agent.mode !== 'readonly' || tool.policy === 'readonly');
  return { kind: 'matched', agent, enabledToolNames: [...new Set(enabled.map(tool => tool.name))] };
}

export function matchHubAgent(agents: readonly HubAgent[], labels: readonly string[], capabilities: readonly DetentCapabilityPack[]): AgentMatch | undefined {
  const issueLabels = new Set(labels.map(normalize));
  const matched = agents.filter(agent => issueLabels.has(agent.label));
  if (!matched.length) return;
  const readonly = matched.filter(agent => agent.mode === 'readonly');
  if (matched.length > 1 && readonly.length !== 1)
    return { kind: 'blocked', message: 'Agent 标签冲突：' + matched.map(agent => agent.label + ' (' + agent.file + ')').join('、') };
  return resolveHubAgentCapabilities(readonly[0] ?? matched[0], agents, capabilities);
}

export function renderAgentSystemPrompt(agent: HubAgent) {
  const prompt = '当前 Agent：' + agent.file + '\n\n' + agent.body;
  if (!agent.skills.length) return prompt;
  return [prompt, '', '## 可用 Skills（命中子任务时请用 Read 读取完整规范）',
    ...agent.skills.map(skill => `- ${skill.name}（${skill.path}）：${skill.description}`),
  ].join('\n');
}
