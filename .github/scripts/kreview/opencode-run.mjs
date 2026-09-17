import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { conclusionOf, exitedOn, stopReason } from '../lib/execution-log.mjs';
import {
  DEFAULT_OPENCODE_MODEL,
  answer,
  collectSecrets,
  executionLog,
  listed,
  parsed,
  providerPolicyDirectory,
  providerPolicyFile,
  sandboxScopes,
  scrub,
  spending,
  validateProviderPolicyConfig,
  validateProviderPolicyVersion,
  isolatedToolPhase,
  MASKED_HOMES,
} from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { bearer, heldExpiry } from '../lib/opencode-token.mjs';
import { completeFinal, completeStage, LIMITS, readExport, recordChildren, recordedCompletion, recoverReview, reviewAnswer, reviewSession, streamFailure } from './opencode-review.mjs';
import { compactionSample, mcpServerCount, supportsCompaction, toolTiming, traceObserver } from './opencode-runtime.mjs';
import { startRelay } from './otel-relay.mjs';
import { startProviderRelay } from './opencode-provider-relay.mjs';
import resultProtocol from './review-result.cjs';
import { isolatedPtyCommand, ptyPilotEnabled } from './opencode-pty-core.mjs';
import { TOOL_INJECTION_ENV, toolIsolationProbe } from './opencode-tool-sandbox.mjs';

const { structuredSubmission, submitted } = resultProtocol;

export { listed, main };

/**
 * DENIED_CREDENTIALS names what a tool call may not read, and it is a declaration rather than a copy.
 *
 * These three were only ever written down in the Claude arm's `settings.sandbox.credentials.envVars`
 * block, and the sandbox proved itself by deriving them from it. That block is being deleted with
 * the arm, so the fact is declared here and specified in `opencode-wiring.test.mjs`, which names
 * what each one costs. **Restating them inside the loop that consumes them would not do**: the
 * derivation existed because a name dropped from a list nothing checks is a credential silently
 * handed back to a write phase's shell.
 *
 * Write phases keep the Anthropic bearer in this trusted broker process. Read-only phases retain
 * the older in-process renewal path, where the model has no write-capable shell.
 */
export const DENIED_CREDENTIALS = Object.freeze([
  // The OTLP auth header, which is a write credential for the fleet's telemetry
  'OTEL_EXPORTER_OTLP_HEADERS',
  // The request pair this action's own steps mint the gateway bearer from
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_OIDC_REQUEST_TOKEN',
]);

/**
 * DENIED_MINTS names the runner credentials that mint an identity for **any** audience.
 *
 * That is escalation rather than spend, which is why these are unset whatever the subprocess scrub
 * says. The Claude arm does not deny them through its settings - it does not have to, because that
 * CLI scrubs a tool subprocess itself and bwrap refuses nothing it is not told to.
 */
export const DENIED_MINTS = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
]);

const UNSET = [...DENIED_CREDENTIALS, ...DENIED_MINTS, ...TOOL_INJECTION_ENV, 'OPENCODE_CONFIG_CONTENT', 'KSAI_PTY_LIVE_FIXTURE'];

const EXPORTER_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';

const PROBE_TIMEOUT_MS = 60_000;
const SCRUBBED = ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const BROKERED = ['ANTHROPIC_FEDERATED_TOKEN', 'ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT'];

export const scrubbing = (env) => String(env.SUBPROCESS_ENV_SCRUB ?? '1').trim() !== '0';

// Half the gateway token's 300s life minus the 120s advisory margin, so a tick that drifts still
// lands well inside the window. Measured at 60s: renewals fell 180s, 195s and 164s apart on run
// 34442575839 - the 195s one had already drifted 15s past the point it was due.
const BROKER_PERIOD_MS = 30_000;

export const PROCESS_SAMPLE_MS = 5_000;
export const LSP_CGROUP_MEMORY_BYTES = 2_147_483_648;
export const LSP_CGROUP_CPU_USEC = 600_000_000;
export const LSP_CGROUP_MAX_PROCESSES = 128;
export const LSP_CGROUP_SAMPLE_MS = 250;
export const LSP_CGROUP_DRAIN_TIMEOUT_MS = 5_000;

const CGROUP_ROOT = '/sys/fs/cgroup';

const READ_ONLY_ON_TEST = ['.git', '.ksai'];

const RESOLVER = '/etc/resolv.conf';

const MASKED_RUNTIME = '/run';

