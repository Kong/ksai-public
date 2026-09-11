import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { warningFor } = require('./warn.cjs');

const CAUSES = new Set(['progress', 'halt']);

const SETTLE_MS = 3000;
const LOOK_MS = 50;

function firstLine(at) {
  try {
    return readFileSync(at, 'utf-8').replaceAll('\r', '').split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

const there = (at) => Boolean(at) && existsSync(at);

export function defunct(pid, root = '/proc') {
  try {
    const stat = readFileSync(join(root, String(pid), 'stat'), 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim().startsWith('Z');
  } catch {
    return false;
  }
}

const alive = (signal, pid) => {
  try {
    signal(pid, 0);
  } catch {
    return false;
  }
  return !defunct(pid);
};

export async function reap(env, say = console.log, signal = process.kill, sleep = wait, within = SETTLE_MS) {
  if (!there(env.PID_FILE)) return;
  const pid = Number(firstLine(env.PID_FILE));
  let watching = false;
  if (Number.isInteger(pid) && pid > 0 && !defunct(pid)) {
    try {
      signal(pid, 'SIGTERM');
      watching = true;
    } catch {
      watching = false;
    }
  }
  if (watching) {
    const until = Date.now() + within;
    while (alive(signal, pid) && Date.now() < until) await sleep(LOOK_MS);
    if (alive(signal, pid)) {
      try {
        signal(pid, 'SIGKILL');
      } catch {}
      warningFor(say)(
        `the watchdog loop was still running ${within}ms after it was asked to stop, so it was killed outright. A trip it was in the middle of did not finish, so a stop this run reports may be missing its reason`,
      );
    }
  }
  if (!watching && !there(env.FIRED_FILE) && !there(env.MISSED_FILE)) {
    warningFor(say)(
      'the watchdog loop was not running when this step reaped it, and it neither stopped the run nor recorded a ceiling it could not act on. This run was unwatched: nothing would have stopped it before the job ceiling',
    );
  }
  try {
    rmSync(env.PID_FILE, { force: true });
  } catch {}
}

export function verdict(env, say = console.log) {
  if (!there(env.FIRED_FILE)) {
    if (there(env.MISSED_FILE)) {
      warningFor(say)(
        `${firstLine(env.MISSED_FILE)}, and no CLI process running in this workspace was found to stop. Nothing was salvaged by the watchdog`,
      );
    }
    return { fired: 'false', cause: '', reason: '' };
  }
  const reason = firstLine(env.REASON_FILE);
  const said = firstLine(env.CAUSE_FILE);
  const cause = CAUSES.has(said) ? said : 'ceiling';
  warningFor(say)(
    `This run was stopped on purpose: ${reason || 'no reason was recorded'}. The "SDK execution error" and "exited with code 143" above are that stop - 143 is SIGTERM - and not a fault in the run. What it had done before it was stopped is under "What the run did"`,
  );
  say('The watchdog fired: the CLI was stopped short of the job ceiling');
  return { fired: 'true', cause, reason };
}

export async function main(env = process.env, say = console.log) {
  await reap(env, say);
  const said = verdict(env, say);
  writeOutputs(env.GITHUB_OUTPUT, {
    fired: said.fired,
    cause: said.cause,
    reason: said.reason,
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
