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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { conclusionOf, exitedOn, stopReason } from '../lib/execution-log.mjs';
import { DEFAULT_OPENCODE_MODEL, answer, collectSecrets, executionLog, listed, parsed, sandboxScopes, scrub, spending } from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { bearer, heldExpiry } from '../lib/opencode-token.mjs';
import { completeFinal, completeStage, LIMITS, readExport, recordChildren, recordedCompletion, recoverReview, reviewAnswer, reviewSession, streamFailure } from './opencode-review.mjs';
import { startRelay } from './otel-relay.mjs';
import resultProtocol from './review-result.cjs';

const { structuredSubmission, submitted } = resultProtocol;

export { listed };

const MASKED_HOMES = ['.config', '.claude'];

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
 * `ANTHROPIC_FEDERATED_TOKEN` is deliberately absent and cannot join them - opencode expands it
 * in-process, so hiding the bearer from a tool call hides it from the run.
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

const UNSET = [...DENIED_CREDENTIALS, ...DENIED_MINTS];

const EXPORTER_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';

const PROBE_TIMEOUT_MS = 60_000;

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
  if (temp) {
    args.push('--tmpfs', temp);
    const tools = join(temp, 'ksai-opencode', 'bin');
    if (exists(tools)) args.push('--ro-bind', tools, tools);
    const sdk = String(env.OPENCODE_SDK_ROOT ?? '');
    if (sdk && exists(sdk)) args.push('--ro-bind', sdk, sdk);
  }

  const resultDir = String(env.KSAI_REVIEW_RESULT_DIR ?? '');
  if (resultDir && exists(resultDir)) args.push('--bind', resultDir, resultDir);

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
  const relay = String(env.KSAI_OTEL_RELAY ?? '').trim();
  if (relay) args.push('--setenv', EXPORTER_ENDPOINT, relay);
  const scrubbed = scrubbing(env) ? SCRUBBED : [];
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
  args.push('--unshare-user', '--unshare-pid', '--new-session', '--die-with-parent', '--chdir', workspace, '--');
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

  const relay = await startRelay({ env });
  const sandbox = sandboxArgs({
    ...env,
    KSAI_TOKEN_DIR: tokenDir,
    KSAI_TOKEN_FILE: tokenFile,
    KSAI_REVIEW_RESULT_DIR: resultDir,
    KSAI_OTEL_RELAY: relay?.url ?? '',
  });
  const quiet = withoutExporter(sandbox);
  const probe = spawnSync('bwrap', [...quiet, 'opencode', '--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (probe.status !== 0) {
    const said = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || String(probe.error?.message ?? 'no output');
    console.log(
      `::error::opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no run was attempted: ${said}`,
    );
    await relay?.close();
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
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
    let resultSequence = 0;
    const invoke = async ({ prompt, timeoutMs = 0, resumeSession = '', finalize = false, resultKind = 'final', candidateIds = [] }) => {
      const began = Date.now();
      const offset = statSync(events).size;
      const resultFile = resultDir ? join(resultDir, `${resultSequence += 1}.json`) : '';
      const runEnv = env.FLOW === 'review' ? { ...env, OPENCODE_RESUME_SESSION: resumeSession, OPENCODE_REVIEW_FINALIZE: String(finalize) } : env;
      const command = resultTransport === 'structured' ? process.execPath : 'opencode';
      const args = resultTransport === 'structured' ? [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-structured.mjs')] : runArgs(runEnv);
      const ran = spawn('bwrap', [...sandbox, command, ...args], {
        env: { ...runEnv, KSAI_REVIEW_RESULT_FILE: resultFile, KSAI_REVIEW_RESULT_KIND: resultKind, KSAI_REVIEW_CANDIDATE_IDS: JSON.stringify(candidateIds) },
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
      Object.assign(env, recordChildren({ env, events, sandbox: quiet }));
    } catch {
      console.log('::warning::child sessions could not be recorded; their usage remains unmeasured');
    }
  }
  await relay?.close();
  const reduced = spawnSync(process.execPath, [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-log.mjs')], {
    env: { ...env, OPENCODE_EXIT: String(code), OPENCODE_EVENTS_FILE: events, OPENCODE_EXECUTION_FILE: execution },
    stdio: 'inherit',
  });
  if (reduced.status !== 0) {
    console.log('::error::the opencode event stream could not be reduced to an execution log, so this run reports nothing it spent');
    if (resultDir) rmSync(resultDir, { recursive: true, force: true });
    return 1;
  }
  if (resultDir) rmSync(resultDir, { recursive: true, force: true });
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