const commandOutput = (result) => `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();

function checkedCommand(run, command, args, options = {}) {
  const result = run(command, args, { encoding: 'utf8', ...options });
  if (result?.status === 0) return;
  throw new Error(`${command} ${args[1] ?? ''} failed: ${commandOutput(result) || `exit ${result?.status ?? 'unknown'}`}`);
}

function privilegedWrite(run, at, value) {
  checkedCommand(run, 'sudo', ['--non-interactive', 'tee', '--', at], { input: `${value}\n` });
}

export function cgroupPath(root = CGROUP_ROOT, pid = process.pid) {
  return join(root, `ksai-opencode-${pid}`);
}

export function processCgroup(raw, root = CGROUP_ROOT) {
  const membership = String(raw).split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  if (!membership?.startsWith('/')) throw new Error('the process has no cgroup v2 membership');
  const at = resolve(root, `.${membership}`);
  if (at !== root && !at.startsWith(`${root}/`)) throw new Error('the process cgroup escapes the v2 hierarchy');
  return at;
}

export function prepareCgroup({
  root = CGROUP_ROOT,
  pid = process.pid,
  exists = existsSync,
  run = spawnSync,
} = {}) {
  if (!exists(join(root, 'cgroup.controllers'))) throw new Error('cgroup v2 is unavailable');
  const at = cgroupPath(root, pid);
  checkedCommand(run, 'sudo', ['--non-interactive', 'mkdir', '--', at]);
  try {
    for (const limit of [
      { name: 'memory.max', value: String(LSP_CGROUP_MEMORY_BYTES) },
      { name: 'memory.swap.max', value: '0' },
      { name: 'memory.oom.group', value: '1' },
      { name: 'pids.max', value: String(LSP_CGROUP_MAX_PROCESSES) },
    ]) privilegedWrite(run, join(at, limit.name), limit.value);
    for (const name of ['cgroup.procs', 'cgroup.kill', 'cpu.stat', 'memory.peak']) {
      if (!exists(join(at, name))) throw new Error(`${name} is unavailable`);
    }
    return at;
  } catch (error) {
    run('sudo', ['--non-interactive', 'rmdir', '--', at], { encoding: 'utf8' });
    throw error;
  }
}

export async function destroyCgroup(
  at,
  run = spawnSync,
  read = readFileSync,
  now = Date.now,
  pause = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); }),
) {
  const deadline = now() + LSP_CGROUP_DRAIN_TIMEOUT_MS;
  while (now() < deadline) {
    try {
      privilegedWrite(run, join(at, 'cgroup.kill'), 1);
    } catch {
      await pause(25);
      continue;
    }
    let events;
    try {
      events = String(read(join(at, 'cgroup.events'), 'utf8'));
    } catch {
      await pause(25);
      continue;
    }
    if (/^populated 0$/m.test(events)) {
      const result = run('sudo', ['--non-interactive', 'rmdir', '--', at], { encoding: 'utf8' });
      if (result?.status === 0) return true;
    }
    await pause(25);
  }
  return false;
}

export function cpuUsage(raw) {
  const line = String(raw).split('\n').find((entry) => entry.startsWith('usage_usec '));
  const text = line?.slice('usage_usec '.length) ?? '';
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function cgroupMetrics(at, read) {
  const usageUsec = cpuUsage(read(join(at, 'cpu.stat'), 'utf8'));
  const peak = String(read(join(at, 'memory.peak'), 'utf8').trim());
  const peakBytes = /^[0-9]+$/.test(peak) ? Number(peak) : NaN;
  if (usageUsec === null || !Number.isSafeInteger(peakBytes)) throw new Error('invalid cgroup telemetry');
  return { usageUsec, peakBytes };
}

export function monitorCgroup(
  at,
  read = readFileSync,
  killGroup = (path) => privilegedWrite(spawnSync, path, 1),
  everyMs = LSP_CGROUP_SAMPLE_MS,
  maxCpuUsec = LSP_CGROUP_CPU_USEC,
  onBreach = (_reason) => {},
) {
  let complete = true;
  let killed = false;
  let failure = null;
  let peakBytes = 0;
  const kill = (reason) => {
    if (killed) return;
    killed = true;
    failure = reason;
    try {
      killGroup(join(at, 'cgroup.kill'));
    } catch {}
    onBreach(reason);
  };
  const sample = () => {
    try {
      const current = cgroupMetrics(at, read);
      peakBytes = Math.max(peakBytes, current.peakBytes);
      if (current.usageUsec > maxCpuUsec) kill(`CPU time ${current.usageUsec}us exceeded ${maxCpuUsec}us`);
    } catch {
      complete = false;
      kill('cgroup telemetry became unavailable');
    }
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    sample();
    let lingering = null;
    try {
      lingering = String(read(join(at, 'cgroup.procs'), 'utf8')).trim().split('\n').filter(Boolean).length;
    } catch {
      complete = false;
      kill('final cgroup process accounting became unavailable');
    }
    return {
      failure,
      metrics: complete ? { peak_memory_kb: Math.ceil(peakBytes / 1024), lingering_processes: lingering } : {
        peak_memory_kb: null,
        lingering_processes: null,
      },
    };
  };
}

export function enforcedStatus(status, enforcement) {
  return status === 0 && enforcement?.failure ? 1 : status;
}

export function cleanupStatus(status, removed) {
  return status === 0 && !removed ? 1 : status;
}

export function startCgroupGuardian(
  script,
  root,
  parent = process.pid,
  launch = spawn,
  timeoutMs = LSP_CGROUP_DRAIN_TIMEOUT_MS,
) {
  const at = cgroupPath(root, parent);
  const child = launch(process.execPath, [script, '--guard', root, String(parent)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      if (error) {
        child.kill('SIGTERM');
        reject(error);
      }
      else resolvePromise({ at, child });
    };
    const onMessage = (message) => {
      if (message?.type !== 'ready') return;
      if (message.at !== at) return finish(new Error('the native resource guardian named another cgroup'));
      finish();
    };
    const timer = setTimeout(
      () => finish(new Error('the native resource guardian did not become ready')),
      timeoutMs,
    );
    child.on('message', onMessage);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`the native resource guardian exited before setup: ${code ?? 'signal'}`)));
  });
}

export function stopCgroupGuardian(
  guardian,
  timeoutMs = LSP_CGROUP_DRAIN_TIMEOUT_MS + 1_000,
) {
  const child = guardian?.child;
  if (!child || child.exitCode !== null) return Promise.resolve(false);
  if (!child.connected) {
    child.kill('SIGKILL');
    return Promise.resolve(false);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (removed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      if (!removed && child.exitCode === null) child.kill('SIGKILL');
      resolvePromise(removed);
    };
    const onMessage = (message) => {
      if (message?.type === 'cleaned') finish(message.removed === true);
    };
    const onExit = () => finish(false);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ type: 'cleanup' }, (error) => {
      if (error) finish(false);
    });
  });
}

export async function removeGuardedCgroup(
  guardian,
  at,
  stop = stopCgroupGuardian,
  destroy = destroyCgroup,
) {
  try {
    if (await stop(guardian)) return true;
  } catch {}
  if (!at) return false;
  try {
    return await destroy(at);
  } catch {
    return false;
  }
}

export function watchCgroupGuardian(guardian, onLost) {
  const child = guardian?.child;
  if (!child) {
    onLost();
    return () => {};
  }
  let active = true;
  let reported = false;
  const lost = (terminate = false) => {
    if (!active || reported) return;
    reported = true;
    if (terminate && child.exitCode === null) child.kill('SIGKILL');
    onLost();
  };
  const exited = () => lost();
  const disconnected = () => lost(true);
  child.once('exit', exited);
  child.once('disconnect', disconnected);
  if (child.exitCode !== null) lost();
  else if (!child.connected) lost(true);
  return () => {
    active = false;
    child.removeListener('exit', exited);
    child.removeListener('disconnect', disconnected);
  };
}

export function processTable(run = spawnSync) {
  let result;
  try {
    result = run('ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='], { encoding: 'utf8' });
  } catch {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const output = String(result.stdout ?? '').trim();
  if (!output) return null;
  const rows = output.split('\n').map((line) => {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== 3 || !tokens.every((value) => /^[0-9]+$/.test(value))) return null;
    const values = tokens.map(Number);
    if (!values.every((value) => Number.isSafeInteger(value))) return null;
    const [pid, ppid, rss_kb] = values;
    return pid > 0 && ppid >= 0 && rss_kb >= 0 ? { pid, ppid, rss_kb } : null;
  });
  return rows.some((row) => row === null) ? null : rows;
}

export function processTree(rows, rootPid) {
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!pids.has(row.pid) && pids.has(row.ppid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

export function monitorProcess(rootPid, table = processTable, everyMs = PROCESS_SAMPLE_MS) {
  const seen = new Set();
  let peakRssKb = 0;
  let complete = true;
  const sample = () => {
    const rows = table();
    if (!Array.isArray(rows) || rows.length === 0) {
      complete = false;
      return null;
    }
    const tree = processTree(rows, rootPid);
    for (const row of tree) seen.add(row.pid);
    peakRssKb = Math.max(peakRssKb, tree.reduce((sum, row) => sum + row.rss_kb, 0));
    return rows;
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    const rows = sample();
    if (!complete || !seen.has(rootPid)) return { peak_rss_kb: null, lingering_processes: null };
    const alive = new Set(rows.map((row) => row.pid));
    return {
      peak_rss_kb: peakRssKb,
      lingering_processes: [...seen].filter((pid) => pid !== rootPid && alive.has(pid)).length,
    };
  };
}

export function runtimeSummary(invocations, mcpServers = null) {
  const complete = (field, rows = invocations) => rows.length > 0 && rows.every(
    (metric) => Number.isFinite(metric[field]) && metric[field] >= 0,
  );
  const sum = (field, rows = invocations) => complete(field, rows)
    ? rows.reduce((total, metric) => total + metric[field], 0)
    : null;
  const withMcp = invocations.filter((metric) => Number(metric.mcp_connects) > 0);
  const withTool = invocations.filter((metric) => Number(metric.tool_calls) > 0);
  const failed = invocations.filter((metric) => metric.exit_code !== 0).length;
  const compactionAvailable = invocations.length > 0 && invocations.every(
    (metric) => Number.isInteger(metric.compaction_count) && metric.compaction_count >= 0,
  );
  return {
    mode: 'one-shot',
    span_source: 'unauthenticated-loopback',
    compaction_source: 'unauthenticated-sandbox-sidecar',
    event_source: 'unauthenticated-json-stream',
    mcp_servers: mcpServers,
    invocation_count: invocations.length,
    failed_invocations: failed,
    failure_rate: invocations.length ? failed / invocations.length : null,
    total_ms: sum('total_ms'),
    startup_ms: sum('startup_ms'),
    model_ms: sum('model_ms'),
    mcp_connect_ms: sum('mcp_connect_ms', withMcp),
    first_mcp_ms: complete('first_mcp_ms', withMcp)
      ? sum('first_mcp_ms', withMcp) / withMcp.length
      : null,
    first_tool_ms: complete('tool_calls') && complete('first_tool_ms', withTool)
      ? sum('first_tool_ms', withTool) / withTool.length
      : null,
    model_calls: sum('model_calls'),
    mcp_connects: sum('mcp_connects'),
    tool_calls: sum('tool_calls'),
    compaction_count: compactionAvailable ? sum('compaction_count') : null,
    compacted_invocations: compactionAvailable
      ? invocations.filter((metric) => metric.compaction_count > 0).length
      : null,
    compaction_unavailable_invocations: invocations.filter(
      (metric) => !Number.isInteger(metric.compaction_count) || metric.compaction_count < 0,
    ).length,
    invocations,
    peak_rss_kb: complete('peak_rss_kb') ? Math.max(...invocations.map((metric) => metric.peak_rss_kb)) : null,
    lingering_processes: sum('lingering_processes'),
  };
}

export function scopeBinds(env = process.env, exists = existsSync, real = realpathSync) {
  const scopes = sandboxScopes(env, exists, real);
  for (const at of scopes.missing) {
    console.log(
      `::warning::the sandbox scope ${at} is not on this runner, so nothing is bound there and no tool may reach it`,
    );
  }
  for (const at of scopes.masked) {
    console.log(
      `::warning::the sandbox scope ${at} names a masked credential store, so it is refused rather than bound back`,
    );
  }
  const args = [];
  for (const { flag, named } of [
    { flag: '--bind', named: scopes.allow },
    { flag: '--ro-bind', named: scopes.deny },
  ]) {
    for (const at of named) args.push(flag, at, at);
  }
  return args;
}

export function resolverBinds(real = realpathSync) {
  let at = '';
  try {
    at = String(real(RESOLVER));
  } catch {
    return [];
  }
  return at.startsWith(`${MASKED_RUNTIME}/`) ? ['--ro-bind', at, at] : [];
}

/** Bind a complete workflow-stage ABI, refusing partial or writable trusted inputs. */
export function workflowBinds(env = process.env, exists = existsSync, kind = (at) => statSync(at)) {
  const values = {
    KSAI_WORKFLOW_PACKAGE: String(env.KSAI_WORKFLOW_PACKAGE ?? ''),
    KSAI_STAGE_REQUEST: String(env.KSAI_STAGE_REQUEST ?? ''),
    KSAI_STAGE_RESULT: String(env.KSAI_STAGE_RESULT ?? ''),
    KSAI_STAGE_ARTIFACTS: String(env.KSAI_STAGE_ARTIFACTS ?? ''),
    KSAI_STAGE_INPUTS: String(env.KSAI_STAGE_INPUTS ?? ''),
  };
  const present = Object.values(values).filter(Boolean).length;
  if (present === 0) return [];
  if (present !== Object.keys(values).length) throw new Error('workflow stage ABI is incomplete');
  const resultDirectory = dirname(values.KSAI_STAGE_RESULT);
  for (const [name, path] of Object.entries(values)) {
    if (name === 'KSAI_STAGE_RESULT') {
      if (exists(path) || !exists(resultDirectory) || !kind(resultDirectory).isDirectory()) {
        throw new Error('workflow stage result is not one new file');
      }
    } else if (!exists(path)) throw new Error(`${name} does not exist`);
  }
  for (const name of ['KSAI_WORKFLOW_PACKAGE', 'KSAI_STAGE_ARTIFACTS', 'KSAI_STAGE_INPUTS']) {
    if (!kind(values[name]).isDirectory()) throw new Error(`${name} is not a directory`);
  }
  if (!kind(values.KSAI_STAGE_REQUEST).isFile()) throw new Error('KSAI_STAGE_REQUEST is not a file');
  return [
    '--ro-bind', values.KSAI_WORKFLOW_PACKAGE, values.KSAI_WORKFLOW_PACKAGE,
    '--ro-bind', values.KSAI_STAGE_REQUEST, values.KSAI_STAGE_REQUEST,
    '--ro-bind', values.KSAI_STAGE_INPUTS, values.KSAI_STAGE_INPUTS,
    '--bind', resultDirectory, resultDirectory,
    '--bind', values.KSAI_STAGE_ARTIFACTS, values.KSAI_STAGE_ARTIFACTS,
    ...Object.entries(values).flatMap(([name, value]) => ['--setenv', name, value]),
  ];
}

export function sandboxArgs(
  env = process.env,
  exists = existsSync,
  kind = (at) => statSync(at),
  real = realpathSync,
) {
  const home = String(env.HOME ?? '');
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const temp = String(env.RUNNER_TEMP ?? '');
  const opencodeHome = String(env.OPENCODE_HOME ?? '');
  const isolatedTools = isolatedToolPhase(env.OPENCODE_PHASE);
  const providerPolicyDir = providerPolicyDirectory(opencodeHome);
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    MASKED_RUNTIME,
    ...resolverBinds(real),
  ];
  if (temp) {
    args.push('--tmpfs', temp);
    const tools = join(temp, 'ksai-opencode', 'bin');
    if (exists(tools)) args.push('--ro-bind', tools, tools);
    const lspRoot = String(env.OPENCODE_LSP_ROOT ?? '');
    if (env.OPENCODE_LSP_TOOL === 'native' && lspRoot && exists(lspRoot)) {
      args.push('--ro-bind', lspRoot, lspRoot);
    }
    const sdk = String(env.OPENCODE_SDK_ROOT ?? '');
    if (sdk && exists(sdk)) args.push('--ro-bind', sdk, sdk);
  }

  const resultDir = String(env.KSAI_REVIEW_RESULT_DIR ?? '');
  if (resultDir && exists(resultDir)) args.push('--bind', resultDir, resultDir);
  args.push(...workflowBinds(env, exists, kind));

  const ptyMetrics = String(env.KSAI_PTY_METRICS_FILE ?? '');
  if (ptyMetrics && exists(ptyMetrics)) {
    args.push('--bind', ptyMetrics, ptyMetrics, '--setenv', 'KSAI_PTY_METRICS_FILE', ptyMetrics);
  }

  const compactionFile = String(env.KSAI_COMPACTION_FILE ?? '');
  if (compactionFile && exists(compactionFile)) {
    args.push('--dir', dirname(compactionFile), '--bind', compactionFile, compactionFile);
  }

  for (const name of MASKED_HOMES) {
    const at = join(home, name);
    if (!exists(at)) continue;
    if (kind(at).isDirectory()) args.push('--tmpfs', at);
    else args.push('--ro-bind', '/dev/null', at);
  }

  const config = String(env.OPENCODE_CONFIG ?? '');
  const scripts = String(env.SCRIPTS ?? '');
  args.push(env.OPENCODE_LSP_TOOL === 'native' ? '--ro-bind' : '--bind', workspace, workspace);
  const trusted = join(workspace, '_ksai');
  if (exists(trusted)) args.push('--ro-bind', trusted, trusted);
  args.push(
    '--ro-bind',
    config,
    config,
    '--ro-bind',
    scripts,
    scripts,
    '--bind',
    opencodeHome,
    opencodeHome,
    '--ro-bind',
    providerPolicyDir,
    providerPolicyDir,
  );

  const channel = String(env.KSAI_CHANNEL_DIR ?? '');
  if (channel && exists(channel)) {
    args.push('--ro-bind', channel, channel, '--bind', join(channel, 'run'), join(channel, 'run'));
  }

  if (String(env.FLOW ?? '') === 'test') {
    for (const name of READ_ONLY_ON_TEST) {
      const at = join(workspace, name);
      if (exists(at)) args.push('--ro-bind', at, at);
    }
  }

  const tokenDir = String(env.KSAI_TOKEN_DIR ?? '');
  if (!isolatedTools && tokenDir && exists(tokenDir)) {
    args.push('--ro-bind', tokenDir, tokenDir, '--setenv', 'KSAI_TOKEN_FILE', String(env.KSAI_TOKEN_FILE ?? ''));
  }

  args.push(
    ...scopeBinds(env, exists),
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'XDG_DATA_HOME',
    opencodeHome,
    '--setenv',
    'XDG_CONFIG_HOME',
    join(opencodeHome, 'config'),
    '--setenv',
    'XDG_CACHE_HOME',
    join(opencodeHome, 'cache'),
    '--setenv',
    'XDG_STATE_HOME',
    join(opencodeHome, 'state'),
    '--setenv',
    'OPENCODE_DISABLE_AUTOUPDATE',
    '1',
    '--setenv',
    'TAR_OPTIONS',
    '--no-same-owner',
  );
  if (compactionFile) args.push('--setenv', 'KSAI_COMPACTION_FILE', compactionFile);
  const relay = String(env.KSAI_OTEL_RELAY ?? '').trim();
  if (relay) args.push('--setenv', EXPORTER_ENDPOINT, relay);
  const providerRelay = String(env.KSAI_PROVIDER_RELAY ?? '').trim();
  if (isolatedTools) {
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(providerRelay)) {
      throw new Error('write-phase provider relay is not a loopback origin');
    }
    args.push('--setenv', 'KSAI_PROVIDER_RELAY', providerRelay);
  }
  if (env.OPENCODE_LSP_TOOL === 'native') {
    args.push(
      '--setenv', 'OPENCODE_EXPERIMENTAL_LSP_TOOL', 'true',
      '--setenv', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'true',
    );
  }
  const scrubbed = isolatedTools ? [...SCRUBBED, ...BROKERED] : scrubbing(env) ? SCRUBBED : [];
  const denied = listed(env.SANDBOX_DENY_ENV);
  if (relay && denied.includes(EXPORTER_ENDPOINT)) {
    console.log(
      `::warning::this caller denies ${EXPORTER_ENDPOINT} to the sandbox, which is the relay's own address, so this run exports no trace and no log line`,
    );
  }
  const exporter = relay ? [] : [EXPORTER_ENDPOINT];
  for (const name of new Set([...UNSET, ...exporter, ...scrubbed, ...denied])) {
    args.push('--unsetenv', name);
  }
  args.push(
    '--setenv',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    '1',
    '--setenv',
    'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    '1',
    '--setenv',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    '1',
    '--setenv',
    'OPENCODE_DISABLE_DEFAULT_PLUGINS',
    '1',
    '--setenv',
    'OPENCODE_DISABLE_MODELS_FETCH',
    '1',
    '--setenv',
    'OPENCODE_CONFIG_DIR',
    providerPolicyDirectory(opencodeHome),
    '--unshare-user',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent',
    '--chdir',
    workspace,
    '--',
  );
  return args;
}

