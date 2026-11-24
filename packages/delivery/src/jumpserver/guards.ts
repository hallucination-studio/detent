import type { DecisionClient } from '@detent/core';

const deny = (reason: string) => ({ ok: false as const, reason });
export const normalizeInspectCommand = (command: string) => command.trim().replace(/[ \t]+/g, ' ');

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

// Limit options on programs that can open other files, switch hosts, or change
// state despite a read-only subcommand. Configured prefixes still apply afterward.
function readonlyArguments([program, ...args]: string[]) {
  const [subcommand, ...rest] = args;
  switch (program) {
    case 'uptime': return args.every(arg => ['-p', '-s', '--pretty', '--since'].includes(arg));
    case 'nginx': return subcommand !== '-t' || rest.every(arg => arg === '-q');
    case 'systemctl': return subcommand !== 'status' || rest.every(arg =>
      !arg.startsWith('-') || ['--no-pager', '--full', '-l'].includes(arg));
    case 'ss': return args.every(arg => /^-[tulnpa46]+$/.test(arg));
    case 'df': return !args.some(arg => arg.length > 2 && arg.startsWith('--') && '--sync'.startsWith(arg));
    case 'kubectl': return subcommand !== 'get' || readonlyKubectlGet(rest);
    default: return true;
  }
}

export function validateReadonlyInspectCommand(command: string, allowPrefixes: readonly string[]) {
  if (!command || command.length > 512 || /[^\w ./=:@%+,~^\t-]/.test(command))
    return deny('巡检命令为空、过长或含有非法字符');
  const normalized = normalizeInspectCommand(command);
  const words = normalized.split(' ');
  if (words.some(word => word.startsWith('~') || word.split('/').includes('..')))
    return deny('巡检命令禁止路径穿越或用户目录');
  if (!readonlyArguments(words)) return deny('巡检命令参数不在只读白名单');

  const allowed = allowPrefixes.some(value => {
    const prefix = normalizeInspectCommand(value);
    if (!prefix) return false;
    const path = prefix.split(' ').at(-1)!;
    const pathPrefix = path.startsWith('/');
    if (normalized !== prefix && !normalized.startsWith(prefix + ' ') &&
        !(pathPrefix && normalized.startsWith(prefix + '/'))) return false;
    if (!pathPrefix || words[0] !== 'cat') return true;
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

export function findBlockedAssets(assetIds: readonly string[], blockedAssets: readonly string[]): string[] {
  const blocked = new Set(blockedAssets.map(id => id.trim().toLowerCase()));
  return assetIds.filter(id => blocked.has(id.trim().toLowerCase()));
}

// Match the executable of every pipe stage, including shell/command wrappers.
const blockedPrograms = new Set((
  'sudo su doas rm mv cp mkdir rmdir touch tee dd chmod chown chgrp ln truncate shred kill pkill killall reboot ' +
  'shutdown halt poweroff init apt apt-get yum dnf rpm dpkg pip npm iptables nft ufw firewall-cmd useradd userdel ' +
  'usermod passwd crontab at vi vim nano ed eval exec sh bash zsh python python3 perl ruby node nc ncat ssh scp ' +
  'rsync wget env command xargs busybox timeout nohup nice'
).split(' '));

function loopbackProbe(args: string[]) {
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-[IsSik]+$/.test(arg) || arg === '--head') continue;
    if (arg === '-m' || arg === '--max-time') {
      if (!/^\d+(?:\.\d+)?$/.test(args[++i] ?? '')) return false;
      continue;
    }
    // Match the raw authority too: URL parsing alone normalizes surprising host spellings.
    if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s{}\[\]]*)?$/i.test(arg)) return false;
    urls++;
  }
  return urls === 1;
}

