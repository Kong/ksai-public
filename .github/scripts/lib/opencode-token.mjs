import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { maskValue, mint } from '../kreview/federated-token.mjs';

const runNode = promisify(execFile);

const TOKEN_SCRIPT = fileURLToPath(new URL('../kreview/federated-token.mjs', import.meta.url));

const BETA = 'oauth-2025-04-20';

const ADVISORY_MS = 120_000;
const MANDATORY_MS = 30_000;
const BACKOFF_MS = 15_000;
const SPAWN_MS = 30_000;
const RETRY_BUDGET_MS = 90_000;
// Two ways out, because a budget alone is only as sound as the clock under it: a clock that does not
// move - a frozen one, or one an NTP step walked backwards - would leave the wait loop spinning.
const MINTS = Math.ceil(RETRY_BUDGET_MS / BACKOFF_MS);
const CARRY_WAIT_MS = 90_000;
const CARRY_POLL_MS = 2_000;
const CARRY_POLLS = Math.ceil(CARRY_WAIT_MS / CARRY_POLL_MS);

const waits = (ms) =>
  new Promise((wake) => {
    setTimeout(wake, ms);
  });

let held = null;
let inFlight = null;
let retryAfter = 0;
/** @type {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch}} */
let defaults = { env: process.env, fetchImpl: undefined };

function seed(env) {
  const token = env.ANTHROPIC_FEDERATED_TOKEN;
  const expiresAt = Number(env.ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT);
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { token, expiresAt };
}

export function brokered(env, read = readFileSync) {
  const at = String(env.KSAI_TOKEN_FILE ?? '');
  if (!at) return null;
  try {
    const body = JSON.parse(String(read(at, 'utf8')));
    const expiresAt = Number(body?.expires_at);
    if (!body?.token || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return { token: String(body.token), expiresAt };
  } catch {
    return null;
  }
}

function fresh(now) {
  return held !== null && held.expiresAt - now > ADVISORY_MS;
}

/**
 * urgent answers whether the held token is too close to expiry to keep serving.
 *
 * The two tiers are the ones Anthropic's own SDKs use: advisory at expiry minus 120 seconds, where a
 * refused exchange is survivable because the token in hand is still good, and mandatory at minus 30.
 * The ninety seconds between them is the whole retry budget, which is why a refusal waits fifteen
 * seconds rather than a minute - one attempt inside that window is not a retry policy.
 */
function urgent(now) {
  return held === null || held.expiresAt - now <= MANDATORY_MS;
}

/**
 * spawned answers a token minted by node rather than by whatever runtime this plugin loaded in.
 *
 * Every exchange that has succeeded ran under node in a step; every one refused ran inside opencode's
 * Bun, with a fresh single-use assertion each time and a 429 carrying no request-id and no
 * rate-limit headers - which is an edge refusing a client rather than the API refusing a request.
 * The token crosses a pipe and never a file, so the rule the static header exists to keep still holds.
 *
 * @param {Record<string, string | undefined>} env
 */
async function spawned(env) {
  const out = await bounded([TOKEN_SCRIPT, '--print'], env, SPAWN_MS);
  const body = JSON.parse(out);
  if (!body.access_token) throw new Error('the minting process printed no access token');
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in), requestId: 'spawned' };
}

/**
 * bounded runs node and answers its stdout, giving up on a timer rather than on the child.
 *
 * This was `execFileSync`, whose `timeout` is only a signal sent to a child the kernel is still
 * willing to schedule - and on a starved runner it is neither. One wedged mint held the whole event
 * loop for twenty minutes: every broker tick behind it was a renewal that never ran, the token in
 * hand died four minutes in, and the run ended on the 401 that followed. An abort rejects on the
 * timer itself, so the loop keeps turning and the next tick is free to try again.
 *
 * The child's handles are dropped afterwards because a killed child and its three stdio sockets stay
 * active handles, which would keep the run's node alive after the agent has exited.
 *
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {number} ms
 * @returns {Promise<string>}
 */
