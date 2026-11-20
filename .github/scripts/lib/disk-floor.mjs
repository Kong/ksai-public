import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, statfsSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { constants } from 'node:os';
import path from 'node:path';

import { runMain } from './main.mjs';

export const DISK_FLOOR = 3 * 2 ** 30;
export const INODE_FLOOR = 100_000;
export const DISK_STOPS = Object.freeze(['bytes', 'inodes', 'unreadable']);
export const TIMED_OUT = 'time';
export const NOT_STARTED = 'start';
export const SANDBOX_FLAGS = Object.freeze(['--as-pid-1', '--info-fd', '4']);
export const GUARD = path.join(import.meta.dirname, 'disk-floor.mjs');
export const GRACE_MS = 30_000;
export const STOP_SAID = Object.freeze({
  bytes: `the runner disk had less than ${DISK_FLOOR / 2 ** 30} GiB free`,
  inodes: `the runner disk had fewer than ${INODE_FLOOR} free inodes`,
  unreadable: 'the free space on the runner disk or the sandbox could not be read',
  [TIMED_OUT]: 'it ran out of time',
  [NOT_STARTED]: 'the sandbox could not start',
});
const REASONS = Object.freeze([...DISK_STOPS, TIMED_OUT, NOT_STARTED]);
const STOPPED = 75;
const UNSTARTED = 127;
const SIGNALLED = 128;
const EVERY_MS = 200;
const REASON_FD = 3;
const CALLER_FD = 4;
const GONE = new Set(['ENOENT', 'ESRCH']);
const HALTED = new Set(['T', 't', 'Z', 'X']);

export function roomOn(at, statfs = statfsSync) {
  try {
    const held = statfs(at, { bigint: true });
    return { bytes: Number(held.bavail * (held.frsize || held.bsize)), inodes: held.files > 0n ? Number(held.ffree) : Infinity };
  } catch {
    return null;
  }
}

export function lowOn(at, statfs = statfsSync) {
  const room = roomOn(at, statfs);
  if (!room) return 'unreadable';
  if (room.bytes < DISK_FLOOR) return 'bytes';
  return room.inodes < INODE_FLOOR ? 'inodes' : '';
}

export function statOf(text) {
  const end = String(text).lastIndexOf(')');
  if (end < 0) return null;
  const [state, parent] = String(text).slice(end + 2).split(' ');
  return /^[A-Za-z]$/.test(state ?? '') && /^\d+$/.test(parent ?? '') ? { state, parent: Number(parent) } : null;
}

const procStat = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8');

export function endSandbox(bwrap, command, { read = procStat, kill = process.kill } = {}) {
  try {
    kill(bwrap, 'SIGSTOP');
  } catch {
    return '';
  }
  try {
    for (;;) {
      const held = statOf(read(bwrap));
      if (!held) return 'unreadable';
      if (HALTED.has(held.state)) break;
    }
    let child;
    try {
      child = statOf(read(command));
    } catch (error) {
      return GONE.has(error?.code) ? '' : 'unreadable';
    }
    if (!child) return 'unreadable';
    if (child.parent === bwrap) kill(command, 'SIGKILL');
    return '';
  } catch {
    return 'unreadable';
  } finally {
    try {
      kill(bwrap, 'SIGCONT');
    } catch {}
  }
}

function pidOf(info) {
  try {
    const pid = JSON.parse(info)['child-pid'];
    return Number.isInteger(pid) && pid > 1 ? pid : 0;
  } catch {
    return 0;
  }
}

const nullDevice = () => openSync('/dev/null', 'r');

