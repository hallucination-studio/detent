import { logError, type DecisionClient } from '@detent/core';
import type { JumpServerAsset } from './client.js';

const deny = (reason: string) => ({ ok: false as const, reason });
export function normalizeShellCommand(command: string) {
  // Whitespace inside a quoted argument is data.
  return /['"]/.test(command) ? command.trim() : command.trim().replace(/[ \t]+/g, ' ');
}

function readonlyKubectlGet(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      if (arg.split(',').some(resource => /^secrets?(?:[./]|$)/i.test(resource))) return false;
      continue;
    }
    const [flag, inlineValue] = arg.split('=');
    if (['-A', '--all-namespaces', '--no-headers', '--show-labels'].includes(flag)) continue;
    if (!['-o', '--output', '-n', '--namespace', '-l', '--selector'].includes(flag)) return false;
    const value = inlineValue ?? args[++i];
    if (value === undefined || value.startsWith('-')) return false;
    if ((flag === '-o' || flag === '--output') && !['wide', 'name', 'json', 'yaml'].includes(value)) return false;
  }
  return true;
}

function readonlyHelm(subcommand: string, args: string[]) {
  if (!['list', 'status', 'history', 'version'].includes(subcommand)) return false;
  let releases = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      releases++;
      continue;
    }
    if (['-A', '--all-namespaces', '--short', '--show-resources', '--deployed', '--failed', '--pending', '--all'].includes(arg)) continue;
    const separator = arg.indexOf('=');
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    if (!['-n', '--namespace', '-o', '--output', '--max', '--revision', '--filter'].includes(flag)) return false;
    const value = separator < 0 ? args[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith('-')) return false;
    if (['-o', '--output'].includes(flag) && !['table', 'json', 'yaml'].includes(value)) return false;
    if (['--max', '--revision'].includes(flag) && !/^\d+$/.test(value)) return false;
  }
  return releases === (['status', 'history'].includes(subcommand) ? 1 : 0);
}

// Only these read-only forms accept extra arguments after a configured prefix.
function readonlyPrefixArguments([program, ...args]: string[]) {
  const [subcommand, ...rest] = args;
  switch (program) {
    case 'uptime': return args.every(arg => ['-p', '-s', '--pretty', '--since'].includes(arg));
    case 'nginx': return subcommand === '-t' && rest.every(arg => arg === '-q');
    case 'systemctl': return subcommand === 'status' && rest.every(arg =>
      !arg.startsWith('-') || ['--no-pager', '--full', '-l'].includes(arg));
    case 'ss': return args.every(arg => /^-[tulnpa46sxriemo]+$/.test(arg));
    case 'df': return !args.some(arg => arg.length > 2 && arg.startsWith('--') && '--sync'.startsWith(arg));
    case 'kubectl': return subcommand === 'get' && readonlyKubectlGet(rest);
    case 'helm': return readonlyHelm(subcommand, rest);
    default: return false;
  }
}

// Basename prefixes apply to installed binaries. Relative and user-controlled
// paths must never inherit the permissions of a system command with the same name.
function installedProgram(executable: string) {
  return executable.replace(/^\/(?:(?:usr\/(?:local\/)?)?s?bin|opt\/[\w.-]+\/bin)\/([\w.-]+)$/, '$1');
}

export function validateReadonlyInspectCommand(command: string, allowPrefixes: readonly string[]) {
  if (isHardBlockedRemoteInspectCommand(command))
    return { ...deny('巡检命令触发硬性安全限制（禁止危险操作、命令组合或读取敏感文件）'), hardBlocked: true as const };
  if (/[^\w ./=:@%+,^\t-]/.test(command)) return deny('巡检命令不匹配只读前缀');
  const normalized = normalizeShellCommand(command);
  const words = normalized.split(' ');
  const [executable, ...args] = words;
  const program = installedProgram(executable);

  const allowed = allowPrefixes.some(value => {
    const prefix = normalizeShellCommand(value);
    if (!prefix) return false;
    const [prefixProgram, ...prefixArgs] = prefix.split(' ');
    if (prefixProgram !== executable && prefixProgram !== program) return false;
    const candidate = [prefixProgram, ...args].join(' ');
    if (candidate === prefix) return true;
    const path = prefixArgs.at(-1) ?? '';
    const pathPrefix = path.startsWith('/');
    if (!candidate.startsWith(prefix + ' ') && !(pathPrefix && candidate.startsWith(prefix + '/'))) return false;
    if (program !== 'cat') return readonlyPrefixArguments([program, ...args]);
    if (!pathPrefix) return false;
    const endOptions = words.indexOf('--');
    return words.every((word, i) => i === 0 || word === path || word.startsWith(path + '/') ||
      (word !== '-' && word.startsWith('-') && (endOptions === -1 || i <= endOptions)));
  });
  return allowed ? { ok: true as const, normalized } : deny('巡检命令不在只读白名单');
}

