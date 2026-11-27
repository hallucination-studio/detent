import { randomUUID } from 'node:crypto';
import { strToU8, unzipSync, Zip, ZipDeflate } from 'fflate';
import type { AppConfig } from '@detent/core';
import type { AnsibleJobRequest } from './client.js';
import { validatePlaybookPath } from './guards.js';

const jobDir = '{{ detent_job_dir.path }}';
const commandPlaybook = [{
  hosts: 'all', gather_facts: false,
  tasks: [
    { 'ansible.builtin.tempfile': { state: 'directory', prefix: 'detent-job-' }, register: 'detent_job_dir' },
    {
      block: [
        { 'ansible.builtin.file': { path: jobDir + '/repo', state: 'directory' } },
        { 'ansible.builtin.copy': { src: 'repo/', dest: jobDir + '/repo/' } },
        { 'ansible.builtin.copy': { src: 'job.sh', dest: jobDir + '/job.sh', mode: '0700' } },
        { 'ansible.builtin.command': { argv: ['/bin/sh', jobDir + '/job.sh'], chdir: jobDir + '/repo' }, register: 'detent_job_exec' },
        { 'ansible.builtin.debug': { var: 'detent_job_exec.stdout_lines' } },
      ],
      always: [{ 'ansible.builtin.file': { path: jobDir, state: 'absent' }, when: 'detent_job_dir.path is defined' }],
    },
  ],
}];

// Add entries by filename so every git filename, including "__proto__", survives stripping.
function zipBlob(files: Map<string, Uint8Array>) {
  const chunks: BlobPart[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(Uint8Array.from(chunk));
  });
  for (const [name, bytes] of files) {
    const entry = new ZipDeflate(name, { level: 1 });
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  return new Blob(chunks);
}

export async function playbookUpload(
  request: AnsibleJobRequest, gitlab: Pick<AppConfig, 'gitlabBaseUrl' | 'gitlabToken'>, signal: AbortSignal,
) {
  const { playbookPath, command } = request;
  if ((playbookPath !== undefined) === (command !== undefined)) throw Error('Exactly one of playbookPath or command is required');
  if (playbookPath !== undefined) {
    const checked = validatePlaybookPath(playbookPath);
    if (!checked.ok) throw Error(checked.reason);
  } else if (typeof command !== 'string' || !command.trim() || command.length > 1000 || /[\0\r]/.test(command)) {
    throw Error('Invalid job command');
  }
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
  let root: string | undefined;
  const files = unzipSync(Buffer.concat(chunks), { filter(entry) {
    expanded += entry.originalSize;
    if (expanded > maxBytes || /[\\\0]/.test(entry.name))
      throw Error('Invalid or oversized repository archive');
    const directory = entry.name.endsWith('/');
    const parts = (directory ? entry.name.slice(0, -1) : entry.name).split('/');
    root ??= parts[0];
    if (parts[0] !== root || parts.some(part => !part || part === '.' || part === '..') || (!directory && parts.length < 2))
      throw Error('Invalid repository archive path');
    return !directory;
  } });
  if (!root) throw Error('Invalid repository archive root');
  const bundle = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    const relative = name.slice(root.length + 1);
    bundle.set(command === undefined ? relative : 'repo/' + relative, bytes);
  }
  const path = playbookPath?.split('/').filter(part => part && part !== '.').join('/');
  if (path) {
    if (!bundle.has(path)) throw Error('Approved playbook is missing from the repository archive');
    const slash = path.lastIndexOf('/');
    const dir = slash > 0 ? path.slice(0, slash) : '';
    if (dir) {
      // ansible-runner resolves roles and vars relative to the imported playbook.
      for (const [relative, bytes] of [...bundle]) {
        const local = dir + '/' + relative;
        if (/^(roles|group_vars|host_vars)\//.test(relative) && !bundle.has(local)) bundle.set(local, bytes);
      }
    }
    if (path !== 'main.yml') bundle.set('main.yml', strToU8(JSON.stringify([{ import_playbook: path }])));
  } else {
    if (!bundle.size) bundle.set('repo/', new Uint8Array());
    bundle.set('job.sh', strToU8('#!/bin/sh\nset -eu\n' + command!.trim() + '\n'));
    bundle.set('main.yml', strToU8(JSON.stringify(commandPlaybook)));
  }
  const form = new FormData();
  form.set('name', 'detent-' + randomUUID());
  form.set('scope', 'private');
  form.set('comment', request.repository + '@' + request.commitSha + ' ' + (path ?? 'job.sh'));
  form.set('path', zipBlob(bundle), 'playbook.zip');
  return form;
}
