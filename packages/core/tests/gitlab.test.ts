import { ToolTrace } from '../src/claude/tool-trace.js';
import { configuredSecrets, redactGitUrl } from '../src/gitlab/redact.js';
import { it, expect, vi } from 'vitest';
import { createMrChannel } from '../src/orchestrator/channel.js';
import { stripBotMention, hasBotMention, parseNoteIntent, parseEmojiIntent } from '../src/gitlab/command-parser.js';
import { GitLabClient } from '../src/gitlab/client.js';
import {
  escapeTableCell,
  NoteStreamer,
  renderSummary,
  renderPlanApprovalCard,
  renderToolApprovalCard,
} from '../src/gitlab/note-streamer.js';
import { loadConfig } from '../src/config.js';
import { createWebhookApp } from '../src/gitlab/webhook.js';

const actor = { username: 'dev', userId: 7 };
it('filters bot and unsupported events before dispatching validated webhook data', async () => {
  const submit = vi.fn();
  const app = createWebhookApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), { isBotUser: id => id === 99 }, submit);
  const post = (payload: object) => app.inject({
    method: 'POST', url: '/webhooks/gitlab', headers: { 'x-gitlab-token': 'test' }, payload,
  });
  try {
    expect((await post({ object_kind: 'issue', user: { id: 99 } })).statusCode).toBe(200);
    const unhandled = await post({ object_kind: 'push' });
    expect(unhandled.statusCode).toBe(200);
    expect(unhandled.json()).toEqual({ ignored: true });
    expect((await post({ object_kind: 'pipeline' })).statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
    const event = { object_kind: 'pipeline', project: { id: 1 }, object_attributes: { id: 2, ref: 'main', status: 'success' } };
    expect((await post({ ...event, extra: 'unused' })).statusCode).toBe(202);
    expect(submit).toHaveBeenCalledWith(expect.any(String), event);
  } finally {
    await app.close();
  }
});
it('parses exact commands and only treats standalone consent as approval while waiting', () => {
  for (const cmd of ['approve', 'reject', 'plan', 'abort', 'reset', 'status']) {
    expect(parseNoteIntent({ ...actor, noteBody: '/' + cmd, sessionStatus: 'IDLE' }).type).toBe(
      cmd.toUpperCase(),
    );
  }
  for (const cmd of ['approve', 'reject', 'plan'])
    expect(parseNoteIntent({ ...actor, noteBody: '/' + cmd + ' 说明', sessionStatus: 'IDLE' }).comment).toBe(
      '说明',
    );
  for (const word of ['同意', '批准', '通过', '可以', 'LGTM', 'approve']) {
    expect(parseNoteIntent({ ...actor, noteBody: word, sessionStatus: 'WAITING_TOOL' }).type).toBe('APPROVE');
    expect(parseNoteIntent({ ...actor, noteBody: word, sessionStatus: 'IDLE' }).type).toBe('PROMPT');
  }
  expect(parseNoteIntent({ ...actor, noteBody: '/approved', sessionStatus: 'WAITING_PLAN' }).type).toBe(
    'PROMPT',
  );
});
it.each([
  ['/use image-sync', 'USE', 'image-sync'],
  [' /USE Agent::Image-Sync  mirror app:v1\nto staging ', 'USE', 'Agent::Image-Sync  mirror app:v1\nto staging'],
  ['/use  \n', 'PROMPT', '/use'],
  ['/useful image-sync', 'PROMPT', '/useful image-sync'],
])('parses %j as %s', (noteBody, type, comment) => {
  expect(parseNoteIntent({ ...actor, noteBody, sessionStatus: 'WAITING_TOOL' })).toEqual({ ...actor, type, comment });
});
it('binds emoji decisions to their note and ignores removals', () => {
  for (const [name, type] of [
    ['thumbsup', 'APPROVE'],
    ['+1', 'APPROVE'],
    ['thumbsdown', 'REJECT'],
    ['-1', 'REJECT'],
  ]) {
    expect(parseEmojiIntent({ ...actor, emojiName: name, noteId: 5 })).toMatchObject({
      targetNoteId: 5,
      type,
    });
    expect(parseEmojiIntent({ ...actor, emojiName: name, action: 'revoke', noteId: 5 })).toBeNull();
  }
});
it('uses the bot id or username and checks inherited membership', async () => {
  const http = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 1, username: 'bot' }))
    .mockResolvedValueOnce(Response.json({ access_level: 20 }))
    .mockResolvedValueOnce(Response.json({ access_level: 30 }))
    .mockResolvedValueOnce(Response.json({ access_level: 30 }))
    .mockResolvedValueOnce(Response.json({ access_level: 40 }));
  const client = new GitLabClient(loadConfig({}), http);
  await client.initBotIdentity();
  expect(client.isBotUser(1)).toBe(true);
  expect(client.isBotUser(undefined, 'bot')).toBe(true);
  expect(client.isBotUser(9, 'user')).toBe(false);
  expect(await client.hasApprovalPermission(1, 7)).toBe(false);
  expect(await client.hasApprovalPermission(1, 7)).toBe(true);
  expect(await client.hasApprovalPermission(1, 7, 40)).toBe(false);
  expect(await client.hasApprovalPermission(1, 7, 40)).toBe(true);
  expect(http.mock.calls[1][0]).toContain('/projects/1/members/all/7');
});
it('reads Issue labels and metadata by project and Issue IID', async () => {
  const issue = { id: 123, iid: 42, title: 'Review', description: null, labels: ['review'], state: 'opened' };
  const http = vi.fn().mockResolvedValue(Response.json(issue));
  const client = new GitLabClient(loadConfig({}), http);
  expect(await client.getIssue(5, 42)).toEqual(issue);
  expect(http).toHaveBeenCalledWith(expect.stringMatching(/\/projects\/5\/issues\/42$/), expect.objectContaining({ method: 'GET' }));
});
it('neutralizes quick actions and redacts credentials on both GitLab note endpoints', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({ id: 9 }));
  const client = new GitLabClient(loadConfig({}), http);
  const body = 'https://oauth2:secret@git/repo\r/close\r\n \t/approve';
  await client.createIssueNote(1, 2, body);
  await client.updateIssueNote(1, 2, 9, body);
  for (const [, request] of http.mock.calls)
    expect(JSON.parse(request.body)).toEqual({ body: 'https://oauth2:***@git/repo\n\\/close\n \t\\/approve' });
});
it('redacts extension credentials in job traces and discussion replies, including a trace split by the length limit', async () => {
  const http = vi.fn();
  const config = { ...loadConfig({ JEV_API_KEY: 'decision-key' }), additionalSecrets: ['remote-token'] };
  const client = new GitLabClient(config, http);
  const padding = 'x'.repeat(15995);
  http.mockResolvedValueOnce(new Response('remote-token' + padding));
  expect(await client.getJobTrace(1, 42)).toBe('***' + padding);
  http.mockResolvedValueOnce(Response.json({ id: 7 }));
  await client.createMergeRequestDiscussionNote(1, 2, 'thread', 'remote-token decision-key\n/merge');
  expect(JSON.parse(http.mock.calls[1][1].body)).toEqual({ body: '*** ***\n\\/merge' });
});
it('closes the Issue by IID and applies the done label', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({}));
  const client = new GitLabClient(loadConfig({}), http);
  await client.closeIssue(5, 42);
  await client.syncIssueStatusLabel(5, 42, 'DONE');
  expect(http.mock.calls[0]).toEqual([expect.stringMatching(/\/projects\/5\/issues\/42$/), expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ state_event: 'close' }),
  })]);
  expect(JSON.parse(http.mock.calls[1][1].body)).toMatchObject({
    add_labels: 'claude::done', remove_labels: expect.stringContaining('claude::idle'),
  });
});
it('coalesces 20 events, serializes final flush and redacts approval cards and traces', async () => {
  vi.useFakeTimers();
  try {
    const url = 'https://oauth2:secret@git/repo';
    const update = vi.fn(async () => {});
    const streamer = new NoteStreamer(200, update, async () => renderSummary([], []));
    for (let i = 0; i < 20; i++) streamer.push({ id: String(i), name: 'Read', input: 'step ' + i, result: url });
    streamer.appendText('正在分析');
    await vi.advanceTimersByTimeAsync(200);
    await streamer.flush();
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls.flat().join('');
    for (const fragment of [
      '正在分析',
      '🔍 工具调用轨迹（20 步）',
      'step 19',
      '<details>',
      'oauth2:***@',
    ])
      expect(body).toContain(fragment);
    expect(body).not.toMatch(/secret|活跃 Worktrees|Merge Requests/);
    expect(renderSummary([], [])).toBe('');
    expect(renderPlanApprovalCard(url)).not.toContain('secret');
    expect(
      renderToolApprovalCard({
        id: 'a',
        toolName: 'Bash',
        toolInput: { command: url },
        approvalType: 'TOOL_USE',
      }),
    ).not.toContain('secret');
  } finally {
    vi.useRealTimers();
  }
});

