import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { listed, sandboxScopes } from '../lib/opencode.mjs';

export const TOOL_DENIED_ENV = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FEDERATED_TOKEN',
  'ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT',
  'GH_TOKEN',
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TOKEN',
  'KSAI_OIDC_REQUEST_TOKEN',
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_TOKEN_DIR',
  'KSAI_TOKEN_FILE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_RESOURCE_ATTRIBUTES',
]);

export const TOOL_INJECTION_ENV = Object.freeze([
  'BASH_ENV',
  'BUN_OPTIONS',
  'CLASSPATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5LIB',
  'PERL5OPT',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'ZDOTDIR',
]);

export const TOOL_WRAPPER_ENV = Object.freeze([
  'FLOW',
  'GOEXPERIMENT',
  'GOMAXPROCS',
  'GOMEMLIMIT',
  'GITHUB_WORKSPACE',
  'KSAI_GOROOT',
  'KSAI_GO_MODULE_CACHE',
  'KSAI_NPM_CACHE',
  'KSAI_REVIEW_RESULT_DIR',
  'KSAI_STAGE_ARTIFACTS',
  'KSAI_STAGE_INPUTS',
  'KSAI_STAGE_REQUEST',
  'KSAI_STAGE_RESULT',
  'KSAI_TOOL_PATH',
  'KSAI_TOOL_ROOT',
  'KSAI_WORKFLOW_PACKAGE',
  'OPENCODE_CONFIG',
  'OPENCODE_HOME',
  'OPENCODE_LSP_ROOT',
  'OPENCODE_LSP_TOOL',
  'PATH',
  'RUNNER_TEMP',
  'SANDBOX_ALLOW_WRITE',
  'SANDBOX_DENY_WRITE',
  'SCRIPTS',
]);

const SAFE_CHILD_ENV = Object.freeze([
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_WORKSPACE',
  'KSAI_STAGE_ARTIFACTS',
  'KSAI_STAGE_INPUTS',
  'KSAI_STAGE_REQUEST',
  'KSAI_STAGE_RESULT',
  'KSAI_WORKFLOW_PACKAGE',
  'LANG',
  'LC_ALL',
  'PATH',
  'TERM',
]);

const PATH_FALLBACK = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const MISE_SHIMS = /\/mise\/shims\/?$/;
const READ_ONLY_ON_TEST = Object.freeze(['.git', '.ksai']);
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

const present = (values) => [...new Set(values.map((one) => String(one ?? '').trim()).filter(Boolean))];

const safeWorkflowBinds = (env, exists, kind) => {
  const roots = [
    ['--ro-bind', env.KSAI_WORKFLOW_PACKAGE],
    ['--ro-bind', env.KSAI_STAGE_REQUEST],
    ['--ro-bind', env.KSAI_STAGE_INPUTS],
    ['--bind', env.KSAI_STAGE_ARTIFACTS],
    ['--bind', env.KSAI_STAGE_RESULT ? dirname(String(env.KSAI_STAGE_RESULT)) : ''],
  ];
  const args = [];
  for (const [flag, at] of roots) {
    const path = String(at ?? '').trim();
    if (!path || !exists(path)) continue;
    if (flag === '--bind' && !kind(path).isDirectory()) continue;
    args.push(flag, path, path);
  }
  return args;
};

export function pinnedToolRoot(env = process.env) {
  const root = String(env.KSAI_TOOL_ROOT ?? '').trim().replace(/\/+$/, '');
  return isAbsolute(root) ? root : '';
}

export function npmCachePayload(env) {
  const root = String(env.KSAI_NPM_CACHE ?? '').trim();
  return isAbsolute(root) && !root.includes(':') ? join(root, '_cacache') : '';
}

export function toolChildEnvironment(env = process.env) {
  const child = Object.create(null);
  for (const name of SAFE_CHILD_ENV) {
    const value = String(env[name] ?? '').trim();
    if (value) child[name] = value;
  }
  Object.assign(child, goToolEnvironment(env));
  const workspace = String(env.GITHUB_WORKSPACE ?? '').replace(/\/+$/, '');
  const runnerTemp = String(env.RUNNER_TEMP ?? '').replace(/\/+$/, '');
  const safePath = String(env.PATH ?? '').split(':').filter((at) =>
    at && (!workspace || !inside(at, workspace)) && (!runnerTemp || !inside(at, runnerTemp)) && !MISE_SHIMS.test(at),
  );
  const toolRoot = pinnedToolRoot(env);
  const pinned = toolRoot ? String(env.KSAI_TOOL_PATH ?? '').split(':').filter((at) => inside(at, toolRoot)) : [];
  child.PATH = [...safePath, ...pinned].join(':') || PATH_FALLBACK;
  for (const [name, from] of [['GOROOT', 'KSAI_GOROOT'], ['GOMODCACHE', 'KSAI_GO_MODULE_CACHE']]) {
    const at = String(env[from] ?? '').trim();
    if (isAbsolute(at) && !at.includes(':')) child[name] = at;
  }
  child.HOME = '/tmp/ksai-home';
  child.TMPDIR = '/tmp';
  child.GOPROXY = 'off';
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
    env.OPENCODE_LSP_ROOT,
    env.SCRIPTS,
    env.KSAI_TOKEN_DIR,
    env.KSAI_TOKEN_FILE,
    env.KSAI_CHANNEL_DIR,
    env.KSAI_REVIEW_RESULT_DIR,
    env.KSAI_PTY_METRICS_FILE,
    env.KSAI_COMPACTION_FILE,
  ]);
}

