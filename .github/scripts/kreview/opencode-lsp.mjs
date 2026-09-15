import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

export const LSP_ARM = Object.freeze({ off: 'off', native: 'native' });
export const OPENCODE_VERSION = '1.18.31';
export const GOPLS_VERSION = 'v0.20.0';
export const TYPESCRIPT_LANGUAGE_SERVER_VERSION = '5.3.0';
export const TYPESCRIPT_VERSION = '5.9.3';
export const STAGE_TIMEOUT_MS = 300_000;
export const LSP_ADDRESS_SPACE_BYTES = 2_147_483_648;
export const LSP_CPU_SECONDS = 600;
export const LSP_MAX_PROCESSES = 64;
export const LSP_MAX_OPEN_FILES = 512;
export const LSP_TMPFS_BYTES = 268_435_456;
export const TSSERVER_MEMORY_MB = 512;
export const TSSERVER_DENIED_PLUGIN_FLAGS = Object.freeze([
  '--allowLocalPluginLoads',
  '--globalPlugins',
  '--pluginProbeLocations',
]);
export const TSSERVER_PACKAGE = Object.freeze({
  name: 'ksai-tsserver-guard',
  version: TYPESCRIPT_VERSION,
  private: true,
});
export const BUILTIN_LSP_SERVERS = Object.freeze([
  'deno', 'typescript', 'vue', 'eslint', 'oxlint', 'biome', 'gopls', 'ruby-lsp', 'ty',
  'pyright', 'elixir-ls', 'zls', 'csharp', 'razor', 'fsharp', 'sourcekit-lsp', 'rust',
  'clangd', 'svelte', 'astro', 'jdtls', 'kotlin-ls', 'yaml-ls', 'lua-ls',
  'php intelephense', 'prisma', 'dart', 'ocaml-lsp', 'bash', 'terraform', 'texlab',
  'dockerfile', 'gleam', 'clojure-lsp', 'nixd', 'tinymist', 'haskell-language-server',
  'julials',
]);
export const DISABLED_LSP_SERVERS = Object.freeze(BUILTIN_LSP_SERVERS.filter(
  (server) => !['gopls', 'typescript'].includes(server),
));
export const RUNTIME_PACKAGE = Object.freeze({
  name: 'ksai-opencode-lsp-runtime',
  version: '1.0.0',
  private: true,
  dependencies: {
    typescript: TYPESCRIPT_VERSION,
    'typescript-language-server': TYPESCRIPT_LANGUAGE_SERVER_VERSION,
  },
});
export const RUNTIME_LOCK = Object.freeze({
  name: RUNTIME_PACKAGE.name,
  version: RUNTIME_PACKAGE.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: RUNTIME_PACKAGE.name,
      version: RUNTIME_PACKAGE.version,
      dependencies: RUNTIME_PACKAGE.dependencies,
    },
    'node_modules/typescript': {
      version: TYPESCRIPT_VERSION,
      resolved: `https://registry.npmjs.org/typescript/-/typescript-${TYPESCRIPT_VERSION}.tgz`,
      integrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
      license: 'Apache-2.0',
      bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' },
      engines: { node: '>=14.17' },
    },
    'node_modules/typescript-language-server': {
      version: TYPESCRIPT_LANGUAGE_SERVER_VERSION,
      resolved: `https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-${TYPESCRIPT_LANGUAGE_SERVER_VERSION}.tgz`,
      integrity: 'sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==',
      license: 'Apache-2.0',
      bin: { 'typescript-language-server': 'lib/cli.mjs' },
      engines: { node: '>=20' },
    },
  },
});
const OUTPUT_LIMIT = 16_384;
const KILL_GRACE_MS = 2_000;
const REQUIRED_PRIVILEGE_FIELDS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'];

const sandboxSource = (goRoot) => String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = process.cwd();
const kind = process.argv[2];
const goRoot = ${JSON.stringify(goRoot)};
const nodeBinary = realpathSync(process.execPath);
const commands = {
  gopls: [join(root, 'bin', 'gopls')],
  typescript: [nodeBinary, '--max-old-space-size=${TSSERVER_MEMORY_MB}', join(root, 'node_modules', '.bin', 'typescript-language-server'), '--stdio'],
  probe: [nodeBinary, '-e', "process.stdout.write(require('node:fs').readFileSync('/proc/self/status', 'utf8'))"],
};
const command = commands[kind];
if (!command) throw new Error('unknown native LSP server');

