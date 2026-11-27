export const normalizeHubValue = (value: string) => value.trim().toLowerCase();

// A single plain or quoted scalar, optionally followed by a YAML comment.
function scalar(value: string) {
  if (/^["']/.test(value)) {
    const match = /^(?:"([^"]*)"|'([^']*)')(?:\s+#.*)?$/.exec(value);
    return match?.[1] ?? match?.[2];
  }
  if (/^[\[\]{}|>]/.test(value)) return undefined;
  const plain = value.replace(/(?:^|\s+)#.*$/, '').trim();
  if (/:(?:\s|$)|^(?:[&*!@`%]|[-?](?:\s|$))/.test(plain)) return undefined;
  return plain;
}

interface HubFrontmatter {
  fields: ReadonlyMap<string, string>;
  body: string;
}

export function readHubFrontmatter(raw: string, keys: ReadonlySet<string>): HubFrontmatter | null {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.shift()?.trimEnd() !== '---') return null;
  const end = lines.findIndex(line => line.trimEnd() === '---');
  if (end < 0) return null;

  const fields = new Map<string, string>();
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = /^([a-z_]+):(?:\s+(.*)|$)/.exec(line);
    if (!field || !keys.has(field[1]) || fields.has(field[1])) return null;
    const key = field[1];
    const rawValue = (field[2] ?? '').trim();
    const style = key === 'routing_hint' && /^([|>]-?)(?:\s+#.*)?$/.exec(rawValue)?.[1];
    let value: string | undefined;
    if (style) {
      const start = i + 1;
      while (i + 1 < end && (!lines[i + 1].trim() || /^ +/.test(lines[i + 1]))) i++;
      // Older Agent manifests may include a multiline routing hint. Skip its body.
      if (lines.slice(start, i + 1).some(line => line.trim())) value = '';
    } else {
      value = ['requires', 'shared_skills', 'allow_prefixes'].includes(key) ? rawValue : scalar(rawValue);
    }
    if (value === undefined) return null;
    fields.set(key, value);
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

export function readHubList(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  let list = raw.replace(/(?:^|\s+)#.*$/, '').trim();
  if (list.startsWith('[') && list.endsWith(']')) {
    list = list.slice(1, -1);
    if (!list.trim()) return [];
  }
  if (/[\[\]{}]/.test(list)) return null;
  const items = [];
  for (const item of list.split(',')) {
    const value = scalar(item.trim());
    if (value === undefined || !value.trim()) return null;
    items.push(value);
  }
  return items;
}
