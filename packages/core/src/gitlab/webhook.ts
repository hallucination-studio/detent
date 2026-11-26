import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import type { ExtensionWebhookEvent, WebhookExtension } from '../extensions.js';
import type { AppConfig } from '../config.js';
import type { GitLabClient } from './client.js';
import type { MergeRequestOrchestrator } from '../orchestrator/mr-orchestrator.js';
import type { SessionOrchestrator } from '../orchestrator/session-orchestrator.js';
import type { NormalizedGitLabEvent } from '../types.js';
import { parseEmojiIntent, parseNoteIntent } from './command-parser.js';

const id = z.number().int().positive();
const user = z.object({ id, username: z.string() });
const actor = user.partial().nullish();
const project = z.object({ id, path_with_namespace: z.string().optional() });
const issue = z.object({ iid: id, state: z.string().optional() });
const assignee = z.union([id, user.partial()]);
const mrResource = issue.extend({ target_project_id: id.optional() });
const payload = z.discriminatedUnion('object_kind', [
  z.object({
    object_kind: z.literal('merge_request'), user: user.extend({ id: id.optional() }), project,
    object_attributes: mrResource.extend({
      action: z.string(), title: z.string().optional(), description: z.string().nullish(), url: z.string().optional(),
      source_branch: z.string().optional(), target_branch: z.string().optional(), source_project_id: id.nullish(),
      merge_commit_sha: z.string().nullish(), last_commit: z.object({ id: z.string() }).nullish(), draft: z.boolean().optional(),
      assignee_id: id.nullish(), assignee_ids: z.array(id).optional(),
    }),
    assignees: z.array(assignee).optional(),
    changes: z.object({ assignees: z.object({ previous: z.array(assignee), current: z.array(assignee) }).optional() }).optional(),
  }),
  z.object({
    object_kind: z.literal('issue'),
    user,
    project,
    object_attributes: issue.extend({
      title: z.string(),
      action: z.string(),
      description: z.string().nullable().optional(),
    }),
  }),
  z.object({
    object_kind: z.literal('note'),
    user,
    project,
    issue: issue.nullish(),
    merge_request: mrResource.nullish(),
    object_attributes: z.object({
      note: z.string(),
      noteable_type: z.string(), system: z.boolean().optional(), discussion_id: z.string().nullish(), type: z.string().nullish(),
      position: z.object({ new_path: z.string().optional(), old_path: z.string().optional(),
        new_line: id.nullish(), old_line: id.nullish() }).nullish(),
      id,
      action: z.string().optional(),
    }),
  }),
  z.object({
    object_kind: z.literal('emoji'),
    user,
    project: project.optional(),
    project_id: id,
    note: z.object({ noteable_type: z.string().optional(), noteable_iid: id.optional(), discussion_id: z.string().nullish() }).nullish(),
    issue: issue.nullish(),
    merge_request: mrResource.nullish(),
    object_attributes: z.object({
      name: z.string(),
      awardable_type: z.string(),
      awardable_id: id,
      action: z.string().optional(),
    }),
  }),
  z.object({
    object_kind: z.literal('pipeline'),
    project, user: actor,
    object_attributes: z.object({ id, ref: z.string(), status: z.string(), sha: z.string().optional(), url: z.string().optional() }),
    merge_request: mrResource.extend({ source_branch: z.string().optional() }).nullish(),
  }),
]);
export type WebhookEvent = z.infer<typeof payload>;
export type EventOf<K extends WebhookEvent['object_kind']> = Extract<WebhookEvent, { object_kind: K }>;

export function actionableMr(event: EventOf<'merge_request'>, client: Pick<GitLabClient, 'isBotUser'>) {
  const attrs = event.object_attributes;
  if (!event.user.username.trim()) return false;
  if (attrs.action === 'merge') return !attrs.state || attrs.state === 'merged';
  if (attrs.action === 'close') return !attrs.state || attrs.state === 'closed';
  if (attrs.state !== 'opened' || event.user.id === undefined) return false;
  const assigned = (list: z.infer<typeof assignee>[]) =>
    list.some(a => typeof a === 'number' ? client.isBotUser(a) : client.isBotUser(a.id, a.username));
  if (attrs.action === 'update') {
    const change = event.changes?.assignees;
    return !!change && !assigned(change.previous) && assigned(change.current);
  }
  return ['open', 'reopen'].includes(attrs.action) &&
    assigned(event.assignees ?? attrs.assignee_ids ?? (attrs.assignee_id ? [attrs.assignee_id] : []));
}
type MatchedWebhook = NonNullable<ReturnType<WebhookExtension>>;
export type QueuedWebhook = WebhookEvent | MatchedWebhook;
type IncomingBody = Record<string, unknown> | null;
const eventKinds = new Set<string>(payload.options.map((option) => option.shape.object_kind.value));

