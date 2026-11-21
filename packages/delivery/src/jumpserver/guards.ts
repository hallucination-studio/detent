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