export function validatePlaybookPath(playbookPath: string) {
  if (!playbookPath || playbookPath.startsWith('/') || /[^\w./-]/.test(playbookPath) ||
      playbookPath.split('/').includes('..') || !/\.ya?ml$/.test(playbookPath))
    return deny('Playbook 必须是仓库内的相对 .yml 或 .yaml 文件路径');
  return { ok: true as const };
}

export function findBlockedAssets(
  assets: readonly (string | Pick<JumpServerAsset, 'id' | 'name' | 'address' | 'nodes' | 'labels'>)[],
  blockedAssets: readonly string[],
): string[] {
  const rules = blockedAssets.map(rule => rule.trim().toLowerCase()).filter(Boolean);
  return assets.filter(asset => rules.some(rule => {
    if (typeof asset === 'string') return asset.trim().toLowerCase() === rule;
    if (rule.startsWith('label:')) return asset.labels?.some(label => label.trim().toLowerCase() === rule.slice(6));
    if (rule.startsWith('/')) return asset.nodes?.some(node => {
      const path = node.trim().toLowerCase();
      return path === rule || path.startsWith(rule + '/');
    });
    return [asset.id, asset.name, asset.address].some(value => value.trim().toLowerCase() === rule);
  })).map(asset => typeof asset === 'string' ? asset : asset.id);
}

// Match the executable of every pipe stage, including shell/command wrappers.
const blockedPrograms = new Set((
  'sudo su doas rm mv cp mkdir rmdir touch tee dd chmod chown chgrp ln truncate shred kill pkill killall reboot ' +
  'shutdown halt poweroff init apt apt-get yum dnf rpm dpkg pip npm iptables nft ufw firewall-cmd useradd userdel ' +
  'usermod passwd crontab at vi vim nano ed eval exec sh bash zsh python python3 perl ruby node nc ncat ssh scp ' +
  'rsync wget env command xargs busybox timeout nohup nice'
).split(' '));

// Parse only literal arguments and pipes. Active shell syntax fails closed.
function splitPipes(command: string): string[][] | null {
  const stages: string[][] = [[]];
  let args = stages[0];
  let word: string | undefined;
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && /[$`]/.test(char)) return null;
      else if (quote === '"' && char === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) word += command[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === ' ' || char === '\t' || char === '|') {
      if (word !== undefined) args.push(word);
      word = undefined;
      if (char === '|') {
        if (!args.length) return null;
        args = [];
        stages.push(args);
      }
    } else {
      if (/[;&<>`$()~\\*?{}\[\]]/.test(char) || command.startsWith('..', i)) return null;
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) args.push(word);
  return quote || !args.length ? null : stages;
}