export function isCiStatusEvent(kind: string) {
  return ['pipeline', 'build', 'deployment'].includes(kind);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function normalizeGitLabEvent(eventId: string, body: Record<string, unknown>): NormalizedGitLabEvent {
  const kind = str(body.object_kind) ?? 'unknown';
  const attrs = record(body.object_attributes);
  const project = record(body.project);
  const user = record(body.user);
  const resource = (value: unknown) => {
    const r = record(value);
    const iid = num(r.iid);
    if (!iid) return;
    const assigned = body.assignees ?? r.assignees ?? r.assignee_ids ?? r.assignee_id;
    const assignees = (Array.isArray(assigned) ? assigned : assigned ? [assigned] : []).map(a => ({
      id: num(a) ?? num(record(a).id), username: str(record(a).username),
    }));
    return { iid, title: str(r.title), description: str(r.description), assignees };
  };
  const issue = resource(kind === 'issue' ? attrs : body.issue);
  const mr = resource(kind === 'merge_request' ? attrs : body.merge_request);
  const note = kind === 'note' ? attrs : record(body.note);
  const ref = str(attrs.ref ?? body.ref ?? attrs.source_branch ?? record(body.merge_request).source_branch ?? body.tag)
    ?.replace(/^refs\/(?:heads|tags)\//, '');
  const commit = record(body.commit);
  const commitUrl = str(body.commit_url);
  const deploySha = commitUrl?.match(/\/commit\/([a-f\d]{40,64})$/i)?.[1] ?? body.short_sha;
  const sha = str(attrs.sha ?? body.sha ?? body.checkout_sha ?? body.after ?? record(attrs.last_commit).id ?? commit.sha ?? commit.id ?? attrs.commit_id ?? deploySha);
  const action = str(attrs.action ?? body.action);
  const status = str(attrs.status ?? body.build_status ?? body.status ?? attrs.state);
  const path = str(project.path_with_namespace ?? body.project_name);
  const projectId = num(project.id ?? body.project_id);
  const url = str(attrs.url ?? body.url ?? body.deployable_url ?? commitUrl ?? commit.url ?? project.web_url ?? record(body.repository).homepage);
  const detail = str(note.note ?? mr?.title ?? issue?.title ?? body.name ?? body.build_name ?? body.environment);
  return {
    eventId, kind, action, status, project: { id: projectId, path }, ref, sha, issue, mr,
    note: typeof note.note === 'string' ? { id: num(note.id), body: note.note, discussionId: str(note.discussion_id) } : undefined,
    emoji: kind === 'emoji' ? str(attrs.name) : undefined,
    actor: { id: num(user.id ?? body.user_id), username: str(user.username ?? body.user_username) },
    url, summary: [kind, action, status, path ?? projectId, ref, detail].filter(Boolean).join(' · ').slice(0, 1600), raw: body,
  };
}

export function createWebhookApp<T extends MatchedWebhook = never>(
  config: AppConfig, gitlab: Pick<GitLabClient, 'isBotUser'>,
  submit: (id: string, event: WebhookEvent | T) => void | Promise<void>,
  matchWebhookEvent?: (event: ExtensionWebhookEvent) => T | null,
  matchPolicy?: (event: NormalizedGitLabEvent) => T | null,
) {
  const app = Fastify();
  app.get('/healthz', async () => ({ ok: true, podId: config.podId }));
  app.post<{ Body: IncomingBody }>('/webhooks/gitlab', async (req, reply) => {
    const token = req.headers['x-gitlab-token'];
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (
      !config.gitlabWebhookSecret ||
      typeof token !== 'string' ||
      !timingSafeEqual(hash(config.gitlabWebhookSecret), hash(token))
    )
      return reply.code(401).send();
    const body = req.body;
    if (typeof body?.object_kind !== 'string') return reply.code(400).send();
    if (!isCiStatusEvent(body.object_kind)) {
      const sender = actor.safeParse(body.user);
      if (!sender.success) return reply.code(400).send();
      if (gitlab.isBotUser(sender.data?.id ?? num(body.user_id), sender.data?.username ?? str(body.user_username)))
        return { ignored: true };
    }
    const uuid = req.headers['idempotency-key'] ?? req.headers['x-gitlab-event-uuid'];
    const eventId = hash(typeof uuid === 'string' ? uuid : JSON.stringify(body)).toString('hex');
    const accept = async (event: WebhookEvent | T) => {
      const queued = submit(eventId, event);
      if (queued) await queued;
      return reply.code(202).send({ accepted: true });
    };
    const policy = () => {
      const match = matchPolicy?.(normalizeGitLabEvent(eventId, body));
      return match ? accept(match) : { ignored: true };
    };
    if (!eventKinds.has(body.object_kind)) {
      const match = matchWebhookEvent?.({ ...body, object_kind: body.object_kind });
      if (!match) return policy();
      return accept(match);
    }
    const parsed = payload.safeParse(body);
    if (body.object_kind === 'merge_request') {
      const ext = matchWebhookEvent?.({ ...body, object_kind: 'merge_request' });
      const mr = parsed.success && parsed.data.object_kind === 'merge_request' && actionableMr(parsed.data, gitlab) ? parsed.data : null;
      if (ext) await submit(eventId + ':ext', ext);
      if (mr) return accept(mr);
      if (ext) return reply.code(202).send({ accepted: true });
      return parsed.success ? { ignored: true } : reply.code(400).send();
    }
    if (!parsed.success) return reply.code(400).send();
    const e = parsed.data;
    if (e.object_kind === 'note') {
      const a = e.object_attributes;
      if (a.system || (a.action && a.action !== 'create')) return { ignored: true };
      if (a.noteable_type === 'MergeRequest') return e.merge_request?.state === 'opened' ? accept(e) : { ignored: true };
    }
    if (e.object_kind === 'emoji' && (e.merge_request || e.note?.noteable_type === 'MergeRequest'))
      return e.object_attributes.awardable_type === 'Note' ? accept(e) : { ignored: true };
    if ((e.object_kind === 'note' && e.object_attributes.noteable_type !== 'Issue') ||
      (e.object_kind === 'emoji' && !e.issue)) return policy();
    if (
      e.object_kind !== 'pipeline' &&
      (e.project?.id ?? ('project_id' in e ? e.project_id : undefined)) !== config.gitlabHubProjectId
    )
      return { ignored: true };
    if (e.object_kind === 'note' && !e.issue)
      return { ignored: true };
    if ((e.object_kind === 'note' || e.object_kind === 'emoji') && e.issue?.state === 'closed')
      return { ignored: true };
    if (e.object_kind === 'emoji' && e.object_attributes.awardable_type !== 'Note')
      return { ignored: true };
    return accept(e);
  });
  return app;
}

export async function dispatchWebhook(
  orchestrator: SessionOrchestrator,
  event: QueuedWebhook,
  eventId?: string,
  mrs?: MergeRequestOrchestrator,
) {
  if ('handle' in event) return event.handle(orchestrator);
  if (event.object_kind === 'pipeline' || event.object_kind === 'merge_request' ||
      (event.object_kind === 'note' && event.object_attributes.noteable_type === 'MergeRequest') ||
      (event.object_kind === 'emoji' && (event.merge_request || event.note?.noteable_type === 'MergeRequest'))) {
    if (!mrs) throw Error('MR worker is required');
    switch (event.object_kind) {
      case 'pipeline': return mrs.handlePipelineEvent(event, eventId);
      case 'merge_request': return mrs.handleMergeRequestEvent(event, eventId);
      case 'note': return mrs.handleMergeRequestNote(event, eventId);
      case 'emoji': return mrs.handleMergeRequestEmoji(event);
    }
  }
  if (event.object_kind === 'issue') {
    if (event.object_attributes.action === 'open' || event.object_attributes.action === 'reopen')
      return orchestrator.handleIssueOpened(event);
    if (event.object_attributes.action === 'close')
      return orchestrator.handleIssueClosed(event.project.id, event.object_attributes.iid);
    return;
  }
  if (!event.issue) return;
  const iid = event.issue.iid;
  const actor = { userId: event.user.id, username: event.user.username };
  if (event.object_kind === 'emoji') {
    const a = event.object_attributes;
    const intent = parseEmojiIntent({
      ...actor,
      noteId: a.awardable_id,
      action: a.action,
      emojiName: a.name,
    });
    if (intent) await orchestrator.handleUserIntent(event.project_id, iid, intent);
  } else {
    const s = await orchestrator.repo.getSessionByIssue(event.project.id, iid);
    if (!s) return;
    const intent = parseNoteIntent({ ...actor, botUsername: orchestrator.gitlab.getBotIdentity?.()?.username, sessionStatus: s.status, noteBody: event.object_attributes.note });
    await orchestrator.handleUserIntent(event.project.id, iid, intent, eventId ?? `note/${event.object_attributes.id}`);
  }
}
