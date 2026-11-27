import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-code';
import { z } from 'zod';
import type { ToolStep } from '../gitlab/note-streamer.js';
import { ToolTrace } from './tool-trace.js';
import buffer from 'node:buffer';
import { configuredSecrets, redactGitUrl, scrubJson } from '../gitlab/redact.js';
import { openModelTransport } from './model-transport.js';
import type { AppConfig } from '../config.js';
import { formatInboxMessages } from '../orchestrator/turn-runtime.js';
import type { IssueSessionRow, SessionInboxRow } from '../types.js';
import type { TurnSandbox } from '../workspace/ephemeral-sandbox.js';
import { schemas, type ToolName, type WorkspaceTools } from '../workspace/mcp-tools.js';
import { ToolDenied, type PermissionGate } from './permission-gate.js';

const textDelta = z.object({
  type: z.literal('content_block_delta'),
  delta: z.object({ type: z.literal('text_delta'), text: z.string() }),
});
export interface TurnInput {
  session: IssueSessionRow;
  allowedWorkspaceTools?: readonly ToolName[];
  drainInbox?: () => Promise<SessionInboxRow[]>;
  sandbox: TurnSandbox;
  resume: boolean;
  prompt: string;
  systemPrompt: string;
  controller: AbortController;
  gate: PermissionGate;
  tools: WorkspaceTools;
  progress: (step: ToolStep) => void;
  appendText?: (delta: string) => void;
}
export interface ClaudeRunner {
  run(turn: TurnInput): Promise<string>;
}
const mcpMetadata = z.object({ _meta: z.object({ 'claudecode/toolUseId': z.string() }) });
function mcpToolId(extra: unknown) {
  return mcpMetadata.safeParse(extra).data?._meta['claudecode/toolUseId'];
}

