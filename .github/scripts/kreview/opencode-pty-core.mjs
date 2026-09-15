import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { isolatedToolCommand } from './opencode-tool-sandbox.mjs';

export const PTY_BUFFER_BYTES = 65_536;
export const PTY_BUFFER_CODE_UNITS = Math.floor(PTY_BUFFER_BYTES / 3);
export const PTY_DEFAULT_TIMEOUT_SECONDS = 600;
export const PTY_MAX_TIMEOUT_SECONDS = 1_800;
export const PTY_MAX_READ_LINES = 200;
export const PTY_MAX_SESSIONS = 4;
export const PTY_MAX_RETAINED_SESSIONS = 8;
export const PTY_DENIED_ENV = Object.freeze([
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
  'KSAI_CHANNEL_ARMED_AT',
  'KSAI_CHANNEL_DIR',
  'KSAI_CHANNEL_FLOW',
  'KSAI_CHANNEL_KILL_AT',
  'KSAI_CHANNEL_NONCE',
  'KSAI_CHANNEL_WARN',
  'KSAI_OIDC_REQUEST_TOKEN',
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_PTY_METRICS_FILE',
  'KSAI_PTY_PID_FILE',
  'KSAI_PTY_LIVE_FIXTURE',
  'KSAI_REVIEW_CANDIDATE_IDS',
  'KSAI_REVIEW_RESULT_DIR',
  'KSAI_REVIEW_RESULT_FILE',
  'KSAI_REVIEW_RESULT_KIND',
  'KSAI_TOKEN_DIR',
  'KSAI_TOKEN_FILE',
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
  'OTEL_EXPORTER_OTLP_HEADERS',
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

const PHASES = new Set(['test', 'direct', 'step', 'fix', 'do']);
const SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;
const SHELL_CONTROL = /[\\;&|`$><#*?{}()~]|\[|\]/;
const COMMAND_WRAPPERS = new Set([
  '!', '.', 'bash', 'busybox', 'bwrap', 'case', 'chroot', 'command', 'coproc', 'corepack', 'csh',
  'daemon', 'dash', 'do', 'doas', 'done', 'elif', 'else', 'env', 'esac', 'eval', 'exec', 'fi',
  'fish', 'for', 'function', 'if', 'ksh', 'nice', 'nohup', 'npx', 'nsenter', 'parallel', 'prlimit',
  'runuser', 'script', 'select', 'setpriv', 'setsid', 'sh', 'source', 'start-stop-daemon', 'stdbuf',
  'su', 'sudo', 'systemd-run', 'tcsh', 'then', 'time', 'timeout', 'unshare', 'until', 'watch',
  'while', 'xargs', 'zsh',
]);
const EVAL_SHORT_FLAGS = Object.freeze({
  bun: 'ep',
  node: 'ep',
  perl: 'eE',
  php: 'r',
  ruby: 'e',
});
const EVAL_LONG_FLAGS = Object.freeze({ bun: ['--eval', '--print'], node: ['--eval', '--print'] });
const LOAD_SHORT_FLAGS = Object.freeze({ node: 'r', perl: 'mM', php: 'BEFRz', ruby: 'r' });
const LOAD_LONG_FLAGS = Object.freeze({
  bun: ['--preload'],
  node: ['--experimental-loader', '--import', '--loader', '--require'],
  php: ['--process-begin', '--process-code', '--process-end', '--process-file', '--zend-extension'],
  ruby: ['--require'],
});
const CODE_SUBCOMMANDS = Object.freeze({
  bun: new Set(['build', 'run', 'test', 'x']),
  deno: new Set(['bench', 'compile', 'eval', 'jupyter', 'repl', 'run', 'serve', 'task', 'test']),
});
export const PTY_OPENCODE_VERSION = '1.18.31';
const PTY_RUNTIME_LOCK_SHA256 = '31636115ee6238df77d3124c3b2d928d8d60916788824bb21b265c92afe7e519';

const executableName = (command) => command.replace(/\/+$/, '').split('/').at(-1).toLowerCase();
const carriesEval = (args, short, long = []) => args.some((arg) =>
  long.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  || /^-[^-]/.test(arg) && short.split('').some((flag) => arg.slice(1).includes(flag)));

const canonicalRuntimeLock = (value) => {
  if (Array.isArray(value)) return value.map((one) => canonicalRuntimeLock(one));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => key !== 'funding' && key !== 'license')
    .sort()
    .map((key) => [key, canonicalRuntimeLock(value[key])]));
};

const simpleArgv = (line) => {
  const args = [];
  let value = '';
  let quote = '';
  let started = false;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = '';
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error('PTY interactive input contains an unterminated quote');
  if (started) args.push(value);
  return args;
};

/** ptyPilotEnabled answers whether this exact phase may load the opt-in pilot. */
export function ptyPilotEnabled(env = process.env) {
  return String(env.OPENCODE_PTY ?? '').trim() === 'true' && PHASES.has(String(env.OPENCODE_PHASE ?? '').trim());
}

/** canonicalCommand validates an argv and renders the same command for the native Bash permission gate. */
export function canonicalCommand(command, args = []) {
  if (!Array.isArray(args) || args.length > 128) throw new Error('PTY command has too many arguments');
  const values = [command, ...args];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error('PTY command arguments must be non-empty bounded strings');
    }
  }
  const executable = executableName(command);
  const evalShort = EVAL_SHORT_FLAGS[executable] ?? (/^python(?:\d+(?:\.\d+)*)?$/.test(executable) ? 'cm' : '');
  const loaderShort = LOAD_SHORT_FLAGS[executable] ?? '';
  const codeSubcommands = Object.hasOwn(CODE_SUBCOMMANDS, executable) ? CODE_SUBCOMMANDS[executable] : null;
  const subcommandWrapper = args.some((arg) => codeSubcommands?.has(arg))
    || ['npm', 'pnpm', 'yarn'].includes(executable) && args.some((arg) => ['exec', 'x', 'dlx'].includes(arg))
    || executable === 'mise' && args.some((arg) => ['exec', 'x'].includes(arg));
  if (COMMAND_WRAPPERS.has(executable) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(command)
    || executable === 'git' && args[0]?.startsWith('-')
    || carriesEval(args, evalShort, EVAL_LONG_FLAGS[executable])
    || carriesEval(args, loaderShort, LOAD_LONG_FLAGS[executable])
    || executable === 'node' && args.some((arg) => arg === '--run' || arg.startsWith('--run='))
    || subcommandWrapper) {
    throw new Error('PTY commands must execute a direct non-wrapper program');
  }
  return values.map((value) => SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

const executablePath = (command, workdir, env, access = accessSync, stat = statSync) => {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(workdir, command)]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean)
      .map((at) => resolve(isAbsolute(at) ? at : resolve(workdir, at), command));
  for (const candidate of candidates) {
    try {
      access(candidate, constants.X_OK);
      if (stat(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`PTY executable is unavailable: ${command}`);
};

/** resolvedPtyCommand pins execution to a trusted resolved executable and normalizes its permission pattern. */
export function resolvedPtyCommand(command, args = [], workdir, roots, env = process.env, real = realpathSync) {
  canonicalCommand(command, args);
  const available = roots.filter(Boolean).map((root) => real(root));
  if (!available.length) throw new Error('PTY has no worktree boundary');
  const candidate = executablePath(command, workdir, env);
  const located = resolve(real(dirname(candidate)), basename(candidate));
  if (available.some((root) => within(located, root))) {
    throw new Error(`PTY executable must be installed outside the worktree: ${command}`);
  }
  let trustedCandidate;
  try {
    trustedCandidate = executablePath(executableName(command), workdir, env);
  } catch {
    throw new Error(`PTY executable must resolve through inherited PATH: ${command}`);
  }
  const trustedLocated = resolve(real(dirname(trustedCandidate)), basename(trustedCandidate));
  if (located !== trustedLocated) {
    throw new Error(`PTY executable differs from inherited PATH: ${command}`);
  }
  const executable = real(trustedCandidate);
  if (available.some((root) => within(executable, root))) {
    throw new Error(`PTY executable resolves into the worktree: ${command}`);
  }
  canonicalCommand(executable, args);
  const requestedPermission = canonicalCommand(executableName(command), args);
  const resolvedPermission = canonicalCommand(executableName(executable), args);
  return {
    command: trustedCandidate,
    args: [...args],
    permission: resolvedPermission,
    permissions: [...new Set([requestedPermission, resolvedPermission])],
    display: requestedPermission,
  };
}

/** interactivePtyPermission resolves command-like input when present while allowing application protocols. */
export function interactivePtyPermission(command, args, workdir, roots, env = process.env) {
  try {
    return resolvedPtyCommand(command, args, workdir, roots, env).permissions;
  } catch (error) {
    if (!String(error?.message).startsWith('PTY executable is unavailable:')) throw error;
    return [canonicalCommand(executableName(command), args)];
  }
}

/** presentedPtySession hides the Linux isolation wrapper from tool output. */
export function presentedPtySession(session, display) {
  if (!display) return session;
  return { ...session, title: display.title, command: display.command, args: display.args };
}

const within = (at, root) => at === root || at.startsWith(`${root.replace(/\/+$/, '')}/`);

const normalizedPathArgument = (input) => {
  let value = input;
  if (value.startsWith('@')) value = value.slice(1);
  if (/^file:/i.test(value)) return fileURLToPath(new URL(value));
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return '';
  return isAbsolute(value) || value === '.' || value === '..' || value.startsWith('./')
    || value.startsWith('../') || value.includes('/') ? value : '';
};

const pathArguments = (arg) => {
  const equals = arg.startsWith('-') ? arg.indexOf('=') : -1;
  const primary = equals >= 0 ? arg.slice(equals + 1) : /^-[^-][/.]/.test(arg) ? arg.slice(2) : arg;
  const values = [primary];
  for (const match of arg.matchAll(/(?:^|,)@([^,]+)/g)) values.push(match[1]);
  return [...new Set(values.map((value) => normalizedPathArgument(value)).filter(Boolean))];
};

const resolvedTarget = (value, workdir, exists = existsSync, real = realpathSync) => {
  const candidate = isAbsolute(value) ? resolve(value) : resolve(workdir, value);
  let existing = candidate;
  const suffix = [];
  while (!exists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(real(existing), ...suffix);
};

/** externalPtyPaths returns path arguments that require OpenCode external-directory approval. */
export function externalPtyPaths(
  args,
  workdir,
  roots,
  exists = existsSync,
  real = realpathSync,
  stat = statSync,
  lstat = lstatSync,
) {
  const available = roots.filter(Boolean).map((root) => real(root));
  if (!available.length) throw new Error('PTY has no worktree boundary');
  const external = new Map();
  for (const arg of args) {
    for (const value of pathArguments(arg)) {
      const candidate = isAbsolute(value) ? resolve(value) : resolve(workdir, value);
      const target = resolvedTarget(value, workdir, exists, real);
      const located = exists(candidate) ? resolve(real(dirname(candidate)), basename(candidate)) : target;
      for (const filepath of new Set([located, target])) {
        if (available.some((root) => within(filepath, root))) continue;
        let directory = false;
        try {
          directory = exists(filepath) && (filepath === located ? lstat(filepath) : stat(filepath)).isDirectory();
        } catch {}
        const parentDir = directory ? filepath : dirname(filepath);
        const pattern = `${parentDir.replace(/\/+$/, '')}/*`;
        external.set(pattern, { filepath, parentDir, pattern });
      }
    }
  }
  return [...external.values()];
}

/** containedWorkdir resolves a real existing directory and refuses every external path and symlink escape. */
export function containedWorkdir(value, roots, real = realpathSync) {
  const available = roots.filter(Boolean).map((root) => real(root));
  if (!available.length) throw new Error('PTY has no worktree boundary');
  const asked = String(value ?? '').trim();
  const candidate = real(asked === '' ? available[0] : isAbsolute(asked) ? asked : resolve(available[0], asked));
  if (!available.some((root) => within(candidate, root))) {
    throw new Error(`PTY workdir is outside the worktree: ${asked || candidate}`);
  }
  return candidate;
}

/** boundedTimeout forces every process under both the PTY ceiling and the run deadline. */
export function boundedTimeout(value, killAt, now = Date.now()) {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error('PTY timeoutSeconds must be a positive integer');
  }
  let timeout = Math.min(value ?? PTY_DEFAULT_TIMEOUT_SECONDS, PTY_MAX_TIMEOUT_SECONDS);
  const deadline = Number(killAt);
  if (Number.isFinite(deadline) && deadline > 0) {
    const remaining = Math.floor((deadline - now) / 1000);
    if (remaining < 1) throw new Error('PTY cannot start after the run deadline');
    timeout = Math.min(timeout, remaining);
  }
  return timeout;
}

/**
 * boundedRead validates the portion of a bounded buffer one tool call may return.
 *
 * @param {{offset?: number, limit?: number, pattern?: string}} [input]
 */
export function boundedRead({ offset, limit, pattern } = {}) {
  const at = offset ?? 0;
  const count = limit ?? PTY_MAX_READ_LINES;
  let literalPattern;
  if (!Number.isInteger(at) || at < 0) throw new Error('PTY read offset must be a non-negative integer');
  if (!Number.isInteger(count) || count < 1) throw new Error('PTY read limit must be a positive integer');
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern.length > 128) throw new Error('PTY read pattern exceeds 128 characters');
    literalPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return { offset: at, limit: Math.min(count, PTY_MAX_READ_LINES), ...(literalPattern === undefined ? {} : { pattern: literalPattern }) };
}

/** decodedInput converts the escape notation exposed by the upstream tool into bounded PTY bytes. */
export function decodedInput(value) {
  const input = String(value ?? '');
  const decoded = input.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g, (match, sequence) => {
    if (sequence.startsWith('x')) return String.fromCodePoint(Number.parseInt(sequence.slice(1), 16));
    if (sequence.startsWith('u')) return String.fromCodePoint(Number.parseInt(sequence.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', '\\': '\\' }[sequence] ?? match;
  });
  const unsupportedControl = [...decoded].some((character) => {
    const point = character.codePointAt(0);
    return point === 127 || (point < 32 && ![3, 4, 9, 10, 13].includes(point));
  });
  if (Buffer.byteLength(decoded) > 4096 || unsupportedControl) {
    throw new Error('PTY input exceeds 4096 bytes or contains unsupported control bytes');
  }
  return decoded;
}

/** permissionCommands parses interactive input that must pass the same gates as a spawn. */
export function permissionCommands(input) {
  const signal = input.codePointAt(0);
  if ([...input].some((character) => [3, 4].includes(character.codePointAt(0)))) {
    if (input.length === 1 && [3, 4].includes(signal)) return [];
    throw new Error('PTY control bytes must be sent in standalone writes');
  }
  const last = input.codePointAt(input.length - 1);
  if (input !== '' && ![10, 13].includes(last)) {
    throw new Error('PTY interactive input must contain complete terminated lines');
  }
  return input
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.length > 1024 || SHELL_CONTROL.test(line)) {
        throw new Error('PTY interactive input contains shell control syntax or exceeds 1024 characters');
      }
      const args = simpleArgv(line);
      if (args.length === 0) throw new Error('PTY interactive input contains no command');
      canonicalCommand(args[0], args.slice(1));
      return args;
    });
}

