import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import { sandboxScopes } from './opencode.mjs';
import { shellTimeoutMs } from './opencode-v2.mjs';
import { HARNESS_TOOL_WRAPPER_ENV, PHASE, RELAY_DIR_ENV, SESSION_ENV } from '../ksai/harness/contract.mjs';
import { CACHE_ROOT, carriedSandbox, SANDBOX_ENV, sandboxBinds, sandboxPath } from '../lib/step-sandbox.mjs';
import { callerDeniedEnvironment, expandSessionEnvironment, TOOL_DENIED_ENV, TOOL_INJECTION_ENV } from '../lib/tool-environment.mjs';

export { callerDeniedEnvironment, TOOL_DENIED_ENV, TOOL_INJECTION_ENV };

export const TOOL_WRAPPER_ENV = Object.freeze([
  'FLOW',
  'GOEXPERIMENT',
  'GOMAXPROCS',
  'GOMEMLIMIT',
  'GITHUB_WORKSPACE',
  'KSAI_GOROOT',
  'KSAI_GO_MODULE_CACHE',
  'KSAI_NPM_CACHE',
  'KSAI_STEP_SANDBOX',
  'KSAI_TOOL_PATH',
  'KSAI_TOOL_ROOT',
  'OPENCODE_CONFIG',
  'OPENCODE_HOME',
  'PATH',
  'RUNNER_TEMP',
  'SANDBOX_ALLOW_WRITE',
  'SANDBOX_DENY_WRITE',
  'SCRIPTS',
  ...HARNESS_TOOL_WRAPPER_ENV,
]);

const SAFE_CHILD_ENV = Object.freeze([
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_WORKSPACE',
  'LANG',
  'LC_ALL',
  'PATH',
  'TERM',
]);

const PATH_FALLBACK = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const HARNESS_PORTS = '/run/ksai-harness-ports';
const MISE_SHIMS = /\/mise\/shims\/?$/;
const READ_ONLY_ON_TEST = Object.freeze(['.git', '.ksai']);
const HISTORY_KEPT_ON = Object.freeze(['test', 'run']);
const GO_TOOL_SETTINGS = Object.freeze({
  GOEXPERIMENT: /^[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*$/,
  GOMAXPROCS: /^[1-9][0-9]*$/,
  GOMEMLIMIT: /^(?:off|[0-9]+(?:B|KiB|MiB|GiB|TiB)?)$/,
});

function goToolEnvironment(env) {
  const denied = new Set(callerDeniedEnvironment(env));
  return Object.fromEntries(Object.entries(GO_TOOL_SETTINGS).flatMap(([name, pattern]) => {
    const value = String(env[name] ?? '').trim();
    return !denied.has(name) && pattern.test(value) ? [[name, value]] : [];
  }));
}

const inside = (at, root) => at === root || at.startsWith(`${root.replace(/\/+$/, '')}/`);

function canonicalPath(at, real = realpathSync) {
  try { return real(at); } catch { return resolve(at); }
}

export const harnessSandbox = (env) => env.OPENCODE_PHASE === PHASE;

export function toolWrapperKeys(env) {
  return harnessSandbox(env) ? [...TOOL_WRAPPER_ENV, SESSION_ENV, 'SANDBOX_DENY_ENV'] : TOOL_WRAPPER_ENV;
}

export function writableSandboxPath(env, at, real = realpathSync) {
  if (!harnessSandbox(env)) return true;
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  return !inside(resolve(at), resolve(workspace)) && !inside(canonicalPath(at, real), canonicalPath(workspace, real));
}

export function harnessRelayDir(env) {
  const dir = String(env[RELAY_DIR_ENV] ?? '');
  if (!harnessSandbox(env) || !dir) return '';
  if (!/^\/tmp\/ksai-relay-\d+-\d+-[a-f0-9]{16}\/harness-ports$/.test(dir)) {
    throw new Error('invalid harness relay socket directory');
  }
  return dir;
}

function harnessPorts(env) {
  const dir = harnessRelayDir(env);
  if (!dir) return [];
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const port = Number(/^(\d{4,5})\.sock$/.exec(entry.name)?.[1]);
    if (!entry.isSocket() || !Number.isInteger(port) || port < 1024 || port > 65535 || entry.name !== `${port}.sock`) {
      throw new Error('invalid harness relay socket');
    }
    return { port, source: join(dir, entry.name), target: join(HARNESS_PORTS, entry.name) };
  });
}

