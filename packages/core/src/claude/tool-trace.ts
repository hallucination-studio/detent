import { scrubJson, workspacePathFilter } from '../gitlab/redact.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ToolStep } from '../gitlab/note-streamer.js';

function preview(value: unknown, redact: (text: string) => string) {
  // Compact JSON already fits on one line. Preserve whitespace inside its
  // string literals, including paths and the contents of file edits.
  const serialized = typeof value === 'string' ? redact(value).replace(/\s+/gu, ' ').trim()
    : JSON.stringify(scrubJson(value, redact));
  const text = redact(serialized ?? '');
  return text.length <= 300 ? text : text.slice(0, 299).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

const pending = '⏳ 执行中…';
type Invocation = { name: string; input: unknown; step: ToolStep };

// SDK 1.x omits the ID in canUseTool. Each PreToolUse supplies its parsed
// arguments and ID before that callback. Consume matching calls in order.
export class ToolTrace {
  private byId = new Map<string, ToolStep>();
  private awaitingHandler = new Map<string, Invocation>();
  private awaitingId = new Map<string, Invocation>();

  private unfinished = new Map<string, ToolStep>();
  readonly redact: (text: string) => string;
  constructor(private progress: (step: ToolStep) => void, redact: (text: string) => string, workspaceRoot?: string) {
    const relative = workspacePathFilter(workspaceRoot);
    this.redact = text => relative(redact(text));
  }

  private take(queue: Map<string, Invocation>, name: string, input: unknown) {
    for (const [id, call] of queue) {
      if (call.name === name && isDeepStrictEqual(call.input, input)) {
        queue.delete(id);
        return call.step;
      }
    }
  }

  private create(id: string, name: string, input: unknown) {
    return { id, name: this.redact(name.replace(/^mcp__detent__/, '')), input: preview(input, this.redact), result: pending };
  }

  sdkCall(id: string | undefined, name: string, input: unknown, before = false) {
    const known = id && this.byId.get(id);
    if (known) {
      known.input = preview(input, this.redact);
      return known;
    }
    const step = this.take(this.awaitingId, name, input) ?? this.create(id ?? randomUUID(), name, input);
    if (id) this.byId.set(id, step);
    if (before) this.awaitingHandler.set(step.id, { name, input, step });
    return step;
  }

  handler(name: string, input: unknown, id?: string) {
    if (id) {
      this.awaitingHandler.delete(id);
      return this.sdkCall(id, name, input);
    }
    const step = this.take(this.awaitingHandler, name, input);
    if (step) return step;
    const provisional = this.create(randomUUID(), name, input);
    this.awaitingId.set(provisional.id, { name, input, step: provisional });
    return provisional;
  }

  pending(step: ToolStep) {
    if (step.result !== pending) return;
    this.unfinished.set(step.id, step);
    this.progress({ ...step });
  }

  update(step: ToolStep, value: unknown, prefix = '') {
    this.awaitingHandler.delete(step.id);
    this.unfinished.delete(step.id);
    const content = value && typeof value === 'object' && 'content' in value ? value.content : value;
    if (Array.isArray(content) && content.length && content.every(part => part?.type === 'text' && typeof part.text === 'string'))
      value = content.map(part => part.text).join('\n');
    step.result = prefix + (preview(value, this.redact) || '""');
    this.progress({ ...step });
  }

  finish(waiting: boolean) {
    for (const step of this.unfinished.values()) this.update(step, waiting ? '⏸️ 等待审批' : '⚠️ 轮次已中断');
  }

  lookup(id: string) {
    return this.byId.get(id);
  }
}
