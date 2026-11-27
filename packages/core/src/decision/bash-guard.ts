import path from 'node:path';
import { logError, redactGitUrl } from '../gitlab/redact.js';
import { isHubScopePath } from '../workspace/hub-paths.js';
import type { DecisionClient, DecisionQuestion } from './jev-client.js';

// Unknown executables (including remote infrastructure clients) require a human.
// Only literal invocations of workspace development and inspection tools reach the model.
const localPrograms = new Set((
  'pwd ls tree cat tac head tail less more wc sort uniq cut tr grep egrep fgrep rg ag find fd stat file ' +
  'du df basename dirname realpath readlink diff cmp echo printf base64 test true false cd git make cmake ninja ' +
  'npm npx yarn pnpm bun deno node tsc eslint prettier vitest jest python python3 pip pip3 pytest poetry uv ' +
  'cargo rustc rustfmt go gofmt mvn gradle dotnet ruby bundle rake gcc clang g++ javac java ' +
  'mkdir rmdir touch cp mv rm tee sed awk perl jq date which whoami uname'
).split(/\s+/));
const dangerous = /\b(?:sudo|su|doas|chmod|chown|mount|umount|mkfs|dd|kill|pkill|killall|shutdown|reboot|crontab|systemctl|service|launchctl|curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|nmap|twine|gh|glab|docker|podman|kubectl|helm|terraform|pulumi|eval|exec|printenv)\b/;
const legacyProtectedPath = /(?:^|[^\w.-])(?:claude\.md|workflows|\.git|\.claude|\.mcp\.json)(?:$|[^\w.-])/i;
export const bashWriteOperation = />|\b(?:tee|rm|mv|cp|ln|unlink|dd|sed|perl|python3?|node|chmod|chown|touch|mkdir|rmdir|truncate|install|patch|apply|checkout|restore|reset|clean|output|write|format|fmt)\b/;

export function bashOperands(command: string) {
  const words = command.match(/(?:[^\s"'|&;<>]|"[^"]*"|'[^']*')+/g) ?? [];
  return words.flatMap(word => {
    const literal = word.replace(/"([^"]*)"|'([^']*)'/g, (_match, double, single) => double ?? single);
    const argument = literal.replace(/^(?:(?:--?[\w-]+|[a-zA-Z_]\w*)=|-[A-Za-z](?=\/))/, '');
    return argument !== literal ? [literal, argument] : [literal];
  });
}

export function isHardGatedLocalBash(command: unknown, workspaceRoot: string) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 ||
      /[\0`$\\]|[<>]\(|&(?![&>])/.test(command.replaceAll('&&', ';'))) return true;
  // Reject fragmented shell words instead of guessing what quoting would execute.
  if (/[\w./-]['"][\w./-]|['"]['"]/.test(command)) return true;
  const literal = command.replace(/['"]/g, '');
  if (/[{}\[\]*?]/.test(literal) && bashWriteOperation.test(literal)) return true;
  if (/\b(?:rm|mv|cp|tee)\b/.test(literal) && literal.split(/\s+/).includes('/dev/null')) return true;
  if (/(?:^|[^\w.-])\.\.(?:$|[^\w.-])|(?:^|[\s=:/<>])~/.test(literal)) return true;
  for (const match of literal.matchAll(/(?:^|[\s=:<>|;&(]|-[A-Za-z])(\/[^\s;|&<>)]*)/g)) {
    const target = path.resolve(match[1]);
    const relative = path.relative(workspaceRoot, target);
    if (target !== '/dev/null' && (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))) return true;
  }
  if (bashWriteOperation.test(literal)) {
    if (legacyProtectedPath.test(literal)) return true;
    // Project paths may use the same names as protected Hub files and directories.
    if (bashOperands(command).some(operand => isHubScopePath(path.relative(workspaceRoot, path.resolve(workspaceRoot, operand))))) return true;
  }
  return literal.split(/&&|\|\||[;|\n]/).some(segment => {
    const words = segment.trim().split(/\s+/);
    if (words[0] === 'env') words.shift();
    while (/^\w+=/.test(words[0])) words.shift();
    const [program] = words;
    if (!localPrograms.has(program) || dangerous.test(segment)) return true;
    if (/\b(?:git\s+.*?\b(?:push|remote|config|credential)|(?:npm|yarn|pnpm|cargo)\s+.*?\bpublish)\b/.test(segment)) return true;
    if (program === 'git' && /\s(?:-c|--config-env)(?:\s|=)/.test(segment)) return true;
    return /\b(?:sh|bash|zsh)\s+-[a-z]*c\b|\bfind\b.*\s-(?:exec|ok)/.test(segment);
  });
}

const questions = {
  category: { type: 'choice', criteria: {
    readonly_inspect: '纯只读查看、目录列表、文件读取/搜索、只读 git 状态/日志查询及管道过滤，不修改任何文件或环境',
    workspace_dev: '仅在当前临时开发工作区内进行的构建、测试、Lint、格式化、依赖安装（如 npm/pnpm/yarn/pip/go/cargo install）或无外部影响的本地开发命令',
    external_or_destructive: '会对外部系统、远端仓库、宿主机造成影响，或包含网络外传、提权、破坏性删除、敏感凭据访问或安全绕过',
    uncertain: '语义模糊、混淆或无法确定影响范围',
  } },
  no_external_impact: { type: 'noul', instructions: '判断执行该命令是否对外部环境、生产系统和宿主机完全无不良影响，可免人工审批自动放行',
    criteria: { true: '无外部或生产影响，仅限只读检查或当前临时工作区开发操作', false: '存在外部影响、破坏性风险、敏感凭据访问或无法确定安全' } },
  impact: { type: 'score', instructions: '评估该命令对外部环境与系统安全的影响等级', criteria: [
    '0: 纯只读，零改动', '1: 仅影响当前临时工作区（构建/测试/依赖安装），无外部影响',
    '2: 有外部影响、系统改动或潜在破坏性，需人工 Review', '3: 高危破坏、越权或安全绕过风险',
  ] },
} satisfies Record<string, DecisionQuestion>;

export async function evaluateLocalBash(decision: DecisionClient, command: string, description: unknown, readonly: boolean) {
  try {
    const { category, no_external_impact: safety, impact } = await decision.decide({
      surface: 'local_ephemeral_workspace_bash', mode: readonly ? 'readonly' : 'coding',
      command: redactGitUrl(command), description: typeof description === 'string' ? redactGitUrl(description) : '',
    }, questions);
    if (category.type !== 'choice' || safety.type !== 'noul' || impact.type !== 'score' ||
        !Object.hasOwn(questions.category.criteria, category.choice)) throw Error('Invalid Jev Bash decision');
    const allowed = (category.choice === 'readonly_inspect' || (!readonly && category.choice === 'workspace_dev')) &&
      safety.noul >= decision.threshold && safety.noul <= 1 && impact.score >= 0 && impact.score <= (readonly ? 1.2 : 1.4);
    return { allowed, confidence: safety.noul, riskNote: `分类 ${category.choice}，安全概率 ${safety.noul.toFixed(2)}，影响等级 ${impact.score.toFixed(2)}` };
  } catch (error) {
    const detail = logError('bash-guard', error);
    return { allowed: false, riskNote: '决策评估超时或不可用：' + detail };
  }
}
