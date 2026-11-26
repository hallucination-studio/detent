import type { DetentCapabilityPack } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { isHubPathSegment } from '../workspace/hub-paths.js';
import { normalizeHubValue as normalize, readHubFrontmatter, readHubList } from './hub-frontmatter.js';
import { matchHubDefinitions, parseWorkflowFields, resolveHubDefinitionCapabilities, workflowKeys, type HubWorkflow } from './hub-workflows.js';

export interface HubSkill {
  name: string;
  description: string;
  path: string;
  scope: 'agent' | 'shared';
}

export interface HubAgent extends HubWorkflow {
  id: string;
  source: 'agents' | 'workflows';
  agentDir?: string;
  routingHint?: string;
  sharedSkills: string[];
  skills: HubSkill[];
}

const agentKeys = new Set([...workflowKeys, 'routing_hint', 'shared_skills']);
const skillKeys = new Set(['name', 'description']);
const agentDefinition = /^agents\/([^/]+)\/AGENT\.md$/;
const localSkillDefinition = /^agents\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;
const sharedSkillDefinition = /^skills\/([^/]+)\/SKILL\.md$/;
const workflowDefinition = /^workflows\/([^/]+)\.md$/;

export function parseHubAgentMarkdown(id: string, file: string, raw: string, source: HubAgent['source']): HubAgent | null {
  const normalizedId = normalize(id);
  const agentDir = source === 'agents' ? agentDefinition.exec(file)?.[1] : undefined;
  if (source === 'agents' && (!agentDir || !isHubPathSegment(agentDir) || normalizedId !== normalize(agentDir))) return null;
  const frontmatter = readHubFrontmatter(raw, agentKeys, source === 'agents');
  if (!frontmatter) return null;
  const workflow = parseWorkflowFields(file, frontmatter, agentDir ? 'agent::' + normalizedId : undefined);
  const sharedSkills = readHubList(frontmatter.fields.get('shared_skills'));
  if (!workflow || !sharedSkills?.every(isHubPathSegment)) return null;
  const routingHint = frontmatter.fields.get('routing_hint');
  return {
    ...workflow, id: normalizedId, source,
    ...(agentDir !== undefined && { agentDir }),
    ...(routingHint !== undefined && { routingHint }),
    sharedSkills: [...new Set(sharedSkills.map(normalize))], skills: [],
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
  const [agentTree, sharedTree, workflowTree] = await Promise.all([
    gitlab.listRepositoryTree(hubProjectId, 'agents', ref, true),
    gitlab.listRepositoryTree(hubProjectId, 'skills', ref, true),
    gitlab.listRepositoryTree(hubProjectId, 'workflows', ref),
  ]);

  const agentIds = new Set<string>();
  const definitions: { id: string; file: string; source: HubAgent['source'] }[] = [];
  const localPaths = new Map<string, string[]>();
  for (const file of blobPaths(agentTree)) {
    const dir = agentDefinition.exec(file)?.[1];
    if (dir && isHubPathSegment(dir)) {
      const id = normalize(dir);
      if (!agentIds.has(id)) {
        agentIds.add(id);
        definitions.push({ id, file, source: 'agents' });
      }
    }
    const skill = localSkillDefinition.exec(file);
    if (skill && isHubPathSegment(skill[1]) && isHubPathSegment(skill[2])) {
      const paths = localPaths.get(skill[1]);
      if (paths) paths.push(file);
      else localPaths.set(skill[1], [file]);
    }
  }
  for (const file of blobPaths(workflowTree)) {
    const name = workflowDefinition.exec(file)?.[1];
    if (!name) continue;
    const id = normalize(name);
    if (!agentIds.has(id)) definitions.push({ id, file, source: 'workflows' });
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

  const loaded = await Promise.all(definitions.map(async ({ id, file, source }) => {
    const raw = await read(file, ref);
    const agent = raw === null ? null : parseHubAgentMarkdown(id, file, raw, source);
    if (!agent) {
      invalidFiles.add(file);
      return null;
    }
    if (agent.agentDir) {
      const paths = [
        ...(localPaths.get(agent.agentDir) ?? []),
        ...agent.sharedSkills.flatMap(name => sharedPaths.get(name) ?? []),
      ].sort();
      const skills = await Promise.all(paths.map(readSkill));
      agent.skills = skills.filter(skill => skill !== null);
    }
    return agent;
  }));
  const agents = loaded.filter(agent => agent !== null).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { present: definitions.length > 0, agents, invalidFiles: [...invalidFiles].sort() };
}

type AgentMatch =
  | { kind: 'matched'; agent: HubAgent; enabledToolNames: string[] }
  | { kind: 'blocked'; message: string; agent?: HubAgent };

function agentGuidance(agents: readonly HubAgent[], invalidFiles: readonly string[]) {
  const legacy = agents.every(agent => agent.source === 'workflows') && invalidFiles.every(file => file.startsWith('workflows/'));
  return {
    term: legacy ? '工作流' : 'Agent', pathPrefix: '',
    template: legacy ? '`workflows/<name>.md`' : '`agents/<id>/AGENT.md` 或 `workflows/<name>.md`',
  };
}

function toAgentMatch(result: ReturnType<typeof matchHubDefinitions<HubAgent>>): AgentMatch {
  if (result.kind === 'matched') return { kind: 'matched', agent: result.workflow, enabledToolNames: result.enabledToolNames };
  return { kind: 'blocked', message: result.message, ...(result.workflow && { agent: result.workflow }) };
}

export function matchHubAgent(
  agents: readonly HubAgent[], issueLabels: readonly string[], capabilities: readonly DetentCapabilityPack[],
  invalidFiles: readonly string[] = [],
): AgentMatch {
  return toAgentMatch(matchHubDefinitions(agents, issueLabels, capabilities, invalidFiles, agentGuidance(agents, invalidFiles)));
}

export function resolveHubAgentCapabilities(
  agent: HubAgent, agents: readonly HubAgent[], capabilities: readonly DetentCapabilityPack[], invalidFiles: readonly string[] = [],
): AgentMatch {
  return toAgentMatch(resolveHubDefinitionCapabilities(agent, agents, capabilities, agentGuidance(agents, invalidFiles)));
}

export function renderAgentSystemPrompt(agent: HubAgent) {
  if (agent.source === 'workflows' && agent.skills.length === 0) return '当前工作流：' + agent.file + '\n\n' + agent.body;
  const prompt = '当前 Agent：' + agent.file + '\n\n' + agent.body;
  if (!agent.skills.length) return prompt;
  return [prompt, '', '## 可用 Skills（命中子任务时请用 Read 读取完整规范）',
    ...agent.skills.map(skill => `- ${skill.name}（${skill.path}）：${skill.description}`),
  ].join('\n');
}