const args = ['--dev', '/dev', '--proc', '/proc', '--size', '${LSP_TMPFS_BYTES}', '--tmpfs', '/tmp'];
const runtime = kind === 'gopls' ? [goRoot] : [nodeBinary];
for (const at of new Set([...runtime, '/lib', '/lib64', '/usr/lib', '/usr/lib64'])) {
  if (at === '/') throw new Error('native LSP runtime cannot expose the host root');
  if (at && existsSync(at)) args.push('--ro-bind', at, at);
}
if (existsSync('/etc/ld.so.cache')) args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
args.push(
  '--ro-bind', workspace, workspace,
  '--ro-bind', root, root,
  '--remount-ro', '/',
  '--remount-ro', '/dev',
  '--clearenv',
  '--setenv', 'HOME', '/tmp',
  '--setenv', 'TMPDIR', '/tmp',
  '--setenv', 'PATH', kind === 'gopls' ? join(goRoot, 'bin') : '/nonexistent',
  ...(kind === 'gopls' ? [
    '--setenv', 'GOROOT', goRoot,
    '--setenv', 'GOCACHE', '/tmp/ksai-gocache',
    '--setenv', 'GOMODCACHE', '/tmp/ksai-gomodcache',
    '--setenv', 'GOPROXY', 'off',
    '--setenv', 'GOTOOLCHAIN', 'local',
  ] : []),
  '--cap-drop', 'ALL',
  '--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-net', '--new-session', '--die-with-parent',
  '--chdir', workspace, '--', ...command,
);
const limits = [
  '--as=${LSP_ADDRESS_SPACE_BYTES}',
  '--cpu=${LSP_CPU_SECONDS}',
  '--nproc=${LSP_MAX_PROCESSES}',
  '--nofile=${LSP_MAX_OPEN_FILES}',
];
const privileges = ['--no-new-privs'];
const child = spawn('/usr/bin/prlimit', [...limits, '--', '/usr/bin/setpriv', ...privileges, '--', '/usr/bin/bwrap', ...args], { stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 127; });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;

const bounded = (text, chunk) => `${text}${chunk}`.slice(-OUTPUT_LIMIT);

export function tsserverSource(tsserver) {
  if (!isAbsolute(tsserver)) throw new Error('the trusted tsserver entrypoint must be absolute');
  return `'use strict';\n` +
    `const denied = ${JSON.stringify(TSSERVER_DENIED_PLUGIN_FLAGS)};\n` +
    `const unsafe = process.argv.slice(2).find((arg) => denied.some((flag) => arg === flag || arg.startsWith(flag + '=')));\n` +
    `if (unsafe) throw new Error('native TypeScript LSP refuses plugin-loading flag ' + unsafe);\n` +
    `require(${JSON.stringify(tsserver)});\n`;
}

