import type { ParsedUserIntent, SessionStatus } from '../types.js';
type Actor = Pick<ParsedUserIntent, 'username' | 'userId'>;
const commands = {
  approve: 'APPROVE',
  reject: 'REJECT',
  plan: 'PLAN',
  abort: 'ABORT',
  reset: 'RESET',
  status: 'STATUS',
  use: 'USE',
} as const;
const protectedMarkdown = /```[\s\S]*?```|```[\s\S]*|`[^`\n]*`|^[^\S\n]*>.*$/gm;
function mentionPattern(username: string) {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.+-])@${escaped}(?![\\w.-])`, 'gi');
}
export function hasBotMention(text: string, botUsername?: string) {
  return !!botUsername && mentionPattern(botUsername).test(text.replace(protectedMarkdown, ' '));
}
export function stripBotMention(text: string, botUsername?: string) {
  if (!botUsername) return text;
  // Keep examples and quotations intact in the user's prompt.
  const visible = text.replace(protectedMarkdown, span => ' '.repeat(span.length));
  let end = 0;
  let result = '';
  for (const match of visible.matchAll(mentionPattern(botUsername))) {
    result += text.slice(end, match.index);
    end = match.index + match[0].length;
  }
  return (result + text.slice(end)).trim();
}
export function parseNoteIntent({
  noteBody,
  sessionStatus,
  botUsername,
  ...actor
}: Actor & { noteBody: string; sessionStatus: SessionStatus; botUsername?: string }): ParsedUserIntent {
  const original = noteBody.trim();
  const prefix = original.match(/^@[^\s]+(?=\s)/)?.[0];
  const body = prefix && stripBotMention(prefix, botUsername) === ''
    ? original.slice(prefix.length).trimStart() : original;
  const match = /^\/(approve|reject|plan|abort|reset|status|use)(?:\s+([\s\S]+))?$/i.exec(body);
  if (match) {
    const type = commands[match[1].toLowerCase() as keyof typeof commands];
    const args = match[2];
    if (args ? ['PLAN', 'APPROVE', 'REJECT', 'USE'].includes(type) : type !== 'USE')
      return { ...actor, type, comment: args };
  }
  if (
    ['WAITING_PLAN', 'WAITING_TOOL'].includes(sessionStatus) &&
    /^(同意|批准|通过|可以|lgtm|approve)$/i.test(body)
  )
    return { ...actor, type: 'APPROVE' };
  return { ...actor, type: 'PROMPT', comment: body };
}
export function parseEmojiIntent({
  emojiName,
  action,
  noteId,
  ...actor
}: Actor & { emojiName: string; action?: string; noteId: number }): ParsedUserIntent | null {
  if (action && action !== 'award' && action !== 'add') return null;
  if (['thumbsup', '+1'].includes(emojiName)) return { ...actor, type: 'APPROVE', targetNoteId: noteId };
  if (['thumbsdown', '-1'].includes(emojiName)) return { ...actor, type: 'REJECT', targetNoteId: noteId };
  return null;
}
