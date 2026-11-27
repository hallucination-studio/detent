import path from 'node:path';
import { contained } from '../workspace/contained-path.js';

// Check the literal invocation. Workspace scripts and build/test targets run as code in the turn sandbox.
const blockedProgram = /^(?:sudo|su|doas|chmod|chown|mount|umount|mkfs(?:\..*)?|dd|kill|pkill|killall|shutdown|reboot|halt|poweroff|crontab|systemctl|service|launchctl|curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|nmap|twine|gh|glab|docker|podman|kubectl|helm|terraform|pulumi|printenv)$/;
const indirectShell = new Set('env eval exec command builtin source . pushd popd xargs time timeout nice nohup if then while until for function'.split(' '));
const inspection = new Set('cd pwd ls tree cat tac head tail wc grep rg stat file du basename dirname realpath readlink diff cmp echo printf test true false git'.split(' '));
const shell = /^(?:sh|bash|zsh|dash)$/;
const readGit = new Set('status diff log show rev-parse ls-files ls-tree branch remote describe shortlog blame grep cat-file show-ref diff-tree'.split(' '));

function readOnlyGit(words: string[]) {
  const [subcommand, ...args] = words;
  if (!readGit.has(subcommand)) return false;
  if (subcommand === 'remote')
    return args.length === 0 || (args.length === 1 && ['-v', '--verbose'].includes(args[0])) || args[0] === 'get-url';
  if (subcommand === 'branch') return args.every(arg => ['--list', '-a', '--all', '--show-current', '-r', '--remotes', '-v', '-vv'].includes(arg));
  const unsafe = ['--output', '--ext-diff', '--textconv', '--no-index', '--open-files-in-pager'];
  return !args.some(arg => {
    const [flag] = arg.split('=');
    return flag === '-O' || (flag.length > 2 && flag.startsWith('--') && unsafe.some(option => option.startsWith(flag)));
  });
}

async function bashOperandsContained(args: string[], root: string, cwd: string, write: boolean) {
  for (const arg of new Set(args)) {
    const value = arg.replace(/^(?:--?[\w-]+=|-[A-Za-z](?=\/)|-[oICL](?=.+))/, '');
    if (value === '/dev/null' && !write) continue;
    if (!await contained(root, value, write, cwd)) return false;
  }
  return true;
}

async function blockedBashWrite(program: string, args: string[], root: string, cwd: string) {
  if (inspection.has(program) && !args.some(arg => /^(?:--output(?:=|$)|-o)/.test(arg))) return false;
  const targets = ['.', ...args];
  // A directory destination implicitly writes a child named after each source.
  if (['cp', 'mv', 'ln', 'install'].includes(program)) {
    const operands = args.filter(arg => !arg.startsWith('-'));
    const flag = args.findIndex(arg => arg === '--target-directory' || arg.startsWith('--target-directory=') || arg.startsWith('-t'));
    const destination = flag < 0 ? (operands.length > 1 ? operands.pop() : '.')
      : args[flag].replace(/^(?:--target-directory=?|-t)/, '') || args[flag + 1];
    if (!destination) return true;
    targets.push(destination, ...operands.map(source => path.join(destination, path.basename(source))));
  }
  return !await bashOperandsContained(targets, root, cwd, true);
}

export async function validateLocalSandboxBash(command: unknown, workspaceRoot: string) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || command.includes('\0'))
    return '命令为空、过长或包含无效字符';
  const syntax = '仅支持可静态检查的本地命令和路径';
  // Tokenize without running a shell. Keep quoted operands intact for realpath checks.
  const tokens = command.trim().match(/[ \t]+|&&|\|\||[;|\n]|\d*>&[012](?!\d)|\d*(?:>>?|<)|(?:[^\s"'&;|<>`$\\(){}\[\]*?#!]+|"[^"\n`$\\]*"|'[^'\n]*')+/gy) ?? [];
  if (tokens.join('') !== command.trim()) return syntax;
  const segments: string[][] = [[]];
  const separators = new Set<string>();
  for (const token of tokens) {
    if (/^[ \t]+$/.test(token)) continue;
    if (['&&', '||', '|', ';', '\n'].includes(token)) {
      separators.add(token);
      segments.push([]);
    } else segments[segments.length - 1].push(token);
  }
  const chainedWithAnd = [...separators].every(op => op === '&&');
  let cwd = workspaceRoot;
  const unquote = (word: string) => word.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single);
  for (const segment of segments) {
    const words: string[] = [];
    for (let j = 0; j < segment.length; j++) {
      const token = segment[j];
      if (/^\d*>&[012]$/.test(token)) continue;
      if (!/^\d*[<>]/.test(token)) {
        words.push(unquote(token));
        continue;
      }
      const operand = segment[++j];
      if (!operand || /^\d*[<>]/.test(operand)) return syntax;
      const dest = unquote(operand);
      if (dest !== '/dev/null' && !await contained(workspaceRoot, dest, !token.endsWith('<'), cwd))
        return '重定向路径超出工作区或受保护';
    }
    const [executable, ...args] = words;
    if (!executable || !/^[\w./+-]+$/.test(executable)) return syntax;
    const program = path.basename(executable);
    if (!await contained(workspaceRoot, executable, false, cwd)) return '命令路径超出工作区';
    if (blockedProgram.test(program) || (!inspection.has(program) && args.some(arg => blockedProgram.test(path.basename(arg)))))
      return '禁止执行此命令';
    if (indirectShell.has(program))
      return '禁止执行此命令';
    if (shell.test(program) && (!args[0] || args[0].startsWith('-'))) return syntax;
    if (['npm', 'yarn', 'pnpm', 'cargo'].includes(program) && args.includes('publish')) return '禁止发布软件包';
    if (!inspection.has(program) && args.includes('git') && (args.includes('push') || args.includes('remote')))
      return '请直接调用本地只读 Git 查询';
    if (program === 'find' && args.some(arg => /^-(?:exec|ok)/.test(arg))) return syntax;
    let operandCwd = cwd;
    if (program === 'git') {
      if (args[0] === '-C') {
        const dir = args[1];
        if (!dir || !await contained(workspaceRoot, dir, false, cwd)) return 'Git 工作目录超出工作区';
        operandCwd = path.resolve(cwd, dir);
        args.splice(0, 2);
      }
      if (!readOnlyGit(args)) return '仅允许本地只读 Git 查询';
    }
    if (!await bashOperandsContained(args, workspaceRoot, operandCwd, false) ||
        await blockedBashWrite(program, args, workspaceRoot, operandCwd))
      return '路径超出工作区或写入受保护文件';
    if (program === 'cd') {
      // After a failed cd, only && guarantees the next command cannot run in the old directory.
      if (args.length !== 1 || !args[0] || args[0].startsWith('-') || !chainedWithAnd) return syntax;
      cwd = path.resolve(cwd, args[0]);
    }
  }
}
