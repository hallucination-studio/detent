import { expect, it, vi } from 'vitest';
import {
  defineExtensionTool, loadHubAgents, matchHubAgent, parseHubAgentMarkdown, parseHubSkillMarkdown, renderAgentSystemPrompt,
  type DetentCapabilityPack, type HubAgent, type HubSkill,
} from '../src/index.js';

const markdown = (fields: string, body = '# Procedure\n\nReview the result.') => `---\n${fields}\n---\n\n${body}\n`;
const agentFile = 'agents/Deploy.V1/AGENT.md';
const parse = (fields: string) => parseHubAgentMarkdown('deploy.v1', agentFile, markdown(fields), 'agents');
const skillFile = 'skills/Verify/SKILL.md';
const skillMarkdown = (name: string) => markdown(`name: ${name}\ndescription: Review the result.`, '# Full specification');

it('derives Agent defaults from its id and preserves the original directory and Markdown body', () => {
  expect(parse('')).toEqual({
    id: 'deploy.v1', source: 'agents', file: agentFile, agentDir: 'Deploy.V1', label: 'agent::deploy.v1',
    mode: 'governed', approverTier: 'standard', closePolicy: 'manual', isDefault: false, description: agentFile,
    requires: [], sharedSkills: [], skills: [], body: '# Procedure\n\nReview the result.',
  } satisfies HubAgent);
});

it('normalizes and deduplicates labels, requirements and shared skill names from CRLF frontmatter', () => {
  const raw = markdown([
    'label: " Deploy::Release " # label', 'mode: readonly', 'requires: [ Checks, checks, " Other " ]',
    'approver_tier: prod', 'close_policy: approve', 'default: true', 'allow_bash: false',
    'description: "Review #1"', 'shared_skills: [ Verify, "VERIFY", risk_notes.v2 ] # skills',
  ].join('\n')).replaceAll('\n', '\r\n');
  expect(parseHubAgentMarkdown('DEPLOY.V1', agentFile, '\uFEFF' + raw, 'agents')).toMatchObject({
    id: 'deploy.v1', label: 'deploy::release', mode: 'readonly', requires: ['checks', 'other'], approverTier: 'prod',
    closePolicy: 'approve', isDefault: true, allowBash: false, description: 'Review #1', sharedSkills: ['verify', 'risk_notes.v2'],
  });
});

it.each([
  ['Review a change # comment', 'Review a change'],
  ['"Review #42" # comment', 'Review #42'],
  ["'Check a result'", 'Check a result'],
  ['|\n    First action\n      nested: action\n\n    Last action\n', 'First action\n  nested: action\n\nLast action\n'],
  ['|- # comment\n  First action\n    # literal text', 'First action\n  # literal text'],
  ['>\n  Review changes\n  and check results\n\n  Then summarize', 'Review changes and check results\nThen summarize\n'],
  ['>-\n  Suggested action\n    more detail\n    second detail\n  Finish', 'Suggested action\n  more detail\n  second detail\nFinish'],
])('parses the routing hint %j without consuming the next field', (hint, expected) => {
  expect(parse(`routing_hint: ${hint}\nmode: readonly`)).toMatchObject({ routingHint: expected, mode: 'readonly' });
});

it.each([
  'unknown: yes', 'description: "unclosed', 'description: [not, scalar]', 'description: key: value', 'label: ', 'label: x\nlabel: y',
  'mode: auto', 'approver_tier: elevated', 'close_policy: invalid', 'allow_bash: yes', 'default: yes',
  'requires: [broken', 'requires: [one,,two]', 'requires: [nested, [list]]',
  'routing_hint: |\nUnindented text', 'routing_hint: >\nmode: readonly', 'routing_hint: |+\n  Unsupported style',
  'shared_skills: [../outside]', 'shared_skills: [..]', 'shared_skills: [a/b]', 'shared_skills: [""]',
  'shared_skills: [" verify "]', 'shared_skills: [a,,b]', 'shared_skills: [a, b',
])('rejects invalid Agent frontmatter %j', fields => {
  expect(parse(fields)).toBeNull();
});

