import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { runMain } from '../../lib/main.mjs';
import {
  FAILURES, REAP_WINDOW_MS, SETUP_STEP_IDS, TEARDOWN_TAIL_MS, drainGroup, endGroup, groupHasOtherLiveMembers,
  groupLeaderMatches, groupLiveMembers, groupStart, readHarnessInput, reapGroups, recordGroup, signalGroups,
  setupLogOf, setupStdoutOf, setupTreeOf, stateDirOf, stateFileOf, stepFailure, toolRootOf, validatePlan,
  writeHarnessResult,
} from './contract.mjs';
import {
  checkDeadline, commandOf, exportedPaths, exportTools, fetchTools, printSetupLogs, readToolPath, setupEnvironment,
  untar, writeFacts,
} from './files.mjs';
import { captureOwner } from './owner.mjs';
import { probeEndpoint } from './probe.mjs';

const GATE = import.meta.filename;
const PERMISSION = 'start\n';
const STOP = ['SIGINT', 'SIGTERM'];
const HOLD_CHECK_MS = 60_000;
const MAX_GATE_HOLD_MS = 6 * 60 * 60 * 1000;

function stopPermission(permission, status) {
  try {
    if (permission && !permission.destroyed && !permission.writableEnded) permission.end('stop\n');
  } catch {
    permission?.destroy();
  }
  status?.destroy();
}

function managedGroup(pgid, started, stateDir, step, child, {
  record = recordGroup, kill = process.kill, checkLeader = groupLeaderMatches, readMembers = groupLiveMembers,
  permission = null, status = null,
} = {}) {
  let saved = false;
  let stopped = false;
  let marked = false;
  let savedMembers = [];
  const markDraining = (members = []) => {
    if (!saved) return;
    const added = members.some((member) => !savedMembers.some((known) => known.pid === member.pid && known.start === member.start));
    if (marked && !added) return;
    const merged = [...savedMembers];
    for (const member of members) {
      if (!merged.some((known) => known.pid === member.pid && known.start === member.start)) merged.push(member);
    }
    record(stateDir, { step, draining: true, ...(merged.length && { members: merged }) });
    marked = true;
    savedMembers = merged;
  };
  const signal = () => {
    stopPermission(permission, status);
    if (stopped) return;
    let liveLeader = false;
    try {
      liveLeader = child.exitCode === null && child.signalCode === null && Boolean(checkLeader(pgid, started));
    } catch {
      return;
    }
    if (!liveLeader) return;
    let members;
    try {
      members = readMembers(pgid);
      if (child.exitCode !== null || child.signalCode !== null || !checkLeader(pgid, started)) return;
    } catch {
      return;
    }
    markDraining(members);
    try {
      if (child.exitCode !== null || child.signalCode !== null || !checkLeader(pgid, started)) return;
    } catch {
      return;
    }
    endGroup(pgid, kill);
    stopped = true;
  };
  const forget = () => {
    if (!saved) return;
    record(stateDir, { step, pgid: null });
    saved = false;
    marked = false;
    savedMembers = [];
  };
  const stop = () => {
    stopPermission(permission, status);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      endGroup(pgid, kill);
      stopped = true;
    }
    forget();
  };
  return {
    save() {
      record(stateDir, { step, pgid, started });
      saved = true;
    },
    markDraining,
    clear() {
      stopped = true;
      forget();
    },
    signal,
    forget,
    stop,
  };
}

function exitOf(child) {
  return once(child, 'exit').then(([code, signal]) => code ?? 128 + (constants.signals[signal] ?? 0), () => 127);
}