it('renders every invocation separately with its raw paths and redacted arguments and results', async () => {
  const credentials = { GITLAB_TOKEN: 'git-secret', ANTHROPIC_API_KEY: 'model-secret', JEV_API_KEY: 'jev-secret',
    GITLAB_WEBHOOK_SECRET: 'hook-secret', MYSQL_PASSWORD: 'sql-secret' };
  const config = { ...loadConfig(credentials), additionalSecrets: ['extra-"secret'] };
  const secrets = configuredSecrets(config);
  const sensitive = [...Object.values(credentials), ...config.additionalSecrets].join(' ');
  const stream = new NoteStreamer(200, vi.fn(), async () => sensitive, secrets);
  const trace = new ToolTrace(step => stream.push(step), text => redactGitUrl(text, secrets));
  const path = '/turn/./Hub  Workspace/CLAUDE.md';
  const names = ['Glob', 'Grep', 'Read', 'Read', 'Edit', 'Write', 'Bash', 'mcp__detent__detent_list_projects', 'mcp__remote__scan'];
  for (const [index, name] of names.entries()) {
    const step = trace.sdkCall(String(index), name, { path, value: sensitive });
    trace.pending(step);
    trace.update(step, { output: [sensitive] });
  }
  const body = await stream.flush('finished');
  const masked = '*** *** *** *** *** ***';
  expect(body).toContain('🔍 工具调用轨迹（9 步）');
  for (const [index, name] of names.entries()) {
    expect(body).toContain(`${index + 1}. **\`${name.replace(/^mcp__detent__/, '')}\`** \`${JSON.stringify({ path, value: masked })}\`  \n   ↳ \`${JSON.stringify({ output: [masked] })}\``);
  }
  expect(body).not.toContain('secret');
  expect(body).not.toContain('执行中');
});

