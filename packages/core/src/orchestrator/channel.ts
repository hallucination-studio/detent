import type { GitLabClient } from '../gitlab/client.js';
import type { SessionStatus } from '../types.js';

export interface SessionChannel {
  approvalProjectId: number;
  createNote(body: string): Promise<{ id: number }>;
  getNote?(noteId: number): Promise<{ body: string }>;
  updateNote(noteId: number, body: string): Promise<void>;
  syncStatusLabel(status: SessionStatus): Promise<void>;
}

export function createIssueChannel(
  gitlab: Pick<GitLabClient, 'createIssueNote' | 'updateIssueNote' | 'syncIssueStatusLabel'> & Partial<Pick<GitLabClient, 'getIssueNote'>>,
  project: number, iid: number,
): SessionChannel {
  return {
    approvalProjectId: project,
    getNote: gitlab.getIssueNote && (id => gitlab.getIssueNote!(project, iid, id)),
    createNote: body => gitlab.createIssueNote(project, iid, body),
    updateNote: (id, body) => gitlab.updateIssueNote(project, iid, id, body),
    syncStatusLabel: status => gitlab.syncIssueStatusLabel(project, iid, status),
  };
}

export function createMrChannel(
  gitlab: Pick<GitLabClient, 'createMergeRequestNote' | 'updateMergeRequestNote' |
    'createMergeRequestDiscussionNote' | 'updateMergeRequestDiscussionNote'> & Partial<Pick<GitLabClient, 'getMergeRequestNote'>>,
  project: number, iid: number, discussionId?: string,
): SessionChannel {
  return {
    approvalProjectId: project,
    getNote: gitlab.getMergeRequestNote && (id => gitlab.getMergeRequestNote!(project, iid, id)),
    createNote: body => discussionId
      ? gitlab.createMergeRequestDiscussionNote(project, iid, discussionId, body)
      : gitlab.createMergeRequestNote(project, iid, body),
    updateNote: (id, body) => discussionId
      ? gitlab.updateMergeRequestDiscussionNote(project, iid, discussionId, id, body)
      : gitlab.updateMergeRequestNote(project, iid, id, body),
    syncStatusLabel: async () => {},
  };
}
