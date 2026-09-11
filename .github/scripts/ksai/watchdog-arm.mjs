import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { annotation } = require('../lib/text.cjs');
const { warningFor } = require('./warn.cjs');
const {
  ASSUMED_CEILING_MINUTES,
  MAX_CEILING_MINUTES,
  SALVAGE_MARGIN_MINUTES,
  ceilingMinutes,
  wholeNumber: whole,
} = require('../lib/watchdog.cjs');

const WATCHDOG_OFF = 'off';

function spentBefore(stampedAtMs, armedAtMs) {
  const stamped = whole(stampedAtMs);
  if (stamped === null || stamped <= 0 || armedAtMs <= stamped) return 0;
  return Math.floor((armedAtMs - stamped) / 1000);
}

export function plan(env, say = console.log) {
  const warn = warningFor(say);
  const asked = String(env.JOB_TIMEOUT_MINUTES ?? '').trim();
  if (asked === '') {
    warn(
      `job_timeout_minutes was not set, so the watchdog assumes a ${ASSUMED_CEILING_MINUTES}-minute job ceiling. GitHub cancels a job whose own timeout-minutes is lower before the watchdog can fire, and that run reports nothing at all. Pass this job's timeout-minutes`,
    );
  } else if (whole(asked) === null) {
    say(annotation(`job_timeout_minutes must be a non-negative integer, got '${asked}'`));
    return null;
  } else if (Number(asked) === 0) {
    say('Watchdog disabled (job_timeout_minutes=0)');
    return WATCHDOG_OFF;
  }

  const ceiling = ceilingMinutes(asked);
  if (ceiling === null) {
    say(
      annotation(
        `job_timeout_minutes must exceed the ${SALVAGE_MARGIN_MINUTES}-minute salvage margin and be no more than ${MAX_CEILING_MINUTES}, GitHub's own longest job, got ${asked}`,
      ),
    );
    return null;
  }

  const failures = whole(env.MAX_CONSECUTIVE_FAILURES);
  if (failures === null) {
    say(annotation(`max_consecutive_tool_failures must be a non-negative integer, got '${env.MAX_CONSECUTIVE_FAILURES ?? ''}'`));
    return null;
  }
  const repeats = whole(env.MAX_REPEATED_CALLS);
  if (repeats === null) {
    say(annotation(`max_repeated_tool_calls must be a non-negative integer, got '${env.MAX_REPEATED_CALLS ?? ''}'`));
    return null;
  }
  if (repeats === 1) {
    say(
      annotation(
        'max_repeated_tool_calls of 1 would stop every run at its first tool call, since one call is already a run of one. Use 0 to turn the check off, or 2 or more',
      ),
    );
    return null;
  }
  if (String(env.CLI_PATTERN ?? '') === '') {
    say(annotation('the watchdog was armed with no CLI pattern, so it would stop nothing'));
    return null;
  }
  const poll = whole(env.POLL_SECONDS);
  if (poll === null || poll < 1) {
    say(annotation(`POLL_SECONDS must be a positive integer, got '${env.POLL_SECONDS ?? ''}'`));
    return null;
  }

  const armedAtMs = Math.floor(Date.now() / 1000) * 1000;
  let spent = spentBefore(env.STAMPED_AT_MS, armedAtMs);
  if (spent >= ceiling * 60) {
    warn(
      `the job start stamp reads ${spent}s ago, which is longer than this job's own ${ceiling}-minute ceiling. A job that had really spent that long was already cancelled, so the stamp is implausible rather than late: it is ignored and the deadline is measured from this step instead`,
    );
    spent = 0;
  }
  let deadline = (ceiling - SALVAGE_MARGIN_MINUTES) * 60 - poll - spent;
  if (deadline < 1) {
    deadline = 1;
    warn(
      `${spent}s of this job's ${ceiling}-minute ceiling was spent before the model started, which leaves it no window at all. This run is stopped and salvaged at once; raise job_timeout_minutes`,
    );
  }
  return { ceiling, deadline, armedAtMs, spent, poll, failures, repeats };
}

export function main(env = process.env, say = console.log, start = spawn) {
  const armed = plan(env, say);
  if (armed === null) return 1;
  if (armed === WATCHDOG_OFF) return 0;

  for (const file of [env.FIRED_FILE, env.REASON_FILE, env.CAUSE_FILE, env.MISSED_FILE].filter(Boolean)) {
    rmSync(file, { force: true });
  }

  const killAtMs = armed.armedAtMs + armed.deadline * 1000;
  const at = join(String(env.SCRIPTS), 'ksai/watchdog-loop.mjs');
  if (!existsSync(at)) {
    say(annotation(`the watchdog loop is not at ${at}, so this run would reach the job ceiling unwatched`));
    return 1;
  }

  const loop = start(
    process.execPath,
    [at],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...env,
        ARMED_AT_MS: String(armed.armedAtMs),
        END_AT_MS: String(killAtMs),
        JOB_TIMEOUT_MINUTES: String(armed.ceiling),
        MAX_CONSECUTIVE_FAILURES: String(armed.failures),
        MAX_REPEATED_CALLS: String(armed.repeats),
        POLL_SECONDS: String(armed.poll),
        TRANSCRIPT_WINDOW_MS: String(armed.poll * 3000),
      },
    },
  );
  loop.unref();
  writeFileSync(String(env.PID_FILE), `${loop.pid}\n`);

  writeOutputs(env.GITHUB_OUTPUT, {
    fired_file: env.FIRED_FILE,
    reason_file: env.REASON_FILE,
    cause_file: env.CAUSE_FILE,
    missed_file: env.MISSED_FILE,
    armed_at_ms: armed.armedAtMs,
    kill_at_ms: killAtMs,
    ceiling: armed.ceiling,
  });

  say(
    `Watchdog armed: SIGTERM to the CLI after ${armed.deadline}s (job ceiling ${armed.ceiling}m, ${armed.spent}s of it already spent before this step)`,
  );
  say(
    armed.failures > 0 || armed.repeats > 0
      ? `Circuit breaker armed, polled every ${armed.poll}s: SIGTERM after ${armed.failures} failures in a row or ${armed.repeats} identical calls in a row (0 means that half is off)`
      : 'Circuit breaker disabled (both limits are 0)',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