function blockedStage(segment: string) {
  const words = segment.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  const [program, ...args] = words.map(word => word.replace(/['"]/g, ''));
  const [subcommand, ...rest] = args;
  const literal = [program, ...args].join(' ');
  if (!program || !/^[\w-]+$/.test(program) || blockedPrograms.has(program)) return true;
  if (/\bsecrets?\b/i.test(literal) && /^(?:cat|grep|rg|awk|sed|head|tail)$/.test(program)) return true;
  switch (program) {
    case 'systemctl':
    case 'service': {
      const verbs = ['status', 'is-active', 'is-enabled', 'list-units', 'list-timers', 'show'];
      if (program === 'service') return args.length !== 2 || !verbs.includes(args[1]);
      return !verbs.includes(subcommand) || rest.some(arg => arg.startsWith('-') && !['--no-pager', '--full', '-l'].includes(arg));
    }
    case 'kubectl':
      return !['get', 'describe', 'logs', 'top', 'version', 'cluster-info'].includes(subcommand) ||
        /go-template-file|--(?:raw|server|token|kubeconfig|client-key)/.test(literal) ||
        (subcommand === 'get' ? !readonlyKubectlGet(rest) : /\bsecrets?\b/i.test(literal));
    case 'nginx': return !['-t', '-T', '-v', '-V'].includes(subcommand) || rest.some(arg => arg !== '-q');
    case 'curl': return !loopbackProbe(args);
    case 'df': return !readonlyArguments([program, ...args]);
    case 'ss': return args.some(arg => /^-[^-]*K|^--(?:kill|destroy)/.test(arg));
    case 'sed': return args.some(arg => /^-[^-]*i|^--in-place/.test(arg)) || /(?:^|[\s/])[ew](?:\s|$)/.test(literal);
    case 'awk': return /\bsystem\s*\(|\bgetline\b/.test(literal) || args.some(arg => /^-f|^--file/.test(arg));
    case 'find': return args.some(arg => /^-(?:delete|exec|ok|fprint|fprintf)/.test(arg));
    case 'journalctl': return args.some(arg => /^--(?:vacuum|rotate|flush|sync|relinquish|setup|update|rebuild)/.test(arg));
    case 'sort': return args.some(arg => /^-o|^--output/.test(arg));
    case 'ip': return !['a', 'addr', 'address', 'link', 'route', 'neigh'].includes(subcommand) ||
      rest.some(arg => !['show', 'list'].includes(arg));
    default: return false;
  }
}

export function isHardBlockedRemoteInspectCommand(command: string) {
  if (!command?.trim() || command.length > 512 || /[\r\n\0;&<>`()~\\]|\|\||\.\./.test(command)) return true;
  // Shell expansions are literal inside single quotes (for example, an awk field).
  if (/[$*?{}]/.test(command.replace(/'[^']*'/g, ''))) return true;
  // Remove balanced quotes before checking literals, including adjacent quoted fragments.
  const literal = command.replace(/'([^']*)'|"([^"]*)"/g, (_match, single, double) => single ?? double);
  if (/'[^']*\|[^']*'|"[^"]*\|[^"]*"/.test(command)) return true;
  const paths = literal.replace(/\/+(?:\.\/+)+|\/{2,}/g, '/');
  if (/['"\[\]]/.test(literal.replaceAll('[::1]', '')) ||
      /\/etc\/(?:shadow|sudoers|gshadow)|\.ssh\b|id_(?:rsa|ed25519)\b|\.env\b/i.test(paths)) return true;
  return command.split('|').some(blockedStage);
}

export async function evaluateRemoteInspectCommand(decision: DecisionClient, command: string) {
  try {
    const { effect, zero_side_effect: safety, impact } = await decision.decide({
      surface: 'remote_jumpserver_readonly_inspect', command,
    }, {
      effect: { type: 'choice', criteria: { pure_readonly: '纯只读诊断', read_sensitive_secret: '读取敏感凭据或密钥',
        state_mutating: '更改文件、服务或系统状态', ambiguous: '无法确定影响' } },
      zero_side_effect: { type: 'noul', instructions: '确认该远程巡检命令对目标服务器和业务环境完全无写入、无状态变更且不泄露凭据/密钥' },
      impact: { type: 'score', criteria: ['0: 纯只读诊断，零影响', '1: 轻微只读负载（查看普通日志/进程/端口），无状态变更',
        '2: 读取敏感凭据或改变服务/文件状态', '3: 高危破坏、提权或不可逆操作'] },
    });
    return effect.type === 'choice' && effect.choice === 'pure_readonly' &&
      safety.type === 'noul' && safety.noul >= decision.threshold && safety.noul <= 1 &&
      impact.type === 'score' && impact.score >= 0 && impact.score <= 0.6;
  } catch {
    return false;
  }
}