it('limits long previews before fencing and keeps the first and last 30 numbered invocations', async () => {
  const stream = new NoteStreamer(200, vi.fn(), async () => '');
  const trace = new ToolTrace(step => stream.push(step), text => text.replaceAll('test-secret', '***'));
  const value = 'x'.repeat(290) + 'test-secret' + '😀'.repeat(20);
  for (let i = 1; i <= 63; i++) trace.update(trace.sdkCall(String(i), 'Read', { i, value }), value);
  const body = await stream.flush();
  expect(body).toContain('🔍 工具调用轨迹（63 步）');
  expect(body.match(/^\d+\. /gm)).toHaveLength(60);
  expect(body).toContain('…（中间省略 3 步）…');
  expect(body).toMatch(/30\. [^\n]+…`/);
  expect(body).toMatch(/34\. [^\n]+…`/);
  expect(body).not.toMatch(/^3[123]\. /m);
  expect(body).toContain('↳ `' + 'x'.repeat(290) + '***😀😀😀…`');
  expect(body).not.toMatch(/test-sec|�/);
});

it('publishes a text-only result without empty sections or executable quick actions', async () => {
  const update = vi.fn();
  const stream = new NoteStreamer(200, update, async () => '');
  await stream.flush('结果\r\n /close\r/label ~done\n\t/approve\n// keep comment\n/* keep block */');
  expect(update).toHaveBeenCalledExactlyOnceWith('结果\n \\/close\n\\/label ~done\n\t\\/approve\n// keep comment\n/* keep block */');
  expect(renderPlanApprovalCard('/close')).toContain('### 📋 实施方案审批\n\n\\/close\n\n---');
});