/**
 * withoutExporter answers the same sandbox with its exporter endpoint unset.
 *
 * The relay serves from this process's event loop, and `spawnSync` stops that loop for as long as
 * the child runs - so a child that exported would block on a response nothing can write until its
 * own exporter gives up. The version probe and every `opencode export` are spawned that way and
 * have no telemetry worth keeping, so they are handed a sandbox that exports nothing. The list is
 * still built once, because a probe that proved a different sandbox proves nothing.
 */
export function withoutExporter(args) {
  const at = args.findIndex((entry, index) => entry === EXPORTER_ENDPOINT && args[index - 1] === '--setenv');
  if (at < 1) return args;
  return [...args.slice(0, at - 1), '--unsetenv', EXPORTER_ENDPOINT, ...args.slice(at + 2)];
}

export function runArgs(env = process.env) {
  const named = String(env.MODEL ?? '').trim() || DEFAULT_OPENCODE_MODEL;
  const args = ['run', '--model', `anthropic/${named}`, '--format', 'json'];
  const staged = env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
  const structuredFinal = env.FLOW === 'review' && env.REVIEW_RESULT_TRANSPORT === 'structured' && env.OPENCODE_REVIEW_FINALIZE === 'true';
  if (staged) args.push('--agent', env.OPENCODE_REVIEW_FINALIZE === 'true' ? 'ksai-review-finish' : 'ksai-review-stage');
  else if (structuredFinal) args.push('--agent', 'ksai-review-structured-finish');
  const variant = String(env.VARIANT ?? '').trim();
  if (variant && !(env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY) && env.OPENCODE_REVIEW_FINALIZE === 'true')) args.push('--variant', variant);
  const session = String(env.OPENCODE_RESUME_SESSION ?? '').trim();
  if (session) args.push('--session', session, '--fork');
  return args;
}

