import { randomUUID } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { AppConfig } from '@detent/core';
import type { AnsibleJobRequest } from './client.js';
import { validatePlaybookPath } from './guards.js';

// Job Center imports ZIPs with a top-level main.yml. Keep the complete pinned tree
// below that entry point so relative imports, roles and files resolve at the same SHA.
export async function playbookUpload(
  request: AnsibleJobRequest, gitlab: Pick<AppConfig, 'gitlabBaseUrl' | 'gitlabToken'>, signal: AbortSignal,
) {
  const checked = validatePlaybookPath(request.playbookPath);
  if (!checked.ok) throw Error(checked.reason);
  const project = encodeURIComponent(request.repository);
  const url = new URL(gitlab.gitlabBaseUrl.replace(/\/$/, '') + '/api/v4/projects/' + project + '/repository/archive.zip');
  url.searchParams.set('sha', request.commitSha);
  // GitLab's HotlinkingDetector rejects archive downloads carrying Node fetch's default Sec-Fetch-Mode: cors.
  const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': gitlab.gitlabToken }, mode: 'same-origin', redirect: 'error', signal });
  if (!res.ok) {
    const raw = await res.text().catch(error => String(error));
    throw Error('GitLab archive HTTP ' + res.status + (raw ? ': ' + raw : ''));
  }
  if (!res.body) throw Error('GitLab archive response has no body');

  // Bound both the download and inflation before allocating the working tree.
  const maxBytes = 64 * 1024 * 1024;
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw Error('GitLab archive exceeds 64 MiB');
    chunks.push(chunk);
  }
  let expanded = 0;
  const files = unzipSync(Buffer.concat(chunks), { filter(entry) {
    expanded += entry.originalSize;
    if (expanded > maxBytes || /[\\\0]/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').includes('..'))
      throw Error('Invalid or oversized repository archive');
    return !entry.name.endsWith('/');
  } });
  const root = Object.keys(files)[0]?.split('/')[0];
  const path = request.playbookPath.split('/').filter(part => part && part !== '.').join('/');
  if (!root || !Object.hasOwn(files, root + '/' + path) || !Object.keys(files).every(name => name.startsWith(root + '/')))
    throw Error('Approved playbook is missing from the repository archive');
  files['main.yml'] = strToU8(JSON.stringify([{ import_playbook: root + '/' + path }]));
  const form = new FormData();
  form.set('name', 'detent-' + randomUUID());
  form.set('scope', 'private');
  form.set('comment', request.repository + '@' + request.commitSha + ' ' + path);
  form.set('path', new Blob([Uint8Array.from(zipSync(files, { level: 1 }))]), 'playbook.zip');
  return form;
}