async function bounded(args, env, ms) {
  const running = runNode('node', args, {
    env: /** @type {NodeJS.ProcessEnv} */ (env),
    encoding: 'utf8',
    signal: AbortSignal.timeout(ms),
    killSignal: 'SIGKILL',
  });
  try {
    const { stdout, stderr } = await running;
    // The minting script narrates the assertion it holds on stderr, which `stdio: inherit` used to
    // carry to the job log. Captured output has to be written on for that line to survive.
    if (stderr) process.stderr.write(String(stderr));
    return String(stdout);
  } catch (error) {
    if (error?.stderr) process.stderr.write(String(error.stderr));
    throw error;
  } finally {
    const child = running.child;
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy();
    child?.unref();
  }
}

async function renew(env, now, fetchImpl) {
  const { accessToken, expiresIn, requestId } = fetchImpl
    ? await mint({ env, fetchImpl })
    : await inProcessOrSpawned(env);
  // A 200 carrying no `expires_in` would make `expiresAt` NaN, which reads as neither fresh nor
  // urgent: the plugin would then mint on every single request for the rest of the run.
  if (!Number.isFinite(Number(expiresIn)) || Number(expiresIn) <= 0) {
    throw new Error(`the exchange returned no usable expires_in (${String(expiresIn)})`);
  }
  held = { token: accessToken, expiresAt: now + Number(expiresIn) * 1000 };
  retryAfter = 0;
  // stderr, never stdout: opencode's stdout is the event stream this run is read back from, and a
  // log line written into it is a line the reducer has to skip. The runner reads its workflow
  // commands from both, so the mask still registers.
  maskValue(accessToken);
  console.error(`ksai: renewed the Anthropic token, expires_in ${expiresIn}s (request-id ${requestId})`);
  return held.token;
}

/**
 * inProcessOrSpawned prefers the runtime that works and falls back to this one when it cannot be run.
 *
 * A sandbox without a node on its PATH is a renewal that still has to be attempted, so the fallback is
 * the in-process exchange this started as rather than a refusal.
 *
 * @param {Record<string, string | undefined>} env
 */
async function inProcessOrSpawned(env) {
  try {
    return await spawned(env);
  } catch (error) {
    console.error(`ksai: minting through node failed (${error?.message}); exchanging in this process instead`);
    return mint({ env });
  }
}

/**
 * renewing answers a renewed token, waiting out a refusal the run has nothing left to survive on.
 *
 * A refusal is survivable while the token in hand is still good, and the answer is that token - which
 * is why the two tiers exist at all. Once it has expired there is nothing to fall back to, and handing
 * it over regardless is a 401 on the very next request: opencode reads that as fatal and exits, so one
 * refused mint cost a twenty-nine minute run every edit it had made. The wait the refusal asked for is
 * therefore taken here, inside the request, for as long as that wait still fits inside the budget. One
 * asking for longer than the whole budget is answered now and with its reason, because stalling every
 * request for an hour to honour a `retry-after` of an hour helps nobody.
 *
 * @param {Record<string, string | undefined>} env
 */
async function renewing(env, now, fetchImpl, clock, sleep) {
  const deadline = clock() + RETRY_BUDGET_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // A retry that recorded the first attempt's `now` would date the new token from before the wait.
      return await renew(env, attempt === 0 ? now : clock(), fetchImpl);
    } catch (error) {
      // Timed from when the attempt failed, not from when it started: `bounded` waits up to thirty
      // seconds and `mint` has no timeout of its own, so a renewal that fails after thirty-two
      // seconds would set a backoff already in the past and the next request would retry at once.
      const failedAt = clock();
      const asked = Number(error?.retryAfterMs);
      // What the exchange asked for wins, longer or shorter. Capping it at the local default let a
      // `retry-after: 120` wait fifteen seconds, which is the opposite of honouring it.
      const wait = Number.isFinite(asked) && asked > 0 ? asked : BACKOFF_MS;
      retryAfter = failedAt + wait;
      const alive = held === null ? null : held.expiresAt - failedAt;
      console.error(
        `::warning::the Anthropic token could not be renewed (${error.message}); ${
          alive !== null && alive <= 0
            ? `the held one expired ${Math.round(-alive / 1000)}s ago, so this waits ${Math.round(wait / 1000)}s and mints again`
            : `holding the current one for ${Math.round(wait / 1000)}s`
        }`,
      );
      // A run with no recorded expiry has only the token the step handed it, and no reading of that
      // token says it is dead. Waiting on it would stall every request for the whole budget.
      const standing = held === null ? String(env.ANTHROPIC_FEDERATED_TOKEN ?? '') : alive > 0 ? held.token : '';
      if (standing) return standing;
      if (attempt + 1 >= MINTS || failedAt + wait >= deadline) {
        throw new Error(`the Anthropic token expired and ${attempt + 1} renewals were refused`, { cause: error });
      }
      await sleep(wait);
    }
  }
}