export function validateProviderPolicy(home, version, read = readFileSync) {
  validateProviderPolicyVersion(version);
  const at = providerPolicyFile(home);
  let policy;
  try {
    policy = JSON.parse(read(at, 'utf8'));
  } catch (error) {
    throw new Error(`trusted provider policy ${at} cannot be read: ${error.message}`, { cause: error });
  }
  validateProviderPolicyConfig(policy, at);
  return at;
}

export async function writeToken(at, env, now = Date.now(), ask = bearer, expiry = heldExpiry) {
  const token = await ask({ env, now });
  if (!token) return false;
  const staged = `${at}.staged`;
  writeFileSync(staged, `${JSON.stringify({ token, expires_at: expiryOf(env, now, expiry()) })}\n`);
  renameSync(staged, at);
  return true;
}

function expiryOf(env, now, held) {
  if (Number.isFinite(held) && held > 0) return held;
  const seeded = Number(env.ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT);
  return Number.isFinite(seeded) && seeded > now ? seeded : now + BROKER_PERIOD_MS * 2;
}

let brokering = false;

/**
 * broker writes the run's token to the file the sandbox reads, at most one write at a time.
 *
 * A mint that outlasts the tick used to leave every tick behind it queued on the same refusal, and
 * each one of those is another mint against an exchange that rate-limits exactly this. One write in
 * flight is therefore the whole policy: a tick that arrives on top of a slow one is dropped, and the
 * next one sixty seconds later finds the mint either finished or still worth skipping.
 */
