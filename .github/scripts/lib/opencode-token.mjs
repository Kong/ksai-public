import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { maskValue, mint } from '../kreview/federated-token.mjs';

const TOKEN_SCRIPT = fileURLToPath(new URL('../kreview/federated-token.mjs', import.meta.url));

const BETA = 'oauth-2025-04-20';

const ADVISORY_MS = 120_000;
const MANDATORY_MS = 30_000;
const BACKOFF_MS = 15_000;

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
function spawned(env) {
  const out = execFileSync('node', [TOKEN_SCRIPT, '--print'], {
    env: /** @type {NodeJS.ProcessEnv} */ (env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 30_000,
  });
  const body = JSON.parse(out);
  if (!body.access_token) throw new Error('the minting process printed no access token');
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in), requestId: 'spawned' };
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
    return spawned(env);
  } catch (error) {
    console.error(`ksai: minting through node failed (${error?.message}); exchanging in this process instead`);
    return mint({ env });
  }
}

/**
 * bearer answers a token good for the next request, renewing before the held one expires.
 *
 * The token this job already minted is the first one held, so the run does not mint twice inside a
 * second - which is what the exchange rate-limited, turning one refusal into one per request until
 * the original expired and every call answered 401. A refusal is therefore held for a minute before
 * another is attempted, and answered with the token in hand, which is valid until it is not.
 */
export async function bearer({
  env = defaults.env,
  now = Date.now(),
  fetchImpl = defaults.fetchImpl,
  clock = () => Date.now(),
} = {}) {
  if (String(env.KSAI_TOKEN_FILE ?? '') !== '') {
    const carried = brokered(env);
    if (carried !== null) held = carried;
    return held?.token ?? seed(env)?.token ?? '';
  }
  if (held === null) held = seed(env);
  if (fresh(now)) return held.token;
  if (now < retryAfter && !urgent(now)) return held.token;
  if (!inFlight) {
    inFlight = renew(env, now, fetchImpl)
      .catch((error) => {
        // Timed from when the attempt failed, not from when it started: `spawned` waits up to thirty
        // seconds and `mint` has no timeout of its own, so a renewal that fails after thirty-two
        // seconds would set a backoff already in the past and the next request would retry at once.
        const failedAt = clock();
        const asked = Number(error?.retryAfterMs);
        // What the exchange asked for wins, longer or shorter. Capping it at the local default let a
        // `retry-after: 120` wait fifteen seconds, which is the opposite of honouring it.
        retryAfter = failedAt + (Number.isFinite(asked) && asked > 0 ? asked : BACKOFF_MS);
        console.error(
          `::warning::the Anthropic token could not be renewed (${error.message}); holding the current one for ${Math.round((retryAfter - failedAt) / 1000)}s`,
        );
        return held?.token ?? env.ANTHROPIC_FEDERATED_TOKEN ?? '';
      })
      .finally(() => {
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
  /** @param {{env?: Record<string, string | undefined>, fetchImpl?: typeof fetch}} [options] */
  reset({ env = process.env, fetchImpl } = {}) {
    held = null;
    inFlight = null;
    retryAfter = 0;
    defaults = { env, fetchImpl };
  },
  held: () => held,
};
