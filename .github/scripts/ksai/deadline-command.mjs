import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';

import { runMain } from '../lib/main.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { reviewDeadlineAt, reviewTimeLeft } from '../lib/review-deadline.mjs';

export const STOP_GRACE_MS = 10_000;
const SIGNALS = ['SIGINT', 'SIGTERM'];
const SELF = import.meta.filename;
const HOLD_POLL_MS = 100;
const MAX_SCAN_PASSES = 8;
const GROUP_LIST_ARGS = ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='];
const PROC_VANISHED = Symbol('proc-vanished');
const PROC_DENIED = Symbol('proc-denied');
const NATIVE_DATE_NOW = Date.now;
const isNativeNow = (fn) => fn === NATIVE_DATE_NOW && /\[native code\]/u.test(Function.prototype.toString.call(fn));

const validPid = (value) => Number.isSafeInteger(value) && value >= 2 && value <= 2_147_483_647;

function readProcStat(pid, readFile = readFileSync, { markVanished = false, markDenied = false } = {}) {
  let raw;
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return markVanished ? PROC_VANISHED : null;
    if (markDenied && (error.code === 'EPERM' || error.code === 'EACCES')) return PROC_DENIED;
    throw error;
  }
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const fields = raw.slice(close + 2).trim().split(' ');
  const state = fields[0];
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (!state || !Number.isSafeInteger(pgid) || pgid < 1 || !/^\d+$/u.test(start ?? '')) return null;
  return { pid: Number(pid), pgid, state, start };
}

function parseListing(listing) {
  const entries = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(pgid) || pgid < 1) continue;
    entries.push({ pid, pgid, state: match[3], start: match[4] });
  }
  return entries;
}

function groupStart(pid, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!validPid(pid)) return null;
  if (platform === 'linux') {
    try {
      const stat = readProcStat(pid, readFile);
      return stat && typeof stat === 'object' ? stat.start : null;
    } catch {
      return null;
    }
  }
  try {
    const output = exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function groupLeaderMatches(pgid, started, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!validPid(pgid) || typeof started !== 'string' || started === '') return false;
  if (platform === 'linux') {
    try {
      const stat = readProcStat(pgid, readFile);
      return Boolean(stat && typeof stat === 'object' && stat.pgid === pgid && stat.start === started);
    } catch {
      return false;
    }
  }
  try {
    const output = exec('/bin/ps', ['-o', 'pgid=', '-o', 'lstart=', '-p', String(pgid)], { encoding: 'utf8' }).trim();
    const match = /^(\d+)\s+(.+?)$/u.exec(output);
    return Boolean(match && Number(match[1]) === pgid && match[2] === started);
  } catch {
    return false;
  }
}

function groupMemberMatches(pgid, pid, started, { platform = process.platform, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!validPid(pgid) || !validPid(pid) || typeof started !== 'string' || started === '') return false;
  if (platform === 'linux') {
    try {
      const stat = readProcStat(pid, readFile);
      return Boolean(stat && typeof stat === 'object' && stat.pgid === pgid && stat.start === started && !/^[XZ]/u.test(stat.state));
    } catch {
      return false;
    }
  }
  try {
    const output = exec('/bin/ps', ['-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const match = /^(\d+)\s+(\S+)\s+(.+?)$/u.exec(output);
    return Boolean(match && Number(match[1]) === pgid && !/^[XZ]/u.test(match[2]) && match[3] === started);
  } catch {
    return false;
  }
}

function groupLiveMembers(pgid, { platform = process.platform, readDir = readdirSync, readFile = readFileSync, exec = execFileSync } = {}) {
  if (!validPid(pgid)) return [];
  if (platform === 'linux') {
    try {
      const members = [];
      for (const name of readDir('/proc')) {
        if (!/^[1-9]\d*$/u.test(name)) continue;
        const stat = readProcStat(name, readFile, { markDenied: true });
        if (stat && stat !== PROC_VANISHED && stat !== PROC_DENIED && stat.pgid === pgid && !/^[XZ]/u.test(stat.state)) {
          members.push({ pid: stat.pid, start: stat.start });
        }
      }
      return members;
    } catch {
      return [];
    }
  }
  try {
    const output = exec('/bin/ps', GROUP_LIST_ARGS, { encoding: 'utf8' });
    return parseListing(output)
      .filter((entry) => entry.pgid === pgid && Boolean(entry.state) && !/^[XZ]/u.test(entry.state))
      .map(({ pid, start }) => ({ pid, start }));
  } catch {
    return [];
  }
}

function linuxGroupHasOtherLiveMembers(pgid, readDir, readFile) {
  let before = readDir('/proc').filter((name) => /^[1-9]\d*$/u.test(name));
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    let disappeared = false;
    for (const name of before) {
      if (Number(name) === pgid) continue;
      const stat = readProcStat(name, readFile, { markVanished: true });
      if (stat === PROC_VANISHED) {
        disappeared = true;
        continue;
      }
      if (stat && typeof stat === 'object' && stat.pgid === pgid && !/^[XZ]/u.test(stat.state)) return true;
    }
    const after = readDir('/proc').filter((name) => /^[1-9]\d*$/u.test(name));
    const seen = new Set(before);
    if (!disappeared && !after.some((pid) => !seen.has(pid))) return false;
    before = after;
  }
  return true;
}

export async function groupHasOtherLiveMembers(pgid, { platform = process.platform, readDir = readdirSync, readFile = readFileSync, launch = spawn } = {}) {
  if (!validPid(pgid)) return false;
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
      return parseListing(stdout).some(
        (entry) => entry.pgid === pgid && entry.pid !== pgid && entry.pid !== child.pid && Boolean(entry.state) && !/^[XZ]/u.test(entry.state),
      );
    } catch {
      continue;
    }
  }
  return true;
}

