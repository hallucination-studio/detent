import type { ParsedUserIntent, SessionStatus } from '../types.js';
type Actor = Pick<ParsedUserIntent, 'username' | 'userId'>;
const commands = {
  approve: 'APPROVE',
  reject: 'REJECT',
  plan: 'PLAN',
  abort: 'ABORT',
  reset: 'RESET',
  status: 'STATUS',
} as const;
export function parseNoteIntent({
  noteBody,
  sessionStatus,
  ...actor
}: Actor & { noteBody: string; sessionStatus: SessionStatus }): ParsedUserIntent {
  const body = noteBody.trim();
  const match = /^\/(approve|reject|plan|abort|reset|status)(?:\s+([\s\S]+))?$/i.exec(body);
  if (match) {
    const type = commands[match[1].toLowerCase() as keyof typeof commands];
    if (!match[2] || ['PLAN', 'APPROVE', 'REJECT'].includes(type))
      return { ...actor, type, comment: match[2] };
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
