import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isHubScopePath } from './hub-paths.js';

function allowedPath(root: string, target: string, write: boolean) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  if (!write) return true;
  const parts = rel.toLowerCase().split(path.sep);
  return !isHubScopePath(rel) &&
    !parts.some(part => ['.git', '.claude', '.mcp.json'].includes(part));
}

export async function contained(root: string, value: unknown, write: boolean, cwd = root) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.startsWith('~') ||
    value.split(path.sep).includes('..')
  )
    return false;
  const target = path.resolve(cwd, value);
  if (!allowedPath(root, target, write)) return false;
  const resolved = await resolveWorkspacePath(root, target);
  return resolved !== undefined && allowedPath(root, resolved, write);
}

async function resolveWorkspacePath(root: string, target: string) {
  let prefix = target;
  // Walk back only over missing components. A dangling symlink exists for lstat
  // and must fail realpath instead of being treated as a new file.
  while (prefix !== root) {
    try {
      await lstat(prefix);
      break;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      // A linked Git worktree has a .git file. Resolve that existing prefix
      // as well when a descendant cannot exist beneath a regular file.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      prefix = path.dirname(prefix);
    }
  }
  try {
    return path.join(await realpath(prefix), path.relative(prefix, target));
  } catch {
    return undefined;
  }
}
