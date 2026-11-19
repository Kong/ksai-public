import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_ROOT = '/tmp/ksai-cache';
export const TOOLCHAIN_ROOT = '/tmp/ksai-toolchain';
export const SANDBOX_ENV = 'KSAI_STEP_SANDBOX';
export const MANIFEST = 'ksai-step-sandbox.json';
export const MANIFEST_ENV = 'KSAI_STEP_SANDBOX_MANIFEST';

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const BIN = /^(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;
const VALUE = /^\/tmp\/ksai-(cache|toolchain)\/([a-z][a-z0-9-]{0,31})((?:\/[A-Za-z0-9._-]+){0,8})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REFUSED_ENV = new RegExp(`^(?:${[
  'PATH', 'HOME', 'TMPDIR', 'SHELL', 'IFS', 'ENV', 'BASH_.*', 'LANG', 'LC_.*', 'TERM', 'CI', 'ZDOTDIR', 'CLASSPATH',
  'GOENV', 'GOFLAGS', 'GOPROXY', 'GOSUMDB', 'GONOSUMDB', 'GONOSUMCHECK', 'GOINSECURE', 'GOTOOLCHAIN', 'GOPRIVATE', 'GONOPROXY',
  'LD_.*', 'DYLD_.*', 'NODE_.*', 'BUN_.*', 'PYTHON.*', 'PERL5.*', 'RUBY.*', 'PHP.*', 'JAVA_.*', 'JDK_.*',
  'KSAI_.*', 'GIT_.*', 'GITHUB_.*', 'ACTIONS_.*', 'RUNNER_.*', 'XDG_.*', 'MISE_.*', 'NPM_CONFIG_.*', 'OPENCODE_.*', 'OTEL_.*', '.*_PROXY',
].join('|')})$`, 'i');
export const MAX_SANDBOX_ENV = 16;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => record(value) && Object.keys(value).every((name) => names.includes(name));

export const sandboxName = (name) => typeof name === 'string' && ENV_NAME.test(name) && !REFUSED_ENV.test(name);
export const cacheName = (name) => typeof name === 'string' && NAME.test(name);
export const toolchainBin = (bin) => typeof bin === 'string' && BIN.test(bin);

export function sandboxValue(value, caches, toolchains) {
  if (typeof value !== 'string' || value.includes(':')) return false;
  const match = VALUE.exec(value);
  if (!match || match[3].split('/').some((one) => one === '.' || one === '..')) return false;
  return (match[1] === 'cache' ? caches : toolchains).includes(match[2]);
}

function envOf(env, caches, toolchains) {
  return record(env) && Object.keys(env).length <= MAX_SANDBOX_ENV
    && Object.entries(env).every(([name, value]) => sandboxName(name) && sandboxValue(value, caches, toolchains));
}

const EMPTY = Object.freeze({ caches: [], toolchains: [], env: {} });

export function publishedSandbox(temp, { read = readFileSync, exists = existsSync, denied = [] } = {}) {
  let text;
  try {
    text = read(join(temp, MANIFEST), 'utf8');
  } catch (error) {
    return { binds: [], carried: EMPTY, refused: error?.code === 'ENOENT' ? '' : 'the step sandbox manifest cannot be read' };
  }
  let held;
  try {
    held = JSON.parse(text);
  } catch {
    return { binds: [], carried: EMPTY, refused: 'the step sandbox manifest is not JSON' };
  }
  if (!exact(held, ['caches', 'toolchains', 'env']) || !record(held.caches) || !record(held.toolchains)) {
    return { binds: [], carried: EMPTY, refused: 'the step sandbox manifest has an unknown shape' };
  }
  const binds = [];
  for (const [name, dir] of Object.entries(held.caches)) {
    if (!cacheName(name) || dir !== join(temp, 'ksai-caches', name) || !exists(dir)) {
      return { binds: [], carried: EMPTY, refused: `the step sandbox manifest names cache \`${name}\` outside the runner temp` };
    }
    binds.push([dir, `${CACHE_ROOT}/${name}`]);
  }
  const toolchains = [];
  for (const [name, one] of Object.entries(held.toolchains)) {
    const root = exact(one, ['root', 'bin']) ? one.root : '';
    const inRoot = typeof root === 'string' && root.startsWith(`${join(temp, 'ksai-toolchains')}/`)
      && SHA256.test(root.slice(join(temp, 'ksai-toolchains').length + 1));
    if (!cacheName(name) || !inRoot || !toolchainBin(one.bin) || !exists(root)) {
      return { binds: [], carried: EMPTY, refused: `the step sandbox manifest names toolchain \`${name}\` outside the runner temp` };
    }
    binds.push([root, `${TOOLCHAIN_ROOT}/${name}`]);
    toolchains.push({ name, bin: one.bin });
  }
  const caches = Object.keys(held.caches);
  if (!envOf(held.env, caches, toolchains.map((one) => one.name))) {
    return { binds: [], carried: EMPTY, refused: 'the step sandbox manifest sets a variable that is not allowed' };
  }
  const env = Object.fromEntries(Object.entries(held.env).filter(([name]) => !denied.includes(name)));
  return { binds, carried: { caches, toolchains, env }, refused: '' };
}

export function carriedSandbox(text) {
  if (!text) return EMPTY;
  let held;
  try {
    held = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!exact(held, ['caches', 'toolchains', 'env']) || !Array.isArray(held.caches) || !Array.isArray(held.toolchains)) return EMPTY;
  if (!held.caches.every(cacheName) || !held.toolchains.every((one) => exact(one, ['name', 'bin']) && cacheName(one.name) && toolchainBin(one.bin))) {
    return EMPTY;
  }
  if (!envOf(held.env, held.caches, held.toolchains.map((one) => one.name))) return EMPTY;
  return held;
}

export const sandboxBinds = (carried) => [
  ...carried.caches.flatMap((name) => ['--ro-bind-try', `${CACHE_ROOT}/${name}`, `${CACHE_ROOT}/${name}`]),
  ...carried.toolchains.flatMap(({ name }) => ['--ro-bind-try', `${TOOLCHAIN_ROOT}/${name}`, `${TOOLCHAIN_ROOT}/${name}`]),
];

export const sandboxPath = (carried) => carried.toolchains.map(({ name, bin }) => `${TOOLCHAIN_ROOT}/${name}/${bin}`);
