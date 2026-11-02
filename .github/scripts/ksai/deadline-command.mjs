import { spawn } from 'node:child_process';

import { runMain } from '../lib/main.mjs';
import { reviewDeadlineAt, reviewTimeLeft } from '../lib/review-deadline.mjs';

const STOP_GRACE_MS = 10_000;
const SIGNALS = ['SIGINT', 'SIGTERM'];

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

export function commandBeforeDeadline(argv, env = process.env, {
  now = Date.now, launch = spawn, schedule = setTimeout, unschedule = clearTimeout,
  kill = killGroup, groupAlive = groupExists, signal = new AbortController().signal,
} = {}) {
  if (!Array.isArray(argv) || !argv.length || !argv[0]) throw new Error('the deadline command names no setup command');
  reviewTimeLeft(env, now());
  const due = reviewDeadlineAt(env);
  if (signal.aborted) return Promise.resolve(130);
  const child = launch(argv[0], argv.slice(1), { env, stdio: 'inherit', detached: process.platform !== 'win32' });
  return new Promise((resolve) => {
    let timer = null;
    let grace = null;
    let stopped = false;
    let expired = false;
    let settled = false;
    let closed = false;
    let exit = 1;
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      grace = schedule(() => {
        kill(child, 'SIGKILL');
        grace = null;
        if (closed) finish(exit);
      }, STOP_GRACE_MS);
      kill(child, 'SIGTERM');
    };
    const finish = (code) => {
      if (settled) return;
      closed = true;
      exit = code;
      if (stopped && grace !== null && groupAlive(child)) return;
      settled = true;
      if (timer !== null) unschedule(timer);
      if (grace !== null) unschedule(grace);
      signal.removeEventListener('abort', stop);
      resolve(expired ? 124 : stopped ? 130 : code);
    };
    child.once('error', () => finish(127));
    child.once('close', (code) => finish(Number.isInteger(code) ? code : 1));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    if (due !== null) {
      timer = schedule(() => {
        expired = true;
        stop();
      }, Math.max(0, due - now()));
    }
  });
}

await runMain(import.meta.url, async () => {
  const abort = new AbortController();
  const stop = () => abort.abort();
  for (const signal of SIGNALS) process.once(signal, stop);
  try {
    const argv = process.argv.slice(2);
    process.exitCode = await commandBeforeDeadline(argv[0] === '--' ? argv.slice(1) : argv, process.env, { signal: abort.signal });
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, stop);
  }
});
