import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../../.cache/e2e-tools/bin/', import.meta.url));
// Published in https://github.com/helm/helm/releases/tag/v3.17.2
const checksums: Record<string, string> = {
  'darwin-amd64': '3e240238c7a3a10efd37b8e16615b28e94ba5db5957247bb42009ba6d52f76e9',
  'darwin-arm64': 'b843cebcbebc9eccb1e43aba9cca7693d32e9f2c4a35344990e3b7b381933948',
  'linux-amd64': '90c28792a1eb5fb0b50028e39ebf826531ebfcf73f599050dbd79bab2f277241',
  'linux-arm64': 'd78d76ec7625a94991e887ac049d93f44bd70e4876200b945f813c9e1ed1df7c',
};

export async function ensureLocalHelmPath() {
  const path = process.env.PATH ?? '';
  for (const dir of [...path.split(delimiter).filter(Boolean), bin]) {
    try {
      await access(join(dir, 'helm'), constants.X_OK);
      return dir === bin ? bin + delimiter + path : path;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const target = process.platform + '-' + (process.arch === 'x64' ? 'amd64' : process.arch);
  if (!checksums[target]) throw Error('Install Helm on PATH for unsupported platform ' + target);
  await mkdir(bin, { recursive: true });
  const staging = await mkdtemp(join(bin, '.install-'));
  try {
    const response = await fetch('https://get.helm.sh/helm-v3.17.2-' + target + '.tar.gz', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error('Downloading Helm returned HTTP ' + response.status);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== checksums[target]) throw Error('Helm SHA256 mismatch for ' + target);
    await writeFile(join(staging, 'helm.tgz'), archive);
    await run('tar', ['-xzf', 'helm.tgz', target + '/helm'], { cwd: staging });
    await rename(join(staging, target, 'helm'), join(bin, 'helm'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return bin + delimiter + path;
}
