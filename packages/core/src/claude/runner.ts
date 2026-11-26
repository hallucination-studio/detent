import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-code';
import { z } from 'zod';
import buffer from 'node:buffer';
import { redactGitUrl } from '../gitlab/client.js';
import type { AppConfig } from '../config.js';
import { formatInboxMessages } from '../orchestrator/turn-runtime.js';
import type { IssueSessionRow, SessionInboxRow } from '../types.js';
import type { TurnSandbox } from '../workspace/ephemeral-sandbox.js';
import { schemas, type ToolName, type WorkspaceTools } from '../workspace/mcp-tools.js';
import type { PermissionGate } from './permission-gate.js';

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
  progress: (step: string) => void;
  appendText?: (delta: string) => void;
}
export interface ClaudeRunner {
  run(turn: TurnInput): Promise<string>;
}
export class SdkClaudeRunner implements ClaudeRunner {
  constructor(private config: AppConfig) {}
  async run(t: TurnInput) {
    const { session, sandbox, gate, drainInbox } = t;
    const id = session.claudeSessionId!;
    const canUseTool = async (name: string, input: Record<string, unknown>) => {
      const label = redactGitUrl(name + (typeof input.command === 'string' ? ' ' + input.command : ''), this.config.jevApiKey)
        .replaceAll(sandbox.workspaceRoot + '/', '').replaceAll(sandbox.workspaceRoot, '.')
        .replaceAll(sandbox.rootDir, '.').replace(/\s+/g, ' ').trim();
      let summary = label.length > 100 ? label.slice(0, 99) + '…' : label;
      try {
        const { jevConfidence, ...result } = await gate.canUseTool(name, input);
        if (jevConfidence !== undefined) summary = '⚡ ' + summary + '（Jev 放行 · ' + jevConfidence.toFixed(2) + '）';
        return result;
      } finally {
        t.progress(summary);
      }
    };
    const invoke = async (name: ToolName, input: Record<string, unknown>) => {
      const permission = await canUseTool(name, input);
      if (permission.behavior === 'deny') throw Error(permission.message);
      t.controller.signal.throwIfAborted();
      return t.tools.invoke(name, permission.updatedInput);
    };
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) ?? '' }],
    });
    const server = createSdkMcpServer({
      name: 'detent',
      tools: [
        ...(t.allowedWorkspaceTools ?? Object.keys(schemas) as ToolName[]).map(name =>
          tool(name, 'GitLab workspace: ' + name, schemas[name], async (input) =>
            result(await invoke(name, input)),
          ),
        ),
        ...Array.from(gate.extensionTools, ([id, extension]) =>
          tool(extension.name, extension.description, extension.schema, async (input) => {
            t.progress(extension.name);
            return result(await gate.invokeExtension(id, input));
          }),
        ),
        tool(
          'AskUserQuestion',
          'Ask a question on GitLab',
          { questions: z.array(z.object({ question: z.string() })).min(1) },
          async (input) => {
            const decision = await canUseTool('AskUserQuestion', input);
            if (decision.behavior === 'deny') throw Error(decision.message);
            return result(decision.updatedInput.answers);
          },
        ),
      ],
    });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: sandbox.claudeHome,
      CLAUDE_CONFIG_DIR: sandbox.claudeHome + '/.claude',
      TMPDIR: sandbox.rootDir,
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: this.config.anthropicApiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    };
    if (this.config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = this.config.anthropicBaseUrl;
    let diagnostic = '';
    try {
      let resultText: string | undefined;
      const messages = query({
        prompt: t.prompt,
        options: {
          hooks: drainInbox && { PostToolUse: [{ hooks: [async () => {
            const items = await drainInbox();
            return items.length ? { hookSpecificOutput: {
              hookEventName: 'PostToolUse', additionalContext: formatInboxMessages(items, this.config.jevApiKey),
            } } : {};
          }] }] },
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
          abortController: t.controller,
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
          appendSystemPrompt: t.systemPrompt,
          mcpServers: { detent: server },
          strictMcpConfig: true,
          includePartialMessages: true,
          // Extension authorization runs with parsed inputs in the MCP handler, once per invocation.
          canUseTool: (name, input) => gate.extensionTools.has(name)
            ? Promise.resolve({ behavior: 'allow', updatedInput: input })
            : canUseTool(name, input),
        },
      });
      for await (const message of messages) {
        if (message.session_id !== id) throw Error('Claude session identity changed');
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
      if (resultText === undefined) throw Error('Claude ended without a result');
      return resultText;
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error);
      const detail = t.controller.signal.aborted ? original : diagnostic.trim() || original;
      let message = redactGitUrl(detail);
      for (const secret of [this.config.anthropicApiKey, this.config.gitlabToken, this.config.jevApiKey]) {
        if (secret) message = message.replaceAll(secret, '***');
      }
      throw Error(message);
    }
  }
}