it('rejects missing delimiters and unsafe Agent directories', () => {
  for (const raw of ['# Procedure', 'label: deploy\n---', '---\nlabel: deploy', 'preamble\n' + markdown('')])
    expect(parseHubAgentMarkdown('deploy.v1', agentFile, raw, 'agents')).toBeNull();
  for (const dir of ['', '..', '.hidden', 'foo/bar', 'with space', 'a\\b'])
    expect(parseHubAgentMarkdown(dir, `agents/${dir}/AGENT.md`, markdown(''), 'agents')).toBeNull();
});

it('requires an explicit legacy label and accepts the existing workflow list syntax', () => {
  const file = 'workflows/Release.md';
  expect(parseHubAgentMarkdown('Release', file, markdown(''), 'workflows')).toBeNull();
  const legacy = parseHubAgentMarkdown('Release', file, markdown('label: Release\nrequires: [Checks, ,]'), 'workflows');
  expect(legacy).toMatchObject({ id: 'release', source: 'workflows', file, label: 'release', requires: ['checks'], skills: [] });
  expect(legacy).not.toHaveProperty('agentDir');
});

it('reads only Skill metadata and retains the exact path and scope', () => {
  const raw = markdown('name: "Verify Changes"\ndescription: "Check #42" # note', 'Skill instructions.');
  expect(parseHubSkillMarkdown(skillFile, raw, 'shared')).toEqual({
    name: 'Verify Changes', description: 'Check #42', path: skillFile, scope: 'shared',
  } satisfies HubSkill);
});

it.each([
  '# No header', '---\nname: Verify\ndescription: Check', markdown('name: Verify'), markdown('description: Check'),
  markdown('name: " "\ndescription: Check'), markdown('name: Verify\ndescription: ""'),
  markdown('name: Verify\ndescription: Check\nextra: unknown'), markdown('name: Verify\nname: Again\ndescription: Check'),
  markdown('name: Verify\ndescription: invalid: mapping'),
])('rejects invalid Skill Markdown %j', raw => {
  expect(parseHubSkillMarkdown(skillFile, raw, 'agent')).toBeNull();
});

const blob = (path: string) => ({ id: path, path, name: 'unused name', type: 'blob' as const });