const present = (values) => [...new Set(values.map((one) => String(one ?? '').trim()).filter(Boolean))];

export function pinnedToolRoot(env = process.env) {
  const root = String(env.KSAI_TOOL_ROOT ?? '').trim().replace(/\/+$/, '');
  return isAbsolute(root) ? root : '';
}

export function toolProcCapability(uid = process.getuid?.()) {
  return uid === 0 ? ['--cap-add', 'CAP_SYS_ADMIN'] : [];
}

export const BUILD_DIR = 'ksai-build';
export const BUILD_ROOT = '/tmp/ksai-build';
const BUILD_PARTS = Object.freeze({ GOCACHE: 'go-build', GOTMPDIR: 'tmp' });

export function buildScratch(env = process.env) {
  const temp = String(env.RUNNER_TEMP ?? '').trim();
  return isAbsolute(temp) && !temp.includes(':') ? join(temp, BUILD_DIR) : '';
}

export function prepareBuildScratch(env = process.env, make = mkdirSync) {
  const at = buildScratch(env);
  if (!at) return '';
  try {
    for (const path of [at, ...Object.values(BUILD_PARTS).map((part) => join(at, part))]) {
      const held = lstatSync(path, { throwIfNoEntry: false });
      if (held && !held.isDirectory()) rmSync(path, { recursive: true, force: true });
      make(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    return at;
  } catch {
    return '';
  }
}

export function npmCachePayload(env) {
  if (harnessSandbox(env)) return '';
  const root = String(env.KSAI_NPM_CACHE ?? '').trim();
  return isAbsolute(root) && !root.includes(':') ? join(root, '_cacache') : '';
}

function runnerToolPath(env) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '').replace(/\/+$/, '');
  const runnerTemp = String(env.RUNNER_TEMP ?? '').replace(/\/+$/, '');
  const harness = harnessSandbox(env);
  return String(env.PATH ?? '').split(':').filter((at) =>
    at && (!workspace || !inside(at, workspace)) && (!runnerTemp || !inside(at, runnerTemp)) && (harness || !MISE_SHIMS.test(at)),
  );
}