/** permissionLines renders interactive commands for the native Bash permission gate. */
export function permissionLines(input) {
  return permissionCommands(input).map(([command, ...args]) => canonicalCommand(executableName(command), args));
}

/** deliveredPtyNotification retries delivery and records a bounded terminal failure. */
export async function deliveredPtyNotification(records, deliver, wait = (delay) => new Promise((done) => {
  setTimeout(done, delay);
})) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await deliver();
      for (const record of records) record.notified = true;
      return result;
    } catch (error) {
      if (attempt < 3) await wait(attempt * 50);
      else {
        for (const record of records) record.notificationFailed = true;
        throw error;
      }
    }
  }
}

/** idlePtyRead recognizes a running read with no output since the preceding read. */
export function idlePtyRead(beforeStatus, afterStatus, observed, previousRaw, currentRaw) {
  return beforeStatus === 'running' && afterStatus === 'running' && observed && previousRaw === currentRaw;
}

/** scrubbedPtyEnvironment overrides every credential and caller-added denial before upstream merges the child environment. */
export function scrubbedPtyEnvironment(env = process.env) {
  const denied = String(env.SANDBOX_DENY_ENV ?? '').split(/[,\n]/).map((one) => one.trim()).filter(Boolean);
  return Object.fromEntries([...new Set([...PTY_DENIED_ENV, ...denied])].map((name) => [name, '']));
}

