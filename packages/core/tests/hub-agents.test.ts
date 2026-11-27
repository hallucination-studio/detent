import { expect, it, vi } from 'vitest';
import {
  defineExtensionTool, loadHubAgents, matchHubAgent, parseHubAgentMarkdown, parseHubSkillMarkdown, renderAgentSystemPrompt,
  type DetentCapabilityPack, type HubAgent, type HubSkill,
} from '../src/index.js';

const markdown = (fields: string, body = '# Procedure\n\nReview the result.') => `---\n${fields}\n---\n\n${body}\n`;
const agentFile = 'agents/Deploy.V1/AGENT.md';
const parse = (fields: string) => parseHubAgentMarkdown('deploy.v1', agentFile, markdown(fields));
const skillFile = 'skills/Verify/SKILL.md';
const skillMarkdown = (name: string) => markdown(`name: ${name}\ndescription: Review the result.`, '# Full specification');

it('derives Agent defaults from its id and preserves the original directory and Markdown body', () => {
  expect(parse('')).toEqual({
    id: 'deploy.v1', file: agentFile, agentDir: 'Deploy.V1', label: 'agent::deploy.v1',
    mode: 'governed', approverTier: 'standard', closePolicy: 'manual', description: agentFile,
    requires: [], uses: [], sharedSkills: [], skills: [], body: '# Procedure\n\nReview the result.',
  } satisfies HubAgent);
});

it('normalizes and deduplicates labels, requirements and shared skill names from CRLF frontmatter', () => {
  const raw = markdown([
    'label: " Deploy::Release " # label', 'mode: readonly', 'requires: [ Checks, checks, " Other " ]',
    'approver_tier: prod', 'close_policy: approve', 'default: true', 'allow_bash: false',
    'description: "Review #1"', 'shared_skills: [ Verify, "VERIFY", risk_notes.v2 ] # skills',
  ].join('\n')).replaceAll('\n', '\r\n');
  expect(parseHubAgentMarkdown('DEPLOY.V1', agentFile, '\uFEFF' + raw)).toMatchObject({
    id: 'deploy.v1', label: 'deploy::release', mode: 'readonly', requires: ['checks', 'other'], approverTier: 'prod',
    closePolicy: 'approve', allowBash: false, description: 'Review #1', sharedSkills: ['verify', 'risk_notes.v2'],
  });
});

it('accepts existing multiline metadata without consuming the next security field', () => {
  expect(parse('routing_hint: >-\n  Review the changes\n  and run tests\nmode: readonly')).toMatchObject({ mode: 'readonly' });
});

it.each([
  'unknown: yes', 'description: "unclosed', 'description: [not, scalar]', 'description: key: value', 'label: ', 'label: x\nlabel: y',
  'mode: auto', 'approver_tier: elevated', 'close_policy: invalid', 'allow_bash: yes', 'default: yes',
  'requires: [broken', 'requires: [one,,two]', 'requires: [nested, [list]]',
  'uses: [broken', 'uses: [checks,,other]',
  'routing_hint: |\nUnindented text', 'routing_hint: >\nmode: readonly', 'routing_hint: |+\n  Unsupported style',
  'shared_skills: [../outside]', 'shared_skills: [..]', 'shared_skills: [a/b]', 'shared_skills: [""]',
  'shared_skills: [" verify "]', 'shared_skills: [a,,b]', 'shared_skills: [a, b',
])('rejects invalid Agent frontmatter %j', fields => {
  expect(parse(fields)).toBeNull();
});