function completionOf(child, exited, { onLaunched = () => {} } = {}) {
  const status = child.stdio?.[3];
  if (!status) return exited.then((code) => ({ code, held: false, verified: false }));
  return new Promise((resolve) => {
    let settled = false;
    let line = '';
    let verifiedDone = false;
    let doneCode = 1;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      status.off('data', onData);
      status.destroy();
      resolve(result);
    };
    const statusClosed = new Promise((done) => {
      status.once('close', done);
      status.once('end', done);
    });
    const onData = (chunk) => {
      line += chunk.toString('utf8');
      for (;;) {
        const end = line.indexOf('\n');
        if (end === -1) return;
        const text = line.slice(0, end).trim();
        line = line.slice(end + 1);
        if (text === 'launched') {
          onLaunched();
          continue;
        }
        const match = /^(done|held) (\d+)$/u.exec(text);
        if (!match) return finish({ code: 1, held: false, verified: false });
        const code = Number(match[2]);
        if (match[1] === 'held') return finish({ code: Number.isInteger(code) ? code : 1, held: true, verified: true });
        verifiedDone = true;
        const finalCode = Number.isInteger(code) ? code : 1;
        doneCode = finalCode;
        void exited.then(() => finish({ code: finalCode, held: false, verified: true }));
        return;
      }
    };
    status.on('error', () => {});
    status.on('data', onData);
    void Promise.all([exited, statusClosed]).then(([code]) => finish({
      code: verifiedDone ? doneCode : code, held: false, verified: verifiedDone,
    }));
  });
}

function launchedOf(child, exited) {
  const status = child.stdio?.[3];
  if (!status) return Promise.resolve({ launched: true, code: 0 });
  return new Promise((resolve) => {
    let settled = false;
    let line = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      status.off('data', onData);
      status.destroy();
      resolve(result);
    };
    const statusClosed = new Promise((done) => {
      status.once('close', done);
      status.once('end', done);
    });
    const onData = (chunk) => {
      line += chunk.toString('utf8');
      for (;;) {
        const end = line.indexOf('\n');
        if (end === -1) return;
        const text = line.slice(0, end).trim();
        line = line.slice(end + 1);
        if (text === 'launched') return finish({ launched: true, code: 0 });
      }
    };
    status.on('error', () => {});
    status.on('data', onData);
    void Promise.all([exited, statusClosed]).then(([code]) => finish({ launched: false, code }));
  });
}

function launchLogged(file, args, { env, tree, log, stdout = log, detached = false, pipe = false, status = false, launch = spawn }) {
  const logFd = openSync(log, 'w', 0o600);
  let outputFd = logFd;
  try {
    if (stdout !== log) outputFd = openSync(stdout, 'w', 0o600);
    if (status) return launch(file, args, { detached, env, cwd: tree, stdio: [pipe ? 'pipe' : 'ignore', outputFd, logFd, 'pipe'] });
    return launch(file, args, { detached, env, cwd: tree, stdio: [pipe ? 'pipe' : 'ignore', outputFd, logFd] });
  } finally {
    if (outputFd !== logFd) closeSync(outputFd);
    closeSync(logFd);
  }
}

