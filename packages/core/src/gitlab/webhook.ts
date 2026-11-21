import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import type { ExtensionWebhookEvent, WebhookExtension } from '../extensions.js';
import type { AppConfig } from '../config.js';
import type { GitLabClient } from './client.js';
import type { SessionOrchestrator } from '../orchestrator/session-orchestrator.js';
import { parseEmojiIntent, parseNoteIntent } from './command-parser.js';

const id = z.number().int().positive();
const user = z.object({ id, username: z.string() });
const actor = user.partial().nullish();
const project = z.object({ id });
const issue = z.object({ iid: id, state: z.string().optional() });
const payload = z.discriminatedUnion('object_kind', [
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
    issue: issue.optional(),
    object_attributes: z.object({
      note: z.string(),
      noteable_type: z.string(),
      id,
      action: z.string().optional(),
    }),
  }),
  z.object({
    object_kind: z.literal('emoji'),
    user,
    project: project.optional(),
    project_id: id,
    issue: issue.optional(),
    object_attributes: z.object({
      name: z.string(),
      awardable_type: z.string(),
      awardable_id: id,
      action: z.string().optional(),
    }),
  }),
  z.object({
    object_kind: z.literal('pipeline'),
    project,
    object_attributes: z.object({ id, ref: z.string(), status: z.string() }),
    merge_request: z.object({ iid: id, source_branch: z.string() }).nullish(),
  }),
]);
export type WebhookEvent = z.infer<typeof payload>;
type MatchedWebhook = NonNullable<ReturnType<WebhookExtension>>;
export type QueuedWebhook = WebhookEvent | MatchedWebhook;
type IncomingBody = Record<string, unknown> | null;
const eventKinds = new Set<string>(payload.options.map((option) => option.shape.object_kind.value));

export function createWebhookApp<T extends MatchedWebhook = never>(
  config: AppConfig, gitlab: Pick<GitLabClient, 'isBotUser'>,
  submit: (id: string, event: WebhookEvent | T) => void | Promise<void>,
  matchWebhookEvent?: (event: ExtensionWebhookEvent) => T | null,
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
    const sender = actor.safeParse(body.user);
    if (!sender.success) return reply.code(400).send();
    if (gitlab.isBotUser(sender.data?.id, sender.data?.username)) return { ignored: true };
    const uuid = req.headers['idempotency-key'] ?? req.headers['x-gitlab-event-uuid'];
    const eventId = hash(typeof uuid === 'string' ? uuid : JSON.stringify(body)).toString('hex');
    const accept = async (event: WebhookEvent | T) => {
      const queued = submit(eventId, event);
      if (queued) await queued;
      return reply.code(202).send({ accepted: true });
    };
    if (!eventKinds.has(body.object_kind)) {
      const match = matchWebhookEvent?.({ ...body, object_kind: body.object_kind });
      if (!match) return { ignored: true };
      return accept(match);
    }
    const parsed = payload.safeParse(body);
    if (!parsed.success) return reply.code(400).send();
    const e = parsed.data;
    if (
      e.object_kind !== 'pipeline' &&
      (e.project?.id ?? ('project_id' in e ? e.project_id : undefined)) !== config.gitlabHubProjectId
    )
      return { ignored: true };
    if (
      e.object_kind === 'note' &&
      (!e.issue ||
        e.object_attributes.noteable_type !== 'Issue' ||
        (e.object_attributes.action && e.object_attributes.action !== 'create'))
    )
      return { ignored: true };
    if ((e.object_kind === 'note' || e.object_kind === 'emoji') && e.issue?.state === 'closed')
      return { ignored: true };
    if (e.object_kind === 'emoji' && (!e.issue || e.object_attributes.awardable_type !== 'Note'))
      return { ignored: true };
    return accept(e);
  });
  return app;
}

export async function dispatchWebhook(
  orchestrator: SessionOrchestrator,
  event: QueuedWebhook,
) {
  if ('handle' in event) return event.handle(orchestrator);
  if (event.object_kind === 'pipeline') return orchestrator.handlePipelineEvent(event);
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
    const intent = parseNoteIntent({ ...actor, sessionStatus: s.status, noteBody: event.object_attributes.note });
    await orchestrator.handleUserIntent(event.project.id, iid, intent);
  }
}
