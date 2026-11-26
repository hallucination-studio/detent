import { it, expect, vi } from 'vitest';
import { parseNoteIntent, parseEmojiIntent } from '../src/gitlab/command-parser.js';
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
    expect((await post({ object_kind: 'push' })).statusCode).toBe(200);
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
    for (let i = 0; i < 20; i++) streamer.push('step ' + i + ' ' + url);
    streamer.appendText('正在分析');
    await vi.advanceTimersByTimeAsync(200);
    await streamer.flush();
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls.flat().join('');
    for (const fragment of [
      '正在分析',
      '20 个步骤',
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