it('loads sorted Hub Agents and their scoped skills, preserving standalone legacy definitions', async () => {
  const localSkill = 'agents/Deploy.V1/skills/Check/SKILL.md';
  const otherLocalSkill = 'agents/Deploy.V1/skills/Review/SKILL.md';
  const badLocalSkill = 'agents/Deploy.V1/skills/Bad/SKILL.md';
  const badSharedSkill = 'skills/Malformed/SKILL.md';
  const missingAgent = 'agents/Missing/AGENT.md';
  const legacy = 'workflows/Audit.md';
  const shadowed = 'workflows/DEPLOY.V1.md';
  const alsoReferencesVerify = 'agents/Other/AGENT.md';
  const files: Record<string, string> = {
    [agentFile]: markdown('shared_skills: [verify, absent, malformed, VERIFY]'),
    [localSkill]: skillMarkdown('Z Local'), [otherLocalSkill]: skillMarkdown('A Local'),
    [badLocalSkill]: markdown('name: Missing Description'), [skillFile]: skillMarkdown('Verify'),
    [badSharedSkill]: '# Invalid', [legacy]: markdown('label: audit\nmode: readonly'),
    [alsoReferencesVerify]: markdown('shared_skills: [verify]'),
  };
  const trees = {
    agents: [localSkill, 'agents/../AGENT.md', agentFile, badLocalSkill, missingAgent, otherLocalSkill, alsoReferencesVerify,
      'agents/Deploy.V1/nested/AGENT.md', 'agents/Deploy.V1/skills/../SKILL.md', 'agents/Deploy.V1/skills/Deep/sub/SKILL.md',
      'agents/Deploy.V1/skills/Lower/skill.md', 'agents/Orphan/skills/Unused/SKILL.md'].map(blob),
    skills: [badSharedSkill, skillFile, 'skills/Unused/SKILL.md', 'skills/Unrelated/Nested/SKILL.md', 'skills/../SKILL.md'].map(blob),
    workflows: [...[shadowed, legacy, 'workflows/nested/skip.md', 'outside/skip.md', 'workflows/notes.txt'].map(blob),
      { ...blob('workflows/folder.md'), type: 'tree' as const }],
  };
  const gitlab = {
    listRepositoryTree: vi.fn(async (_project: number, dir: string) => trees[dir as keyof typeof trees]),
    getRepositoryFile: vi.fn(async (_project: number, file: string) => files[file] ?? null),
  };
  const result = await loadHubAgents(gitlab, 12, 'stable');
  expect(gitlab.listRepositoryTree.mock.calls).toEqual([[12, 'agents', 'stable', true], [12, 'skills', 'stable', true], [12, 'workflows', 'stable']]);
  expect(result.present).toBe(true);
  expect(result.agents.map(agent => agent.id)).toEqual(['audit', 'deploy.v1', 'other']);
  expect(result.agents.map(agent => agent.source)).toEqual(['workflows', 'agents', 'agents']);
  expect(result.agents[1]).toMatchObject({
    sharedSkills: ['verify', 'absent', 'malformed'],
    skills: [
      { name: 'Z Local', path: localSkill, scope: 'agent' }, { name: 'A Local', path: otherLocalSkill, scope: 'agent' },
      { name: 'Verify', path: skillFile, scope: 'shared' },
    ],
  });
  expect(result.agents[2].skills.map(skill => skill.path)).toEqual([skillFile]);
  expect(result.invalidFiles).toEqual([badLocalSkill, missingAgent, badSharedSkill]);
  const requested = [...Object.keys(files), missingAgent].sort();
  expect(gitlab.getRepositoryFile.mock.calls.map(call => call[1]).sort()).toEqual(requested);
  for (const file of requested) expect(gitlab.getRepositoryFile).toHaveBeenCalledWith(12, file, 'stable');
});