async function setupCommand(step, index, context) {
  const {
    stateDir, tree, due, deadlineAt, holdUntil, signal, groups, setStop, record, beforePermission, launch, kill,
    readStart, checkLeader, readMembers,
  } = context;
  signal.throwIfAborted();
  checkDeadline(due);
  const { argv, env } = commandOf(step, context);
  const log = setupLogOf(stateDir, index);
  const stdout = step.exports_path ? setupStdoutOf(stateDir, index) : log;
  const child = launchLogged(process.execPath, [GATE, 'gate', step.detach ? 'detached' : 'attached', String(due), String(holdUntil), '--', ...argv], {
    detached: true, env, tree, log, stdout, launch, pipe: true, status: true,
  });
  const exited = exitOf(child);
  const pgid = child.pid;
  if (!pgid) return { result: 'failed', exit_code: await exited };
  const permission = child.stdin;
  if (!permission) {
    endGroup(pgid);
    throw new Error('the harness gate has no permission channel');
  }
  permission.on('error', () => {});
  const launched = step.detach ? launchedOf(child, exited) : null;
  const completed = step.detach ? null : completionOf(child, exited);
  let started = null;
  try {
    started = readStart(pgid);
  } catch {
    started = null;
  }
  if (!started) {
    permission.destroy();
    child.stdio?.[3]?.destroy();
    return { result: 'failed', exit_code: await exited };
  }
  const group = managedGroup(pgid, started, stateDir, step.id, child, {
    record, kill, checkLeader, readMembers, permission, status: child.stdio?.[3],
  });
  setStop(group.stop);
  let timer;
  let permitted = false;
  try {
    group.save();
    groups.set(step.id, { pgid, started });
    await beforePermission();
    signal.throwIfAborted();
    checkDeadline(due);
    permission.write(PERMISSION);
    permitted = true;
    setStop(group.signal);
    if (step.detach) {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, due - Date.now())); });
      const startedGate = await Promise.race([launched, timeout]);
      signal.throwIfAborted();
      if (startedGate === null || Date.now() >= due) {
        stopPermission(permission, child.stdio?.[3]);
        await drainGroup(pgid, deadlineAt, {
          kill, signalFirst: true, identity: { started }, beforeSignal: group.markDraining,
        });
        group.clear();
        throw Object.assign(new Error('harness command deadline reached'), { exitCode: 124 });
      }
      permission.destroy();
      if (!startedGate.launched) return { result: 'failed', exit_code: startedGate.code };
      child.unref();
      return { result: 'started' };
    }
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, due - Date.now())); });
    const outcome = await Promise.race([completed, timeout]);
    signal.throwIfAborted();
    if (outcome === null || Date.now() >= due) {
      stopPermission(permission, child.stdio?.[3]);
      if (outcome === null || outcome.held || !outcome.verified || Date.now() < deadlineAt) {
        await drainGroup(pgid, deadlineAt, {
          kill, signalFirst: outcome === null || outcome.held, identity: { started }, beforeSignal: group.markDraining,
        });
        group.clear();
      }
      throw Object.assign(new Error('harness command deadline reached'), { exitCode: 124 });
    }
    if (outcome.held) child.unref();
    else if (outcome.verified) group.clear();
    if (outcome.code === 0 && step.exports_path) context.toolPath.push(...exportedPaths(stdout, context.toolRoot));
    return { result: outcome.code === 0 ? 'succeeded' : 'failed', exit_code: outcome.code };
  } catch (error) {
    stopPermission(permission, child.stdio?.[3]);
    if (!permitted && !signal.aborted) group.stop();
    child.unref();
    throw error;
  } finally {
    clearTimeout(timer);
    permission.destroy();
    child.stdio?.[3]?.destroy();
    setStop(null);
  }
}

async function collectReady(step, endpoints, { plan, groups, lastSetup, deadlineAt, signal, capture, probeCheck }) {
  const ready = new Set(step.ready);
  for (const [index, endpoint] of plan.endpoints.entries()) {
    if (endpoint.probe) continue;
    if (lastSetup.get(endpoint.environment) === step.id) ready.add(index);
  }
  for (const index of ready) {
    const endpoint = plan.endpoints[index];
    const { owner, address, port, probe } = endpoint;
    const ownedGroup = owner.kind === 'process_group' ? groups.get(owner.step) : null;
    const pgid = ownedGroup?.pgid ?? 0;
    const startedAt = ownedGroup?.started ?? '';
    const options = { address, port, pgid, startedAt, deadlineAt, signal };
    const failedOwner = (failure) => {
      endpoints.set(index, { endpoint: index, owned: false, ...(probe && { probe: { ready: false } }) });
      return { ...failure, endpoint: index };
    };
    if (Date.now() >= deadlineAt) return failedOwner(FAILURES.probeDeadline);
    let instance;
    try {
      instance = await capture(owner, options);
    } catch (error) {
      if (error?.ownerPrevented) return failedOwner(FAILURES.probeDeadline);
      return failedOwner(error?.ownerRefused ? FAILURES.endpointNotOwned : FAILURES.ownerUnreadable);
    }
    const { failure, ...fact } = probe
      ? await probeCheck(endpoint, instance, options)
      : { owned: true, failure: undefined };
    endpoints.set(index, { endpoint: index, ...(fact.owned && { instance }), ...fact });
    if (failure) return { ...failure, endpoint: index };
  }
  return null;
}

