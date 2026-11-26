export const normalizeHubValue = (value: string) => value.trim().toLowerCase();

// A single plain or quoted scalar, optionally followed by a YAML comment.
function scalar(value: string, strict: boolean) {
  if (/^["']/.test(value)) {
    const match = /^(?:"([^"]*)"|'([^']*)')(?:\s+#.*)?$/.exec(value);
    return match?.[1] ?? match?.[2];
  }
  if (/^[\[\]{}|>]/.test(value)) return undefined;
  const plain = value.replace(/(?:^|\s+)#.*$/, '').trim();
  if (strict && /:(?:\s|$)|^(?:[&*!@`%]|[-?](?:\s|$))/.test(plain)) return undefined;
  return plain;
}

function blockScalar(lines: string[], style: string) {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim()) indent = Math.min(indent, /^ +/.exec(line)?.[0].length ?? 0);
  }
  if (!Number.isFinite(indent) || indent === 0) return undefined;
  const content = lines.map(line => line.trim() ? line.slice(indent) : '');
  while (content.at(-1) === '') content.pop();

  let text = content.join('\n');
  if (style.startsWith('>')) {
    // Fold adjacent lines. Blank lines and more-indented text mark paragraph breaks.
    const folded: string[] = [];
    let previous = -1;
    for (const [index, line] of content.entries()) {
      if (!line) continue;
      let breaks = index - previous - 1;
      if (previous >= 0 && (/^\s/.test(content[previous]) || /^\s/.test(line))) breaks++;
      folded.push(breaks ? '\n'.repeat(breaks) : previous >= 0 ? ' ' : '', line);
      previous = index;
    }
    text = folded.join('');
  }
  return text + (style.endsWith('-') ? '' : '\n');
}

export interface HubFrontmatter {
  fields: ReadonlyMap<string, string>;
  body: string;
}

export function readHubFrontmatter(raw: string, keys: ReadonlySet<string>, strict = true): HubFrontmatter | null {
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
      value = blockScalar(lines.slice(start, i + 1), style);
    } else {
      value = key === 'requires' || key === 'shared_skills' ? rawValue : scalar(rawValue, strict);
    }
    if (value === undefined) return null;
    fields.set(key, value);
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

export function readHubList(raw: string | undefined, allowEmptyItems = false): string[] | null {
  if (raw === undefined) return [];
  let list = raw.replace(/(?:^|\s+)#.*$/, '').trim();
  if (list.startsWith('[') && list.endsWith(']')) {
    list = list.slice(1, -1);
    if (!list.trim()) return [];
  }
  if (/[\[\]{}]/.test(list)) return null;
  const items = [];
  for (const item of list.split(',')) {
    const value = scalar(item.trim(), !allowEmptyItems);
    if (value === undefined || (!allowEmptyItems && !value.trim())) return null;
    if (value.trim()) items.push(value);
  }
  return items;
}
