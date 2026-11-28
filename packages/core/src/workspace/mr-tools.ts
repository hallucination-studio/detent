import { configuredSecrets } from '../gitlab/redact.js';
import { defineExtensionTool } from '../extensions.js';
import { redactGitUrl, type GitLabClient, type LiveMr } from '../gitlab/client.js';
import type { SessionWorktreeRow } from '../types.js';
import { EphemeralSandbox, git, type TurnSandbox } from './ephemeral-sandbox.js';

export function createMrTools(gitlab: Pick<GitLabClient, 'listMergeRequestDiffs' | 'listMergeRequestDiscussions'>,
  mr: LiveMr, host: EphemeralSandbox, sandbox: TurnSandbox, tree: SessionWorktreeRow) {
  const project = mr.target_project_id;
  const redact = (text: string) => redactGitUrl(text, configuredSecrets(host.config));
  return [
    defineExtensionTool({
      name: 'detent_get_mr_diff', description: '读取当前 MR 的文件差异。', policy: 'readonly', schema: {},
      async execute() {
        const diffs = await gitlab.listMergeRequestDiffs(project, mr.iid);
        const chunks: string[] = [];
        let remaining = 32 * 1024 - 32;
        for (const file of diffs) {
          const chunk = Buffer.from(redact(`--- ${file.old_path}\n+++ ${file.new_path}\n${file.diff}\n`));
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining).toString(), '\n[diff truncated]');
            break;
          }
          remaining -= chunk.length;
          chunks.push(chunk.toString());
        }
        return chunks.join('');
      },
    }),
    defineExtensionTool({
      name: 'detent_list_mr_discussions', description: '读取当前 MR 的评审讨论和行内位置。', policy: 'readonly', schema: {},
      async execute() {
        const threads = await gitlab.listMergeRequestDiscussions(project, mr.iid);
        return threads.map(({ id, notes }) => ({ id, notes: notes.map(note => ({
          id: note.id, author: note.author && { id: note.author.id, username: redact(note.author.username) }, body: redact(note.body), type: note.type,
          resolvable: note.resolvable, resolved: note.resolved, system: note.system,
          position: note.position && { ...note.position, old_path: note.position.old_path && redact(note.position.old_path),
            new_path: note.position.new_path && redact(note.position.new_path) },
        })) }));
      },
    }),
    defineExtensionTool({
      name: 'detent_sync_target_branch', description: '将目标分支合入当前 MR 的本地源分支并报告冲突。',
      policy: 'coding_auto', schema: {},
      execute: () => host.serialize(async () => {
        const dir = await host.projectDir(sandbox, tree.directoryName);
        const local = (...args: string[]) => git(args, dir, sandbox.claudeHome);
        if ((await local('branch', '--show-current')).trim() !== mr.source_branch) throw Error('Expected MR source branch');
        await local('check-ref-format', 'refs/heads/' + mr.target_branch);
        const target = await host.gitlab.getProject(project);
        const fetchTarget = () => host.remote(sandbox, dir, target.http_url_to_repo,
          ['fetch', '--no-tags', '--', target.http_url_to_repo, 'refs/heads/' + mr.target_branch]);
        await fetchTarget();
        if ((await local('rev-parse', '--is-shallow-repository')).trim() === 'true' &&
            !await local('merge-base', 'HEAD', 'FETCH_HEAD').then(() => true, () => false)) {
          await host.remote(sandbox, dir, tree.repoHttpUrl,
            ['fetch', '--no-tags', '--unshallow', '--', tree.repoHttpUrl, 'refs/heads/' + tree.branchName]);
          await fetchTarget();
        }
        const parent = (await local('rev-parse', 'FETCH_HEAD')).trim();
        const head = (await local('rev-parse', 'HEAD')).trim();
        try {
          await local('merge', '--no-edit', 'FETCH_HEAD');
          if ((await local('rev-parse', 'HEAD')).trim() !== head) sandbox.mrMergeParent = parent;
          return { merged: true };
        } catch (error) {
          const files = (await local('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
          if (!files.length) throw error;
          sandbox.mrMergeParent = (await local('rev-parse', 'MERGE_HEAD')).trim();
          return { merged: false, conflictedFiles: files.map(redact) };
        }
      }),
    }),
  ];
}