export async function runSetup({ plan: inputPlan, setup_tree: setupTree, setup_deadline_at: jobSetupDeadlineAt, job_deadline_at: jobDeadlineAt = 0 }, {
  env = process.env, fetch = globalThis.fetch, extract = untar, record = recordGroup, beforePermission = () => nextTurn(),
  launch = spawn, capture = captureOwner, probeCheck = probeEndpoint, kill = process.kill,
  readStart = groupStart, checkLeader = groupLeaderMatches, readMembers = groupLiveMembers, onStop = () => {},
} = {}) {
  const startedAt = Date.now();
  const facts = { steps: [], endpoints: [], failure: undefined };
  const stateDir = stateDirOf(env.RUNNER_TEMP);
  const endpoints = new Map();
  const save = () => {
    facts.endpoints = [...endpoints.values()];
    writeFacts(stateDir, facts);
  };
  let unexported = null;
  const fail = (failure, exitCode = 1) => {
    const tools = unexported;
    unexported = null;
    if (tools) {
      try {
        exportTools(env, tools);
      } catch {}
    }
    facts.failure = failure;
    save();
    return { result: { ok: false, facts }, exitCode };
  };
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    try {
      stopActive?.();
    } catch {}
    fail(stepFailure(SETUP_STEP_IDS.up, 130, true));
    onStop();
  };
  let stopActive = null;
  for (const name of STOP) process.once(name, stop);
  try {
    checkDeadline(jobSetupDeadlineAt);
    const plan = validatePlan(inputPlan, env);
    const planDeadlineAt = startedAt + plan.budget.setup_seconds * 1000;
    const deadlineAt = Math.min(jobSetupDeadlineAt, planDeadlineAt);
    const holdUntil = Number.isSafeInteger(jobDeadlineAt) && jobDeadlineAt > 0 ? jobDeadlineAt : deadlineAt + MAX_GATE_HOLD_MS;
    const tree = realpathSync(setupTree ?? setupTreeOf(env.RUNNER_TEMP));
    mkdirSync(toolRootOf(env.RUNNER_TEMP), { mode: 0o700 });
    const toolRoot = realpathSync(toolRootOf(env.RUNNER_TEMP));
    const allowed = setupEnvironment(env, stateDir);
    const signal = abort.signal;
    let toolPath;
    try {
      toolPath = await fetchTools(plan, { toolRoot, env, deadlineAt, signal, fetch, extract });
    } catch {
      if (signal.aborted) return fail(stepFailure(SETUP_STEP_IDS.up, 130, true), 130);
      return Date.now() >= deadlineAt ? fail(FAILURES.toolchainDeadline, 124) : fail(FAILURES.toolchainFailed);
    }
    const groups = new Map();
    const lastSetup = new Map(plan.steps.filter((step) => step.phase === 'setup').map((step) => [step.environment, step.id]));
    const context = {
      plan, stateDir, tree, toolRoot, toolPath, allowed, groups, lastSetup, deadlineAt, holdUntil, signal, record,
      beforePermission, launch, capture, probeCheck, kill, readStart, checkLeader, readMembers,
      setStop: (stopGroup) => { stopActive = stopGroup; },
    };
    const lastPrepare = plan.steps.findLastIndex((step) => step.phase === 'prepare');
    if (lastPrepare === -1) exportTools(env, context);
    else unexported = context;
    for (const [index, step] of plan.steps.entries()) {
      if (step.phase === 'teardown') continue;
      const started = Date.now();
      const due = Math.min(deadlineAt, started + step.timeout_seconds * 1000);
      const fact = (outcome) => ({ id: step.id, ...outcome, seconds: Math.max(0, Math.min(600, (Date.now() - started) / 1000)) });
      let outcome;
      try {
        outcome = await setupCommand(step, index, { ...context, due });
      } catch (error) {
        const code = signal.aborted ? 130 : Date.now() >= deadlineAt ? 124 : 1;
        const stepCode = signal.aborted ? 130 : errorCode(error);
        facts.steps.push(fact({ result: signal.aborted ? 'cancelled' : 'failed', exit_code: stepCode }));
        return fail({ ...stepFailure(SETUP_STEP_IDS.up, code), step: step.id }, code);
      }
      facts.steps.push(fact(outcome));
      save();
      if (outcome.result === 'failed') return fail({ ...stepFailure(SETUP_STEP_IDS.up, 1), step: step.id });
      const failed = await collectReady(step, endpoints, context);
      if (Date.now() >= deadlineAt && (!failed || failed.reason === FAILURES.probeDeadline.reason)) {
        return fail({ ...stepFailure(SETUP_STEP_IDS.up, 124), step: step.id }, 124);
      }
      if (failed) return fail(failed, failed.reason === FAILURES.probeDeadline.reason ? 124 : 1);
      save();
      if (index === lastPrepare) {
        unexported = null;
        exportTools(env, context);
      }
    }
    checkDeadline(deadlineAt);
    const missing = plan.endpoints.findIndex((_endpoint, index) => !endpoints.has(index));
    if (missing !== -1) return fail({ ...FAILURES.endpointNotOwned, endpoint: missing });
    save();
    return { result: { ok: true, facts }, exitCode: 0 };
  } catch (error) {
    const code = abort.signal.aborted ? 130 : errorCode(error);
    return fail(stepFailure(SETUP_STEP_IDS.up, code), code);
  } finally {
    for (const name of STOP) process.removeListener(name, stop);
  }
}