/**
 * carried answers the token the broker outside the sandbox last wrote, waiting out a stale one.
 *
 * Nothing on this side can mint: the OIDC request variables are unset on the way into the sandbox,
 * which is the whole point of brokering the token through a file. So an expired file is not something
 * a request can repair, only outlast - and answering with it regardless is the 401 that ends the run.
 * The wait covers a broker tick that a slow mint pushed late, and gives up rather than hanging forever
 * on a broker that has stopped writing, because a refused request logs better than a wedged one.
 *
 * @param {Record<string, string | undefined>} env
 */
async function carried(env, clock, sleep, read) {
  const deadline = clock() + CARRY_WAIT_MS;
  let warned = false;
  // Counted as well as timed, for the reason `MINTS` is: a clock that does not move is not a budget.
  for (let polls = 0; ; polls += 1) {
    const found = brokered(env, read);
    if (found !== null) held = found;
    if (held !== null && held.expiresAt > clock()) return held.token;
    if (clock() >= deadline || polls >= CARRY_POLLS) break;
    if (!warned) {
      console.error(
        `::warning::the brokered token has expired; waiting up to ${Math.round(CARRY_WAIT_MS / 1000)}s for the broker to write a fresh one`,
      );
      warned = true;
    }
    await sleep(CARRY_POLL_MS);
  }
  return held?.token ?? seed(env)?.token ?? '';
}

/**
 * bearer answers a token good for the next request, renewing before the held one expires.
 *
 * The token this job already minted is the first one held, so the run does not mint twice inside a
 * second - which is what the exchange rate-limited, turning one refusal into one per request until
 * the original expired and every call answered 401. A refusal is therefore held for a minute before
 * another is attempted, and answered with the token in hand for as long as that token is good for
 * anything; past its expiry the request waits on a fresh one rather than being handed a corpse.
 */
export async function bearer({
  env = defaults.env,
  now = Date.now(),
  fetchImpl = defaults.fetchImpl,
  clock = () => Date.now(),
  sleep = waits,
  read = readFileSync,
} = {}) {
  if (String(env.KSAI_TOKEN_FILE ?? '') !== '') return carried(env, clock, sleep, read);
  if (held === null) held = seed(env);
  if (fresh(now)) return held.token;
  if (now < retryAfter && !urgent(now)) return held.token;
  if (!inFlight) {
    inFlight = renewing(env, now, fetchImpl, clock, sleep).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * authHeaders answers the headers one model request carries, for the way this run authenticates.
 *
 * One implementation serves the static config and the renewing hook: the config expands `{env:...}`
 * once when it connects and the hook writes the same names per request, so a shape spelled twice
 * would leave a review authenticating one way for ten minutes and another way after that.
 *
 * On `oidc-bearer` the gateway is handed the runner's identity token in both headers and holds the
 * Anthropic credential itself, so the federation beta means nothing to it. On `federation` the token
 * is Anthropic's own and that beta is what it is read under.
 *
 * @param {string} token
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export function authHeaders(token, env = defaults.env) {
  const authorization = `Bearer ${token}`;
  if (String(env.ANTHROPIC_AUTH ?? '').trim() === 'federation') {
    return { authorization, 'anthropic-beta': BETA, 'x-api-key': '' };
  }
  return { authorization, 'x-api-key': token };
}

/**
 * answersAnthropic answers whether a request is bound for the provider this plugin authenticates.
 *
 * @param {unknown} providerID
 */
export function answersAnthropic(providerID) {
  return String(providerID ?? '').includes('anthropic');
}

export function heldExpiry() {
  return held === null ? 0 : Number(held.expiresAt) || 0;
}

export const __test = {
  bounded,
  /** @param {{env?: Record<string, string | undefined>, fetchImpl?: typeof fetch}} [options] */
  reset({ env = process.env, fetchImpl } = {}) {
    held = null;
    inFlight = null;
    retryAfter = 0;
    defaults = { env, fetchImpl };
  },
  held: () => held,
};
