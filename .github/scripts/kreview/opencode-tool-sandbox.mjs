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
  'GITHUB_WORKSPACE',
  'KSAI_GOROOT',
  'KSAI_GO_MODULE_CACHE',
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
const READ_ONLY_ON_TEST = Object.freeze(['.git', '.ksai']);

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

export function toolChildEnvironment(env = process.env) {
  const child = Object.create(null);
  for (const name of SAFE_CHILD_ENV) {
    const value = String(env[name] ?? '').trim();
    if (value) child[name] = value;
  }
  const workspace = String(env.GITHUB_WORKSPACE ?? '').replace(/\/+$/, '');
  const runnerTemp = String(env.RUNNER_TEMP ?? '').replace(/\/+$/, '');
  const safePath = String(env.PATH ?? '').split(':').filter((at) =>
    at && (!workspace || !inside(at, workspace)) && (!runnerTemp || !inside(at, runnerTemp)),
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
    '--tmpfs', '/proc',
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

export function isolatedToolCommand(command, args, workdir, linux = process.platform === 'linux', env = process.env) {
  if (!linux) return { command, args };
  return {
    command: 'bwrap',
    args: [...toolSandboxArgs(env, workdir), command, ...args],
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
if (fs.readdirSync('/proc').length !== 0) throw new Error('the parent process namespace is visible');
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
const port = Number(new URL(relayUrl).port);
await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
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
  return isolatedToolCommand(
    'node',
    ['-e', PROBE_SOURCE, String(env.KSAI_PROVIDER_RELAY ?? ''), String(env.GITHUB_WORKSPACE ?? ''), JSON.stringify(TOOL_DENIED_ENV), ...hidden],
    String(env.GITHUB_WORKSPACE ?? ''),
    true,
    env,
  );
}

export function toolLauncherEnvironment(env = process.env) {
  const allowed = new Set(TOOL_WRAPPER_ENV);
  const launcher = Object.fromEntries(Object.entries(env)
    .filter(([name]) => allowed.has(name))
    .map(([name, value]) => [name, String(value ?? '')]));
  launcher.PATH = toolChildEnvironment(env).PATH;
  return launcher;
}

export function toolPathRoots(env = process.env, directory = String(env.GITHUB_WORKSPACE ?? '')) {
  const workspace = String(directory ?? '').trim();
  const scopes = sandboxScopes(env, existsSync, realpathSync).allow;
  const workflow = [
    env.KSAI_WORKFLOW_PACKAGE,
    env.KSAI_STAGE_REQUEST,
    env.KSAI_STAGE_INPUTS,
    env.KSAI_STAGE_ARTIFACTS,
    env.KSAI_STAGE_RESULT ? dirname(String(env.KSAI_STAGE_RESULT)) : '',
  ];
  return present([workspace, '/tmp', ...scopes, ...workflow]).map((one) => resolve(one));
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

export function callerDeniedEnvironment(env = process.env) {
  return listed(env.SANDBOX_DENY_ENV);
}