function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function groupExists(child) {
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function exitOf(child) {
  return once(child, 'exit').then(([code]) => (Number.isInteger(code) ? code : 1), () => 127);
}

function openControlChannel(control) {
  let stream = control;
  const nativeFd = !stream;
  if (!stream) {
    try {
      stream = new Socket({ fd: 4, readable: true, writable: false });
    } catch {
      return { nextLine: () => Promise.resolve(null), isStopped: () => true, close: () => {} };
    }
  }
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
        const count = readSync(4, probe, 0, probe.length, null);
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
      return closed || lines.some((line) => line === 'stop' || line === 'term' || line === 'kill');
    },
    close: () => { stream.destroy?.(); },
  };
}

function holdWait(ms, released) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void released.then(() => {
      clearTimeout(timer);
      resolve();
      return null;
    });
  });
}

export async function superviseCommand(argv, {
  runCommand = (file, args) => exitOf(spawn(file, args, { stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'ignore'] })),
  hasOtherMembers = groupHasOtherLiveMembers,
  control = null,
  readPermission = null,
  writeStatus = (line, close = false) => {
    writeFileSync(3, `${line}\n`);
    if (close) closeSync(3);
  },
  now = Date.now,
  schedule = setTimeout,
  unschedule = clearTimeout,
  parentPid = process.ppid,
  currentParent = () => process.ppid,
  wait = holdWait,
  kill = process.kill,
} = {}) {
  const [mode, separator, file, ...args] = argv;
  if ((mode !== 'step' && mode !== 'review') || separator !== '--' || !file) return 1;
  let statusClosed = false;
  let signaled = false;
  let finished = false;
  let orphanGrace = null;
  const finishStatus = (line) => {
    statusClosed = true;
    try {
      writeStatus(line, true);
    } catch {}
  };
  const onSignal = (name) => {
    if (signaled) return;
    signaled = true;
    if (statusClosed) return;
    try {
      writeStatus(`signal ${name}`, false);
    } catch {}
  };
  for (const name of SIGNALS) process.on(name, onSignal);
  const channel = readPermission ? null : openControlChannel(control);
  try {
    let permission = '';
    try {
      permission = readPermission ? readPermission() : (await channel.nextLine()) ?? '';
    } catch {
      permission = '';
    }
    const match = /^start (\d+) (-?\d+)$/u.exec(permission.trim());
    if (!match || signaled) {
      finishStatus('refused 130');
      return 130;
    }
    const absDue = Number(match[1]);
    const left = Number(match[2]);
    const effectiveDue = absDue > 0 ? absDue : left > 0 ? now() + left : Infinity;
    if (left === 0 || now() >= effectiveDue) {
      finishStatus('late 124');
      return 124;
    }
    if (channel?.isStopped()) {
      finishStatus('refused 130');
      return 130;
    }
    if (now() >= effectiveDue) {
      finishStatus('late 124');
      return 124;
    }
    let released = false;
    let orphanStopped = false;
    let orphanKilled = false;
    let resolveHold = () => {};
    const holdDone = new Promise((resolve) => { resolveHold = () => { resolve(null); }; });
    const killGroupNow = () => {
      if (finished || orphanKilled || released) return;
      orphanStopped = true;
      orphanKilled = true;
      if (orphanGrace !== null) {
        unschedule(orphanGrace);
        orphanGrace = null;
      }
      try {
        kill(-process.pid, 'SIGKILL');
      } catch {}
      resolveHold();
    };
    const stopOrphanGroup = () => {
      if (finished || orphanStopped || released) return;
      orphanStopped = true;
      orphanGrace = schedule(() => {
        orphanGrace = null;
        orphanKilled = true;
        try {
          kill(-process.pid, 'SIGKILL');
        } catch {}
        resolveHold();
      }, STOP_GRACE_MS);
      try {
        kill(-process.pid, 'SIGTERM');
      } catch {}
    };
    const watchControl = async () => {
      if (!channel) return;
      for (;;) {
        const msg = await channel.nextLine();
        if (msg === 'release') {
          released = true;
          resolveHold();
          return;
        }
        if (msg === 'stop') continue;
        if (msg === 'term') {
          stopOrphanGroup();
          continue;
        }
        if (msg === 'kill') {
          killGroupNow();
          return;
        }
        if (msg === null) {
          stopOrphanGroup();
          return;
        }
      }
    };
    try {
      writeStatus('launched', false);
    } catch {
      return now() >= effectiveDue ? 124 : 130;
    }
    if (signaled || channel?.isStopped()) {
      finishStatus('refused 130');
      return 130;
    }
    if (now() >= effectiveDue) {
      finishStatus('late 124');
      return 124;
    }
    void watchControl();
    const code = await runCommand(file, args);
    const exitFor = () => (orphanStopped ? (now() >= effectiveDue ? 124 : 130) : code);
    const held = !orphanKilled && await hasOtherMembers(process.pid);
    finishStatus(`${held ? 'held' : 'done'} ${code}`);
    if (!held) return exitFor();
    for (;;) {
      if (released || orphanKilled || !await hasOtherMembers(process.pid)) return exitFor();
      if (!orphanStopped && currentParent() !== parentPid) stopOrphanGroup();
      await Promise.race([wait(HOLD_POLL_MS, holdDone), holdDone]);
    }
  } finally {
    finished = true;
    if (orphanGrace !== null) {
      unschedule(orphanGrace);
      orphanGrace = null;
    }
    channel?.close();
    for (const name of SIGNALS) process.removeListener(name, onSignal);
  }
}