it('rejects missing delimiters and unsafe Agent directories', () => {
  for (const raw of ['# Procedure', 'label: deploy\n---', '---\nlabel: deploy', 'preamble\n' + markdown('')])
    expect(parseHubAgentMarkdown('deploy.v1', agentFile, raw)).toBeNull();
  for (const dir of ['', '..', '.hidden', 'foo/bar', 'with space', 'a\\b'])
    expect(parseHubAgentMarkdown(dir, `agents/${dir}/AGENT.md`, markdown(''))).toBeNull();
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

it('loads sorted Hub Agents and their scoped skills', async () => {
  const localSkill = 'agents/Deploy.V1/skills/Check/SKILL.md';
  const otherLocalSkill = 'agents/Deploy.V1/skills/Review/SKILL.md';
  const badLocalSkill = 'agents/Deploy.V1/skills/Bad/SKILL.md';
  const badSharedSkill = 'skills/Malformed/SKILL.md';
  const missingAgent = 'agents/Missing/AGENT.md';
  const alsoReferencesVerify = 'agents/Other/AGENT.md';
  const files: Record<string, string> = {
    [agentFile]: markdown('shared_skills: [verify, absent, malformed, VERIFY]'),
    [localSkill]: skillMarkdown('Z Local'), [otherLocalSkill]: skillMarkdown('A Local'),
    [badLocalSkill]: markdown('name: Missing Description'), [skillFile]: skillMarkdown('Verify'),
    [badSharedSkill]: '# Invalid',
    [alsoReferencesVerify]: markdown('shared_skills: [verify]'),
  };
  const trees = {
    agents: [localSkill, 'agents/../AGENT.md', agentFile, badLocalSkill, missingAgent, otherLocalSkill, alsoReferencesVerify,
      'agents/Deploy.V1/nested/AGENT.md', 'agents/Deploy.V1/skills/../SKILL.md', 'agents/Deploy.V1/skills/Deep/sub/SKILL.md',
      'agents/Deploy.V1/skills/Lower/skill.md', 'agents/Orphan/skills/Unused/SKILL.md'].map(blob),
    skills: [badSharedSkill, skillFile, 'skills/Unused/SKILL.md', 'skills/Unrelated/Nested/SKILL.md', 'skills/../SKILL.md'].map(blob),
  };
  const gitlab = {
    listRepositoryTree: vi.fn(async (_project: number, dir: string) => trees[dir as keyof typeof trees]),
    getRepositoryFile: vi.fn(async (_project: number, file: string) => files[file] ?? null),
  };
  const result = await loadHubAgents(gitlab, 12, 'stable');
  expect(gitlab.listRepositoryTree.mock.calls).toEqual([[12, 'agents', 'stable', true], [12, 'skills', 'stable', true]]);
  expect(result.present).toBe(true);
  expect(result.agents.map(agent => agent.id)).toEqual(['deploy.v1', 'other']);
  expect(result.agents[0]).toMatchObject({
    sharedSkills: ['verify', 'absent', 'malformed'],
    skills: [
      { name: 'Z Local', path: localSkill, scope: 'agent' }, { name: 'A Local', path: otherLocalSkill, scope: 'agent' },
      { name: 'Verify', path: skillFile, scope: 'shared' },
    ],
  });
  expect(result.agents[1].skills.map(skill => skill.path)).toEqual([skillFile]);
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

  listRepositoryTree.mockResolvedValue([blob(agentFile)]);
  expect(await loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main')).toEqual({
    present: true, agents: [], invalidFiles: [agentFile],
  });
  expect(getRepositoryFile).toHaveBeenCalledExactlyOnceWith(1, agentFile, 'main');
  listRepositoryTree.mockRejectedValue(Error('GitLab HTTP 403'));
  await expect(loadHubAgents({ listRepositoryTree, getRepositoryFile }, 1, 'main')).rejects.toThrow('403');
});

const inspect = defineExtensionTool({ name: 'inspect', policy: 'readonly', description: '', schema: {}, execute: vi.fn() });
const checks: DetentCapabilityPack = {
  name: ' Checks ', enabled: true, tools: [inspect, inspect, { ...inspect, name: 'apply', policy: 'always_approve' }],
};
const deploy = parse('requires: [checks]\ndefault: true')!;
const audit = parseHubAgentMarkdown('audit', 'agents/audit/AGENT.md', markdown('label: Audit\nmode: readonly\nrequires: checks'))!;

it('selects named optional packs alongside requirements without blocking on unavailable options', () => {
  const agent = parse('requires: [base]\nuses: [ Checks, "CHECKS", missing ]')!;
  expect(agent.uses).toEqual(['checks', 'missing']);
  const base = { ...checks, name: 'base', tools: [{ ...inspect, name: 'base_tool' }] };
  const unrelated = { ...base, name: 'unrelated', tools: [{ ...inspect, name: 'other' }] };
  const match = (enabled: boolean) => matchHubAgent([agent], [agent.label], [base, { ...checks, enabled }, unrelated]);
  expect(match(true)).toMatchObject({ kind: 'matched', enabledToolNames: ['base_tool', 'inspect', 'apply'] });
  expect(match(false)).toMatchObject({ kind: 'matched', enabledToolNames: ['base_tool'] });
});

it.each(['readonly', 'governed'])('selects every enabled pack with a wildcard in %s mode', mode => {
  const agent = parse(`mode: ${mode}\nuses: ['*']`)!;
  const packs = [checks, { ...checks, name: 'extra', tools: [{ ...inspect, name: 'extra_tool' }] },
    { ...checks, name: 'disabled', enabled: false, tools: [{ ...inspect, name: 'hidden' }] }];
  expect(matchHubAgent([agent], [agent.label], packs)).toMatchObject({
    kind: 'matched', enabledToolNames: mode === 'readonly' ? ['inspect', 'extra_tool'] : ['inspect', 'apply', 'extra_tool'],
  });
});

it('prioritizes a single explicitly matched readonly Agent and leaves unmatched Issues unified', () => {
  expect(matchHubAgent([deploy, audit], ['unknown'], [checks])).toBeUndefined();
  expect(matchHubAgent([deploy, audit], [' AGENT::DEPLOY.V1 ', ' AUDIT '], [checks])).toEqual({
    kind: 'matched', agent: audit, enabledToolNames: ['inspect'],
  });
  const enabled = [{ ...checks, enabled: false }, checks, { ...checks, name: 'unrelated', tools: [{ ...inspect, name: 'other' }] }];
  expect(matchHubAgent([deploy, audit], ['agent::deploy.v1'], enabled)).toMatchObject({ enabledToolNames: ['inspect', 'apply'] });
});

it('reports conflicts for multiple matches without a single readonly match', () => {
  const governanceAudit = { ...audit, mode: 'governed' as const };
  for (const agents of [[deploy, governanceAudit], [{ ...deploy, mode: 'readonly' as const }, audit]])
    expect(matchHubAgent(agents, ['agent::deploy.v1', 'audit'], [checks])).toMatchObject({
      kind: 'blocked', message: expect.stringContaining('agent::deploy.v1 (' + agentFile + ')、audit (agents/audit/AGENT.md)'),
    });
});

it('explains missing capabilities with ready alternatives', () => {
  const ready = { ...audit, requires: [] };
  const needs = { ...deploy, requires: ['checks', 'missing'] };
  const capability = { ...checks, enabled: false, setupHint: 'Configure CHECKS_TOKEN.' };
  const missing = matchHubAgent([ready, needs], ['agent::deploy.v1'], [capability]);
  expect(missing).toMatchObject({ kind: 'blocked', agent: needs });
  if (missing?.kind !== 'blocked') throw Error('Expected missing capabilities');
  for (const line of ['### ⚪ 当前能力尚未开通', 'checks：Configure CHECKS_TOKEN.', 'missing：请在服务端配置并启用此能力', '`audit`'])
    expect(missing.message).toContain(line);
});

it('renders a Skill index', () => {
  expect(renderAgentSystemPrompt(deploy)).toBe('当前 Agent：' + agentFile + '\n\n' + deploy.body);
  const skill = parseHubSkillMarkdown(skillFile, skillMarkdown('Verify'), 'shared')!;
  expect(renderAgentSystemPrompt({ ...deploy, skills: [skill] })).toBe([
    '当前 Agent：' + agentFile, '', deploy.body, '', '## 可用 Skills（命中子任务时请用 Read 读取完整规范）',
    '- Verify（skills/Verify/SKILL.md）：Review the result.',
  ].join('\n'));
});
