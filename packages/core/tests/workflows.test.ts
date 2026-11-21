import { expect, it, vi } from 'vitest';
import {
  defineExtensionTool, loadHubWorkflows, matchHubWorkflow, parseHubWorkflowMarkdown,
  type DetentCapabilityPack, type HubWorkflow, type WorkflowApproverTier, type WorkflowMode,
} from '../src/index.js';

const raw = (fields: string) => '---\n' + fields + '\n---\n\n# Steps\n\nReview.\n';
const read = defineExtensionTool({ name: 'inspect', policy: 'readonly', schema: {}, description: '', execute: vi.fn() });
const pack: DetentCapabilityPack = { name: 'sample', enabled: true, tools: [read, { ...read, name: 'apply', policy: 'always_approve' }] };
const scan = parseHubWorkflowMarkdown('scan.md', raw('label: scan\nmode: readonly\nrequires: [sample]'))!;
const publish = parseHubWorkflowMarkdown('publish.md', raw('label: publish\nrequires: sample\ndescription: 发布'))!;

it('parses routing fields, comments and Markdown body with either line ending', () => {
  const mode: WorkflowMode = 'readonly';
  const approverTier: WorkflowApproverTier = 'prod';
  const workflow = parseHubWorkflowMarkdown('scan.md', raw([
    'label: " Scan "', 'mode: readonly # report', 'approver_tier: prod', 'allow_bash: false', 'default: true',
    "requires: [ Sample, 'API', , ]", 'description: "审查 #1" # inline comment',
  ].join('\n')).replaceAll('\n', '\r\n'));
  expect(workflow).toEqual({
    file: 'scan.md', label: 'scan', mode, approverTier, allowBash: false, isDefault: true,
    requires: ['sample', 'api'], description: '审查 #1', body: '# Steps\n\nReview.',
  } satisfies HubWorkflow);
  expect(parseHubWorkflowMarkdown('x.md', raw('label: x'))).toEqual({
    file: 'x.md', label: 'x', mode: 'governed', approverTier: 'standard', isDefault: false,
    requires: [], description: 'x.md', body: '# Steps\n\nReview.',
  });
  expect(parseHubWorkflowMarkdown('x.md', raw('label: x\nrequires: A, B\nallow_bash: true')))
    .toMatchObject({ requires: ['a', 'b'], allowBash: true });
  expect(parseHubWorkflowMarkdown('x.md', raw('label: x\nrequires: []'))?.requires).toEqual([]);
});

it.each(['mode: readonly', 'label: ', 'label: ""', 'label: []', 'label: x\nmode: other',
  'label: x\napprover_tier: other', 'label: x\nallow_bash: yes', 'label: x\ndefault: nope',
  'label: x\nrequires: [abc', 'label: x\nlabel: y', 'label: x\nmod: readonly',
])('rejects invalid frontmatter %j', fields => {
  expect(parseHubWorkflowMarkdown('x.md', raw(fields))).toBeNull();
});

it('requires an opening and closing frontmatter delimiter', () => {
  for (const source of ['# title', 'label: scan\n---', '---\nlabel: scan', 'preamble\n' + raw('label: scan')])
    expect(parseHubWorkflowMarkdown('x.md', source)).toBeNull();
});

const entry = (name: string, type: 'blob' | 'tree' = 'blob') => ({ id: name, name, type, path: 'workflows/' + name });

it('loads sorted Markdown blobs and reports missing and invalid files separately', async () => {
  const gitlab = {
    listRepositoryTree: vi.fn().mockResolvedValue([
      entry('z.md'), entry('b.md'), entry('folder.md', 'tree'), entry('a.md'), entry('notes.txt'), entry('c.md'),
    ]),
    getRepositoryFile: vi.fn(async (_p: number, path: string, _ref: string) => {
      if (path.endsWith('/c.md')) return null;
      if (path.endsWith('/b.md')) return '# missing header';
      return raw('label: scan');
    }),
  };
  const loaded = await loadHubWorkflows(gitlab, 12, 'stable');
  expect(loaded.present).toBe(true);
  expect(loaded.workflows.map(w => w.file)).toEqual(['a.md', 'z.md']);
  expect(loaded.invalidFiles).toEqual(['b.md', 'c.md']);
  expect(gitlab.listRepositoryTree).toHaveBeenCalledWith(12, 'workflows', 'stable');
  expect(gitlab.getRepositoryFile.mock.calls).toEqual(['a', 'b', 'c', 'z'].map(n => [12, 'workflows/' + n + '.md', 'stable']));
  gitlab.getRepositoryFile.mockResolvedValue(null);
  expect(await loadHubWorkflows(gitlab, 12, 'stable')).toMatchObject({ present: true, workflows: [] });
});

