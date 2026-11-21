import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import { git } from '../src/workspace/ephemeral-sandbox.js';
export async function bareProjects(root: string) {
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  await git(['init', '-b', 'main'], seed, root);
  await writeFile(path.join(seed, 'CLAUDE.md'), 'hub rules');
  await writeFile(path.join(seed, 'tracked'), 'before');
  await git(['add', '.'], seed, root);
  await git(['commit', '-m', 'seed'], seed, root);
  for (const id of [1, 2, 3]) await git(['clone', '--bare', seed, path.join(root, id + '.git')], root, root);
  return {
    getProject: async (id: string | number) => ({
      id: Number(id),
      path_with_namespace: 'org/project' + id,
      http_url_to_repo: pathToFileURL(path.join(root, id + '.git')).href,
      default_branch: 'main',
    }),
    buildAuthenticatedCloneUrl: (url: string) => url,
    listProjects: vi.fn(),
    createMergeRequest: vi.fn(),
    listPipelines: vi.fn(),
    getPipelineJobs: vi.fn(),
    getJobTrace: vi.fn(),
  };
}