export function toolSandboxArgs(
  env = process.env,
  workdir = String(env.GITHUB_WORKSPACE ?? ''),
  exists = existsSync,
  kind = (at) => statSync(at),
  real = realpathSync,
) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  if (!workspace || !isAbsolute(workspace)) throw new Error('tool sandbox has no workspace');
  const cwd = String(workdir ?? '').trim();
  if (!cwd || !isAbsolute(cwd)) throw new Error('tool sandbox workdir is not absolute');
  const scopes = sandboxScopes(env, exists, real);
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/ksai-home',
    '--tmpfs', '/run',
  ];
  const runnerTemp = String(env.RUNNER_TEMP ?? '').trim();
  if (runnerTemp && isAbsolute(runnerTemp) && exists(runnerTemp) && !inside(runnerTemp, '/tmp')) {
    args.push('--tmpfs', runnerTemp);
  }
  const toolRoot = pinnedToolRoot(env);
  if (toolRoot && exists(toolRoot)) args.push('--ro-bind', toolRoot, toolRoot);
  args.push(env.OPENCODE_LSP_TOOL === 'native' ? '--ro-bind' : '--bind', workspace, workspace);
  for (const at of scopes.allow) args.push('--bind', at, at);
  for (const at of scopes.deny) args.push('--ro-bind', at, at);
  args.push(...safeWorkflowBinds(env, exists, kind));
  const trusted = join(workspace, '_ksai');
  if (exists(trusted)) args.push('--ro-bind', trusted, trusted);
  if (String(env.FLOW ?? '') === 'test') {
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
  args.push('--clearenv');
  for (const [name, value] of Object.entries(toolChildEnvironment(env))) args.push('--setenv', name, value);
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

export function isolatedToolCommand(command, args, workdir, linux = process.platform === 'linux', env = process.env) {
  if (!linux) return { command, args };
  const npm = npmCachePayload(env)
    ? ['/bin/sh', '-c', 'mkdir -p /tmp/ksai-npm-cache/_cacache && if [ -d /tmp/ksai-npm-seed/index-v5 ]; then cp -R /tmp/ksai-npm-seed/index-v5 /tmp/ksai-npm-cache/_cacache/ || exit; fi; exec "$@"', 'ksai-npm', command, ...args]
    : [command, ...args];
  return {
    command: 'bwrap',
    args: [...toolSandboxArgs(env, workdir), ...npm],
  };
}

const PROBE_SOURCE = `
const fs = require('node:fs');
const dns = require('node:dns/promises');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
(async () => {
const [relayUrl, workspace, deniedJson, ...hidden] = process.argv.slice(1);
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
const child = spawnSync(process.execPath, ['-e', 'if (process.env.ANTHROPIC_FEDERATED_TOKEN) process.exit(9)']);
if (child.status !== 0) throw new Error('a descendant inherited a credential');
if (spawnSync('rg', ['--version']).status !== 0) throw new Error('isolated search runtime is unavailable');
const scratch = fs.mkdtempSync(workspace + '/.ksai-tool-probe-');
fs.writeFileSync(scratch + '/write', 'ok');
fs.rmSync(scratch, { recursive: true });
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
    env.OPENCODE_LSP_ROOT,
    env.SCRIPTS,
    env.KSAI_TOKEN_DIR,
    env.KSAI_TOKEN_FILE,
  ]);
  const isolated = isolatedToolCommand(
    'node',
    ['-e', PROBE_SOURCE, String(env.KSAI_PROVIDER_RELAY || env.KSAI_PROVIDER_SOCKET || ''), String(env.GITHUB_WORKSPACE ?? ''), JSON.stringify(TOOL_DENIED_ENV), ...hidden],
    String(env.GITHUB_WORKSPACE ?? ''),
    true,
    env,
  );
  return {
    command: '/usr/bin/env',
    args: ['-i', ...Object.entries(toolLauncherEnvironment(env)).map(([name, value]) => `${name}=${value}`), isolated.command, ...isolated.args],
  };
}

export function toolLauncherEnvironment(env = process.env) {
  const allowed = new Set(TOOL_WRAPPER_ENV);
  const go = goToolEnvironment(env);
  const launcher = Object.fromEntries(Object.entries(env)
    .filter(([name]) => allowed.has(name) && (!(name in GO_TOOL_SETTINGS) || Object.hasOwn(go, name)))
    .map(([name, value]) => [name, go[name] ?? String(value ?? '')]));
  launcher.PATH = toolChildEnvironment(env).PATH;
  return launcher;
}

function stageRoots(env) {
  return present([
    env.KSAI_STAGE_REQUEST,
    env.KSAI_STAGE_INPUTS,
    env.KSAI_STAGE_ARTIFACTS,
    env.KSAI_STAGE_RESULT ? dirname(String(env.KSAI_STAGE_RESULT)) : '',
  ]);
}

export function toolPathRoots(env = process.env, directory = String(env.GITHUB_WORKSPACE ?? '')) {
  const workspace = String(directory ?? '').trim();
  const scopes = sandboxScopes(env, existsSync, realpathSync).allow;
  return present([workspace, '/tmp', ...scopes, env.KSAI_WORKFLOW_PACKAGE, ...stageRoots(env)]).map((one) => resolve(one));
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
  const within = (at, root) => inside(at.lexical, root.lexical) && inside(at.canonical, root.canonical);
  const staged = stageRoots(env).map((one) => normalizedToolPath(one, directory, exists, real))
    .filter((root) => !protectedRoots.some((held) => inside(held.lexical, root.lexical) || inside(held.canonical, root.canonical)));
  if (staged.some((root) => within(target, root))) return target.canonical;
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

export function callerDeniedEnvironment(env = process.env) {
  return listed(env.SANDBOX_DENY_ENV);
}
