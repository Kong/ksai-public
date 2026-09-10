import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { conclusionOf, exitedOn, stopReason } from '../lib/execution-log.mjs';
import modelCatalog from '../lib/model-catalog.json' with { type: 'json' };
import { answer, collectSecrets, executionLog, listed, parsed, sandboxScopes, scrub, spending } from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { bearer, heldExpiry } from '../lib/opencode-token.mjs';
import { completeStage, LIMITS, readExport, recordChildren, recordedCompletion, recoverReview, reviewAnswer, reviewSession, streamFailure } from './opencode-review.mjs';

export { listed };

const MASKED_HOMES = ['.config', '.claude'];

const UNSET = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_OIDC_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
];

const SCRUBBED = ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export const scrubbing = (env) => String(env.SUBPROCESS_ENV_SCRUB ?? '1').trim() !== '0';

// Half the gateway token's 300s life minus the 120s advisory margin, so a tick that drifts still
// lands well inside the window. Measured at 60s: renewals fell 180s, 195s and 164s apart on run
// 34442575839 - the 195s one had already drifted 15s past the point it was due.
const BROKER_PERIOD_MS = 30_000;

const READ_ONLY_ON_TEST = ['.git', '.ksai'];

const RESOLVER = '/etc/resolv.conf';

const MASKED_RUNTIME = '/run';