export async function broker(at, env, write = writeToken) {
  if (brokering) return false;
  brokering = true;
  try {
    return await write(at, env);
  } catch (error) {
    console.log(`::warning::the run's token could not be brokered (${error?.message}), so it holds the one it started on`);
    return false;
  } finally {
    brokering = false;
  }
}

/**
 * main runs the review. `probe` is injectable for one reason: the abort below has to be executable.
 *
 * It was asserted by reading this file for the error string, which survives disabling the branch -
 * `if (false && probe.status !== 0)` left the whole suite green while a run proceeded past a
 * sandbox that never started, every tool call died at exec, and the empty event stream was
 * published as a reviewer that wrote nothing.
 */
async function main(env = process.env, {
  probe: probeWith = spawnSync,
  startProvider = startProviderRelay,
} = {}) {
  const home = String(env.OPENCODE_HOME ?? '');
  for (const name of ['config', 'cache', 'state']) mkdirSync(join(home, name), { recursive: true });
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  writeFileSync(events, '');
  writeOutputs(env.GITHUB_OUTPUT, {
    execution_file: execution,
  });

  const isolatedTools = isolatedToolPhase(env.OPENCODE_PHASE);
  const tokenDir = !isolatedTools && String(env.RUNNER_TEMP ?? '') ? join(String(env.RUNNER_TEMP), 'ksai-token') : '';
  const tokenFile = tokenDir ? join(tokenDir, 'token.json') : '';
  if (tokenDir) mkdirSync(tokenDir, { recursive: true });

  const resultTransport = env.FLOW === 'review' ? String(env.REVIEW_RESULT_TRANSPORT ?? '').trim() || 'tool' : 'text';
  if (!['text', 'tool', 'structured'].includes(resultTransport)) {
    console.log(`::error::unknown review result transport: ${resultTransport}`);
    return 1;
  }
  const runnerTemp = String(env.RUNNER_TEMP ?? '');
  if (resultTransport === 'tool' && !runnerTemp) {
    console.log('::error::typed review results require RUNNER_TEMP');
    return 1;
  }
  if (resultTransport === 'structured' && (!runnerTemp || !existsSync(String(env.OPENCODE_SDK_ROOT ?? '')))) {
    console.log('::error::structured review results require the pinned SDK under RUNNER_TEMP');
    return 1;
  }
  const resultDir = resultTransport === 'tool' ? mkdtempSync(join(runnerTemp, 'review-results-')) : '';
  if (resultDir) chmodSync(resultDir, 0o700);
  const ptyMetrics = ptyPilotEnabled(env) ? join(runnerTemp, 'opencode-pty-metrics.json') : '';
  if (ptyMetrics) {
    writeFileSync(ptyMetrics, '{"version":1,"leaked_process_count":null}\n', { mode: 0o600 });
    env.KSAI_PTY_METRICS_FILE = ptyMetrics;
  }
  const removePtyMetrics = () => {
    if (ptyMetrics) rmSync(ptyMetrics, { force: true });
  };

  let compactionDir = '';
  if (runnerTemp && supportsCompaction(env.OPENCODE_VERSION)) {
    try {
      compactionDir = mkdtempSync(join(runnerTemp, 'opencode-compaction-'));
      chmodSync(compactionDir, 0o700);
    } catch (error) {
      console.log(`::warning::compaction telemetry could not be prepared (${error?.message})`);
    }
  } else if (runnerTemp) {
    console.log(`::warning::compaction telemetry is unavailable for OpenCode ${env.OPENCODE_VERSION || '(unknown)'}`);
  }

  try {
    validateProviderPolicy(home, env.OPENCODE_VERSION);
  } catch (error) {
    console.log(`::error::${error.message}`);
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
    if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
    removePtyMetrics();
    return 1;
  }
  const traces = traceObserver();
  let relay = null;
  let providerRelay = null;
  try {
    relay = await startRelay({ env, observe: traces.observe });
  } catch (error) {
    console.log(`::warning::runtime telemetry could not start (${error?.message}), so span timings are unavailable`);
  }
  if (isolatedTools) {
    try {
      providerRelay = await startProvider({ env });
    } catch (error) {
      console.log(`::error::the trusted provider relay could not start: ${error?.message ?? error}`);
      await relay?.close();
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
      removePtyMetrics();
      return 1;
    }
  }
  const sandboxEnv = {
    ...env,
    KSAI_TOKEN_DIR: tokenDir,
    KSAI_TOKEN_FILE: tokenFile,
    KSAI_REVIEW_RESULT_DIR: resultDir,
    KSAI_OTEL_RELAY: relay?.url ?? '',
    KSAI_PROVIDER_RELAY: providerRelay?.url ?? '',
    KSAI_COMPACTION_FILE: '',
  };
  const sandbox = sandboxArgs(sandboxEnv);
  const quiet = withoutExporter(sandbox);
  const probe = probeWith('bwrap', [...quiet, 'opencode', '--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (probe.status !== 0) {
    const said = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || String(probe.error?.message ?? 'no output');
    console.log(
      `::error::opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no run was attempted: ${said}`,
    );
    await relay?.close();
    await providerRelay?.close();
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
    if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
    removePtyMetrics();
    return 1;
  }
  if (isolatedTools) {
    let isolated;
    try {
      isolated = toolIsolationProbe(sandboxEnv);
    } catch (error) {
      console.log(`::error::tool isolation could not be described: ${error.message}`);
      await relay?.close();
      await providerRelay?.close();
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
      removePtyMetrics();
      return 1;
    }
    const nested = probeWith('bwrap', [...quiet, isolated.command, ...isolated.args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (nested.status !== 0) {
      const said = `${nested.stdout ?? ''}${nested.stderr ?? ''}`.trim() || String(nested.error?.message ?? 'no output');
      console.log(`::error::write-phase tools cannot enter their credential-free network namespace: ${said}`);
      await relay?.close();
      await providerRelay?.close();
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
      removePtyMetrics();
      return 1;
    }
  } else if (ptyPilotEnabled(env)) {
    const isolated = isolatedPtyCommand('true', [], String(env.GITHUB_WORKSPACE ?? ''), true);
    const nested = probeWith('bwrap', [...quiet, isolated.command, ...isolated.args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (nested.status !== 0) {
      const said = `${nested.stdout ?? ''}${nested.stderr ?? ''}`.trim() || String(nested.error?.message ?? 'no output');
      console.log(`::error::the PTY pilot cannot create its per-session namespace: ${said}`);
      await relay?.close();
      await providerRelay?.close();
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
      removePtyMetrics();
      return 1;
    }
  }
  console.log(`sandboxed opencode ${String(probe.stdout ?? '').trim()}`);

  const out = openSync(events, 'w');
  let nativeCgroup = '';
  let nativeReturnCgroup = '';
  let nativeGuardian = null;
  let nativeGuardianLost = false;
  let nativeEmergencyCleanup = null;
  let stopGuardianWatch = null;
  if (env.OPENCODE_LSP_TOOL === 'native') {
    try {
      nativeReturnCgroup = processCgroup(readFileSync('/proc/self/cgroup', 'utf8'));
      nativeGuardian = await startCgroupGuardian(
        join(String(env.SCRIPTS ?? ''), 'kreview/opencode-cgroup.mjs'),
        nativeReturnCgroup,
      );
      nativeCgroup = prepareCgroup({ root: nativeReturnCgroup });
      if (nativeCgroup !== nativeGuardian.at) throw new Error('the native resource guardian watches another cgroup');
      stopGuardianWatch = watchCgroupGuardian(nativeGuardian, () => {
        nativeGuardianLost = true;
        console.log(`::error::the native LSP resource guardian stopped before cleanup of ${nativeCgroup}`);
        nativeEmergencyCleanup = destroyCgroup(nativeCgroup).catch(() => false);
      });
      if (nativeGuardianLost) throw new Error('the native resource guardian stopped after setup');
    } catch (error) {
      stopGuardianWatch?.();
      if (nativeEmergencyCleanup) await nativeEmergencyCleanup;
      else if (nativeGuardian) await removeGuardedCgroup(nativeGuardian, nativeGuardian.at);
      console.log(`::error::the native LSP arm needs its delegated resource cgroup before model execution: ${error?.message ?? error}`);
      closeSync(out);
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
      removePtyMetrics();
      return 1;
    }
  }

  let code = 0;
  let deadlineExpired = false;
  let ticking = null;
  const runtimeMetrics = [];
  let configuredMcp = null;
  try {
    configuredMcp = mcpServerCount(JSON.parse(readFileSync(String(env.OPENCODE_CONFIG ?? ''), 'utf8')));
  } catch {}
  let runtime = runtimeSummary(runtimeMetrics, configuredMcp);
  try {
    if (tokenFile) {
      await broker(tokenFile, env);
      ticking = setInterval(() => void broker(tokenFile, env), BROKER_PERIOD_MS);
      ticking.unref?.();
    }
    const pipeline = env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
    let resultSequence = 0;
    const invoke = async ({ prompt, timeoutMs = 0, resumeSession = '', finalize = false, resultKind = 'final', candidateIds = [] }) => {
      const offset = statSync(events).size;
      const resultFile = resultDir ? join(resultDir, `${resultSequence += 1}.json`) : '';
      let compactionFile = '';
      if (compactionDir) {
        try {
          compactionFile = join(compactionDir, `${runtimeMetrics.length + 1}.jsonl`);
          writeFileSync(compactionFile, '');
          chmodSync(compactionFile, 0o600);
        } catch (error) {
          compactionFile = '';
          console.log(`::warning::compaction telemetry is unavailable for this invocation (${error?.message})`);
        }
      }
      const runEnv = env.FLOW === 'review'
        ? { ...env, KSAI_COMPACTION_FILE: compactionFile, OPENCODE_RESUME_SESSION: resumeSession, OPENCODE_REVIEW_FINALIZE: String(finalize) }
        : { ...env, KSAI_COMPACTION_FILE: compactionFile };
      const invocationSandbox = compactionFile ? sandboxArgs({
        ...env,
        KSAI_TOKEN_DIR: tokenDir,
        KSAI_TOKEN_FILE: tokenFile,
        KSAI_REVIEW_RESULT_DIR: resultDir,
        KSAI_OTEL_RELAY: relay?.url ?? '',
        KSAI_PROVIDER_RELAY: providerRelay?.url ?? '',
        KSAI_COMPACTION_FILE: compactionFile,
      }) : sandbox;
      const nativeRuntime = env.OPENCODE_LSP_TOOL === 'native';
      if (nativeRuntime && nativeGuardianLost) throw new Error('the native resource guardian stopped during the run');
      const innerCommand = resultTransport === 'structured' ? process.execPath : 'opencode';
      const innerArgs = resultTransport === 'structured'
        ? [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-structured.mjs')]
        : runArgs(runEnv);
      const command = nativeRuntime ? process.execPath : 'bwrap';
      const args = ['bwrap', ...invocationSandbox, innerCommand, ...innerArgs];
      if (nativeRuntime) args.unshift(join(String(env.SCRIPTS ?? ''), 'kreview/opencode-cgroup.mjs'), nativeCgroup, nativeReturnCgroup, String(process.pid), '--');
      else args.shift();
      const began = Date.now();
      relay?.beginObservation();
      const finishTrace = traces.begin(began);
      const ran = spawn(command, args, {
        env: { ...runEnv, KSAI_REVIEW_RESULT_FILE: resultFile, KSAI_REVIEW_RESULT_KIND: resultKind, KSAI_REVIEW_CANDIDATE_IDS: JSON.stringify(candidateIds) },
        stdio: ['pipe', out, 'inherit'],
      });
      const stopEnforcing = nativeRuntime ? monitorCgroup(
        nativeCgroup,
        undefined,
        undefined,
        undefined,
        undefined,
        (reason) => {
          console.log(`::error::the native LSP run exceeded its aggregate resource limit: ${reason}`);
          ran.kill('SIGKILL');
        },
      ) : null;
      const stopMonitoring = monitorProcess(ran.pid);
      let hardStop = null;
      let timedOut = false;
      const timeout = timeoutMs ? setTimeout(() => {
        timedOut = true;
        ran.kill('SIGTERM');
        hardStop = setTimeout(() => ran.kill('SIGKILL'), 2000);
      }, timeoutMs) : null;
      ran.stdin.on('error', () => {});
      ran.stdin.end(prompt);
      let status = await new Promise((ended) => {
        ran.on('error', () => ended(127));
        ran.on('close', (value, signal) => ended(exitedOn(value, signal)));
      });
      const enforcement = stopEnforcing?.();
      status = enforcedStatus(status, enforcement);
      const ended = Date.now();
      const runtimeMetric = {
        invocation: runtimeMetrics.length + 1,
        exit_code: status,
        total_ms: Math.max(0, ended - began),
        ...compactionSample(compactionFile, began, ended),
        ...finishTrace(ended),
        ...stopMonitoring(),
      };
      runtimeMetrics.push(runtimeMetric);
      if (timeout) clearTimeout(timeout);
      if (hardStop) clearTimeout(hardStop);
      const segment = parsed(readFileSync(events).subarray(offset).toString('utf8'));
      Object.assign(runtimeMetric, toolTiming(segment, began, ended));
      const submission = resultTransport === 'tool'
        ? submitted({ file: resultFile, events: segment, kind: resultKind, candidateIds })
        : resultTransport === 'structured'
          ? structuredSubmission({ events: segment, kind: resultKind, candidateIds })
          : null;
      const [result] = executionLog({ events: segment, exitCode: status, said: answer(segment) });
      const remaining = timeoutMs - (Date.now() - began);
      const recorded = pipeline && status === 0 && remaining > 0 ? recordedCompletion(segment, (id) => readExport({ env, sandbox: quiet, id, timeoutMs: Math.min(15_000, remaining) })) : {};
      return { code: status, text: submission?.text ?? recorded.text ?? (env.FLOW === 'review' && !pipeline ? reviewAnswer(segment) : answer(segment)), submission, completion: recorded.completion, session_id: segment.find((event) => typeof event.sessionID === 'string')?.sessionID,
        failure: streamFailure(segment), timed_out: timedOut,
        usage: spending(segment).length ? { ...result.usage, cost_usd: result.total_cost_usd, num_turns: result.num_turns } : null };
    };
    const budget = { remaining: 1 };
    const recovering = async (options) => {
      const result = await recoverReview({ ...options, flow: env.FLOW, invoke, budget });
      for (const attempt of result.attempts) writeSync(out, `${JSON.stringify({ type: 'ksai_review_attempt', ...attempt })}\n`);
      return result;
    };
    const run = (options) => pipeline
      ? completeStage({ ...options, resultTransport, invoke: recovering })
      : env.FLOW === 'review' && resultTransport === 'structured'
        ? completeFinal({ ...options, invoke: recovering })
        : env.FLOW === 'review' ? recovering(options) : invoke(options);
    const prompt = readFileSync(String(env.PROMPT_FILE ?? ''), 'utf8');
    if (pipeline) {
      Object.assign(env, await reviewSession({ env, events, prompt, run }));
      code = Number(env.OPENCODE_REVIEW_EXIT);
    } else {
      const killAt = Number(env.KSAI_CHANNEL_KILL_AT);
      const timeoutMs = env.FLOW === 'review' ? killAt > 0 ? Math.max(0, killAt - Date.now()) : LIMITS.totalMs : 0;
      const result = env.FLOW === 'review' && timeoutMs === 0 ? { code: 124, timed_out: true } : await run({ prompt, timeoutMs });
      code = result.code === 0 && resultTransport !== 'text' && result.submission?.status !== 'accepted' ? 1 : result.code;
      env.OPENCODE_REVIEW_SUBMISSION_STATUS = result.submission?.status ?? '';
      env.OPENCODE_REVIEW_CORRECTIONS = String(result.corrections ?? 0);
      deadlineExpired = result.timed_out === true;
      if ((resultTransport !== 'text' && result.submission?.status === 'accepted') || result.attempts?.length > 1) {
        const reviewFile = `${events}.review.json`;
        writeFileSync(reviewFile, scrub(result.text ?? '', collectSecrets(env)));
        env.OPENCODE_REVIEW_FILE = reviewFile;
      }
    }
  } catch {
    code = 1;
    console.log('::error::the model runner failed; reducing and redacting the partial stream');
  } finally {
    if (ticking) clearInterval(ticking);
    runtime = runtimeSummary(runtimeMetrics, configuredMcp);
    try {
      writeSync(out, `${JSON.stringify({ type: 'ksai_runtime', runtime })}\n`);
    } catch (error) {
      console.log(`::warning::runtime measurements could not be recorded (${error?.message})`);
    }
    closeSync(out);
    if (nativeGuardian) {
      stopGuardianWatch?.();
      const removed = nativeEmergencyCleanup
        ? await nativeEmergencyCleanup
        : await removeGuardedCgroup(nativeGuardian, nativeCgroup);
      code = cleanupStatus(code, removed && !nativeGuardianLost);
      if (!removed) console.log(`::error::the native LSP resource guardian could not remove ${nativeCgroup}`);
    }
  }
  const reason = stopReason(code);
  console.log(`opencode exit=${code}`);
  if (deadlineExpired) {
    console.log(`::error::${reason}; the review deadline expired, so this attempt has no finished answer`);
  } else if (code > 128) {
    console.log(
      `::error::${reason}; an external signal stopped this attempt before it returned a finished answer`,
    );
  }

  if (env.FLOW === 'review') {
    try {
      Object.assign(env, recordChildren({ env, events, sandbox: quiet }));
    } catch {
      console.log('::warning::child sessions could not be recorded; their usage remains unmeasured');
    }
  }
  if (ptyMetrics) {
    try {
      const metrics = JSON.parse(readFileSync(ptyMetrics, 'utf8'));
      metrics.active_at_runner_exit = Number(metrics.active_sessions) || 0;
      metrics.namespace_cleanup_count = metrics.active_at_runner_exit;
      metrics.active_sessions = 0;
      writeFileSync(ptyMetrics, `${JSON.stringify(metrics)}\n`);
    } catch {
      console.log('::warning::the PTY pilot metrics could not be finalized');
    }
  }
  await relay?.close();
  await providerRelay?.close();
  const reduced = spawnSync(process.execPath, [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-log.mjs')], {
    env: {
      ...env,
      OPENCODE_EXIT: String(code),
      OPENCODE_EVENTS_FILE: events,
      OPENCODE_EXECUTION_FILE: execution,
      OPENCODE_RUNTIME_METRICS: JSON.stringify(runtime),
    },
    stdio: 'inherit',
  });
  removePtyMetrics();
  if (reduced.status !== 0) {
    console.log('::error::the opencode event stream could not be reduced to an execution log, so this run reports nothing it spent');
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
    if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
    return 1;
  }
  if (resultDir) rmSync(resultDir, { recursive: true, force: true });
  if (compactionDir) rmSync(compactionDir, { recursive: true, force: true });
  writeOutputs(env.GITHUB_OUTPUT, {
    pipeline_file: env.REVIEW_PIPELINE_FILE || '',
    children_file: env.OPENCODE_CHILDREN_FILE || '',
    hypotheses_file: env.REVIEW_HYPOTHESES_FILE || '',
    conclusion: conclusionOf(execution),
  });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