export function commandBeforeDeadline(argv, env = process.env, {
  now = Date.now, launch = spawn, schedule = setTimeout, unschedule = clearTimeout,
  kill = killGroup, groupAlive = null, readStart = groupStart,
  checkLeader = groupLeaderMatches, readMembers = groupLiveMembers, checkMember = null,
  supervise = null, beforePermission = null,
  signal = new AbortController().signal,
} = {}) {
  if (!Array.isArray(argv) || !argv.length || !argv[0]) throw new Error('the deadline command names no setup command');
  const raw = env.KSAI_STEP_DEADLINE_AT;
  const stepDue = raw === undefined || raw === '' ? null : Number(raw);
  if (stepDue !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(stepDue) || stepDue <= 0)) {
    throw new Error('KSAI_STEP_DEADLINE_AT must be an epoch time in milliseconds');
  }
  const reviewDue = reviewDeadlineAt(env);
  const startedAt = now();
  if (stepDue !== null && stepDue <= startedAt) {
    writeOutputs(env.GITHUB_OUTPUT, { launched: false });
    return Promise.resolve(124);
  }
  if (reviewDue !== null && reviewDue <= startedAt) reviewTimeLeft(env, startedAt);
  const due = Math.min(reviewDue ?? Infinity, stepDue ?? Infinity);
  if (signal.aborted) return Promise.resolve(130);
  const supervised = supervise ?? (process.platform !== 'win32' && launch === spawn);
  const mode = stepDue !== null ? 'step' : 'review';
  const child = supervised
    ? launch(process.execPath, [SELF, '--supervise', mode, '--', ...argv], {
      env, stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'], detached: true,
    })
    : launch(argv[0], argv.slice(1), {
      env, stdio: 'inherit', detached: process.platform !== 'win32',
    });
  const useIdentity = process.platform !== 'win32' && groupAlive === null;
  const safeReadStart = (pid) => {
    try { return readStart(pid); } catch { return null; }
  };
  const safeCheckLeader = (pid, start) => {
    try { return Boolean(checkLeader(pid, start)); } catch { return false; }
  };
  const safeReadMembers = (pid) => {
    try { return readMembers(pid); } catch { return []; }
  };
  const started = useIdentity && child.pid ? safeReadStart(child.pid) : null;
  let knownMembers = [];
  const verifyMember = checkMember ?? (readMembers === groupLiveMembers
    ? groupMemberMatches
    : (pgid, pid, memberStart) => safeReadMembers(pgid).some((member) => member.pid === pid && member.start === memberStart));
  const safeVerifyMember = (pgid, pid, memberStart) => {
    try { return Boolean(verifyMember(pgid, pid, memberStart)); } catch { return false; }
  };
  const membersMatch = () => {
    if (!knownMembers.length) return false;
    const live = safeReadMembers(child.pid);
    const matched = live.filter((member) => knownMembers.some((known) => known.pid === member.pid && known.start === member.start));
    return matched.some((member) => safeVerifyMember(child.pid, member.pid, member.start));
  };
  const groupOwned = () => {
    if (!child.pid) return false;
    if (!useIdentity) return groupAlive ? groupAlive(child) : groupExists(child);
    if (!started) return false;
    if (safeCheckLeader(child.pid, started)) return true;
    return membersMatch();
  };
  const signalVerified = (sig) => {
    if (!child.pid) return false;
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      kill(child, sig);
      return true;
    }
    if (!useIdentity) {
      kill(child, sig);
      return true;
    }
    if (!started) return false;
    if (safeCheckLeader(child.pid, started)) {
      if (!supervised && sig === 'SIGTERM') {
        const members = safeReadMembers(child.pid);
        if (!safeCheckLeader(child.pid, started)) return false;
        knownMembers = members;
      }
      kill(child, sig);
      return true;
    }
    if (!membersMatch()) return false;
    kill(child, sig);
    return true;
  };
  return new Promise((resolve) => {
    let timer = null;
    let grace = null;
    let stopped = false;
    let expired = false;
    let settled = false;
    let closed = false;
    let verifiedDone = false;
    let permitted = !supervised;
    let commandLaunched = !supervised;
    let wroteNotLaunched = false;
    let launchRefused = false;
    let launchedLate = false;
    let identityFailed = false;
    let permissionEnded = false;
    let exit = 1;
    const status = child.stdio?.[3];
    const permission = child.stdio?.[4];
    permission?.on('error', () => {});
    let statusLine = '';
    const armDeadline = () => {
      if (!Number.isFinite(due) || timer !== null || settled) return;
      timer = schedule(() => {
        expired = true;
        stop();
      }, Math.max(0, due - now()));
    };
    const settle = (code, { atDeadline = !launchRefused && Number.isFinite(due) && now() >= due } = {}) => {
      if (settled) return;
      settled = true;
      if (timer !== null) unschedule(timer);
      if (grace !== null) unschedule(grace);
      signal.removeEventListener('abort', stop);
      if (!permissionEnded) permission?.destroy();
      if (status) {
        status.off('data', onStatus);
        status.destroy();
      }
      const finalCode = expired || (!launchRefused && atDeadline) ? 124 : stopped ? 130 : code;
      if (finalCode === 124 && stepDue !== null && !commandLaunched && !wroteNotLaunched) {
        wroteNotLaunched = true;
        writeOutputs(env.GITHUB_OUTPUT, { launched: false });
      }
      resolve(finalCode);
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      if (!permitted) {
        launchRefused = true;
        permission?.destroy();
        return;
      }
      if (permission && 'write' in permission) permission.write('stop\n');
      grace = schedule(() => {
        if (!signalVerified('SIGKILL') && permission && 'end' in permission) {
          permissionEnded = true;
          permission.end('kill\n');
        }
        grace = null;
        if (closed) finish(exit);
      }, STOP_GRACE_MS);
      if (!signalVerified('SIGTERM') && permission && 'write' in permission) permission.write('term\n');
    };
    const finish = (code) => {
      if (settled) return;
      closed = true;
      exit = code;
      if (launchRefused) {
        settle(launchedLate ? 124 : identityFailed ? 1 : 130, { atDeadline: false });
        return;
      }
      const atDeadline = Number.isFinite(due) && now() >= due;
      if (stopped && grace !== null && !verifiedDone && groupOwned()) return;
      if (!stopped && !verifiedDone && (atDeadline || signal.aborted) && groupOwned()) {
        if (atDeadline) expired = true;
        stop();
        return;
      }
      if (!stopped && stepDue !== null && !verifiedDone && groupOwned()) signalVerified('SIGKILL');
      settle(code, { atDeadline });
    };
    const grantPermission = () => {
      if (settled || permitted) return;
      if (signal.aborted || stopped) {
        launchRefused = true;
        stopped = true;
        permission?.destroy();
        return;
      }
      const current = now();
      if (Number.isFinite(due) && current >= due) {
        launchRefused = true;
        launchedLate = true;
        expired = true;
        permission?.destroy();
        return;
      }
      if (useIdentity && !started) {
        launchRefused = true;
        identityFailed = true;
        permission?.destroy();
        return;
      }
      permitted = true;
      const absDue = Number.isFinite(due) && isNativeNow(now) ? due : 0;
      const left = Number.isFinite(due) ? Math.max(1, due - current) : -1;
      if (permission && 'write' in permission) permission.write(`start ${absDue} ${left}\n`);
      armDeadline();
    };
    const onStatus = (chunk) => {
      statusLine += chunk.toString('utf8');
      for (;;) {
        const end = statusLine.indexOf('\n');
        if (end === -1) return;
        const line = statusLine.slice(0, end).trim();
        statusLine = statusLine.slice(end + 1);
        if (line === 'launched') {
          commandLaunched = true;
          continue;
        }
        if (line === 'signal SIGTERM' || line === 'signal SIGINT') {
          stop();
          continue;
        }
        if (line === 'late 124') {
          commandLaunched = false;
          launchRefused = true;
          launchedLate = true;
          expired = true;
          verifiedDone = true;
          exit = 124;
          return;
        }
        if (line === 'refused 130') {
          commandLaunched = false;
          launchRefused = true;
          if (!identityFailed) stopped = true;
          verifiedDone = true;
          exit = identityFailed ? 1 : 130;
          return;
        }
        const match = /^(done|held) (\d+)$/u.exec(line);
        if (!match) continue;
        commandLaunched = true;
        const code = Number(match[2]);
        exit = Number.isInteger(code) ? code : 1;
        if (match[1] === 'done') {
          verifiedDone = true;
          return;
        }
        closed = true;
        const atDeadline = Number.isFinite(due) && now() >= due;
        if (!stopped && (signal.aborted || atDeadline)) {
          if (atDeadline) expired = true;
          stop();
          return;
        }
        if (stopped) {
          if (grace !== null) return;
          settle(exit, { atDeadline: false });
          return;
        }
        if (stepDue !== null) {
          if (!signalVerified('SIGKILL') && permission && 'end' in permission) {
            permissionEnded = true;
            permission.end('kill\n');
          }
          settle(exit, { atDeadline: false });
          return;
        }
        if (permission && 'end' in permission) {
          permissionEnded = true;
          permission.end('release\n');
        }
        settle(exit, { atDeadline: false });
        return;
      }
    };
    if (status) {
      status.on('error', () => {});
      status.on('data', onStatus);
    }
    child.once('error', () => finish(127));
    child.once('close', (code) => finish(verifiedDone ? exit : Number.isInteger(code) ? code : 1));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) {
      stop();
      return;
    }
    if (supervised) {
      if (beforePermission) void Promise.resolve(beforePermission()).then(grantPermission, () => stop());
      else grantPermission();
    } else {
      armDeadline();
    }
  });
}

await runMain(import.meta.url, async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--supervise') {
    process.exitCode = await superviseCommand(argv.slice(1));
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  for (const signal of SIGNALS) process.once(signal, stop);
  try {
    process.exitCode = await commandBeforeDeadline(argv[0] === '--' ? argv.slice(1) : argv, process.env, { signal: abort.signal });
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, stop);
  }
});