const errorCode = (error) => error?.exitCode === 124 ? 124 : 1;

export async function holdGroup(pgid, holdUntil, code, {
  hasOtherMembers = groupHasOtherLiveMembers,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  kill = process.kill,
  holdSliceMs = HOLD_CHECK_MS,
} = {}) {
  while (now() < holdUntil) {
    const delay = Math.min(holdSliceMs, holdUntil - now());
    if (delay <= 0) break;
    await wait(delay);
    if (!await hasOtherMembers(pgid)) return code;
  }
  endGroup(pgid, kill);
  return code;
}

function armHoldDeadline(pgid, holdUntil, { now = Date.now, kill = process.kill, holdSliceMs = HOLD_CHECK_MS } = {}) {
  let timer = null;
  let armed = true;
  const cancel = () => {
    armed = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const step = () => {
    if (!armed) return;
    const remaining = holdUntil - now();
    if (remaining <= 0) {
      cancel();
      endGroup(pgid, kill);
      return;
    }
    timer = setTimeout(step, Math.min(holdSliceMs, remaining));
  };
  step();
  return cancel;
}

function openGateControl(control) {
  const stream = control ?? process.stdin;
  const nativeFd = !control;
  let buffer = '';
  let closed = false;
  const lines = [];
  const waiters = [];
  const wake = () => {
    while (waiters.length) {
      if (!lines.length && !closed) break;
      const resolve = waiters.shift();
      resolve(lines.length ? lines.shift() : null);
    }
  };
  const pushChunk = (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      lines.push(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
    wake();
  };
  const drainProbe = () => {
    if (!nativeFd || closed) return;
    const probe = Buffer.alloc(64);
    for (;;) {
      try {
        const count = readSync(0, probe, 0, probe.length, null);
        if (count === 0) {
          if (buffer.trim()) lines.push(buffer.trim());
          buffer = '';
          closed = true;
          wake();
          return;
        }
        pushChunk(probe.toString('utf8', 0, count));
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return;
        if (error.code === 'EINTR') continue;
        closed = true;
        wake();
        return;
      }
    }
  };
  stream.setEncoding?.('utf8');
  stream.on('data', pushChunk);
  stream.on('error', () => { closed = true; wake(); });
  stream.on('end', () => {
    if (buffer.trim()) lines.push(buffer.trim());
    buffer = '';
    closed = true;
    wake();
  });
  stream.on('close', () => { closed = true; wake(); });
  return {
    nextLine: () => (lines.length
      ? Promise.resolve(lines.shift())
      : closed
        ? Promise.resolve(null)
        : new Promise((resolve) => { waiters.push(resolve); })),
    isStopped: () => {
      drainProbe();
      return closed || lines.some((line) => line === 'stop');
    },
    close: () => { stream.destroy?.(); },
  };
}

function spawnGateCommand(file, args, launch = spawn) {
  const child = launch(file, args, { stdio: ['ignore', 'inherit', 'inherit', 'ignore'] });
  const exited = exitOf(child);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('spawn', () => finish({ ok: true, exited }));
    child.once('error', () => finish({ ok: false, code: 127 }));
  });
}

