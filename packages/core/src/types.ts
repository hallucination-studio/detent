export type SessionStatus =
  | 'PLANNING'
  | 'WAITING_PLAN'
  | 'CODING'
  | 'WAITING_TOOL'
  | 'IDLE'
  | 'FAILED';

export type PermissionMode = 'plan' | 'default' | 'acceptEdits';

export type ApprovalType = 'PLAN' | 'TOOL_USE' | 'ASK_USER';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export type WorktreeStatus = 'ACTIVE' | 'ARCHIVED';

export interface IssueSessionRow {
  id: string;
  hubProjectId: number;
  hubIssueIid: number;
  issueTitle: string;
  claudeSessionId: string | null;
  lastMessageSeq: number;
  status: SessionStatus;
  permissionMode: PermissionMode;
  activeNoteId: number | null;
  lockedByPod: string | null;
  lockExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionMessageRow {
  id?: number;
  sessionId: string;
  seq: number;
  messageUuid: string | null;
  messageType: string;
  rawJsonLine: string;
  createdAt?: Date;
}

export interface SessionWorktreeRow {
  id: string;
  sessionId: string;
  targetProjectId: number;
  targetProjectPath: string;
  repoHttpUrl: string;
  directoryName: string;
  branchName: string;
  baseBranch: string;
  lastCommitSha: string | null;
  uncommittedDiff: string | null;
  status: WorktreeStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionMergeRequestRow {
  id: string;
  sessionId: string;
  worktreeId: string | null;
  targetProjectId: number;
  targetProjectPath: string;
  mrIid: number;
  mrTitle: string;
  mrWebUrl: string;
  sourceBranch: string;
  targetBranch: string;
  mrState: 'opened' | 'merged' | 'closed';
  mergeCommitSha: string | null;
  mergedBy: string | null;
  mergedAt: Date | null;
  latestPipelineId: number | null;
  latestPipelineStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRequestRow {
  id: string;
  sessionId: string;
  approvalType: ApprovalType;
  gitlabNoteId: number | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy: string | null;
  decisionComment: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export type ParsedIntentType =
  | 'APPROVE'
  | 'REJECT'
  | 'PLAN'
  | 'ABORT'
  | 'RESET'
  | 'STATUS'
  | 'PROMPT';

export interface ParsedUserIntent {
  type: ParsedIntentType;
  comment?: string;
  targetNoteId?: number;
  username: string;
  userId: number;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitLabIssueEvent {
  object_kind: 'issue';
  user: GitLabUser;
  project: {
    id: number;
    path_with_namespace: string;
    http_url_to_repo: string;
    default_branch?: string;
  };
  object_attributes: {
    id: number;
    iid: number;
    title: string;
    description: string | null;
    state: 'opened' | 'closed';
    action: 'open' | 'update' | 'close' | 'reopen';
    url: string;
  };
}

export interface GitLabNoteEvent {
  object_kind: 'note';
  user: GitLabUser;
  project: {
    id: number;
    path_with_namespace: string;
    http_url_to_repo: string;
  };
  object_attributes: {
    id: number;
    note: string;
    noteable_type: 'Issue' | 'MergeRequest' | 'Commit' | 'Snippet';
    noteable_id: number;
    url: string;
  };
  issue?: {
    id: number;
    iid: number;
    title: string;
    description: string | null;
    state: 'opened' | 'closed';
  };
}

export interface GitLabEmojiEvent {
  object_kind: 'emoji';
  event_type?: 'award';
  user: GitLabUser;
  project_id: number;
  project?: {
    id: number;
    path_with_namespace: string;
  };
  object_attributes: {
    id: number;
    name: string; // e.g., "thumbsup", "thumbsdown"
    awardable_type: 'Note' | 'Issue' | 'MergeRequest';
    awardable_id: number;
    action?: 'award' | 'revoke';
  };
  note?: {
    id: number;
    note: string;
    noteable_type: 'Issue' | 'MergeRequest';
    noteable_id: number;
  };
  issue?: {
    id: number;
    iid: number;
    title: string;
  };
}

export interface GitLabPipelineEvent {
  object_kind: 'pipeline';
  project: {
    id: number;
    path_with_namespace: string;
    web_url: string;
  };
  object_attributes: {
    id: number;
    ref: string;
    sha: string;
    status: 'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual';
    detailed_status?: string;
    url?: string;
  };
  merge_request?: {
    id: number;
    iid: number;
    title: string;
    source_branch: string;
    target_branch: string;
    state: string;
    url: string;
  };
}

export type GitLabWebhookPayload =
  | GitLabIssueEvent
  | GitLabNoteEvent
  | GitLabEmojiEvent
  | GitLabPipelineEvent;
