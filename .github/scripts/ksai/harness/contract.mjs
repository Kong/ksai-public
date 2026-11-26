import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import json from '../../lib/json.cjs';
import { validSessionEnvironment } from '../../lib/tool-environment.mjs';
import { STOP_GRACE_MS } from '../deadline-command.mjs';
import { ENV_NAME, RESERVED_ENV, toolchainOf } from '../stage-steps.mjs';

export const PROFILE = 'workflow-harness';
export const PHASE = 'package-harness';
export const CAPABILITY_KEY = 'harness';
export const CAPABILITY_CONTRACT = 'ksai.konghq.com/stage-harness/v1';
export const PLAN_FIELD = 'harness_plan';
export const BASE_SHA_FIELD = 'harness_base_sha';
export const RUNNER_FIELD = 'harness_runner';
export const NATIVE_HARNESS_FIELD = 'native_harness';
export const PLAN_FILE_OUTPUT = 'harness_plan_file';
export const RUNNER_OUTPUT = RUNNER_FIELD;
export const PROFILE_OUTPUT = 'profile';
export const JOB_DEADLINE_OUTPUT = 'job_deadline_at';
export const STAGE_LATE_OUTPUT = 'stage_late';
export const SESSION_REFUSED_OUTPUT = 'session_refused';
export const SESSION_REFUSED_VALUE = 'true';
export const UNVERIFIED_ANSWER = 'the stage has no verified answer';
export const ENGINE_STOP_MS = 45_000;
export const HOST_EXIT_MARGIN_MS = 5000;
export const CHANNEL_KILL_AT = 'KSAI_CHANNEL_KILL_AT';
export const LAUNCH_DEADLINE_AT = 'KSAI_LAUNCH_DEADLINE_AT';
export const DEADLINES_MODE = 'deadlines';
export const TOOL_ROOT = '$RUNNER_TEMP/ksai-harness-tools';
export const RELAY_DIR_ENV = 'KSAI_HARNESS_RELAY_DIR';
export const SESSION_ENV = 'KSAI_HARNESS_SESSION_ENV';
export const RELAY_LINE = 'harness relay sockets at ';
export const RELAY_STEP = 'relay';
export const HARNESS_TOOL_WRAPPER_ENV = Object.freeze(['OPENCODE_PHASE', RELAY_DIR_ENV, 'KSAI_MODEL_PATH']);
export const SETUP_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ARCH', 'DOCKER_HOST', 'DOCKER_CONFIG',
]);
export const MAX_PLAN_BYTES = 256 * 1024;
export const MODEL_MIN_SECONDS = 60;
export const MAX_ENVIRONMENTS = 32;
export const MAX_ENVIRONMENT_NAME = 128;
export const MAX_STARTED_BY = 2048;
export const MAX_ENDPOINT_URL = 1024;
export const MAX_EXPORTS_PATH_BYTES = 64 * 1024;
export const SETUP_STEP_IDS = Object.freeze({
  restore: 'harness_restore',
  files: 'harness_files',
  up: 'harness_setup',
  relay: 'harness_relay',
});