function trustedExecutable(program, env, preferred = []) {
  const toolRoot = pinnedToolRoot(env);
  const root = toolRoot && canonicalPath(toolRoot);
  const tools = new Set(preferred);
  for (const entry of new Set([...tools, ...runnerToolPath(env), ...PATH_FALLBACK.split(':')])) {
    if (!isAbsolute(entry)) continue;
    const path = join(entry, program);
    try {
      const actual = realpathSync(path);
      if (tools.has(entry) !== Boolean(root && inside(actual, root))) continue;
      if (!statSync(actual).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { continue; }
  }
  throw new Error(`the runner executable ${program} is unavailable`);
}

function harnessToolPaths(env, toolRoot = pinnedToolRoot(env)) {
  if (!toolRoot) return [];
  const canonicalRoot = canonicalPath(toolRoot);
  const prepared = String(env.KSAI_MODEL_PATH ?? '').split(':');
  const pinned = String(env.KSAI_TOOL_PATH ?? '').split(':');
  return [...new Set([...prepared, ...pinned])]
    .filter((at) => isAbsolute(at) && normalize(at) === at && inside(at, toolRoot) && inside(canonicalPath(at), canonicalRoot));
}

function harnessSessionEnvironment(env, toolRoot = pinnedToolRoot(env), tools = harnessToolPaths(env, toolRoot)) {
  return expandSessionEnvironment(JSON.parse(env[SESSION_ENV] ?? '{}'), {
    tool_root: toolRoot,
    tool_path: tools.join(':'),
    workspace: String(env.GITHUB_WORKSPACE ?? '').replace(/\/+$/, ''),
  }, env);
}

function harnessChildEnvironment(env, includeSession) {
  const toolRoot = pinnedToolRoot(env);
  const tools = harnessToolPaths(env, toolRoot);
  const language = String(env.LANG ?? '').trim() || 'C.UTF-8';
  return {
    PATH: [...new Set([...tools, ...runnerToolPath(env)])].join(':') || PATH_FALLBACK,
    HOME: '/tmp/ksai-home',
    TMPDIR: '/tmp',
    CI: String(env.CI ?? '').trim() || 'true',
    LANG: language,
    LC_ALL: String(env.LC_ALL ?? '').trim() || language,
    TERM: String(env.TERM ?? '').trim() || 'dumb',
    ...(includeSession ? harnessSessionEnvironment(env, toolRoot, tools) : {}),
  };
}

export function toolChildEnvironment(env = process.env) {
  if (harnessSandbox(env)) return harnessChildEnvironment(env, true);
  const child = Object.create(null);
  for (const name of SAFE_CHILD_ENV) {
    const value = String(env[name] ?? '').trim();
    if (value) child[name] = value;
  }
  Object.assign(child, goToolEnvironment(env));
  const workspace = String(env.GITHUB_WORKSPACE ?? '').replace(/\/+$/, '');
  const safePath = runnerToolPath(env);
  const toolRoot = pinnedToolRoot(env);
  const pinned = toolRoot ? String(env.KSAI_TOOL_PATH ?? '').split(':').filter((at) => inside(at, toolRoot)) : [];
  child.PATH = [...safePath, ...pinned].join(':') || PATH_FALLBACK;
  for (const [name, from] of [['GOROOT', 'KSAI_GOROOT'], ['GOMODCACHE', 'KSAI_GO_MODULE_CACHE']]) {
    const at = String(env[from] ?? '').trim();
    if (isAbsolute(at) && !at.includes(':')) child[name] = at;
  }
  const carried = carriedSandbox(env[SANDBOX_ENV]);
  const denied = new Set(callerDeniedEnvironment(env));
  for (const [name, value] of Object.entries(carried.env)) if (!denied.has(name)) child[name] = value;
  child.PATH = [...sandboxPath(carried), child.PATH].join(':');
  child.HOME = '/tmp/ksai-home';
  child.TMPDIR = '/tmp';
  child.GOPROXY = 'off';
  child.GOSUMDB = 'off';
  child.GOTOOLCHAIN = 'local';
  child.MISE_OFFLINE = '1';
  child.MISE_TASK_RUN_AUTO_INSTALL = '0';
  if (npmCachePayload(env)) {
    child.NPM_CONFIG_CACHE = '/tmp/ksai-npm-cache';
    child.NPM_CONFIG_OFFLINE = 'true';
    child.NPM_CONFIG_LOGS_DIR = '/tmp/ksai-npm-logs';
  }
  if (toolRoot) {
    child.MISE_DATA_DIR = toolRoot;
    child.MISE_CACHE_DIR = '/tmp/ksai-mise-cache';
    child.MISE_TRUSTED_CONFIG_PATHS = workspace;
    child.MISE_YES = '1';
  }
  child.CI ||= 'true';
  child.LANG ||= 'C.UTF-8';
  child.LC_ALL ||= child.LANG;
  child.TERM ||= 'dumb';
  return child;
}

export function toolProtectedPaths(env = process.env) {
  return present([
    env.RUNNER_TEMP,
    env.OPENCODE_CONFIG,
    env.OPENCODE_HOME,
    env.SCRIPTS,
    env.KSAI_CHANNEL_DIR,
  ]);
}

export function toolSandboxArgs(
  env = process.env,
  workdir = String(env.GITHUB_WORKSPACE ?? ''),
  exists = existsSync,
  kind = (at) => statSync(at),
  real = realpathSync,
  ports = harnessPorts(env),
  includeSession = false,
) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  if (!workspace || !isAbsolute(workspace)) throw new Error('tool sandbox has no workspace');
  const cwd = String(workdir ?? '').trim();
  if (!cwd || !isAbsolute(cwd)) throw new Error('tool sandbox workdir is not absolute');
  const scopes = sandboxScopes(env, exists, real);
  const readOnly = harnessSandbox(env);
  const carried = carriedSandbox(env[SANDBOX_ENV]);
  const allowed = (at) => writableSandboxPath(env, at, real);
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/ksai-home',
    '--tmpfs', '/run',
    ...sandboxBinds({ ...carried, writable: (carried.writable ?? []).filter((name) => allowed(join(CACHE_ROOT, name))) }),
  ];
  const runnerTemp = String(env.RUNNER_TEMP ?? '').trim();
  if (runnerTemp && isAbsolute(runnerTemp) && exists(runnerTemp) && !inside(runnerTemp, '/tmp')) {
    args.push('--tmpfs', runnerTemp);
  }
  if (ports.length) {
    args.push('--dir', HARNESS_PORTS);
    for (const { source, target } of ports) args.push('--ro-bind', source, target);
  }
  const toolRoot = pinnedToolRoot(env);
  if (toolRoot && exists(toolRoot)) args.push('--ro-bind', toolRoot, toolRoot);
  if (!readOnly) args.push('--bind', workspace, workspace);
  for (const at of scopes.allow.filter(allowed)) args.push('--bind', at, at);
  for (const at of scopes.deny) args.push('--ro-bind', at, at);
  const trusted = join(workspace, '_ksai');
  if (exists(trusted)) args.push('--ro-bind', trusted, trusted);
  if (HISTORY_KEPT_ON.includes(String(env.FLOW ?? ''))) {
    for (const name of READ_ONLY_ON_TEST) {
      const at = join(workspace, name);
      if (exists(at)) args.push('--ro-bind', at, at);
    }
  }
  for (const at of toolProtectedPaths(env)) {
    if (!isAbsolute(at) || !exists(at) || (runnerTemp && inside(at, runnerTemp))) continue;
    const directory = kind(at).isDirectory();
    args.push(directory ? '--tmpfs' : '--ro-bind', ...(directory ? [at] : ['/dev/null', at]));
  }
  const npmCache = npmCachePayload(env);
  if (npmCache && exists(npmCache)) {
    args.push('--dir', '/tmp/ksai-npm-cache', '--dir', '/tmp/ksai-npm-cache/_cacache',
      '--ro-bind', npmCache, '/tmp/ksai-npm-seed');
    const content = join(npmCache, 'content-v2');
    if (exists(content)) args.push('--ro-bind', content, '/tmp/ksai-npm-cache/_cacache/content-v2');
  }
  const build = buildScratch(env);
  const built = !readOnly && Boolean(build) && allowed(BUILD_ROOT) && Object.values(BUILD_PARTS).every((part) => exists(join(build, part)));
  if (built) args.push('--bind', build, BUILD_ROOT);
  if (readOnly) args.push('--ro-bind', workspace, workspace);
  args.push('--clearenv');
  const child = readOnly ? harnessChildEnvironment(env, includeSession) : toolChildEnvironment(env);
  for (const [name, value] of Object.entries(child)) args.push('--setenv', name, value);
  const writable = (carried.writable ?? []).map((name) => `${CACHE_ROOT}/${name}`);
  const moved = (name) => Object.hasOwn(carried.env, name) && child[name] === carried.env[name]
    && writable.some((root) => child[name] === root || child[name].startsWith(`${root}/`));
  for (const [name, part] of built ? Object.entries(BUILD_PARTS) : []) {
    if (!moved(name)) args.push('--setenv', name, `${BUILD_ROOT}/${part}`);
  }
  args.push(
    '--cap-drop', 'ALL',
    '--unshare-user',
    '--disable-userns',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
    '--die-with-parent',
    '--chdir', cwd,
    '--',
  );
  return args;
}

