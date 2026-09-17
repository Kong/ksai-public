import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';

const VERSION_SHAPE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;

const INTEGRITY_SHAPE = /^sha512-[A-Za-z0-9+/]{86}==$/;

const TARBALL_BYTES = 512 * 1024 * 1024;

const METADATA_TIMEOUT_MS = 20_000;

const TARBALL_TIMEOUT_MS = 180_000;

const readCpu = () => {
  try {
    return readFileSync('/proc/cpuinfo', 'utf8');
  } catch {
    return '';
  }
};

const glibcRuntime = () => existsSync('/lib64/ld-linux-x86-64.so.2');

const sha512 = (bytes) => createHash('sha512').update(bytes).digest();

const untar = (tarball, into) => spawnSync('tar', ['-xzf', tarball, '-C', into, '--no-same-owner', '--no-same-permissions', 'package/bin/opencode'], {
  stdio: 'ignore',
  timeout: 120_000,
}).status === 0;

/** packageFor answers the platform package npm's opencode launcher would run here, or '' where this installer does not apply. */
export function packageFor({ platform, arch, glibc, cpuinfo }) {
  if (platform !== 'linux' || arch !== 'x64' || !glibc) return '';
  return /(^|\s)avx2(\s|$)/i.test(String(cpuinfo)) ? 'opencode-linux-x64' : 'opencode-linux-x64-baseline';
}

/**
 * installOpencode places one verified OpenCode binary in the job-local tool directory.
 *
 * The registry's own integrity for the exact version decides whether a tarball is used, so a tarball
 * restored from a cache is trusted no further than one just downloaded.
 */
export async function installOpencode({
  version = '',
  distDir = '',
  toolDir = '',
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  glibc = glibcRuntime(),
  cpuinfo = readCpu(),
  extract = untar,
  log = console.error,
} = {}) {
  if (!VERSION_SHAPE.test(version) || !distDir || !toolDir) throw new Error('the OpenCode install names no version or directory');
  const name = packageFor({ platform, arch, glibc, cpuinfo });
  if (!name) return null;

  const metadata = await fetchImpl(`${REGISTRY}/${name}/${version}`, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!metadata.ok) throw new Error(`the registry answered ${metadata.status} for ${name}@${version}`);
  const described = JSON.parse(await metadata.text());
  const tarballUrl = `${REGISTRY}/${name}/-/${name}-${version}.tgz`;
  const integrity = String(described?.dist?.integrity ?? '');
  if (described?.name !== name || described?.version !== version || described?.dist?.tarball !== tarballUrl || !INTEGRITY_SHAPE.test(integrity)) {
    throw new Error(`the registry described ${name}@${version} in a shape this installer does not accept`);
  }
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64');

  mkdirSync(distDir, { recursive: true });
  const tarball = join(distDir, `${name}-${version}.tgz`);
  let fetched = false;
  if (!existsSync(tarball) || !sha512(readFileSync(tarball)).equals(expected)) {
    if (existsSync(tarball)) log(`::warning::the cached ${name}@${version} tarball does not match the registry integrity, so it was downloaded again`);
    const response = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the registry answered ${response.status} for the ${name}@${version} tarball`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > TARBALL_BYTES) throw new Error('the OpenCode tarball exceeds its bound');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > TARBALL_BYTES) throw new Error('the OpenCode tarball exceeds its bound');
    if (!sha512(bytes).equals(expected)) throw new Error(`the downloaded ${name}@${version} tarball does not match the registry integrity`);
    const partial = `${tarball}.${process.pid}.partial`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, tarball);
    fetched = true;
  }

  mkdirSync(toolDir, { recursive: true });
  const staging = mkdtempSync(join(distDir, 'extract-'));
  try {
    if (!extract(tarball, staging)) throw new Error(`the ${name}@${version} tarball could not be unpacked`);
    const binary = join(toolDir, `opencode-${version}-${name}`);
    rmSync(binary, { force: true });
    renameSync(join(staging, 'package', 'bin', 'opencode'), binary);
    chmodSync(binary, 0o755);
    return { binary, fetched, name };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const installed = await installOpencode({
      version: String(process.env.VERSION ?? ''),
      distDir: String(process.env.DIST_DIR ?? ''),
      toolDir: String(process.env.TOOL_DIR ?? ''),
    });
    if (!installed) {
      console.error('this runner is not Linux x64 with glibc, so OpenCode is installed from npm');
      process.exitCode = 1;
    } else {
      console.error(`${installed.fetched ? 'Downloaded' : 'Restored'} ${installed.name}@${process.env.VERSION}, verified against the registry integrity`);
      process.stdout.write(`${installed.binary}\n`);
    }
  } catch (error) {
    console.error(`::warning::OpenCode could not be installed from its verified registry package (${error.message}), so it is installed from npm`);
    process.exitCode = 1;
  }
}