it('renders numbered questions, fenced commands and escaped fallback tool inputs', () => {
  const tool = { id: 'approval-id', toolName: 'AskUserQuestion', approvalType: 'ASK_USER' } as const;
  const questions = [{ question: '哪个分支？\n /label' }, { question: '/close' }];
  const ask = renderToolApprovalCard({ ...tool, toolInput: { questions } });
  expect(ask).toContain('1. 哪个分支？\n \\/label\n2. \\/close');
  expect(ask).toContain('直接回复你的确认内容即可继续');
  expect(ask).not.toMatch(/AskUserQuestion|approval-id|questions/);

  const approval = { ...tool, approvalType: 'TOOL_USE' } as const;
  const command = 'echo ````\n/close\ncd /tmp/turn/workspace/projects/web';
  const bash = renderToolApprovalCard(
    { ...approval, toolName: 'Bash', toolInput: { command, description: '检查' } },
    '/tmp/turn/workspace',
  );
  expect(bash).toContain('**用途**：检查\n\n`````sh\necho ````\n\\/close\ncd projects/web\n`````');
  const card = (toolInput: Record<string, unknown>) => renderToolApprovalCard({ ...approval, toolName: 'other', toolInput });
  expect(card({ 'a|b': 'c\r/label\n|' })).toContain('| a\\|b | c /label \\| |');
  expect(escapeTableCell('prod`|`svc', 'code')).toBe('`` prod`\\|`svc ``');
  expect(card({ args: ['```'] })).toContain('````json');
  expect(card({})).toContain('```json\n{}\n```');
});

it('recognizes standalone mentions outside code, quotes and email addresses', () => {
  const examples = ['`@bot`', '```sh\necho @bot\n```', '  > @bot /abort', 'dev@bot.com', 'x+@bot',
    '@bot-dev', '@bot.example', '@bot_2'];
  for (const text of examples) {
    expect(hasBotMention(text, 'bot')).toBe(false);
    expect(stripBotMention(text, 'bot')).toBe(text.trim());
  }
  expect(hasBotMention('(@BoT)', 'bot')).toBe(true);
  expect(stripBotMention('@Bot /abort', 'bot')).toBe('/abort');
  expect(hasBotMention('@bot')).toBe(false);
  expect(parseNoteIntent({ ...actor, sessionStatus: 'CODING', noteBody: '@BOT /abort', botUsername: 'bot' }).type).toBe('ABORT');
  for (const text of ['> @bot /abort', '`@bot /abort`', '@other /abort'])
    expect(parseNoteIntent({ ...actor, sessionStatus: 'CODING', noteBody: text, botUsername: 'bot' }).type).toBe('PROMPT');
});

it('accepts bot-triggered CI and deployment events but filters bot pushes, tags and releases', async () => {
  const submit = vi.fn();
  const app = createWebhookApp(loadConfig({ GITLAB_WEBHOOK_SECRET: 'test' }), { isBotUser: id => id === 99 },
    submit, () => ({ key: 'ci', handle: vi.fn() }));
  const post = (payload: object) => app.inject({ method: 'POST', url: '/webhooks/gitlab',
    headers: { 'x-gitlab-token': 'test' }, payload });
  try {
    for (const kind of ['pipeline', 'build', 'deployment'])
      expect((await post({ object_kind: kind, user: { id: 99 }, project: { id: 7 },
        object_attributes: { id: 5, ref: 'main', status: 'failed' } })).statusCode).toBe(202);
    for (const kind of ['push', 'tag_push', 'release', 'merge_request'])
      expect((await post({ object_kind: kind, user_id: 99 })).json()).toEqual({ ignored: true });
    expect(submit).toHaveBeenCalledTimes(3);
  } finally {
    await app.close();
  }
});