it('distinguishes absent definitions, invalid definitions and failed GitLab reads', async () => {
  const absent = { present: false, agents: [], invalidFiles: [] };
  const listRepositoryTree = vi.fn().mockResolvedValue([blob(skillFile)]);
  const getRepositoryFile = vi.fn().mockResolvedValue('# Invalid frontmatter');
  expect(await loadHubAgents({ listRepositoryTree }, 1, 'main')).toEqual(absent);
  expect(listRepositoryTree).not.toHaveBeenCalled();
  expect(await loadHubAgents({ getRepositoryFile }, 1, 'main')).toEqual(absent);
  expect(await loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main')).toEqual(absent);
  expect(getRepositoryFile).not.toHaveBeenCalled();

  listRepositoryTree.mockResolvedValue([blob(agentFile), blob('workflows/Deploy.V1.md')]);
  expect(await loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main')).toEqual({
    present: true, agents: [], invalidFiles: [agentFile],
  });
  expect(getRepositoryFile).toHaveBeenCalledExactlyOnceWith(1, agentFile, 'main');
  listRepositoryTree.mockRejectedValue(Error('GitLab HTTP 403'));
  await expect(loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main')).rejects.toThrow('403');
});

it('keeps legacy files with different labels routable when their filenames differ only by case', async () => {
  const listRepositoryTree = vi.fn(async (_project: number, dir: string) =>
    dir === 'workflows' ? ['workflows/review.md', 'workflows/Review.md'].map(blob) : []);
  const getRepositoryFile = vi.fn(async (_project: number, file: string) =>
    markdown(file.endsWith('Review.md') ? 'label: standard-review' : 'label: quick-review'));
  const { agents } = await loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main');
  expect(agents.map(agent => agent.file)).toEqual(['workflows/Review.md', 'workflows/review.md']);
  expect(matchHubAgent(agents, ['quick-review'], [])).toMatchObject({ kind: 'matched', agent: { file: 'workflows/review.md' } });
});

const inspect = defineExtensionTool({ name: 'inspect', policy: 'readonly', description: '', schema: {}, execute: vi.fn() });
const checks: DetentCapabilityPack = {
  name: ' Checks ', enabled: true, tools: [inspect, inspect, { ...inspect, name: 'apply', policy: 'always_approve' }],
};
const deploy = parse('requires: [checks]\ndefault: true')!;
const audit = parseHubAgentMarkdown('audit', 'workflows/audit.md', markdown('label: Audit\nmode: readonly\nrequires: checks'), 'workflows')!;

it('prioritizes a single explicitly matched readonly Agent and uses the default only without a label match', () => {
  expect(matchHubAgent([deploy, audit], ['unknown'], [checks])).toEqual({ kind: 'matched', agent: deploy, enabledToolNames: ['inspect', 'apply'] });
  expect(matchHubAgent([deploy, audit], [' AGENT::DEPLOY.V1 ', ' AUDIT '], [checks])).toEqual({
    kind: 'matched', agent: audit, enabledToolNames: ['inspect'],
  });
  const enabled = [{ ...checks, enabled: false }, checks, { ...checks, name: 'unrelated', tools: [{ ...inspect, name: 'other' }] }];
  expect(matchHubAgent([deploy, audit], ['agent::deploy.v1'], enabled)).toMatchObject({ enabledToolNames: ['inspect', 'apply'] });
});

it('reports conflicts for multiple matches without a single readonly match and for ambiguous defaults', () => {
  const governanceAudit = { ...audit, mode: 'governed' as const };
  for (const agents of [[deploy, governanceAudit], [{ ...deploy, mode: 'readonly' as const }, audit]])
    expect(matchHubAgent(agents, ['agent::deploy.v1', 'audit'], [checks])).toMatchObject({
      kind: 'blocked', message: expect.stringContaining('agent::deploy.v1 (' + agentFile + ')、audit (workflows/audit.md)'),
    });
  expect(matchHubAgent([deploy, { ...audit, isDefault: true }], [], [checks])).toMatchObject({
    kind: 'blocked', message: expect.stringContaining('默认Agent'),
  });
});

it('lists full paths and invalid files and explains missing capabilities with ready alternatives', () => {
  const ready = { ...audit, requires: [] };
  const needs = { ...deploy, requires: ['checks', 'missing'], isDefault: false };
  const capability = { ...checks, enabled: false, setupHint: 'Configure CHECKS_TOKEN.' };
  const invalid = ['skills/Malformed/SKILL.md'];
  const menu = matchHubAgent([ready, needs], [], [capability], invalid);
  expect(menu.kind).toBe('blocked');
  if (menu.kind !== 'blocked') throw Error('Expected a menu');
  for (const line of [agentFile, 'workflows/audit.md', ...invalid, 'agents/<id>/AGENT.md', '已就绪', '缺少能力包'])
    expect(menu.message).toContain(line);
  const missing = matchHubAgent([ready, needs], ['agent::deploy.v1'], [capability]);
  expect(missing).toMatchObject({ kind: 'blocked', agent: needs });
  if (missing.kind !== 'blocked') throw Error('Expected missing capabilities');
  for (const line of [agentFile, 'checks：Configure CHECKS_TOKEN.', 'missing：服务端未注册该能力包', '已就绪的Agent标签：audit'])
    expect(missing.message).toContain(line);
});

it('renders a Skill index while preserving the legacy workflow prompt exactly', () => {
  expect(renderAgentSystemPrompt(audit)).toBe('当前工作流：workflows/audit.md\n\n' + audit.body);
  expect(renderAgentSystemPrompt(deploy)).toBe('当前 Agent：' + agentFile + '\n\n' + deploy.body);
  const skill = parseHubSkillMarkdown(skillFile, skillMarkdown('Verify'), 'shared')!;
  expect(renderAgentSystemPrompt({ ...deploy, skills: [skill] })).toBe([
    '当前 Agent：' + agentFile, '', deploy.body, '', '## 可用 Skills（命中子任务时请用 Read 读取完整规范）',
    '- Verify（skills/Verify/SKILL.md）：Review the result.',
  ].join('\n'));
});
