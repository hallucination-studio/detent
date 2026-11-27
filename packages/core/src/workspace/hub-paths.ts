import path from 'node:path';

export function isHubPathSegment(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

export function isHubScopePath(relativePath: string) {
  return ['agents', 'skills', 'events.json', 'capabilities.json'].includes(relativePath.toLowerCase().split(path.sep, 1)[0]);
}
