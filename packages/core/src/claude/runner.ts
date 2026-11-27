import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-code';
import { z } from 'zod';
import path from 'node:path';
import buffer from 'node:buffer';
import { configuredSecrets, redactGitUrl } from '../gitlab/redact.js';
import { openModelTransport } from './model-transport.js';
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
const toolLabels: Record<string, string> = {
  detent_list_projects: '查询 GitLab 仓库列表',
  detent_close_worktree: '归档工作树',
  detent_commit_and_push: '提交推送分支',
  detent_create_mr: '创建或更新 Merge Request',
  detent_get_pipeline_status: '查询流水线状态',
  detent_get_pipeline_job_log: '查看流水线任务日志',
  detent_get_mr_diff: '查看 MR 代码变更',
  detent_list_mr_discussions: '查看 MR 评审讨论',
  detent_sync_target_branch: '同步目标分支',
  detent_check_project_onboarding: '检查仓库接入状态',
  detent_onboard_project: '配置仓库 Webhook',
  detent_list_tags: '查询历史 Tag',
  detent_create_release: '创建 Tag / Release',
};

export function formatToolProgress(name: string, input: Record<string, unknown>, sandbox: TurnSandbox,
  redact: (value: string) => string, description?: string, jevConfidence?: number): string | null {
  let label = Object.hasOwn(toolLabels, name) ? toolLabels[name] : description;
  if (['Glob', 'Grep', 'detent_close_issue'].includes(name)) return null;
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    if (typeof input.file_path !== 'string') return null;
    const relative = path.relative(sandbox.workspaceRoot, path.resolve(sandbox.workspaceRoot, input.file_path));
    const projectPath = /^projects\/([^/]+\/.+)$/.exec(relative)?.[1];
    if (name === 'Read' && !projectPath) return null;
    label = (name === 'Read' ? '读取 ' : '修改 ') + (projectPath ?? relative);
  } else if (name === 'Bash' && typeof input.command === 'string') {
    label = '执行命令：' + input.command.replaceAll(sandbox.workspaceRoot + '/', '').replaceAll(sandbox.workspaceRoot, '.').replaceAll(sandbox.rootDir, '.');
  } else if (name === 'detent_checkout_project' || name === 'detent_checkout_worktree') {
    label = '检出仓库 ' + input.project;
  }
  if (!label) return null;
  const clean = redact(label).replace(/\s+/g, ' ').trim();
  const summary = clean.length > 100 ? clean.slice(0, 99) + '…' : clean;
  return name === 'Bash' && jevConfidence !== undefined ? summary + '（已自动放行）' : summary;
}

export class SdkClaudeRunner implements ClaudeRunner {
  constructor(private config: AppConfig) {}
  async run(t: TurnInput) {
    const { session, sandbox, gate, drainInbox } = t;
    const secrets = configuredSecrets(this.config);
    const redact = (value: string) => redactGitUrl(value, secrets);
    const id = session.claudeSessionId!;
    const canUseTool = async (name: string, input: Record<string, unknown>) => {
      const { jevConfidence, ...result } = await gate.canUseTool(name, input);
      if (result.behavior === 'allow') {
        const step = formatToolProgress(name, input, sandbox, redact, undefined, jevConfidence);
        if (step) t.progress(step);
      }
      return result;
    };
    const invoke = async (name: ToolName, input: Record<string, unknown>) => {
      const permission = await canUseTool(name, input);
      if (permission.behavior === 'deny') throw Error(permission.message);
      t.controller.signal.throwIfAborted();
      return t.tools.invoke(name, permission.updatedInput);
    };
    const result = async (operation: Promise<unknown>) => {
      try {
        const text = JSON.stringify(await operation, (_key, value) => typeof value === 'string' ? redact(value) : value);
        return { content: [{ type: 'text' as const, text: text ?? '' }] };
      } catch (error) {
        throw Error(redact(error instanceof Error ? error.message : String(error)));
      }
    };
    const server = createSdkMcpServer({
      name: 'detent',
      tools: [
        ...(t.allowedWorkspaceTools ?? Object.keys(schemas) as ToolName[]).map(name =>
          tool(name, 'GitLab workspace: ' + name, schemas[name], async (input) =>
            result(invoke(name, input)),
          ),
        ),
        ...Array.from(gate.extensionTools, ([id, extension]) =>
          tool(extension.name, redact(extension.description), extension.schema, async (input) => {
            const output = await result(gate.invokeExtension(id, input));
            const step = formatToolProgress(extension.name, input, sandbox, redact, extension.description);
            if (step) t.progress(step);
            return output;
          }),
        ),
        tool(
          'AskUserQuestion',
          'Ask a question on GitLab',
          { questions: z.array(z.object({ question: z.string() })).min(1) },
          async (input) => {
            const decision = await canUseTool('AskUserQuestion', input);
            if (decision.behavior === 'deny') throw Error(decision.message);
            return result(Promise.resolve(decision.updatedInput.answers));
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
    let model: Awaited<ReturnType<typeof openModelTransport>> | undefined;
    let diagnostic = '';
    const transport = new AbortController();
    let interrupt: (() => void) | undefined;
    let shutdown: NodeJS.Timeout | undefined;
    try {
      let resultText: string | undefined;
      t.controller.signal.throwIfAborted();
      if (this.config.anthropicApiKey) {
        model = await openModelTransport(this.config.anthropicBaseUrl ?? 'https://api.anthropic.com', this.config.anthropicApiKey);
        env.ANTHROPIC_BASE_URL = model.url;
        env.ANTHROPIC_AUTH_TOKEN = 'detent-local';
      }
      const messages = query({
        prompt: redact(t.prompt),
        options: {
          hooks: drainInbox && { PostToolUse: [{ hooks: [async () => {
            const items = await drainInbox();
            return items.length ? { hookSpecificOutput: {
              hookEventName: 'PostToolUse', additionalContext: redact(formatInboxMessages(items, this.config.jevApiKey)),
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
      return resultText;
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