export function runBounded(command, args, options = {}, start = spawn, kill = process.kill) {
  const { timeoutMs = STAGE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = start(command, args, {
      ...spawnOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hardStop = null;
    let closed = false;
    let closedStatus = null;
    let settled = false;
    const stop = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else kill(-child.pid, signal);
      } catch {}
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      resolvePromise({ status: closedStatus, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      hardStop = setTimeout(() => {
        stop('SIGKILL');
        hardStop = null;
        if (closed) finish();
      }, killGraceMs);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout = bounded(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = bounded(stderr, chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (status) => {
      closed = true;
      closedStatus = status;
      clearTimeout(timer);
      if (!timedOut || !hardStop) finish();
    });
  });
}

export const checked = async (command, args, options = {}) => {
  const result = await runBounded(command, args, options);
  if (result.status === 0 && !result.timedOut) return String(result.stdout ?? '').trim();
  const said = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || `exit ${result.status}`;
  const reason = result.timedOut ? ` timed out after ${options.timeoutMs}ms` : '';
  throw new Error(`${command} ${args[0] ?? ''}${reason}: ${said}`);
};

export function verifySandboxPrivileges(raw) {
  const values = new Map(String(raw).split('\n').map((line) => {
    const separator = line.indexOf(':');
    return separator < 0 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
  const retained = REQUIRED_PRIVILEGE_FIELDS.filter((name) => !/^0+$/.test(values.get(name) ?? ''));
  if (retained.length > 0 || values.get('NoNewPrivs') !== '1') {
    throw new Error(`native LSP sandbox retained privileges: ${[...retained, ...(values.get('NoNewPrivs') === '1' ? [] : ['NoNewPrivs'])].join(', ')}`);
  }
}

export function serverPaths(root) {
  const base = resolve(String(root ?? ''));
  return Object.freeze({
    root: base,
    sandbox: join(base, 'sandbox.mjs'),
    gopls: join(base, 'bin', 'gopls'),
    typescriptLanguageServer: join(base, 'node_modules', '.bin', 'typescript-language-server'),
    typescript: join(base, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
    tsserverPackage: join(base, 'ksai-tsserver-guard', 'package.json'),
    tsserver: join(base, 'ksai-tsserver-guard', 'lib', 'tsserver.js'),
  });
}

export function lspConfig(root, exists = existsSync) {
  if (!root || !isAbsolute(root)) throw new Error('native LSP needs an absolute trusted server root');
  const paths = serverPaths(root);
  return {
    ...Object.fromEntries(DISABLED_LSP_SERVERS.map((server) => [server, { disabled: true }])),
    gopls: exists(paths.sandbox) && exists(paths.gopls) ? {
      command: [process.execPath, paths.sandbox, 'gopls'],
      extensions: ['.go'],
      env: {
        GOCACHE: '/tmp/ksai-gocache',
        GOMODCACHE: '/tmp/ksai-gomodcache',
        GOPROXY: 'off',
        GOTOOLCHAIN: 'local',
      },
    } : { disabled: true },
    typescript: exists(paths.sandbox) && exists(paths.typescriptLanguageServer) && exists(paths.typescript) && exists(paths.tsserverPackage) && exists(paths.tsserver) ? {
      command: [process.execPath, paths.sandbox, 'typescript'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
      initialization: {
        disableAutomaticTypingAcquisition: true,
        maxTsServerMemory: TSSERVER_MEMORY_MB,
        plugins: [],
        tsserver: { path: paths.tsserver, useSyntaxServer: 'never' },
      },
    } : { disabled: true },
  };
}

export function installPlan(root) {
  const paths = serverPaths(root);
  return [
    {
      command: 'npm',
      args: [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      cwd: paths.root,
    },
    {
      command: 'go',
      args: ['install', `golang.org/x/tools/gopls@${GOPLS_VERSION}`],
      env: { GOBIN: join(paths.root, 'bin'), GOTOOLCHAIN: 'local' },
    },
  ];
}

export function canonicalGoRoot(reported, exists = existsSync, real = realpathSync) {
  if (!isAbsolute(reported) || reported === '/' || !exists(reported)) {
    throw new Error(`go reports an unavailable GOROOT: ${reported || '(empty)'}`);
  }
  let canonical;
  try {
    canonical = real(reported);
  } catch {
    throw new Error(`go reports an unavailable GOROOT: ${reported}`);
  }
  if (!isAbsolute(canonical) || canonical === '/' || !exists(canonical)) {
    throw new Error(`go reports an unavailable canonical GOROOT: ${canonical || '(empty)'}`);
  }
  return canonical;
}

export async function setup(
  root,
  run = checked,
  exists = existsSync,
  mkdir = mkdirSync,
  write = writeFileSync,
  chmod = chmodSync,
  now = Date.now,
  real = realpathSync,
) {
  const paths = serverPaths(root);
  const deadline = now() + STAGE_TIMEOUT_MS;
  const invoke = (command, args, options = {}) => run(command, args, {
    ...options,
    timeoutMs: Math.max(1, deadline - now()),
  });
  mkdir(paths.root, { recursive: true });
  mkdir(join(paths.root, 'bin'), { recursive: true });
  mkdir(join(paths.root, 'ksai-tsserver-guard', 'lib'), { recursive: true });
  write(join(paths.root, 'package.json'), `${JSON.stringify(RUNTIME_PACKAGE, null, 2)}\n`);
  write(join(paths.root, 'package-lock.json'), `${JSON.stringify(RUNTIME_LOCK, null, 2)}\n`);
  for (const step of installPlan(paths.root)) {
    await invoke(step.command, step.args, {
      ...(step.cwd ? { cwd: step.cwd } : {}),
      ...(step.env ? { env: { ...process.env, ...step.env } } : {}),
    });
  }
  const goRoot = canonicalGoRoot(await invoke('go', ['env', 'GOROOT']), exists, real);
  if (process.platform === 'linux') {
    for (const executable of ['/usr/bin/bwrap', '/usr/bin/prlimit', '/usr/bin/setpriv']) {
      if (!exists(executable)) throw new Error(`native LSP needs ${executable}`);
    }
  }
  if (exists(paths.sandbox)) chmod(paths.sandbox, 0o700);
  write(paths.sandbox, sandboxSource(goRoot), { mode: 0o500 });
  chmod(paths.sandbox, 0o500);
  write(paths.tsserverPackage, `${JSON.stringify(TSSERVER_PACKAGE, null, 2)}\n`);
  write(paths.tsserver, tsserverSource(paths.typescript), { mode: 0o500 });
  chmod(paths.tsserver, 0o500);
  if (process.platform === 'linux') {
    verifySandboxPrivileges(await invoke(process.execPath, [paths.sandbox, 'probe'], { cwd: paths.root }));
  }
  const gopls = await invoke(paths.gopls, ['version']);
  const typescriptLanguageServer = await invoke(paths.typescriptLanguageServer, ['--version']);
  const typescript = await invoke(process.execPath, ['-p', `require(${JSON.stringify(join(paths.root, 'node_modules', 'typescript', 'package.json'))}).version`]);
  if (!gopls.includes(GOPLS_VERSION)) throw new Error(`gopls reports ${gopls || '(empty)'}, expected ${GOPLS_VERSION}`);
  if (typescriptLanguageServer !== TYPESCRIPT_LANGUAGE_SERVER_VERSION) throw new Error(`typescript-language-server reports ${typescriptLanguageServer || '(empty)'}, expected ${TYPESCRIPT_LANGUAGE_SERVER_VERSION}`);
  if (typescript !== TYPESCRIPT_VERSION) throw new Error(`typescript reports ${typescript || '(empty)'}, expected ${TYPESCRIPT_VERSION}`);
  const config = lspConfig(paths.root, exists);
  if (config.gopls.disabled === true || config.typescript.disabled === true) {
    throw new Error('native LSP server setup is incomplete after installation');
  }
  return paths.root;
}

export function lspToolMetrics(events) {
  if (events.length === 0) {
    return { tool_calls: null, lsp_calls: null, lsp_first_call_ms: null, lsp_total_ms: null };
  }
  const calls = events.filter((event) => event?.type === 'tool_use' && typeof event.part?.tool === 'string');
  const byTool = Object.fromEntries(
    [...new Set(calls.map((event) => event.part.tool))]
      .sort()
      .map((tool) => [tool, calls.filter((event) => event.part.tool === tool).length]),
  );
  const startedAt = (event) => {
    const start = event.part?.state?.time?.start;
    return typeof start === 'number' && Number.isFinite(start) ? start : Number.POSITIVE_INFINITY;
  };
  const durationOf = (event) => {
    const start = event.part?.state?.time?.start;
    const end = event.part?.state?.time?.end;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    const duration = end - start;
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  };
  const lsp = calls.filter((event) => event.part.tool === 'lsp').sort((left, right) => startedAt(left) - startedAt(right));
  const durations = lsp.map((event) => durationOf(event));
  const completeDurations = durations.every((duration) => duration !== null);
  return {
    tool_calls: byTool,
    lsp_calls: lsp.length,
    lsp_first_call_ms: completeDurations ? durations[0] ?? null : null,
    lsp_total_ms: completeDurations ? durations.reduce((sum, duration) => sum + duration, 0) : null,
  };
}

async function main(env = process.env) {
  const root = String(env.OPENCODE_LSP_ROOT ?? '').trim();
  if (!root) throw new Error('OPENCODE_LSP_ROOT names no server root');
  if (env.OPENCODE_VERSION !== OPENCODE_VERSION) {
    throw new Error(`native LSP server policy supports OpenCode ${OPENCODE_VERSION}, got ${env.OPENCODE_VERSION || '(empty)'}`);
  }
  const installed = await setup(root);
  writeOutputs(env.GITHUB_OUTPUT, {
    root: installed,
  });
  console.log(
    `native LSP servers staged for OpenCode ${OPENCODE_VERSION}: gopls ${GOPLS_VERSION}, ` +
      `typescript-language-server ${TYPESCRIPT_LANGUAGE_SERVER_VERSION}, typescript ${TYPESCRIPT_VERSION}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