export function guard(argv, {
  at, limit, env, launch = spawn, low = lowOn, end = endSandbox, every = EVERY_MS, say = (word) => writeSync(REASON_FD, word), blank = nullDevice,
  caller = null,
}) {
  return new Promise((resolve) => {
    const told = (word, code) => {
      try {
        say(word);
      } catch {}
      resolve(code);
    };
    const early = low(at);
    if (early) {
      told(early, STOPPED);
      return;
    }
    const bwrap = launch('bwrap', [...SANDBOX_FLAGS, ...argv], { env, stdio: ['ignore', 'inherit', 'inherit', blank(), 'pipe'] });
    let info = '';
    let command = 0;
    let known = false;
    let stop = '';
    let acted = false;
    let settled = false;
    let exited = null;
    const quiet = () => {
      clearInterval(poll);
      clearTimeout(timer);
    };
    const act = () => {
      if (!stop || acted || !known || exited) return;
      acted = true;
      if (command === 0) return;
      const why = end(bwrap.pid, command);
      if (!why) return;
      settled = true;
      quiet();
      told(why, STOPPED);
    };
    const request = (word) => {
      if (exited) return;
      stop ||= word;
      act();
    };
    const finish = () => {
      if (settled || !exited || !known) return;
      settled = true;
      quiet();
      const { code, signal } = exited;
      const word = low(at) || (stop && signal ? 'unreadable' : stop);
      if (word) told(word, STOPPED);
      else if (command === 0) told(NOT_STARTED, UNSTARTED);
      else resolve(code ?? SIGNALLED + (constants.signals[signal] ?? 0));
    };
    const poll = setInterval(() => {
      const why = low(at);
      if (why) request(why);
    }, every);
    const timer = setTimeout(() => request(TIMED_OUT), limit);
    caller?.once('end', () => request('unreadable'));
    const child = /** @type {import('node:stream').Readable | null | undefined} */ (bwrap.stdio[4]);
    known = !child;
    child?.setEncoding('utf8');
    child?.on('data', (chunk) => {
      info += chunk;
    });
    child?.on('end', () => {
      known = true;
      command = pidOf(info);
      act();
      finish();
    });
    bwrap.on('error', () => {
      if (settled) return;
      settled = true;
      quiet();
      told(NOT_STARTED, UNSTARTED);
    });
    bwrap.on('exit', (code, signal) => {
      exited = { code, signal };
      quiet();
      finish();
    });
  });
}

export function fencedRun(argv, { env, timeout, at, run = spawnSync, kill = process.kill, low = lowOn }) {
  /** @type {import('node:child_process').SpawnSyncOptions & { detached: boolean }} */
  const options = {
    input: JSON.stringify(env ?? {}),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.env.RUNNER_TRACKING_ID ? { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID } : {}),
    },
    stdio: ['pipe', 'inherit', 'inherit', 'pipe', 'pipe'],
    timeout: timeout + GRACE_MS,
    killSignal: 'SIGKILL',
    detached: true,
  };
  const done = run(process.execPath, [GUARD, at, String(Math.max(1, Math.ceil(timeout))), '--', ...argv], options);
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (done.error);
  const said = String(done.output?.[3] ?? '');
  const timedOut = error?.code === 'ETIMEDOUT';
  let stop = REASONS.includes(said) ? said : '';
  if ((error || done.signal || stop === 'unreadable') && Number.isInteger(done.pid) && done.pid > 1) {
    try {
      kill(-done.pid, 'SIGKILL');
    } catch {}
  }
  if (!stop && (timedOut || done.signal)) stop = low(at) || (timedOut ? TIMED_OUT : '');
  return { status: stop ? null : done.status, signal: done.signal ?? null, error: timedOut ? undefined : error, stop };
}

await runMain(import.meta.url, async () => {
  const [at, limit, separator, ...argv] = process.argv.slice(2);
  if (!path.isAbsolute(String(at ?? '')) || !(Number(limit) > 0) || separator !== '--' || argv.length === 0) {
    throw new Error('disk-floor.mjs takes a directory, a time limit in milliseconds, --, and the bwrap arguments');
  }
  let code = STOPPED;
  try {
    const env = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const caller = new Socket({ fd: CALLER_FD, readable: true, writable: false });
    caller.on('error', () => {});
    caller.resume();
    code = await guard(argv, { at, limit: Number(limit), env, caller });
  } catch {
    try {
      writeSync(REASON_FD, 'unreadable');
    } catch {}
  }
  process.exit(code);
});