export function toolShell(exists = existsSync) {
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export const HARNESS_FORWARDER_SOURCE = `
const net = require('node:net');
const { spawn } = require('node:child_process');
const [due, ports, session, command, ...args] = process.argv.slice(1);
const deadline = Number(due);
let port;

(async () => {
  for (const next of JSON.parse(ports)) {
    port = next;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('tool deadline expired');
    const server = net.createServer({ allowHalfOpen: true }, (inbound) => {
      const outbound = net.connect({ path: '/run/ksai-harness-ports/' + next + '.sock', allowHalfOpen: true });
      inbound.on('error', () => outbound.destroy());
      outbound.on('error', () => inbound.destroy());
      inbound.once('close', () => outbound.destroy());
      outbound.once('close', () => inbound.destroy());
      inbound.pipe(outbound).pipe(inbound);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tool deadline expired')), remaining);
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        clearTimeout(timer);
        server.removeListener('error', reject);
        server.on('error', () => process.exit(1));
        resolve();
      });
    });
  }
  if (Date.now() >= deadline) throw new Error('tool deadline expired');
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...JSON.parse(session) } });
  child.once('error', () => process.exit(125));
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 125);
  });
})().catch((error) => {
  console.error('harness TCP port ' + port + ': ' + error.message);
  process.exit(125);
});
`;

export function isolatedToolCommand(command, args, workdir, linux = process.platform === 'linux', env = process.env) {
  if (!linux) return { command, args };
  const harness = harnessSandbox(env);
  const ports = harnessPorts(env);
  const target = harness && !isAbsolute(command) ? trustedExecutable(command, env, harnessToolPaths(env)) : command;
  const seed = 'mkdir -p /tmp/ksai-npm-cache/_cacache && if [ -d /tmp/ksai-npm-seed/index-v5 ]; then cp -R /tmp/ksai-npm-seed/index-v5 /tmp/ksai-npm-cache/_cacache/ || exit; fi; exec "$@"';
  const npm = npmCachePayload(env)
    ? ['/bin/sh', '-c', seed, 'ksai-npm', target, ...args]
    : [target, ...args];
  const forward = ports.length ? [process.execPath, '-e', HARNESS_FORWARDER_SOURCE, '--',
    String(Date.now() + shellTimeoutMs(env)), JSON.stringify(ports.map(({ port }) => port)), JSON.stringify(harnessSessionEnvironment(env))] : [];
  return {
    command: harness ? trustedExecutable('bwrap', env) : 'bwrap',
    args: [...toolSandboxArgs(env, workdir, existsSync, statSync, realpathSync, ports, !forward.length), ...forward, ...npm],
  };
}

const PROBE_SOURCE = `
const fs = require('node:fs');
const dns = require('node:dns/promises');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
(async () => {
const [relayUrl, workspace, search, readOnly, deniedJson, ...hidden] = process.argv.slice(1);
const denied = JSON.parse(deniedJson);
if (!fs.readlinkSync('/proc/self/exe')) throw new Error('the isolated executable path is unavailable');
if (fs.existsSync('/run/ksai-tool-proc')) throw new Error('the parent proc mount is visible');
for (const pid of fs.readdirSync('/proc').filter((name) => /^[0-9]+$/.test(name))) {
  try {
    const exposed = fs.readFileSync('/proc/' + pid + '/environ', 'utf8');
    if (denied.some((name) => exposed.includes(name + '='))) throw new Error('parent credentials are visible');
  } catch (error) {
    if (String(error.message).includes('credentials are visible')) throw error;
  }
}
for (const name of denied) if (process.env[name]) throw new Error('credential environment was inherited');
for (const path of hidden) {
  try {
    const stat = fs.statSync(path);
    if (stat.isDirectory() ? fs.readdirSync(path).length > 0 : fs.readFileSync(path).length > 0) {
      throw new Error('trusted runtime state is readable');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT' && !String(error.message).includes('trusted runtime state')) throw error;
    if (String(error.message).includes('trusted runtime state')) throw error;
  }
}
const child = spawnSync(process.execPath, ['-e', 'if (process.env.KSAI_MODEL_TOKEN) process.exit(9)']);
if (child.status !== 0) throw new Error('a descendant inherited a credential');
if (spawnSync(search, ['--version']).status !== 0) throw new Error('isolated search runtime is unavailable');
const scratch = (root) => {
  const directory = fs.mkdtempSync(root + '/.ksai-tool-probe-');
  try { fs.writeFileSync(directory + '/write', 'ok'); }
  finally { fs.rmSync(directory, { recursive: true }); }
};
scratch(readOnly ? '/tmp' : workspace);
if (readOnly) {
  let workspaceWritable = false;
  try { scratch(workspace); workspaceWritable = true; }
  catch (error) { if (error.code !== 'EROFS') throw error; }
  if (workspaceWritable) throw new Error('the tool workspace is writable');
}
const relay = relayUrl.startsWith('/') ? { path: relayUrl } : { host: '127.0.0.1', port: Number(new URL(relayUrl).port) };
await new Promise((resolve, reject) => {
  const socket = net.connect(relay);
  socket.once('connect', () => reject(new Error('tool namespace reached the provider relay')));
  socket.once('error', () => resolve());
});
try {
  await dns.lookup('example.com');
  throw new Error('tool namespace resolved public DNS');
} catch (error) {
  if (String(error.message).includes('resolved public DNS')) throw error;
}
})().catch((error) => { console.error(error); process.exit(1); });
`;

export function toolIsolationProbe(env) {
  const hidden = present([
    env.OPENCODE_CONFIG,
    env.OPENCODE_HOME,
    env.SCRIPTS,
  ]);
  const harness = harnessSandbox(env);
  const probeEnv = { ...env };
  delete probeEnv[SESSION_ENV];
  const isolated = isolatedToolCommand(
    process.execPath,
    ['-e', PROBE_SOURCE, '--', String(env.KSAI_PROVIDER_RELAY || env.KSAI_PROVIDER_SOCKET || ''), String(env.GITHUB_WORKSPACE ?? ''),
      harness ? trustedExecutable('rg', env) : 'rg', harness ? '1' : '', JSON.stringify(TOOL_DENIED_ENV), ...hidden],
    String(env.GITHUB_WORKSPACE ?? ''),
    true,
    probeEnv,
  );
  return {
    command: '/usr/bin/env',
    args: ['-i', ...Object.entries(toolLauncherEnvironment(probeEnv)).map(([name, value]) => `${name}=${value}`), isolated.command, ...isolated.args],
  };
}

export function toolLauncherEnvironment(env = process.env) {
  const allowed = new Set(toolWrapperKeys(env));
  const go = goToolEnvironment(env);
  const launcher = Object.fromEntries(Object.entries(env)
    .filter(([name]) => allowed.has(name) && (!(name in GO_TOOL_SETTINGS) || Object.hasOwn(go, name)))
    .map(([name, value]) => [name, go[name] ?? String(value ?? '')]));
  launcher.PATH = runnerToolPath(env).join(':') || PATH_FALLBACK;
  return launcher;
}

export function toolPathRoots(env = process.env, directory = String(env.GITHUB_WORKSPACE ?? '')) {
  const workspace = String(directory ?? '').trim();
  const scopes = sandboxScopes(env, existsSync, realpathSync).allow;
  return present([workspace, '/tmp', ...scopes]).map((one) => resolve(one));
}

export function normalizedToolPath(value, directory, exists = existsSync, real = realpathSync) {
  const candidate = resolve(isAbsolute(value) ? value : join(directory, value));
  let parent = candidate;
  const suffix = [];
  while (!exists(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(parent.slice(next.length + (next.endsWith('/') ? 0 : 1)));
    parent = next;
  }
  return { lexical: candidate, canonical: resolve(real(parent), ...suffix) };
}

export function assertToolPath(value, directory, env = process.env, exists = existsSync, real = realpathSync) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('tool path is empty');
  const target = normalizedToolPath(value, directory, exists, real);
  const roots = toolPathRoots(env, directory).map((one) => normalizedToolPath(one, directory, exists, real));
  const protectedRoots = toolProtectedPaths(env).map((one) => normalizedToolPath(one, directory, exists, real));
  if (protectedRoots.some((root) => inside(target.lexical, root.lexical) || inside(target.canonical, root.canonical))) {
    throw new Error('tool path reaches trusted runtime state');
  }
  if (!roots.some((root) => inside(target.lexical, root.lexical) && inside(target.canonical, root.canonical))) {
    throw new Error('tool path leaves the isolated filesystem');
  }
  return target.canonical;
}

export function patchPaths(text) {
  const paths = [];
  const source = String(text ?? '').replaceAll('\r\n', '\n');
  for (const match of source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1]);
  for (const match of source.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1]);
  return paths;
}