it('uses MR and discussion endpoints and redacts all note writes', async () => {
  const calls: { path: string; method?: string; body?: string }[] = [];
  const client = new GitLabClient(loadConfig({ JEV_API_KEY: 'example-secret' }), async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body?.toString() });
    if (new URL(String(url)).pathname.endsWith('/discussions')) return Response.json([{ id: 'thread', notes: [{
      id: 5, body: 'review', type: 'DiffNote', resolvable: true, resolved: false,
      position: { old_path: 'a.ts', new_path: 'b.ts', old_line: null, new_line: 8 },
    }] }]);
    return Response.json(init?.method === 'GET' ? [] : { id: 4 });
  });
  const mr = createMrChannel(client, 2, 3);
  const thread = createMrChannel(client, 2, 3, 'a/b');
  const note = 'example-secret\n/close';
  for (const channel of [mr, thread]) {
    expect(channel.approvalProjectId).toBe(2);
    await channel.createNote(note);
    await channel.updateNote(4, note);
    await channel.syncStatusLabel('DONE');
  }
  await client.createCommitComment(2, 'abc', note);
  await client.createIssue(2, { title: note, description: note, labels: ['alert'] });
  await client.createMergeRequest(2, { source_branch: 'feature', target_branch: 'main', title: note, description: note, assignee_ids: [42] });
  for (const call of calls) {
    expect(call.body).not.toContain('example-secret');
    expect(Object.values(JSON.parse(call.body!))).toContain('***\n\\/close');
  }
  expect(JSON.parse(calls.at(-1)!.body!).assignee_ids).toEqual([42]);
  await client.getMergeRequest(2, 3);
  await client.listOpenMergeRequestsByBranch(2, 'feature');
  await client.listMergeRequestDiffs(2, 3);
  const [discussion] = await client.listMergeRequestDiscussions(2, 3);
  const inlineNote = discussion.notes.find(note => note.type === 'DiffNote' && note.resolvable && !note.resolved);
  expect(inlineNote?.position).toEqual({ old_path: 'a.ts', new_path: 'b.ts', old_line: null, new_line: 8 });
  expect(calls.map(c => c.path.replace('/api/v4/projects/2/', ''))).toEqual([
    'merge_requests/3/notes', 'merge_requests/3/notes/4', 'merge_requests/3/discussions/a%2Fb/notes',
    'merge_requests/3/discussions/a%2Fb/notes/4', 'repository/commits/abc/comments', 'issues', 'merge_requests',
    'merge_requests/3', 'merge_requests', 'merge_requests/3/diffs', 'merge_requests/3/discussions',
  ]);
});

it('reads job traces only for the source branch or a pipeline belonging to the MR', async () => {
  const http = vi.fn();
  const client = new GitLabClient(loadConfig({ JEV_API_KEY: 'test-secret' }), http);
  const mr = { iid: 4, source_branch: 'feature', source_project_id: 3, target_project_id: 2, target_branch: 'main',
    state: 'opened' as const, title: 'change', web_url: '', description: null };
  await expect(client.getJobTrace(7, 1, mr)).rejects.toThrow('outside');
  expect(http).not.toHaveBeenCalled();
  http.mockResolvedValueOnce(Response.json({ pipeline: { id: 11, ref: 'feature' } })).mockResolvedValueOnce(new Response('test-secret'));
  expect(await client.getJobTrace(3, 1, mr)).toBe('***');
  http.mockResolvedValueOnce(Response.json({ pipeline: { id: 12, ref: 'refs/merge-requests/4/head' } }))
    .mockResolvedValueOnce(Response.json([{ id: 12, project_id: 2 }])).mockResolvedValueOnce(new Response('job output'));
  expect(await client.getJobTrace(2, 2, mr)).toBe('job output');
  http.mockResolvedValueOnce(Response.json({ pipeline: { id: 13, ref: 'main' } })).mockResolvedValueOnce(Response.json([{ id: 12 }]));
  await expect(client.getJobTrace(2, 3, mr)).rejects.toThrow('outside');
  expect(http.mock.calls.filter(([url]) => url.endsWith('/trace'))).toHaveLength(2);
});

it('accepts exact help commands and addressed help in English or Chinese', () => {
  const parse = (noteBody: string) => parseNoteIntent({ ...actor, sessionStatus: 'WAITING_PLAN', botUsername: 'bot', noteBody });
  for (const body of ['/help', '@bot /help', '@BOT HeLp  ', '@bot 帮助\n']) expect(parse(body)).toEqual({ ...actor, type: 'HELP' });
  for (const body of ['help', '帮助', '@other help', '@bot help me', '`@bot help`', '> @bot 帮助', '/help more'])
    expect(parse(body).type).toBe('PROMPT');
});

it('normalizes public callback bases and rejects credential-bearing or ambiguous URLs', () => {
  for (const suffix of ['', '/', '/webhooks/gitlab///'])
    expect(loadConfig({ DETENT_PUBLIC_URL: ' https://example.com/detent' + suffix + ' ' }).detentPublicUrl).toBe('https://example.com/detent');
  for (const url of ['file:///tmp', 'https://user:key@example.com', 'https://host/?', 'https://host/#', 'bad'])
    expect(() => loadConfig({ DETENT_PUBLIC_URL: url })).toThrow();
});
