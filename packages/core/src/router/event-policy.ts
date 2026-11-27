import type { SessionOrchestrator } from '../orchestrator/session-orchestrator.js';
import type { AppConfig } from '../config.js';
import type { DetentExtensions, WebhookExtension } from '../extensions.js';
import { SessionBusy } from '../orchestrator/turn-runtime.js';
import { sendEventNotification } from './notifier.js';
import { z } from 'zod';
import { logError } from '../gitlab/redact.js';
import type { GitLabClient } from '../gitlab/client.js';
import { hasBotMention } from '../gitlab/command-parser.js';
import { isCiStatusEvent } from '../gitlab/webhook.js';
import type { DecisionClient } from '../decision/jev-client.js';
import type { GitLabUser, NormalizedGitLabEvent } from '../types.js';

const action = z.enum(['ignore', 'notify', 'run']);
const route = z.enum(['ignore', 'notify', 'run', 'semantic']);
const oneOrMany = z.union([z.string(), z.array(z.string()).nonempty()]);
const fields = z.object({
  event: oneOrMany, status: oneOrMany.optional(), project: oneOrMany.optional(), branch: oneOrMany.optional(),
  ownership: z.enum(['assigned', 'mentioned', 'any']).optional(),
  allowedActions: z.array(action).nonempty().optional(), fallbackAction: action.optional(), promptHint: z.string().optional(),
  notifyTarget: z.enum(['resource', 'hub_issue', 'commit']).optional(), hubIssueLabel: z.string().optional(),
  maxAutoFixAttempts: z.number().int().min(0).max(10).optional(),
});
// With actionType present, action filters the GitLab action. Otherwise action selects the route.
const ruleSchema = z.union([
  fields.extend({ actionType: route, action: oneOrMany.optional() }).strict(),
  fields.extend({ action: route }).strict().transform(({ action, ...rest }) => ({ ...rest, actionType: action, action: undefined })),
]);
type EventPolicyRule = z.infer<typeof ruleSchema>;
const schema = z.object({ version: z.literal(1), rules: z.array(ruleSchema) });
type Policy = { present: boolean; rules: EventPolicyRule[] };

export async function loadHubEventPolicy(gitlab: Pick<GitLabClient, 'getRepositoryFile'>, project: number, ref: string): Promise<Policy> {
  const file = await gitlab.getRepositoryFile(project, 'events.json', ref);
  if (file === null) return { present: false, rules: [] };
  try {
    return { present: true, rules: schema.parse(JSON.parse(file)).rules };
  } catch (error) {
    logError('event-policy', error);
    return { present: true, rules: [] };
  }
}
function matches(filter: z.infer<typeof oneOrMany> | undefined, predicate: (candidate: string) => boolean) {
  return filter === undefined || (Array.isArray(filter) ? filter.some(predicate) : predicate(filter));
}
function glob(pattern: string, value?: string) {
  if (value === undefined) return false;
  const pieces = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + pieces.join('.*') + '$').test(value);
}
function owns(rule: EventPolicyRule, event: NormalizedGitLabEvent, bot?: GitLabUser) {
  const resource = event.mr ?? event.issue;
  if (rule.ownership === 'assigned') return !!bot && !!resource?.assignees.some(a => a.id === bot.id || a.username === bot.username);
  if (rule.ownership === 'mentioned') return [event.note?.body, resource?.title, resource?.description]
    .some(text => text && hasBotMention(text, bot?.username));
  return true;
}
export async function evaluateEventPolicy(policy: Policy, event: NormalizedGitLabEvent,
  options: { decision?: DecisionClient; bot?: GitLabUser } = {}) {
  const rule = policy.rules.find(r => matches(r.event, kind => kind === '*' || kind === event.kind) &&
    matches(r.action, action => action === event.action) && matches(r.status, status => status === event.status) &&
    matches(r.project, project => glob(project, event.project.path) || glob(project, event.project.id?.toString())) &&
    matches(r.branch, branch => glob(branch, event.ref)) && owns(r, event, options.bot));
  if (!rule) return { action: 'ignore' as const };
  if (rule.actionType !== 'semantic') return { action: rule.actionType, rule };
  const choices = rule.allowedActions ?? action.options;
  if (options.decision) {
    try {
      const { action: answer } = await options.decision.decide({ summary: event.summary, hint: rule.promptHint }, {
        action: { type: 'choice', criteria: Object.fromEntries(choices.map(choice => [choice, choice])) },
      });
      const chosen = choices.find(choice => answer?.type === 'choice' && choice === answer.choice);
      if (chosen) return { action: chosen, rule };
    } catch (error) {
      logError('event-policy', error);
    }
  }
  return { action: rule.fallbackAction ?? 'notify', rule };
}

export function matchHubEvent(gitlab: GitLabClient, config: AppConfig, event: NormalizedGitLabEvent,
  decision?: DecisionClient, onNotify?: DetentExtensions['onNotify']): NonNullable<ReturnType<WebhookExtension>> {
  const hub = config.gitlabHubProjectId;
  return { key: `policy/${event.project.id}/${event.mr?.iid ?? event.issue?.iid ?? event.ref ?? event.eventId}`,
    async handle(orchestrator) {
      const policy = await loadHubEventPolicy(gitlab, hub, config.gitlabHubDefaultBranch);
      const { action, rule } = await evaluateEventPolicy(policy, event, { decision, bot: gitlab.getBotIdentity() });
      if (action === 'ignore') return;
      const body = [event.summary, event.url].filter(Boolean).join('\n');
      if (action === 'notify') {
        await sendEventNotification(gitlab, config, { eventId: event.eventId, projectId: event.project.id,
          issueIid: event.issue?.iid, mrIid: event.mr?.iid, sha: event.sha, body,
          target: rule?.notifyTarget ?? 'resource', hubIssueLabel: rule?.hubIssueLabel }, onNotify);
        return;
      }
      if (!isCiStatusEvent(event.kind) && event.actor?.id !== undefined &&
          !await gitlab.hasApprovalPermission(event.project.id ?? hub, event.actor.id)) return;
      await runHubEvent(gitlab, config, event, body, orchestrator, rule?.hubIssueLabel);
    },
  };
}


export async function runHubEvent(gitlab: Pick<GitLabClient, 'createIssue'>, config: AppConfig, event: NormalizedGitLabEvent,
  body: string, orchestrator: Pick<SessionOrchestrator, 'repo' | 'wakeSession'>, label?: string) {
  const hub = config.gitlabHubProjectId;
  const issue = event.project.id === hub && event.issue ? event.issue : await gitlab.createIssue(hub, {
    title: event.summary.slice(0, 255), description: body, labels: label ? [label] : [],
  });
  const session = await orchestrator.repo.getOrCreateSession(hub, issue.iid, issue.title ?? event.summary);
  if (session.status === 'DONE') return;
  await orchestrator.repo.enqueueSessionInbox({
    sessionId: session.id, eventId: event.eventId, sourceKind: event.kind,
    senderUsername: event.actor?.username, content: body,
  });
  try {
    await orchestrator.wakeSession(session, 'inbox');
  } catch (error) {
    logError('event-policy', error);
    if (!(error instanceof SessionBusy)) throw error;
  }
}