const BUDGET_MAX = Object.freeze({
  setup_seconds: 600,
  teardown_seconds: 180,
  start_seconds: 30,
  mint_seconds: 15,
  model_min_seconds: MODEL_MIN_SECONDS,
  completion_seconds: 240,
});
const MAX_PORT = 65_535;
const MAX_STEP_ID = 128;
const MAX_PROBE_SECONDS = 180;
const MAX_PROBE_INTERVAL_SECONDS = 2;
const MAX_PROBE_TRY_SECONDS = 5;
const MIN_COMPLETION_MS = 60_000;
export const REAP_WINDOW_MS = 5000;
export const TEARDOWN_TAIL_MS = 2 * STOP_GRACE_MS + REAP_WINDOW_MS;
const PHASES = new Set(['prepare', 'setup', 'teardown']);
const COMMIT = /^[0-9a-f]{40}$/;
const HTTP_AUTHORITY = /^[^\s@/?#\\]+$/u;
const AUTHORITY = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u;
const TMP = '/tmp';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && !value.includes('\0');
const characters = (value) => [...value].length;
const nonempty = (value) => text(value) && value !== '';
const between = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const list = (value, valid) => Array.isArray(value) && value.every((entry) => valid(entry));
const keys = (value, required, optional = []) => record(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const strings = (value, name, item) => record(value) && Object.entries(value).every(([key, entry]) => name(key) && item(entry));
const component = (value) => nonempty(value) && !/[\\/]/u.test(value) && value !== '.' && value !== '..';
const workPath = (value) => nonempty(value) && value.split('/').every((part) => component(part))
  && value !== '.git' && !value.startsWith('.git/');
const stepID = (value) => nonempty(value) && characters(value) <= MAX_STEP_ID && value !== RELAY_STEP;
const environmentName = (value) => text(value) && characters(value) <= MAX_ENVIRONMENT_NAME;
const environmentKey = (key) => ENV_NAME.test(key) && !RESERVED_ENV.test(key);

function validRestore(restore) {
  return keys(restore, ['paths', 'commits']) && list(restore.paths, workPath)
    && list(restore.commits, (commit) => typeof commit === 'string' && COMMIT.test(commit));
}

function validRemove(remove) {
  return keys(remove, ['paths', 'root_prefixes', 'keep', 'names'])
    && list(remove.paths, workPath) && list(remove.root_prefixes, component)
    && list(remove.keep, component) && list(remove.names, component);
}

function validStep(step, endpoints) {
  return keys(step, ['id', 'environment', 'phase', 'argv', 'env', 'detach', 'tools', 'exports_path', 'ready', 'timeout_seconds'])
    && stepID(step.id) && environmentName(step.environment) && PHASES.has(step.phase)
    && list(step.argv, text) && nonempty(step.argv[0])
    && strings(step.env, environmentKey, text)
    && typeof step.detach === 'boolean' && typeof step.tools === 'boolean' && typeof step.exports_path === 'boolean'
    && (!step.exports_path || (step.phase === 'prepare' && !step.detach))
    && list(step.ready, (index) => between(index, 0, endpoints - 1))
    && between(step.timeout_seconds, 1, step.phase === 'teardown' ? BUDGET_MAX.teardown_seconds : BUDGET_MAX.setup_seconds);
}

function validOwner(owner, steps) {
  switch (owner?.kind) {
    case 'container':
      return keys(owner, ['kind', 'labels']) && strings(owner.labels, nonempty, text)
        && Object.keys(owner.labels).length > 0;
    case 'process_group':
      return keys(owner, ['kind', 'step']) && steps.has(owner.step);
    default:
      return false;
  }
}

function authorityHost(authority, scheme) {
  if (typeof authority !== 'string' || !HTTP_AUTHORITY.test(authority)) return '';
  const match = AUTHORITY.exec(authority);
  if (!match || (match[2] !== undefined && !between(Number(match[2]), 1, MAX_PORT))) return '';
  try {
    return new URL(`${scheme}://${authority}`).hostname ? match[1] : '';
  } catch {
    return '';
  }
}

function validProbe(probe, sandboxPort) {
  if (!keys(probe, ['kind', 'scheme', 'authority', 'target', 'status_min', 'status_max', 'interval_seconds', 'try_seconds', 'timeout_seconds'])
    || probe.kind !== 'http' || (probe.scheme !== 'http' && probe.scheme !== 'https')) return false;
  const host = authorityHost(probe.authority, probe.scheme);
  return host !== '' && text(probe.target) && probe.target.startsWith('/')
    && ![...probe.target].some((char) => char <= ' ' || char === '\u007F')
    && characters(`${probe.scheme}://${host}:${sandboxPort}${probe.target}`) <= MAX_ENDPOINT_URL
    && between(probe.status_min, 100, 599) && between(probe.status_max, probe.status_min, 599)
    && between(probe.interval_seconds, 1, MAX_PROBE_INTERVAL_SECONDS)
    && between(probe.try_seconds, 1, MAX_PROBE_TRY_SECONDS)
    && between(probe.timeout_seconds, 1, MAX_PROBE_SECONDS);
}

function validEndpoint(endpoint, steps) {
  return keys(endpoint, ['environment', 'address', 'port', 'sandbox_port', 'owner'], ['probe'])
    && environmentName(endpoint.environment) && endpoint.address === '127.0.0.1'
    && between(endpoint.port, 1, MAX_PORT) && between(endpoint.sandbox_port, 1024, MAX_PORT)
    && validOwner(endpoint.owner, steps)
    && (Object.hasOwn(endpoint, 'probe') ? validProbe(endpoint.probe, endpoint.sandbox_port) : endpoint.owner.kind === 'container');
}

function validBudget(budget) {
  return keys(budget, Object.keys(BUDGET_MAX))
    && Object.entries(BUDGET_MAX).every(([key, maximum]) => between(budget[key], 1, maximum))
    && budget.model_min_seconds === MODEL_MIN_SECONDS && budget.mint_seconds <= budget.start_seconds
    && budget.teardown_seconds * 1000 > TEARDOWN_TAIL_MS + HOST_EXIT_MARGIN_MS + STOP_GRACE_MS;
}

function refusePlan(field) {
  throw Object.assign(new Error(`invalid harness plan: ${field}`), { field });
}

export function validatePlan(value, env = process.env) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  if (!bytes || Buffer.byteLength(bytes) > MAX_PLAN_BYTES) refusePlan('plan bytes');
  let plan;
  try {
    plan = json.parseIJson(bytes);
  } catch {
    refusePlan('json');
  }
  if (!keys(plan, ['restore', 'remove', 'toolchains', 'steps', 'endpoints', 'files', 'budget', 'session_env'])) refusePlan('fields');
  if (!validSessionEnvironment(plan.session_env, env)) refusePlan('session_env');
  if (!validRestore(plan.restore)) refusePlan('restore');
  if (!validRemove(plan.remove)) refusePlan('remove');
  if (!list(plan.toolchains, toolchainOf) || new Set(plan.toolchains.map(({ name }) => name)).size !== plan.toolchains.length) {
    refusePlan('toolchains');
  }
  if (!Array.isArray(plan.endpoints) || !list(plan.steps, (step) => validStep(step, plan.endpoints.length))) {
    refusePlan('steps');
  }
  const steps = new Set(plan.steps.map(({ id }) => id));
  if (steps.size !== plan.steps.length) refusePlan('step ids');
  const environments = plan.steps.filter((step) => step.phase === 'setup' && step.environment !== '');
  if (environments.length > MAX_ENVIRONMENTS || environments.some((step) => characters(step.argv.join(' ')) > MAX_STARTED_BY)) {
    refusePlan('environments');
  }
  if (!plan.endpoints.every((endpoint) => validEndpoint(endpoint, steps))
    || new Set(plan.endpoints.map(({ sandbox_port: port }) => port)).size !== plan.endpoints.length) {
    refusePlan('endpoints');
  }
  if (!strings(plan.files, workPath, (entry) => typeof entry === 'string')) refusePlan('files');
  if (!validBudget(plan.budget)) refusePlan('budget');
  return plan;
}

export function harnessDeadlines(jobDeadlineAt, budget, engineStopMs) {
  const deadline = Number(jobDeadlineAt);
  if (!between(deadline, 1, Number.MAX_SAFE_INTEGER) || !validBudget(budget)
    || !between(engineStopMs, 1, Number.MAX_SAFE_INTEGER)) throw new Error('invalid harness deadline or budget');
  const completionAt = deadline - Math.max(MIN_COMPLETION_MS, budget.completion_seconds * 1000);
  const killAt = completionAt - budget.teardown_seconds * 1000 - engineStopMs;
  const launchAt = killAt - engineStopMs - budget.model_min_seconds * 1000;
  return {
    job_deadline_at: deadline,
    setup_deadline_at: launchAt - budget.start_seconds * 1000,
    teardown_deadline_at: completionAt - TEARDOWN_TAIL_MS,
    reap_deadline_at: completionAt - STOP_GRACE_MS,
    kill_at: killAt,
    launch_at: launchAt,
  };
}

const STEP_FAILURES = Object.freeze({
  deadlines: ['setup', 'deadline_missing', 'deadline_missing'],
  review_base: ['restore', 'restore_deadline', 'restore_failed'],
  [SETUP_STEP_IDS.restore]: ['restore', 'restore_deadline', 'restore_failed'],
  steering: ['setup', 'setup_deadline', 'setup_failed'],
  cleanup: ['setup', 'setup_deadline', 'setup_failed'],
  build_run: ['setup', 'setup_deadline', 'setup_failed'],
  governed_run: ['setup', 'setup_deadline', 'setup_failed'],
  opencode_install: ['setup', 'setup_deadline', 'setup_failed'],
  model_headers: ['setup', 'setup_deadline', 'setup_failed'],
  governance_prepare: ['setup', 'setup_deadline', 'setup_failed'],
  [SETUP_STEP_IDS.files]: ['setup', 'setup_deadline', 'setup_failed'],
  [SETUP_STEP_IDS.up]: ['setup', 'setup_deadline', 'setup_failed'],
  [SETUP_STEP_IDS.relay]: ['relay', 'relay_deadline', 'relay_failed'],
  mint: ['mint', 'mint_deadline', 'mint_failed'],
  harness_cutoff: ['cutoff', 'start_reserve', 'start_reserve'],
});

export const FAILURES = Object.freeze({
  baseUnavailable: Object.freeze({ phase: 'restore', reason: 'base_unavailable' }),
  restoreRefused: Object.freeze({ phase: 'restore', reason: 'restore_refused' }),
  toolchainDeadline: Object.freeze({ phase: 'toolchain', reason: 'toolchain_deadline' }),
  toolchainFailed: Object.freeze({ phase: 'toolchain', reason: 'toolchain_failed' }),
  filesRefused: Object.freeze({ phase: 'setup', reason: 'files_refused' }),
  endpointNotOwned: Object.freeze({ phase: 'probe', reason: 'endpoint_not_owned' }),
  ownerUnreadable: Object.freeze({ phase: 'probe', reason: 'owner_unreadable' }),
  probeDeadline: Object.freeze({ phase: 'probe', reason: 'probe_deadline' }),
  probeFailed: Object.freeze({ phase: 'probe', reason: 'probe_failed' }),
  sessionRefused: Object.freeze({ phase: 'cutoff', reason: 'session_refused' }),
  stageLate: Object.freeze({ phase: 'setup', reason: 'stage_late' }),
});

export function stepFailure(step, exitCode, cancelled = false) {
  if (!Object.hasOwn(STEP_FAILURES, step)) throw new Error(`unknown harness action step: ${step}`);
  const [phase, deadline, failure] = STEP_FAILURES[step];
  const exit = Number(exitCode);
  const reason = exit === 124 ? deadline : exit === 130 || cancelled ? 'cancelled' : failure;
  return { phase, reason };
}

export function modelLaunchRefused(exitCode, outputs) {
  return Number(exitCode) === 124 && String(outputs?.launched) === 'false' && !outputs?.conclusion;
}

export const stateDirOf = (temp) => join(temp, 'ksai-harness');
export const stateFileOf = (stateDir) => join(stateDir, 'state.json');
export const factsFileOf = (stateDir) => join(stateDir, 'facts.json');
export const setupTreeOf = (temp) => join(temp, 'ksai-harness-setup');
export const toolRootOf = (temp) => join(temp, TOOL_ROOT.slice('$RUNNER_TEMP/'.length));
export const setupLogOf = (stateDir, index) => join(stateDir, `step-${index}.log`);
export const setupStdoutOf = (stateDir, index) => `${setupLogOf(stateDir, index)}.stdout`;
export const relayLogOf = (stateDir) => join(stateDir, 'relay.log');

export function readHarnessInput() {
  return JSON.parse(readFileSync(0, 'utf8') || '{}');
}

export function writeHarnessResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

function groupsOf(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(state?.process_groups)) throw new Error('invalid harness process group state');
    return state.process_groups;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

export function recordGroup(stateDir, { step, ...update }) {
  const file = stateFileOf(stateDir);
  const groups = groupsOf(file);
  const index = groups.findIndex((entry) => entry.step === step);
  const entry = { ...groups[index], step };
  for (const field of ['pgid', 'started', 'dir', 'draining', 'members']) {
    if (update[field] === null) delete entry[field];
    else if (update[field] !== undefined) entry[field] = update[field];
  }
  if (update.pgid === null) {
    delete entry.started;
    delete entry.draining;
    delete entry.members;
  } else if (update.pgid !== undefined) {
    if (update.draining === undefined) delete entry.draining;
    if (update.members === undefined) delete entry.members;
  }
  if (index === -1) groups.push(entry);
  else groups[index] = entry;
  writeGroups(file, groups);
}

function writeGroups(file, groups) {
  const stateDir = dirname(file);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pending = join(stateDir, `.state-${randomUUID()}.json`);
  try {
    writeFileSync(pending, JSON.stringify({ process_groups: groups }), { mode: 0o600, flag: 'wx' });
    renameSync(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }
}

function removeRelayDir(dir, env) {
  const run = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  if (typeof dir !== 'string' || !/^\d+$/.test(run) || !/^\d+$/.test(attempt)) return;
  try {
    const root = realpathSync(TMP);
    const resolved = realpathSync(dir);
    const prefix = `${root}${sep}ksai-relay-${run}-${attempt}-`;
    if (dirname(resolved) === root && resolved.startsWith(prefix)) rmSync(resolved, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export const GROUP_LIST_ARGS = ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='];
const MAX_GROUP_SCAN_PASSES = 8;
const LINUX_SCAN_BATCH = 64;
const PROC_VANISHED = Symbol('proc-vanished');
const PROC_DENIED = Symbol('proc-denied');

function readProcStat(pid, readFile = readFileSync, { markVanished = false, markDenied = false } = {}) {
  let raw;
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return markVanished ? PROC_VANISHED : null;
    if (markDenied && ['EPERM', 'EACCES'].includes(error.code)) return PROC_DENIED;
    throw error;
  }
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const fields = raw.slice(close + 2).trim().split(' ');
  const state = fields[0];
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (!state || !between(pgid, 1, 2_147_483_647) || !/^\d+$/u.test(start ?? '')) return null;
  return { pid: Number(pid), pgid, state, start };
}

function listProcPids(readDir = readdirSync) {
  return readDir('/proc').filter((name) => /^[1-9]\d*$/u.test(name));
}

function hasAddedPid(before, after) {
  const seen = new Set(before);
  return after.some((pid) => !seen.has(pid));
}

async function runPs(args, bound, { signal = null, now = Date.now, exec = null, execAsync = execFile } = {}) {
  checkBound(bound, signal, now);
  const timeout = Math.max(1, bound() - now());
  try {
    const stdout = exec
      ? exec('/bin/ps', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' })
      : await new Promise((resolve, reject) => {
        execAsync('/bin/ps', args, {
          encoding: 'utf8', timeout, killSignal: 'SIGKILL', ...(signal && { signal }),
        }, (error, output) => {
          if (error) reject(error);
          else resolve(output);
        });
      });
    checkBound(bound, signal, now);
    return stdout;
  } catch (error) {
    checkBound(bound, signal, now);
    throw error;
  }
}

async function verifyLeaderNow(pgid, startedAt, io) {
  checkBound(io.bound, io.signal, io.now);
  if (io.platform === 'linux') {
    const matched = groupLeaderMatches(pgid, startedAt, io);
    checkBound(io.bound, io.signal, io.now);
    return matched;
  }
  try {
    const value = (await runPs(['-p', String(pgid), '-o', 'pgid=,lstart='], io.bound, io)).trim();
    const match = /^(\d+)\s+(.+?)$/u.exec(value);
    return Boolean(match && Number(match[1]) === pgid && match[2] === startedAt);
  } catch (error) {
    checkBound(io.bound, io.signal, io.now);
    if (error?.exitCode === 124) throw error;
    return false;
  }
}

async function verifyMemberNow(pgid, pid, startedAt, io) {
  checkBound(io.bound, io.signal, io.now);
  if (io.platform === 'linux') {
    const matched = groupMemberMatches(pgid, pid, startedAt, io);
    checkBound(io.bound, io.signal, io.now);
    return matched;
  }
  try {
    const value = (await runPs(['-p', String(pid), '-o', 'pgid=,stat=,lstart='], io.bound, io)).trim();
    const match = /^(\d+)\s+(\S+)\s+(.+?)$/u.exec(value);
    return Boolean(match && Number(match[1]) === pgid && !/^[XZ]/u.test(match[2]) && match[3] === startedAt);
  } catch (error) {
    checkBound(io.bound, io.signal, io.now);
    if (error?.exitCode === 124) throw error;
    return false;
  }
}

async function verifyOwnedNow(pgid, identity, result, io) {
  let denied = null;
  try {
    if (await verifyLeaderNow(pgid, identity.started, io)) return true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
    denied = error;
  }
  if (!identity.draining || !Array.isArray(identity.members) || !identity.members.length) {
    if (denied) throw denied;
    return false;
  }
  const matched = result.members.filter((member) =>
    identity.members.some((known) => known?.pid === member.pid && known?.start === member.start));
  for (const member of matched) {
    try {
      if (await verifyMemberNow(pgid, member.pid, member.start, io)) return true;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
      denied ??= error;
    }
  }
  if (denied) throw denied;
  return false;
}

async function scanLinuxGroup(pgid, bound, identity, { readDir, readFile, now, signal }) {
  checkBound(bound, signal, now);
  let before = listProcPids(readDir);
  for (let pass = 0; pass < MAX_GROUP_SCAN_PASSES; pass += 1) {
    checkBound(bound, signal, now);
    let disappeared = false;
    let denied = false;
    const entries = [];
    for (let index = 0; index < before.length; index += 1) {
      if (index > 0 && index % LINUX_SCAN_BATCH === 0) await nextTurn();
      checkBound(bound, signal, now);
      const stat = readProcStat(before[index], readFile, { markVanished: true, markDenied: true });
      if (stat === PROC_VANISHED) {
        disappeared = true;
        continue;
      }
      if (stat === PROC_DENIED) {
        denied = true;
        continue;
      }
      if (stat) entries.push(stat);
    }
    checkBound(bound, signal, now);
    const result = matchGroup(pgid, entries, identity);
    if (result.live) {
      if (await verifyOwnedNow(pgid, identity, result, { platform: 'linux', readFile, bound, signal, now })) {
        checkBound(bound, signal, now);
        return result;
      }
      checkBound(bound, signal, now);
      await nextTurn();
      checkBound(bound, signal, now);
      before = listProcPids(readDir);
      continue;
    }
    if (result.unverified) return result;
    if (entries.some((entry) => entry.pid === pgid && (entry.start !== identity.started || entry.pgid !== pgid))) {
      return { owned: false, live: false, unverified: false, members: [] };
    }
    if (denied) return { owned: false, live: false, unverified: true, members: [] };
    checkBound(bound, signal, now);
    const after = listProcPids(readDir);
    checkBound(bound, signal, now);
    if (!disappeared && !hasAddedPid(before, after)) return result;
    checkBound(bound, signal, now);
    await nextTurn();
    checkBound(bound, signal, now);
    before = after;
  }
  throw new Error('process scan did not stabilize for group');
}

export function groupStart(pid, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!between(pid, 2, 2_147_483_647)) return null;
  if (platform === 'linux') {
    const stat = readProcStat(pid, readFile);
    return stat && typeof stat === 'object' ? stat.start : null;
  }
  try {
    const value = exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function groupLiveMembers(pgid, {
  platform = process.platform, readDir = readdirSync, readFile = readFileSync, exec = execFileSync,
} = {}) {
  if (!between(pgid, 2, 2_147_483_647)) return [];
  if (platform === 'linux') {
    const found = [];
    for (const name of listProcPids(readDir)) {
      const stat = readProcStat(name, readFile, { markDenied: true });
      if (stat && typeof stat === 'object' && stat.pgid === pgid && Boolean(stat.state) && !/^[XZ]/u.test(stat.state)) {
        found.push({ pid: stat.pid, start: stat.start });
      }
    }
    return found;
  }
  try {
    const stdout = exec('/bin/ps', GROUP_LIST_ARGS, { encoding: 'utf8' });
    return parseProcessListing(stdout)
      .filter((entry) => entry.pgid === pgid && Boolean(entry.state) && !/^[XZ]/u.test(entry.state))
      .map(({ pid, start }) => ({ pid, start }));
  } catch {
    return [];
  }
}

export function groupLeaderMatches(pgid, startedAt, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!between(pgid, 2, 2_147_483_647) || typeof startedAt !== 'string' || startedAt === '') return false;
  if (platform === 'linux') {
    const stat = readProcStat(pgid, readFile);
    return Boolean(stat && typeof stat === 'object' && stat.pgid === pgid && stat.start === startedAt);
  }
  try {
    const value = exec('/bin/ps', ['-p', String(pgid), '-o', 'pgid=,lstart='], { encoding: 'utf8' }).trim();
    const match = /^(\d+)\s+(.+?)$/u.exec(value);
    return Boolean(match && Number(match[1]) === pgid && match[2] === startedAt);
  } catch {
    return false;
  }
}

export function groupMemberMatches(pgid, pid, startedAt, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!between(pgid, 2, 2_147_483_647) || !between(pid, 2, 2_147_483_647) || typeof startedAt !== 'string' || startedAt === '') return false;
  if (platform === 'linux') {
    const stat = readProcStat(pid, readFile);
    return Boolean(stat && typeof stat === 'object' && stat.pgid === pgid && stat.start === startedAt && Boolean(stat.state) && !/^[XZ]/u.test(stat.state));
  }
  try {
    const value = exec('/bin/ps', ['-p', String(pid), '-o', 'pgid=,stat=,lstart='], { encoding: 'utf8' }).trim();
    const match = /^(\d+)\s+(\S+)\s+(.+?)$/u.exec(value);
    return Boolean(match && Number(match[1]) === pgid && !/^[XZ]/u.test(match[2]) && match[3] === startedAt);
  } catch {
    return false;
  }
}

function linuxGroupHasOtherLiveMembers(pgid, readDir, readFile) {
  let before = listProcPids(readDir);
  for (let pass = 0; pass < MAX_GROUP_SCAN_PASSES; pass += 1) {
    let disappeared = false;
    for (const name of before) {
      if (Number(name) === pgid) continue;
      const stat = readProcStat(name, readFile, { markVanished: true });
      if (stat === PROC_VANISHED) {
        disappeared = true;
        continue;
      }
      if (stat && typeof stat === 'object' && stat.pgid === pgid && stat.pid !== pgid && Boolean(stat.state) && !/^[XZ]/u.test(stat.state)) return true;
    }
    const after = listProcPids(readDir);
    if (!disappeared && !hasAddedPid(before, after)) return false;
    before = after;
  }
  return true;
}

export async function groupHasOtherLiveMembers(pgid, { platform = process.platform, readDir = readdirSync, readFile = readFileSync, launch = spawn } = {}) {
  if (!between(pgid, 2, 2_147_483_647)) return false;
  if (platform === 'linux') {
    try {
      return linuxGroupHasOtherLiveMembers(pgid, readDir, readFile);
    } catch {
      return true;
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const child = launch('/bin/ps', GROUP_LIST_ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const [code] = await once(child, 'close');
      if (code !== 0) continue;
      return parseProcessListing(stdout).some(
        (entry) => entry.pgid === pgid && entry.pid !== pgid && entry.pid !== child.pid && Boolean(entry.state) && !/^[XZ]/u.test(entry.state),
      );
    } catch {
      continue;
    }
  }
  return true;
}

export function parseProcessListing(listing) {
  const entries = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!between(pid, 1, 2_147_483_647) || !between(pgid, 1, 2_147_483_647)) continue;
    entries.push({ pid, pgid, state: match[3], start: match[4] });
  }
  return entries;
}

export function matchGroup(pgid, entries, { started = '', draining = false, members: knownMembers = [] } = {}) {
  if (typeof started !== 'string' || started === '') return { owned: false, live: false, unverified: false, members: [] };
  const leader = entries.find((entry) => entry.pid === pgid);
  const members = entries.filter((entry) => entry.pgid === pgid && Boolean(entry.state) && !/^[XZ]/u.test(entry.state));
  const memberIds = members.map(({ pid, start }) => ({ pid, start }));
  if (leader) {
    if (leader.start !== started || leader.pgid !== pgid) return { owned: false, live: false, unverified: false, members: [] };
    return { owned: true, live: members.length > 0, unverified: false, members: memberIds };
  }
  if (!members.length) return { owned: false, live: false, unverified: false, members: [] };
  const verified = draining && Array.isArray(knownMembers) && knownMembers.length > 0
    && members.some((member) => knownMembers.some((known) => known?.pid === member.pid && known?.start === member.start));
  if (verified) return { owned: true, live: true, unverified: false, members: memberIds };
  return { owned: false, live: false, unverified: true, members: [] };
}

export function inspectListing(pgid, listing, identity) {
  return matchGroup(pgid, parseProcessListing(listing), identity);
}

export function listedGroup(pgid, listing, identity) {
  return inspectListing(pgid, listing, identity).live;
}

export function checkDeadline(deadlineAt, now = Date.now) {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new Error('invalid harness deadline');
  if (now() >= deadlineAt) throw Object.assign(new Error('harness deadline reached'), { exitCode: 124 });
}

export function endGroup(pgid, kill = process.kill) {
  if (!pgid) return false;
  try {
    kill(-pgid, 'SIGKILL');
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

const checkBound = (deadline, signal = null, now = Date.now) => {
  if (signal?.aborted) throw Object.assign(new Error('harness deadline reached'), { exitCode: 124 });
  checkDeadline(deadline(), now);
};

async function listProcesses(bound, io = {}) {
  return parseProcessListing(await runPs(GROUP_LIST_ARGS, bound, io));
}

export async function inspectGroup(pgid, deadlineAt, identity, {
  platform = process.platform,
  readDir = readdirSync,
  readFile = readFileSync,
  exec = null,
  execAsync = execFile,
  now = Date.now,
  signal = null,
  limit = null,
} = {}) {
  const bound = boundOf(deadlineAt, limit);
  checkBound(bound, signal, now);
  if (typeof identity?.started !== 'string' || identity.started === '') {
    return { owned: false, live: false, unverified: false, members: [] };
  }
  if (platform === 'linux') return scanLinuxGroup(pgid, bound, identity, { readDir, readFile, now, signal });
  const io = { platform, readFile, exec, execAsync, bound, signal, now };
  for (let pass = 0; pass < MAX_GROUP_SCAN_PASSES; pass += 1) {
    const result = matchGroup(pgid, await listProcesses(bound, io), identity);
    checkBound(bound, signal, now);
    if (!result.live) return result;
    if (await verifyOwnedNow(pgid, identity, result, io)) {
      checkBound(bound, signal, now);
      return result;
    }
    checkBound(bound, signal, now);
    await nextTurn();
    checkBound(bound, signal, now);
  }
  throw new Error('process scan did not stabilize for group');
}

const normalizeInspection = (value) => (typeof value === 'boolean'
  ? { owned: value, live: value, unverified: false, members: [] }
  : {
    owned: Boolean(value?.owned),
    live: Boolean(value?.live),
    unverified: Boolean(value?.unverified),
    members: Array.isArray(value?.members) ? value.members : [],
  });

export async function drainGroup(pgid, deadlineAt, {
  kill = process.kill, live = inspectGroup, signalFirst = false, identity = null, beforeSignal = null, signal = null, now = Date.now,
} = {}) {
  const checkDrain = () => {
    signal?.throwIfAborted();
    checkDeadline(deadlineAt, now);
  };
  const scanOptions = signal ? { signal } : undefined;
  const knownMembers = Array.isArray(identity?.members) ? [...identity.members] : [];
  const mergeMembers = (found) => {
    for (const member of found) {
      if (!knownMembers.some((known) => known.pid === member.pid && known.start === member.start)) {
        knownMembers.push(member);
      }
    }
  };
  const check = async (draining) => {
    checkDrain();
    const result = normalizeInspection(identity === null
      ? await live(pgid, deadlineAt, undefined, scanOptions)
      : await live(pgid, deadlineAt, {
        ...identity,
        ...(draining && { draining: true }),
        ...(knownMembers.length && { members: [...knownMembers] }),
      }, scanOptions));
    checkDrain();
    if (result.owned && result.members.length) mergeMembers(result.members);
    if (result.unverified) throw new Error('unverified live processes remain in group');
    return result.live;
  };
  let drainingPersisted = Boolean(identity?.draining);
  let persisted = Array.isArray(identity?.members) ? identity.members.length : 0;
  const persistBeforeSignal = async () => {
    if (!beforeSignal) return true;
    while (!drainingPersisted || knownMembers.length > persisted) {
      checkDrain();
      const count = knownMembers.length;
      beforeSignal([...knownMembers]);
      drainingPersisted = true;
      persisted = count;
      if (identity === null) return true;
      if (!await check(true)) return false;
      if (knownMembers.length > persisted) checkDrain();
    }
    return true;
  };
  let denied;
  checkDrain();
  if ((!signalFirst || identity !== null) && !await check(Boolean(identity?.draining))) return;
  if (!await persistBeforeSignal()) return;
  try {
    for (;;) {
      checkDrain();
      try {
        if (!endGroup(pgid, kill)) return;
        denied = undefined;
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
        denied ??= error;
      }
      await nextTurn();
      checkDrain();
      if (!await check(true)) return;
      if (!await persistBeforeSignal()) return;
      checkDrain();
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error.exitCode === 124 && denied ? denied : error;
  }
}

function mergeVerifiedMembers(existing = [], found = []) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  let added = false;
  for (const member of found) {
    if (!merged.some((known) => known?.pid === member.pid && known?.start === member.start)) {
      merged.push(member);
      added = true;
    }
  }
  return { merged, added };
}

function markEntryDraining(file, groups, entry, write, members = []) {
  const prevDraining = entry.draining;
  const prevMembers = entry.members;
  const { merged, added } = mergeVerifiedMembers(entry.members, members);
  const changed = !entry.draining || added;
  if (!changed) return false;
  entry.draining = true;
  if (merged.length) entry.members = merged;
  try {
    write(file, groups);
    return true;
  } catch (error) {
    if (prevDraining === undefined) delete entry.draining;
    else entry.draining = prevDraining;
    if (prevMembers === undefined) delete entry.members;
    else entry.members = prevMembers;
    throw error;
  }
}

function clearGroupEntry(entry) {
  delete entry.pgid;
  delete entry.started;
  delete entry.draining;
  delete entry.members;
}

const boundOf = (deadlineAt, limit) => () => (typeof limit === 'function' ? Math.min(deadlineAt, limit()) : deadlineAt);

async function prepareGroupSignal(file, groups, entry, { live, deadline, signal, write }) {
  checkBound(deadline, signal);
  const scanOptions = { ...(signal && { signal }), limit: deadline };
  let result = normalizeInspection(await live(entry.pgid, deadline(), entry, scanOptions));
  let writes = 0;
  for (;;) {
    checkBound(deadline, signal);
    if (result.unverified) throw new Error('unverified live processes remain in group');
    if (!result.live) return false;
    if (!markEntryDraining(file, groups, entry, write, result.members)) return true;
    if (++writes > 1) checkBound(deadline, signal);
    result = normalizeInspection(await live(entry.pgid, deadline(), entry, scanOptions));
  }
}

function sendGroupSignal(entry, kill) {
  try {
    return { done: !endGroup(entry.pgid, kill), denied: undefined };
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    return { done: false, denied: error };
  }
}

export async function signalGroups(stateDir, kill = process.kill, {
  live = inspectGroup, deadlineAt = Date.now() + REAP_WINDOW_MS, limit = null, signal = null, write = writeGroups,
} = {}) {
  const file = stateFileOf(stateDir);
  const groups = groupsOf(file);
  const deadline = boundOf(deadlineAt, limit);
  let failure;
  for (const entry of groups) {
    if (!between(entry?.pgid, 2, 2_147_483_647)) continue;
    try {
      if (!await prepareGroupSignal(file, groups, entry, { live, deadline, signal, write })) continue;
      checkBound(deadline, signal);
      const { denied } = sendGroupSignal(entry, kill);
      if (denied) failure ??= denied;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

export async function reapGroups(stateDir, {
  env = process.env, kill = process.kill, live = inspectGroup, deadlineAt = Date.now() + REAP_WINDOW_MS, limit = null, signal = null, write = writeGroups,
} = {}) {
  const file = stateFileOf(stateDir);
  const groups = groupsOf(file);
  const errors = [];
  const deadline = boundOf(deadlineAt, limit);
  const options = { live, deadline, signal, write };
  let active = [];
  for (const entry of groups) {
    if (!entry) continue;
    if (!between(entry.pgid, 2, 2_147_483_647)) {
      clearGroupEntry(entry);
      continue;
    }
    try {
      if (!await prepareGroupSignal(file, groups, entry, options)) {
        clearGroupEntry(entry);
        continue;
      }
      checkBound(deadline, signal);
      const signaled = sendGroupSignal(entry, kill);
      if (signaled.done) clearGroupEntry(entry);
      else active.push({ entry, denied: signaled.denied });
    } catch (error) {
      errors.push(error);
    }
  }
  while (active.length) {
    await nextTurn();
    const stillLive = [];
    for (const state of active) {
      try {
        if (!await prepareGroupSignal(file, groups, state.entry, options)) {
          clearGroupEntry(state.entry);
          continue;
        }
        stillLive.push(state);
      } catch (error) {
        errors.push(error.exitCode === 124 && state.denied ? state.denied : error);
      }
    }
    const next = [];
    const reverify = active.length > 1;
    for (const state of stillLive) {
      try {
        if (reverify && !await prepareGroupSignal(file, groups, state.entry, options)) {
          clearGroupEntry(state.entry);
          continue;
        }
        checkBound(deadline, signal);
        const signaled = sendGroupSignal(state.entry, kill);
        if (signaled.done) clearGroupEntry(state.entry);
        else next.push({ entry: state.entry, denied: signaled.denied ? state.denied ?? signaled.denied : undefined });
      } catch (error) {
        errors.push(error.exitCode === 124 && state.denied ? state.denied : error);
      }
    }
    active = next;
  }
  for (const entry of groups) {
    if (!entry) continue;
    try {
      removeRelayDir(entry.dir, env);
      delete entry.dir;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const pending = groups.filter((entry) => entry?.pgid !== undefined || entry?.dir !== undefined);
    if (pending.length) write(file, pending);
    else rmSync(file, { force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw errors[0];
}