export function scopeBinds(env = process.env, exists = existsSync) {
  const scopes = sandboxScopes(env, exists);
  for (const at of scopes.missing) {
    console.log(
      `::warning::the sandbox scope ${at} is not on this runner, so nothing is bound there and no tool may reach it`,
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
  if (temp) args.push('--tmpfs', temp);

  for (const name of MASKED_HOMES) {
    const at = join(home, name);
    if (!exists(at)) continue;
    if (kind(at).isDirectory()) args.push('--tmpfs', at);
    else args.push('--ro-bind', '/dev/null', at);
  }

  const config = String(env.OPENCODE_CONFIG ?? '');
  const scripts = String(env.SCRIPTS ?? '');
  args.push('--bind', workspace, workspace);
  const trusted = join(workspace, '_ksai');
  if (exists(trusted)) args.push('--ro-bind', trusted, trusted);
  args.push('--ro-bind', config, config, '--ro-bind', scripts, scripts, '--bind', opencodeHome, opencodeHome);

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
  if (tokenDir && exists(tokenDir)) {
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
  const scrubbed = scrubbing(env) ? SCRUBBED : [];
  for (const name of new Set([...UNSET, ...scrubbed, ...listed(env.SANDBOX_DENY_ENV)])) {
    args.push('--unsetenv', name);
  }
  args.push('--unshare-user', '--unshare-pid', '--new-session', '--die-with-parent', '--chdir', workspace, '--');
  return args;
}

export function runArgs(env = process.env) {
  const named = String(env.MODEL ?? '').trim() || modelCatalog.aliases[modelCatalog.defaultAlias];
  const args = ['run', '--model', `anthropic/${named}`, '--format', 'json'];
  if (env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY)) args.push('--agent', env.OPENCODE_REVIEW_FINALIZE === 'true' ? 'ksai-review-finish' : 'ksai-review-stage');
  const variant = String(env.VARIANT ?? '').trim();
  if (variant && !(env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY) && env.OPENCODE_REVIEW_FINALIZE === 'true')) args.push('--variant', variant);
  const session = String(env.OPENCODE_RESUME_SESSION ?? '').trim();
  if (session) args.push('--session', session, '--fork');
  return args;
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

async function main(env = process.env) {
  const home = String(env.OPENCODE_HOME ?? '');
  for (const name of ['config', 'cache', 'state']) mkdirSync(join(home, name), { recursive: true });
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  writeFileSync(events, '');
  writeOutputs(env.GITHUB_OUTPUT, {
    execution_file: execution,
  });

  const tokenDir = String(env.RUNNER_TEMP ?? '') ? join(String(env.RUNNER_TEMP), 'ksai-token') : '';
  const tokenFile = tokenDir ? join(tokenDir, 'token.json') : '';
  if (tokenDir) mkdirSync(tokenDir, { recursive: true });

  const sandbox = sandboxArgs({ ...env, KSAI_TOKEN_DIR: tokenDir, KSAI_TOKEN_FILE: tokenFile });
  const probe = spawnSync('bwrap', [...sandbox, 'opencode', '--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    const said = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || String(probe.error?.message ?? 'no output');
    console.log(
      `::error::opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no run was attempted: ${said}`,
    );
    return 1;
  }
  console.log(`sandboxed opencode ${String(probe.stdout ?? '').trim()}`);

  const out = openSync(events, 'w');
  let code = 0;
  let deadlineExpired = false;
  let ticking = null;
  try {
    if (tokenFile) {
      await broker(tokenFile, env);
      ticking = setInterval(() => void broker(tokenFile, env), BROKER_PERIOD_MS);
      ticking.unref?.();
    }
    const pipeline = env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
    const invoke = async ({ prompt, timeoutMs = 0, resumeSession = '', finalize = false }) => {
      const began = Date.now();
      const offset = statSync(events).size;
      const ran = spawn('bwrap', [...sandbox, 'opencode', ...runArgs(env.FLOW === 'review' ? { ...env, OPENCODE_RESUME_SESSION: resumeSession, OPENCODE_REVIEW_FINALIZE: String(finalize) } : env)], {
        stdio: ['pipe', out, 'inherit'],
      });
      let hardStop = null;
      let timedOut = false;
      const timeout = timeoutMs ? setTimeout(() => {
        timedOut = true;
        ran.kill('SIGTERM');
        hardStop = setTimeout(() => ran.kill('SIGKILL'), 2000);
      }, timeoutMs) : null;
      ran.stdin.on('error', () => {});
      ran.stdin.end(prompt);
      const status = await new Promise((ended) => {
        ran.on('error', () => ended(127));
        ran.on('close', (value, signal) => ended(exitedOn(value, signal)));
      });
      if (timeout) clearTimeout(timeout);
      if (hardStop) clearTimeout(hardStop);
      const segment = parsed(readFileSync(events).subarray(offset).toString('utf8'));
      const [result] = executionLog({ events: segment, exitCode: status, said: answer(segment) });
      const remaining = timeoutMs - (Date.now() - began);
      const recorded = pipeline && status === 0 && remaining > 0 ? recordedCompletion(segment, (id) => readExport({ env, sandbox, id, timeoutMs: Math.min(15_000, remaining) })) : {};
      return { code: status, text: recorded.text || (env.FLOW === 'review' && !pipeline ? reviewAnswer(segment) : answer(segment)), completion: recorded.completion, session_id: segment.find((event) => typeof event.sessionID === 'string')?.sessionID,
        failure: streamFailure(segment), timed_out: timedOut,
        usage: spending(segment).length ? { ...result.usage, cost_usd: result.total_cost_usd, num_turns: result.num_turns } : null };
    };
    const budget = { remaining: 1 };
    const recovering = async (options) => {
      const result = await recoverReview({ ...options, flow: env.FLOW, invoke, budget });
      for (const attempt of result.attempts) writeSync(out, `${JSON.stringify({ type: 'ksai_review_attempt', ...attempt })}\n`);
      return result;
    };
    const run = (options) => pipeline ? completeStage({ ...options, invoke: recovering }) : env.FLOW === 'review' ? recovering(options) : invoke(options);
    const prompt = readFileSync(String(env.PROMPT_FILE ?? ''), 'utf8');
    if (pipeline) {
      Object.assign(env, await reviewSession({ env, events, prompt, run }));
      code = Number(env.OPENCODE_REVIEW_EXIT);
    } else {
      const killAt = Number(env.KSAI_CHANNEL_KILL_AT);
      const timeoutMs = env.FLOW === 'review' ? killAt > 0 ? Math.max(0, killAt - Date.now()) : LIMITS.totalMs : 0;
      const result = env.FLOW === 'review' && timeoutMs === 0 ? { code: 124, timed_out: true } : await run({ prompt, timeoutMs });
      code = result.code;
      deadlineExpired = result.timed_out === true;
      if (result.attempts?.length > 1) {
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
    closeSync(out);
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
      Object.assign(env, recordChildren({ env, events, sandbox }));
    } catch {
      console.log('::warning::child sessions could not be recorded; their usage remains unmeasured');
    }
  }
  const reduced = spawnSync(process.execPath, [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-log.mjs')], {
    env: { ...env, OPENCODE_EXIT: String(code), OPENCODE_EVENTS_FILE: events, OPENCODE_EXECUTION_FILE: execution },
    stdio: 'inherit',
  });
  if (reduced.status !== 0) {
    console.log('::error::the opencode event stream could not be reduced to an execution log, so this run reports nothing it spent');
    return 1;
  }
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