export class SdkClaudeRunner implements ClaudeRunner {
  constructor(private config: AppConfig) {}
  async run(t: TurnInput) {
    const { session, sandbox, gate, drainInbox } = t;
    const secrets = configuredSecrets(this.config);
    const redact = (value: string) => redactGitUrl(value, secrets);
    const id = session.claudeSessionId!;
    const trace = new ToolTrace(t.progress, redact);
    const failed = new Set<string>();
    const calls = new Map<string, { name: string; input: unknown }>();
    const canUseTool = async (name: string, input: Record<string, unknown>, step = trace.handler(name, input)) => {
      const { jevConfidence: _confidence, ...decision } = await gate.canUseTool(name, input);
      if (decision.behavior === 'deny') {
        failed.add(step.id);
        trace.update(step, decision.message, '⛔ 已拦截：');
      } else {
        trace.pending(step);
      }
      return decision;
    };
    const invoke = async (name: string, input: Record<string, unknown>, extra: unknown,
      operation: (step: ToolStep) => Promise<unknown>) => {
      const step = trace.handler('mcp__detent__' + name, input, mcpToolId(extra));
      trace.pending(step);
      try {
        const output = await operation(step);
        const text = JSON.stringify(scrubJson(output, redact));
        trace.update(step, output);
        return { content: [{ type: 'text' as const, text: redact(text ?? '') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!failed.has(step.id)) trace.update(step, message, error instanceof ToolDenied ? '⛔ 已拦截：' : '❌ ');
        failed.add(step.id);
        throw Error(redact(message));
      }
    };
    const server = createSdkMcpServer({
      name: 'detent',
      tools: [
        ...(t.allowedWorkspaceTools ?? Object.keys(schemas) as ToolName[]).map(name =>
          tool(name, 'GitLab workspace: ' + name, schemas[name], (input, extra) =>
            invoke(name, input, extra, async step => {
              const decision = await canUseTool(name, input, step);
              if (decision.behavior === 'deny') throw Error(decision.message);
              t.controller.signal.throwIfAborted();
              return t.tools.invoke(name, decision.updatedInput);
            })),
        ),
        ...Array.from(gate.extensionTools, ([id, extension]) =>
          tool(extension.name, redact(extension.description), extension.schema, (input, extra) =>
            invoke(extension.name, input, extra, () => gate.invokeExtension(id, input))),
        ),
        tool(
          'AskUserQuestion',
          'Ask a question on GitLab',
          { questions: z.array(z.object({ question: z.string() })).min(1) },
          (input, extra) => invoke('AskUserQuestion', input, extra, async step => {
            const decision = await canUseTool('AskUserQuestion', input, step);
            if (decision.behavior === 'deny') throw Error(decision.message);
            return decision.updatedInput.answers;
          }),
        ),
      ],
    });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: sandbox.claudeHome,
      CLAUDE_CONFIG_DIR: sandbox.claudeHome + '/.claude',
      TMPDIR: sandbox.rootDir,
      ...(this.config.claudeModel && { ANTHROPIC_SMALL_FAST_MODEL: this.config.claudeModel, CLAUDE_CODE_SUBAGENT_MODEL: this.config.claudeModel }),
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    };
    let model: Awaited<ReturnType<typeof openModelTransport>> | undefined;
    let diagnostic = '';
    const transport = new AbortController();
    let interrupt: (() => void) | undefined;
    let shutdown: NodeJS.Timeout | undefined;
    try {
      let resultText: string | undefined;
      t.controller.signal.throwIfAborted();
      if (this.config.anthropicApiKey || this.config.anthropicBaseUrl || this.config.claudeModel || secrets.length) {
        model = await openModelTransport(this.config.anthropicBaseUrl ?? 'https://api.anthropic.com', this.config.anthropicApiKey, secrets, this.config.claudeModel);
        env.ANTHROPIC_BASE_URL = model.url;
        env.ANTHROPIC_AUTH_TOKEN = 'detent-local';
      }
      const messages = query({
        prompt: redact(t.prompt),
        options: {
          hooks: {
            PreToolUse: [{ hooks: [async (input, toolUseID) => {
              if (input.hook_event_name === 'PreToolUse') {
                trace.sdkCall(toolUseID, input.tool_name, input.tool_input, true);
              }
              return {};
            }] }],
            PostToolUse: [{ hooks: [async (input, toolUseID) => {
              if (input.hook_event_name === 'PostToolUse') {
                const step = trace.sdkCall(toolUseID, input.tool_name, input.tool_input);
                if (!failed.has(step.id)) trace.update(step, input.tool_response);
              }
              const items = await drainInbox?.();
              return items?.length ? { hookSpecificOutput: {
                hookEventName: 'PostToolUse', additionalContext: formatInboxMessages(items, secrets),
              } } : {};
            }] }],
          },
          stderr: (chunk) => {
            diagnostic = (diagnostic + chunk).slice(-2000);
          },
          // Claude Code 1.x probes the retired SlowBuffer prototype at startup.
          // Supply the alias only inside its child process on newer Node runtimes.
          executableArgs:
            'SlowBuffer' in buffer
              ? []
              : [
                  '--import',
                  'data:text/javascript,import buffer from "node:buffer"%3Bbuffer.SlowBuffer=buffer.Buffer',
                ],
          cwd: sandbox.workspaceRoot,
          abortController: transport,
          env,
          permissionMode: gate.readonly ? 'default' : session.permissionMode,
          resume: t.resume ? id : undefined,
          extraArgs: {
            'setting-sources': 'user',
            // Route even SDK-default read permissions through Detent's workspace checks.
            settings: JSON.stringify({ permissions: { ask: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] } }),
            ...(!t.resume ? { 'session-id': id } : {}),
          },
          disallowedTools: [
            ...(gate.readonly ? ['Edit', 'Write'] : []),
            ...(gate.disableBash ? ['Bash'] : []),
            'Task', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'BashOutput', 'KillShell',
            'SlashCommand', 'TodoWrite', 'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
          ],
          // Each registered Detent handler calls canUseTool itself, including AskUserQuestion.
          allowedTools: ['mcp__detent'],
          model: this.config.claudeModel,
          maxTurns: this.config.claudeMaxTurns,
          appendSystemPrompt: redact(t.systemPrompt),
          mcpServers: { detent: server },
          strictMcpConfig: true,
          includePartialMessages: true,
          // Extension authorization runs with parsed inputs in the MCP handler, once per invocation.
          canUseTool: (name, input) => gate.extensionTools.has(name)
            ? Promise.resolve({ behavior: 'allow', updatedInput: input })
            : canUseTool(name, input),
        },
      });
      // Stop the turn through the CLI control channel. Killing its transport while
      // an MCP handler is replying makes SDK 1.x reject outside the message iterator.
      interrupt = () => {
        shutdown = setTimeout(() => transport.abort(), 10000);
        void messages.interrupt().catch(() => transport.abort());
      };
      t.controller.signal.addEventListener('abort', interrupt, { once: true });
      if (t.controller.signal.aborted) interrupt();
      for await (const message of messages) {
        if (message.session_id !== id) throw Error('Claude session identity changed');
        if (message.type === 'assistant') {
          for (const block of message.message.content)
            if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
        }
        if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_result') continue;
            const call = calls.get(block.tool_use_id);
            calls.delete(block.tool_use_id);
            if (!block.is_error) continue;
            const step = trace.lookup(block.tool_use_id) ?? (call && trace.sdkCall(block.tool_use_id, call.name, call.input));
            if (step && !failed.has(step.id)) trace.update(step, block.content, '❌ ');
          }
        }
        if (message.type === 'stream_event' && t.appendText) {
          const fragment = textDelta.safeParse(message.event);
          if (fragment.success) t.appendText(fragment.data.delta.text);
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error)
            throw Error('Claude run failed: ' + message.subtype);
          resultText = message.result;
        }
      }
      t.controller.signal.throwIfAborted();
      if (resultText === undefined) throw Error('Claude ended without a result');
      return redact(resultText);
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error);
      const detail = t.controller.signal.aborted ? original : diagnostic.trim() || original;
      throw Error(redact(detail));
    } finally {
      model?.close();
      clearTimeout(shutdown);
      if (interrupt) t.controller.signal.removeEventListener('abort', interrupt);
    }
  }
}