export async function gate(argv, {
  control = null,
  readPermission = null,
  runCommand = null,
  spawnCommand = spawnGateCommand,
  hasOtherMembers = groupHasOtherLiveMembers,
  writeStatus = (line, close = true) => {
    writeFileSync(3, `${line}\n`);
    if (close) closeSync(3);
  },
  hold = holdGroup,
  now = Date.now,
  kill = process.kill,
  holdSliceMs = HOLD_CHECK_MS,
} = {}) {
  const [mode, deadline, holdUntilArg, separator, file, ...args] = argv;
  const holdUntil = Number(holdUntilArg);
  if ((mode !== 'attached' && mode !== 'detached') || !Number.isSafeInteger(holdUntil) || holdUntil <= 0 || separator !== '--' || !file) return 1;
  let channel = null;
  if (readPermission) {
    if (readPermission() !== PERMISSION) return 1;
    checkDeadline(Number(deadline), now);
    checkDeadline(holdUntil, now);
  } else {
    channel = openGateControl(control);
    const line = await channel.nextLine();
    if (line !== 'start' || channel.isStopped()) {
      channel.close();
      return 1;
    }
  }
  const cancelHold = armHoldDeadline(process.pid, holdUntil, { now, kill, holdSliceMs });
  let code;
  let held;
  try {
    checkDeadline(Number(deadline), now);
    checkDeadline(holdUntil, now);
    if (channel?.isStopped()) return 1;
    channel?.close();
    channel = null;
    let pending;
    if (runCommand) {
      pending = Promise.resolve(runCommand(file, args));
      if (!readPermission) {
        try {
          writeStatus('launched', mode === 'detached');
        } catch {}
      }
    } else {
      const started = await spawnCommand(file, args);
      if (!started.ok) return started.code;
      if (!readPermission) {
        try {
          writeStatus('launched', mode === 'detached');
        } catch {}
      }
      pending = started.exited;
    }
    code = await pending;
    held = await hasOtherMembers(process.pid);
    if (mode === 'attached') {
      try {
        writeStatus(`${held ? 'held' : 'done'} ${code}`, true);
      } catch {}
    }
  } finally {
    channel?.close();
    cancelHold();
  }
  if (!held) return code;
  return hold(process.pid, holdUntil, code, { hasOtherMembers, now, kill, holdSliceMs });
}