it('distinguishes an absent workflow directory or unsupported reader from a failed read', async () => {
  const absent = { present: false, workflows: [], invalidFiles: [] };
  const listRepositoryTree = vi.fn().mockResolvedValue([entry('data.csv')]);
  expect(await loadHubWorkflows({ listRepositoryTree }, 1, 'main')).toEqual(absent);
  expect(listRepositoryTree).not.toHaveBeenCalled();
  const gitlab = { listRepositoryTree, getRepositoryFile: vi.fn() };
  expect(await loadHubWorkflows(gitlab, 1, 'main')).toEqual(absent);
  expect(gitlab.getRepositoryFile).not.toHaveBeenCalled();
  listRepositoryTree.mockRejectedValue(Error('GitLab HTTP 403'));
  await expect(loadHubWorkflows(gitlab, 1, 'main')).rejects.toThrow('403');
});

it('matches normalized labels and explicit defaults, giving one readonly match precedence', () => {
  const fallback = { ...publish, isDefault: true };
  for (const labels of [[], [' Publish ']]) {
    expect(matchHubWorkflow([fallback, scan], labels, [pack])).toEqual({
      kind: 'matched', workflow: fallback, enabledToolNames: ['inspect', 'apply'],
    });
  }
  expect(matchHubWorkflow([fallback, scan], ['publish', ' SCAN '], [pack])).toEqual({
    kind: 'matched', workflow: scan, enabledToolNames: ['inspect'],
  });
});

it('reports conflicting workflow labels and ambiguous defaults', () => {
  const other = { ...publish, file: 'second.md', label: 'second' };
  for (const mode of ['governed', 'readonly'] as const) {
    const result = matchHubWorkflow([{ ...publish, mode }, { ...other, mode }], ['publish', 'second'], [pack]);
    expect(result).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/publish.*second.*只保留一个/) });
  }
  expect(matchHubWorkflow([publish, other].map(w => ({ ...w, isDefault: true })), [], [pack]))
    .toMatchObject({ kind: 'blocked', message: expect.stringContaining('默认工作流') });
});

it('includes tools from all required enabled packs and omits unrelated tools', () => {
  const workflow = { ...publish, requires: ['sample', 'search'] };
  const packs = [pack, { ...pack, enabled: false }, { ...pack, name: 'search', tools: [{ ...read, name: 'query' }] },
    { ...pack, name: 'extra', tools: [{ ...read, name: 'other' }] }];
  expect(matchHubWorkflow([workflow], ['publish'], packs)).toEqual({
    kind: 'matched', workflow, enabledToolNames: ['inspect', 'apply', 'query'],
  });
});

it('lists the available SOPs and gives actionable guidance for each missing capability', () => {
  const ready = { ...scan, requires: [], description: '检查' };
  const needs = { ...publish, requires: ['sample', 'unknown'] };
  const disabled = { ...pack, enabled: false, setupHint: '请配置 API_KEY' };
  const workflows = [ready, needs];
  const menu = matchHubWorkflow(workflows, ['other'], [disabled]);
  expect(menu.kind).toBe('blocked');
  if (menu.kind === 'blocked') {
    for (const text of ['scan (workflows/scan.md)', '检查', '已就绪', 'publish (workflows/publish.md)', '发布', '缺少能力包', '添加', 'workflows/<name>.md'])
      expect(menu.message).toContain(text);
  }
  const unavailable = matchHubWorkflow(workflows, ['publish'], [disabled]);
  expect(unavailable).toMatchObject({ kind: 'blocked', workflow: needs });
  if (unavailable.kind === 'blocked') {
    for (const text of ['sample：请配置 API_KEY', 'unknown：服务端未注册该能力包', '编辑 Hub 仓库的 workflows/publish.md', 'scan'])
      expect(unavailable.message).toContain(text);
  }
});