function blockedStage([executable, ...args]: string[]) {
  const program = executable.split('/').at(-1) ?? '';
  if (!/^[\w./-]+$/.test(executable) || !program || blockedPrograms.has(program)) return true;

  const literal = [executable, ...args].join(' ').replace(/\/+(?:\.\/+)+|\/{2,}/g, '/');
  if (/\/etc\/(?:shadow|sudoers|gshadow)\b|\.ssh\b|id_(?:rsa|ed25519)\b|\.env\b|\/secrets?\b/i.test(literal)) return true;
  const kubectlGet = program === 'kubectl' && args[0] === 'get' && !args.includes('--');
  for (const [i, arg] of args.entries()) {
    if (!/\bsecrets?\b/i.test(arg)) continue;
    // A namespace named "secrets" does not select the Secret resource.
    if (kubectlGet && /^--namespace=secrets?$/i.test(arg)) continue;
    if (kubectlGet && /^secrets?$/i.test(arg) && ['-n', '--namespace'].includes(args[i - 1])) continue;
    return true;
  }
  if (program === 'awk') return args.some(arg => /\||\bsystem\s*\(|\bgetline\b/.test(arg));
  if (program === 'sed') return args.some(arg => /^-[^-]*i|^--in-place/.test(arg));
  if (program === 'find') return args.some(arg => /^-(?:delete|exec(?:dir)?|ok(?:dir)?)$/.test(arg));
  return false;
}

export function isHardBlockedRemoteInspectCommand(command: string) {
  if (!command?.trim() || command.length > 512 || /[\r\n\0]/.test(command)) return true;
  const stages = splitPipes(command);
  return stages === null || stages.some(blockedStage);
}

const effects = { pure_readonly: '纯只读诊断', read_sensitive_secret: '读取敏感凭据或密钥',
  state_mutating: '更改文件、服务或系统状态', ambiguous: '无法确定影响' };

export async function evaluateRemoteInspectCommand(decision: DecisionClient, command: string) {
  try {
    const { effect, zero_side_effect: safety, impact } = await decision.decide({
      surface: 'remote_jumpserver_readonly_inspect', command,
    }, {
      effect: { type: 'choice', criteria: effects },
      zero_side_effect: { type: 'noul', instructions: '确认该远程巡检命令对目标服务器和业务环境完全无写入、无状态变更且不泄露凭据/密钥',
        criteria: { true: '纯只读诊断，无任何写入、状态变更或凭据泄露', false: '存在写入、状态变更、凭据读取或高危风险' } },
      impact: { type: 'score', criteria: ['0: 纯只读诊断，零影响', '1: 轻微只读负载（查看普通日志/进程/端口），无状态变更',
        '2: 读取敏感凭据或改变服务/文件状态', '3: 高危破坏、提权或不可逆操作'] },
    });
    if (effect?.type !== 'choice' || !Object.hasOwn(effects, effect.choice) || safety?.type !== 'noul' ||
        !Number.isFinite(safety.noul) || impact?.type !== 'score' || !Number.isFinite(impact.score))
      throw Error('Jev 巡检响应缺少有效的 choice、noul 或 impact');
    const allowed = effect.choice === 'pure_readonly' && safety.noul >= 0.75 &&
      safety.noul <= 1 && impact.score >= 0 && impact.score <= 1.35;
    const metrics = `Jev: choice=${effect.choice}, noul=${safety.noul}, impact=${impact.score}`;
    return { allowed, reason: allowed ? metrics : `未通过只读巡检风控（${metrics}）` };
  } catch (error) {
    const detail = logError('jumpserver-guard', error);
    return { allowed: false, reason: '只读巡检 Jev 评估失败：' + detail };
  }
}

export async function validateShellCommands(commands: readonly string[], allowPrefixes: readonly string[], decision?: DecisionClient) {
  if (!Array.isArray(commands) || !commands.length || commands.length > 10) return deny('每次巡检必须传入 1 至 10 条命令');
  const pending: string[] = [];
  for (const command of commands) {
    if (typeof command !== 'string') return deny('巡检命令必须为字符串');
    const check = validateReadonlyInspectCommand(command, allowPrefixes);
    if (check.ok) continue;
    if ('hardBlocked' in check || !decision) return deny(`命令「${command}」未通过只读校验：${check.reason}`);
    pending.push(normalizeShellCommand(command));
  }
  if (decision && pending.length) {
    const results = await Promise.all(pending.map(cmd => evaluateRemoteInspectCommand(decision, cmd)));
    for (const [i, res] of results.entries())
      if (!res.allowed) return deny(`命令「${pending[i]}」未通过只读校验：${res.reason}`);
  }
  return { ok: true as const, commands: commands.map(normalizeShellCommand) };
}

export function buildBatchShellScript(commands: readonly string[]) {
  if (commands.length === 1) return commands[0];
  const lines = ['set +e'];
  for (const [index, cmd] of commands.entries()) {
    const quoted = "'" + cmd.replaceAll("'", "'\\''") + "'";
    lines.push(`printf '=== [%d/%d] %s ===\\n' ${index + 1} ${commands.length} ${quoted}`,
      '(', cmd, ')', `printf '[rc=%d]\\n' "$?"`);
  }
  return [...lines, 'exit 0'].join('\n');
}