async function teardownCommand(step, index, context, deadlineAt) {
  const { stateDir, tree, readStart, signal, launch = spawn } = context;
  signal?.throwIfAborted();
  const due = Math.min(deadlineAt, Date.now() + step.timeout_seconds * 1000);
  checkDeadline(due);
  const { argv, env } = commandOf(step, context);
  const child = launchLogged(process.execPath, [GATE, 'gate', 'attached', String(due), String(deadlineAt + TEARDOWN_TAIL_MS), '--', ...argv], {
    env, tree, log: setupLogOf(stateDir, index), detached: true, pipe: true, status: true, launch,
  });
  const exited = exitOf(child);
  const pgid = child.pid;
  if (!pgid) return exited;
  const permission = child.stdin;
  if (!permission) {
    endGroup(pgid);
    throw new Error('the harness gate has no permission channel');
  }
  permission.on('error', () => {});
  const completed = completionOf(child, exited);
  let started = null;
  try {
    started = readStart(pgid);
  } catch {
    started = null;
  }
  if (!started) {
    permission.destroy();
    child.stdio?.[3]?.destroy();
    return exited;
  }
  const group = managedGroup(pgid, started, stateDir, step.id, child, {
    record: recordGroup, kill: context.kill, permission, status: child.stdio?.[3],
  });
  let timer;
  let onAbort;
  let permitted = false;
  try {
    signal?.throwIfAborted();
    group.save();
    signal?.throwIfAborted();
    checkDeadline(due);
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, due - Date.now())); });
    const racers = [completed, timeout];
    if (signal) {
      racers.push(new Promise((resolve) => {
        onAbort = () => {
          stopPermission(permission, child.stdio?.[3]);
          resolve('aborted');
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    permission.write(PERMISSION);
    permitted = true;
    const outcome = await Promise.race(racers);
    if (signal?.aborted || outcome === 'aborted') {
      stopPermission(permission, child.stdio?.[3]);
      child.unref();
      return 130;
    }
    if (outcome !== null && Date.now() < due) {
      if (outcome.held) child.unref();
      else if (outcome.verified) group.clear();
      return outcome.code;
    }
    stopPermission(permission, child.stdio?.[3]);
    await drainGroup(pgid, deadlineAt, {
      kill: context.kill, signalFirst: outcome === null || outcome.held, identity: { started },
      beforeSignal: group.markDraining, signal,
    });
    if (signal?.aborted) {
      child.unref();
      return 130;
    }
    group.clear();
    return 124;
  } catch (error) {
    stopPermission(permission, child.stdio?.[3]);
    if (signal?.aborted) {
      child.unref();
      return 130;
    }
    if (!permitted) group.stop();
    child.unref();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    permission.destroy();
    child.stdio?.[3]?.destroy();
  }
}

export async function runDown({ plan: inputPlan, setup_tree: setupTree, state_file: state, teardown_deadline_at: deadlineAt, cancelled }, {
  env = process.env, onStop = () => {}, print = (text) => process.stderr.write(text), kill = process.kill,
  live = null, readStart = groupStart, reap = reapGroups, launch = spawn,
} = {}) {
  const stateDir = stateDirOf(env.RUNNER_TEMP);
  const abort = new AbortController();
  let activeTeardown = null;
  let reaping = null;
  let reapingBound = 0;
  let completedBound = 0;
  let signalBound = 0;
  let earlyError;
  let finalError;
  let stopping = false;
  const cleanupBound = () => (Date.now() >= deadlineAt ? Date.now() + REAP_WINDOW_MS : deadlineAt);
  const activeBoundOf = (passBound) => (signalBound > 0 ? Math.min(passBound, signalBound) : passBound);
  const runReapPass = async (passBound) => {
    try {
      await reap(stateDir, { env, deadlineAt: passBound, limit: () => activeBoundOf(passBound) });
      finalError = undefined;
    } catch (error) {
      finalError = error;
    }
  };
  const reapState = async (bound = cleanupBound()) => {
    let target = bound;
    for (;;) {
      if (reaping) {
        const startedBound = reapingBound;
        await reaping;
        const effectiveBound = activeBoundOf(startedBound);
        const nextBound = signalBound > 0 ? signalBound : target;
        if (!finalError || nextBound <= effectiveBound || nextBound <= Date.now()) return;
        target = nextBound;
        continue;
      }
      const passBound = signalBound > 0 ? signalBound : target;
      if (completedBound >= passBound || (completedBound > 0 && !finalError)) return;
      reapingBound = passBound;
      const pass = runReapPass(passBound);
      reaping = pass;
      let effectiveBound = passBound;
      try {
        await pass;
      } finally {
        effectiveBound = activeBoundOf(passBound);
        if (reaping === pass) {
          completedBound = Math.max(completedBound, effectiveBound);
          reaping = null;
          reapingBound = 0;
        }
      }
      if (!finalError || signalBound <= effectiveBound || signalBound <= Date.now()) return;
      target = signalBound;
    }
  };
  const onSignal = () => {
    stopping = true;
    abort.abort();
    if (!signalBound) signalBound = Date.now() + REAP_WINDOW_MS;
    const handoff = activeTeardown ? activeTeardown.catch(() => {}) : Promise.resolve();
    void handoff.then(() => reapState(signalBound)).then(onStop, onStop);
  };
  for (const name of STOP) process.once(name, onSignal);
  let plan;
  let result = 0;
  try {
    if (state && state !== stateFileOf(stateDir)) throw new Error('the harness state file has an invalid path');
    plan = validatePlan(inputPlan, env);
    const teardown = [...plan.steps.entries()].filter(([, step]) => step.phase === 'teardown');
    if (cancelled === true || cancelled === 'true') {
      try {
        const earlyBound = cleanupBound();
        await signalGroups(stateDir, kill, {
          ...(live && { live }), deadlineAt: earlyBound, limit: () => activeBoundOf(earlyBound),
        });
      } catch (error) {
        earlyError = error;
      }
    }
    checkDeadline(deadlineAt);
    if (teardown.length) {
      const tree = realpathSync(setupTree ?? setupTreeOf(env.RUNNER_TEMP));
      const toolRoot = toolRootOf(env.RUNNER_TEMP);
      const toolPath = readToolPath(toolRoot, env);
      const context = { stateDir, tree, toolRoot, toolPath, allowed: setupEnvironment(env, stateDir), kill, readStart, signal: abort.signal, launch };
      const runTeardownStep = async (step, index) => {
        const running = teardownCommand(step, index, context, deadlineAt);
        activeTeardown = running;
        try {
          return await running.catch(errorCode);
        } finally {
          if (activeTeardown === running) activeTeardown = null;
        }
      };
      for (const [index, step] of teardown) {
        if (stopping) break;
        checkDeadline(deadlineAt);
        const code = await runTeardownStep(step, index);
        result ||= code;
      }
    }
    if (stopping) result = 130;
    else checkDeadline(deadlineAt);
  } catch (error) {
    result = errorCode(error);
  } finally {
    try {
      await reapState();
      printSetupLogs(plan, stateDir, env, print, [earlyError, finalError]);
    } finally {
      for (const name of STOP) process.removeListener(name, onSignal);
    }
  }
  return result || (finalError ? errorCode(finalError) : stopping ? 130 : 0);
}

await runMain(import.meta.url, async () => {
  const mode = process.argv[2];
  if (mode === 'gate') {
    try {
      process.exitCode = await gate(process.argv.slice(3));
    } catch (error) {
      process.exitCode = errorCode(error);
    }
    return;
  }
  if (mode === 'reap') {
    const deadlineAt = process.env.KSAI_STEP_DEADLINE_AT;
    await reapGroups(stateDirOf(process.env.RUNNER_TEMP), { deadlineAt: deadlineAt ? Number(deadlineAt) : undefined });
    writeHarnessResult({ ok: true });
    return;
  }
  if (mode === 'down') {
    let exitCode = 1;
    try {
      exitCode = await runDown(readHarnessInput(), { onStop: () => process.exit(130) });
    } finally {
      writeHarnessResult({ ok: exitCode === 0 });
      process.exitCode = exitCode;
    }
    return;
  }
  if (mode !== 'up') throw new Error('unknown harness steps mode');
  const { result, exitCode } = await runSetup(readHarnessInput(), { onStop: () => process.exit(130) });
  writeHarnessResult(result);
  process.exitCode = exitCode;
});
