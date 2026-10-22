import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RIPGREP = Object.freeze({
  version: '15.2.0',
  builds: Object.freeze({
    x64: Object.freeze({
      triple: 'x86_64-unknown-linux-musl',
      sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
      bytes: 2265718,
    }),
    arm64: Object.freeze({
      triple: 'aarch64-unknown-linux-musl',
      sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915',
      bytes: 1982561,
    }),
  }),
});

export const SANDBOX_SEARCH = '/usr/local/bin/rg';

const INSTALLED_SEARCH = Object.freeze(['/usr/bin/rg', SANDBOX_SEARCH]);
const APT_SOURCES = Object.freeze(['/etc/apt/sources.list.d/ubuntu.sources', '/etc/apt/sources.list.d/debian.sources']);
const SUDO = Object.freeze(['/usr/bin/sudo', '-n', '--']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const nonEmpty = (path, read) => {
  try {
    return read(path).length > 0;
  } catch {
    return false;
  }
};

export function ripgrepArchive(arch) {
  const build = Object.hasOwn(RIPGREP.builds, arch) ? RIPGREP.builds[arch] : null;
  if (!build) return null;
  const name = `ripgrep-${RIPGREP.version}-${build.triple}`;
  return Object.freeze({
    ...build,
    name,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP.version}/${name}.tar.gz`,
  });
}

async function answers(run, argv) {
  try {
    await run(argv);
    return true;
  } catch {
    return false;
  }
}

export async function installRipgrep({ run, workDir, arch = process.arch, fetchImpl = fetch, signal = new AbortController().signal, archive = ripgrepArchive(arch) }) {
  for (const path of INSTALLED_SEARCH) {
    if (await answers(run, [path, '--version'])) return Object.freeze({ path, fetched: false });
  }
  if (!archive) throw new Error(`no pinned ripgrep build runs on ${arch}`);
  const response = await fetchImpl(archive.url, { signal });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${archive.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== archive.bytes || sha256(bytes) !== archive.sha256) {
    throw new Error(`the downloaded ${archive.name} differs from its pinned digest`);
  }
  const tarball = join(workDir, `${archive.name}.tar.gz`);
  await writeFile(tarball, bytes, { mode: 0o600 });
  await run(['/usr/bin/tar', '-xzf', tarball, '-C', workDir, '--no-same-owner', '--no-same-permissions', `${archive.name}/rg`]);
  await run([...SUDO, '/usr/bin/install', '-m', '0755', join(workDir, archive.name, 'rg'), SANDBOX_SEARCH]);
  const version = await run([SANDBOX_SEARCH, '--version']);
  if (!String(version).startsWith(`ripgrep ${RIPGREP.version}`)) throw new Error(`${SANDBOX_SEARCH} is not ripgrep ${RIPGREP.version}`);
  return Object.freeze({ path: SANDBOX_SEARCH, fetched: true });
}

export async function installBubblewrap({ run, read = readFileSync }) {
  if (await answers(run, ['/usr/bin/bwrap', '--version'])) return false;
  const source = APT_SOURCES.find((path) => nonEmpty(path, read)) ?? '/etc/apt/sources.list';
  if (!nonEmpty(source, read)) throw new Error('no operating-system APT source is available for bubblewrap');
  const apt = [
    '/usr/bin/apt-get',
    '-o', `Dir::Etc::sourcelist=${source}`,
    '-o', 'Dir::Etc::sourceparts=-',
    '-o', 'APT::Get::List-Cleanup=0',
    '-o', 'Acquire::Retries=3',
    '-o', 'Acquire::http::Timeout=30',
    '-o', 'Acquire::https::Timeout=30',
  ];
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run([...SUDO, ...apt, 'update'], 120_000);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await run([...SUDO, ...apt, 'install', '-y', 'bubblewrap'], 300_000);
  await run(['/usr/bin/bwrap', '--version']);
  return true;
}

export async function enableUserNamespaces({ run }) {
  const sysctl = (setting) => answers(run, [...SUDO, '/usr/sbin/sysctl', '-w', setting]);
  const probe = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--proc', '/proc', '--unshare-user', '--unshare-pid', '--unshare-net', '/usr/bin/true'];
  await sysctl('kernel.apparmor_restrict_unprivileged_userns=0');
  if (await answers(run, probe)) return;
  await sysctl('user.max_user_namespaces=15000');
  await sysctl('kernel.unprivileged_userns_clone=1');
  await run(probe);
}

export async function prepareSandboxTools({
  run, workDir, arch = process.arch, fetchImpl = fetch, signal = new AbortController().signal, read = readFileSync, archive = ripgrepArchive(arch),
}) {
  const [search] = await Promise.all([
    installRipgrep({ run, workDir, arch, fetchImpl, signal, archive }),
    installBubblewrap({ run, read }),
  ]);
  await enableUserNamespaces({ run });
  return search;
}
