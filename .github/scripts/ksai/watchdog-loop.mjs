import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { TRIPPED } from './progress.mjs';
import { main as stopDue } from './stop-due.mjs';

const require = createRequire(import.meta.url);
const { wholeNumber } = require('../lib/watchdog.cjs');

const numberIn = (value) => wholeNumber(value) ?? 0;

function stalled(env) {
  if (numberIn(env.MAX_CONSECUTIVE_FAILURES) <= 0 && numberIn(env.MAX_REPEATED_CALLS) <= 0) return '';
  const checker = env.ENGINE === 'opencode' ? 'kreview/opencode-progress.mjs' : 'ksai/progress.mjs';
  const out = spawnSync(process.execPath, [join(env.SCRIPTS, checker), '--check'], {
    encoding: 'utf-8',
    env: { ...env, TRANSCRIPT_SINCE: env.ARMED_AT_MS },
  });
  return out.status === TRIPPED ? String(out.stdout ?? '').trim() : '';
}

export function stop(env) {
  let here = String(env.GITHUB_WORKSPACE ?? '');
  try {
    here = realpathSync(here);
  } catch {}
  const found = spawnSync('pgrep', ['-f', String(env.CLI_PATTERN)], { encoding: 'utf-8' });
  let killed = false;
  for (const line of String(found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let cwd = '';
    try {
      cwd = realpathSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== here) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killed = true;
    } catch {}
  }
  return killed;
}

function bestEffort(run) {
  try {
    return run();
  } catch {
    return '';
  }
}

export function trip(env) {
  if (Date.now() >= numberIn(env.END_AT_MS)) {
    return { reason: `the job ceiling (${env.JOB_TIMEOUT_MINUTES}m) was reached`, cause: 'ceiling' };
  }
  const halt = bestEffort(() => stopDue(env));
  if (halt) return { reason: halt, cause: 'halt' };
  const stall = bestEffort(() => stalled(env));
  if (stall) return { reason: stall, cause: 'progress' };
  return null;
}

export async function watch(env, { sleep = wait, kill = stop } = {}) {
  const poll = numberIn(env.POLL_SECONDS) * 1000;
  let asked = false;
  const finishFirst = () => {
    asked = true;
  };
  for (;;) {
    await sleep(Math.min(poll, Math.max(0, numberIn(env.END_AT_MS) - Date.now())));
    const tripped = trip(env);
    if (!tripped) {
      if (asked) return 'asked';
      continue;
    }

    process.on('SIGTERM', finishFirst);
    let killed = false;
    try {
      bestEffort(() => writeFileSync(env.REASON_FILE, `${tripped.reason}\n`));
      bestEffort(() => writeFileSync(env.CAUSE_FILE, `${tripped.cause}\n`));
      bestEffort(() => writeFileSync(env.FIRED_FILE, ''));
      killed = kill(env);
      if (!killed) {
        for (const file of [env.REASON_FILE, env.CAUSE_FILE, env.FIRED_FILE]) {
          bestEffort(() => rmSync(file, { force: true }));
        }
        if (tripped.cause === 'ceiling') {
          bestEffort(() => writeFileSync(env.MISSED_FILE, `${tripped.reason}\n`));
        }
      }
    } finally {
      process.off('SIGTERM', finishFirst);
    }
    if (killed) return 'stopped';
    if (tripped.cause === 'ceiling') return 'missed';
    if (asked) return 'asked';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await watch(process.env);
}