/** refreshPtyLiveness marks only OS-confirmed exits dead and returns the live count. */
export function refreshPtyLiveness(records, alive) {
  const newlyDead = [];
  let active = 0;
  for (const record of records.values()) {
    if (!record.dead && !alive(record.pid)) {
      record.dead = true;
      newlyDead.push(record);
    }
    if (!record.dead) active += 1;
  }
  return { active, newlyDead };
}

/** prunablePtyRecords returns oldest completed records whose processes are confirmed dead. */
export function prunablePtyRecords(records, targetSize) {
  const excess = Math.max(0, records.size - targetSize);
  return [...records.values()]
    .filter((record) => record.dead && record.completed && (record.notified || record.notificationFailed))
    .sort((a, b) => a.started - b.started)
    .slice(0, excess);
}

/** isolatedPtyCommand keeps every Linux session inside its own killable PID namespace. */
export function isolatedPtyCommand(command, args, workdir, linux = process.platform === 'linux') {
  return isolatedToolCommand(command, args, workdir, linux, {
    ...process.env,
    GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE || workdir,
  });
}

/** pinnedRuntime refuses a dependency graph that differs from the exact audited lock. */
export function pinnedRuntime(manifest, lock) {
  const root = lock?.packages?.['']?.dependencies ?? {};
  const packages = lock?.packages ?? {};
  const serialized = JSON.stringify(canonicalRuntimeLock(lock));
  const digest = typeof serialized === 'string' ? createHash('sha256').update(serialized).digest('hex') : '';
  return digest === PTY_RUNTIME_LOCK_SHA256 &&
    manifest?.dependencies?.['opencode-pty'] === '0.3.6' && root['opencode-pty'] === '0.3.6' &&
    packages['node_modules/opencode-pty']?.version === '0.3.6' &&
    packages['node_modules/bun-pty']?.version === '0.4.10' &&
    packages['node_modules/@opencode-ai/plugin']?.version === PTY_OPENCODE_VERSION &&
    packages['node_modules/@opencode-ai/sdk']?.version === PTY_OPENCODE_VERSION &&
    packages['node_modules/open']?.version === '11.0.0';
}
