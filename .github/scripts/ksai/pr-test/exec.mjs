import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

const DEFAULT_TIMEOUT_MS = 600_000;

const MAX_OUTPUT_CHARS = 8_192;
/**
 * Names the tested tree never sees: credentials it could spend, and the runner files it could write
 * to reach a later step. Exported so the action's own install of that tree's tools blanks the same
 * set, and so a test can hold the two together.
 */
export const BLOCKED_CHILD_ENV = new Set([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GH_TOKEN',
  'GITHUB_ENV',
  'GITHUB_WORKSPACE',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TOKEN',
  'KSAI_OIDC_REQUEST_TOKEN',
  'KSAI_OIDC_REQUEST_URL',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'RUNNER_TEMP',
  'RUN',
  'SCRIPTS',
]);
const GITHUB_CLI_ENV = new Set(['GH_TOKEN']);

const childEnvironment = (extra, allowed = new Set()) => {
  const environment = { ...process.env, ...extra };
  for (const name of BLOCKED_CHILD_ENV) {
    if (!allowed.has(name)) delete environment[name];
  }
  return environment;
};

const appendBounded = (buffer, chunk, maxChars) => {
  const next = buffer + chunk;
  return next.length > maxChars ? next.slice(-maxChars) : next;
};

const runChild = (command, args, options, allowed) => {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, stream = false, maxOutputChars = MAX_OUTPUT_CHARS } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(env, allowed),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputChars);
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk, maxOutputChars);
      if (stream) process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
};

export const run = (command, args, options = {}) => runChild(command, args, options, new Set());

export const runGitHub = (args, options = {}) => runChild('gh', args, options, GITHUB_CLI_ENV);

export async function runDetached(
  command,
  args,
  { cwd, env = null, logPath, timeoutMs = DEFAULT_TIMEOUT_MS },
) {
  const log = await open(logPath, 'a');
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment(env),
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });

  const pid = child.pid;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(pid, 'SIGKILL');
  }, timeoutMs);

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (status) => resolve(status ?? 1));
  });

  clearTimeout(timer);
  await log.close();
  return { code, pid, timedOut };
}

export async function startDetached(command, args, { cwd, env = null, logPath }) {
  const log = await open(logPath, 'a');
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment(env),
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });

  const spawnError = await new Promise((resolve) => {
    child.once('error', resolve);
    child.once('spawn', () => resolve(null));
  });

  await log.close();
  if (spawnError) throw new Error(`${command} could not start: ${spawnError.message}`);

  child.unref();
  return child.pid;
}

export function killGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export const tail = (text, lines = 20, chars = 600) => {
  const stripped = text
    // eslint-disable-next-line no-control-regex -- the escapes are the thing being removed
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
  return stripped.length > chars ? `...${stripped.slice(-chars)}` : stripped;
};

export const quote = (command, args) => [command, ...args].join(' ');

export async function waitForHttp(url, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never attempted';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return { ready: true, status: response.status };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return { ready: false, status: null, error: lastError };
}
