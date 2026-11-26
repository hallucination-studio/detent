import type { AppConfig } from '../config.js';
import type { DetentExtensions, EventNotification } from '../extensions.js';
import type { GitLabClient } from '../gitlab/client.js';
import { renderNote } from '../gitlab/note-streamer.js';
import { notifyHook } from '../orchestrator/lifecycle.js';
import { createMrChannel } from '../orchestrator/channel.js';

export async function sendEventNotification(gitlab: Pick<GitLabClient, 'createMergeRequestNote' | 'updateMergeRequestNote' |
  'createMergeRequestDiscussionNote' | 'updateMergeRequestDiscussionNote' | 'createIssueNote' | 'createCommitComment' | 'createIssue'>, config: AppConfig, notification: EventNotification,
  onNotify?: DetentExtensions['onNotify']) {
  const { target, projectId, issueIid, mrIid, sha, hubIssueLabel } = notification;
  const body = renderNote(notification.body, config.jevApiKey);
  if (target === 'resource' && projectId && mrIid) await createMrChannel(gitlab, projectId, mrIid).createNote(body);
  else if (target === 'resource' && projectId && issueIid) await gitlab.createIssueNote(projectId, issueIid, body);
  else if (target !== 'hub_issue' && projectId && sha) await gitlab.createCommitComment(projectId, sha, body);
  else if (projectId === config.gitlabHubProjectId && issueIid) await gitlab.createIssueNote(projectId, issueIid, body);
  else await gitlab.createIssue(config.gitlabHubProjectId, {
    title: body.split('\n')[0].slice(0, 255), description: body, labels: hubIssueLabel ? [hubIssueLabel] : [],
  });
  if (onNotify) await notifyHook(() => onNotify({ ...notification, body }), config.jevApiKey);
}
