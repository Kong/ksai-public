import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const BETAS = 'oauth-2025-04-20,oidc-federation-2026-04-01';

/** AUTH_MODES names the two ways a run authenticates to the origin it sends its model calls to. */
export const AUTH_MODES = Object.freeze(['oidc-bearer', 'federation']);

const OIDC_ASSUMED_SECONDS = 240;

const MINT_TIMEOUT_MS = 30_000;

/**
 * mask asks the runner to redact a value from every later log line.
 *
 * On stderr, because a caller's stdout may be a stream something parses - opencode's event stream
 * is - and the runner reads its workflow commands from both.
 *
 * @param {string} value
 */
export function maskValue(value) {
  console.error(`::add-mask::${value}`);
}

/**
 * authOf answers how this run authenticates, and refuses anything the origin was not told to expect.
 *
 * @param {Record<string, string | undefined>} env
 */
export function authOf(env) {
  const said = String(env.ANTHROPIC_AUTH ?? '').trim();
  if (!AUTH_MODES.includes(said)) {
    throw new Error(`anthropic_auth must be one of ${AUTH_MODES.join(', ')}, got: ${said || '(empty)'}`);
  }
  return said;
}

/**
 * originProblem answers why a value is not an origin this run may call, or null when it is one.
 *
 * Two refusals, and both are made everywhere an origin is read. An empty value is refused rather
 * than read as Anthropic: a `with:` key overrides a default even when its value is blank, so a
 * forwarded empty string would take a whole repository off the gateway with nothing saying so.
 *
 * **A value ending in `/v1` names an endpoint rather than an origin**, and every caller appends its
 * own version segment - Claude Code to `ANTHROPIC_BASE_URL`, the AI SDK behind opencode to its
 * provider option. Accepting one would post to `/v1/v1/messages` and publish a reviewer that wrote
 * nothing, so it is refused where the value is read rather than repaired where it is used.
 *
 * @param {string | undefined} said
 * @returns {string | null}
 */
export function originProblem(said) {
  const trimmed = String(said ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed.startsWith('https://')) return `must start with https://, got: ${trimmed || '(empty)'}`;
  if (/\/v1$/i.test(trimmed)) {
    return `names an endpoint rather than an origin - the version segment is appended for you, so this would be called at ${trimmed}/v1. Drop the /v1, got: ${trimmed}`;
  }
  return null;
}

/**
 * originOf answers the origin this run calls, refusing anything `originProblem` names.
 *
 * @param {Record<string, string | undefined>} env
 */
export function originOf(env) {
  const said = String(env.ANTHROPIC_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const problem = originProblem(said);
  if (problem) throw new Error(`anthropic_base_url ${problem}`);
  return said;
}

/**
 * exchangeUrl answers where a federated exchange is made, which is the origin the run already calls.
 *
 * @param {Record<string, string | undefined>} env
 */
export function exchangeUrl(env) {
  return `${originOf(env)}/v1/oauth/token`;
}

/** IDENTIFIERS names the four federation values that route a mint to a team's workspace. */
export const IDENTIFIERS = Object.freeze([
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
]);

/** missingIdentifiers answers the identifiers that carry no letter or digit, which a blank one does not. */
export function missingIdentifiers(env) {
  return IDENTIFIERS.filter((name) => !/[a-z0-9]/i.test(String(env[name] ?? '')));
}

/**
 * requestIdentity asks the runner for an identity token for the origin this run calls.
 *
 * The audience is that origin and is never named a second time: a token minted for a host that does
 * not receive it is refused by whichever host does, and the two drifting apart is undebuggable from
 * the outside.
 *
 * @param {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (value: string) => void}} options
 * @returns {Promise<string>}
 */
export async function requestIdentity({ env, fetchImpl = fetch, mask = () => {} }) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new Error('no OIDC endpoint on this job, so it is missing permissions: id-token: write');
  }
  const response = await fetchImpl(`${url}&audience=${encodeURIComponent(originOf(env))}`, {
    headers: { authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`identity token request failed: HTTP ${response.status}`);
  }
  const body = /** @type {{value?: string}} */ (await response.json());
  if (!body.value) {
    throw new Error('identity token response carried no value');
  }
  mask(body.value);
  return body.value;
}

const LIMIT_HEADERS = [
  'retry-after',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-unified-reset',
];

/**
 * limitsOf answers what a refusal said about the limit it enforced, or nothing when it said nothing.
 *
 * A 429 whose body is only "Rate limited. Please try again later." leaves the shape of the limit to
 * be inferred from timestamps across runs, which is how this was being read before. Whatever the
 * endpoint states about itself is worth more than that inference and costs one line.
 *
 * @param {Headers} headers
 */
export function limitsOf(headers) {
  const said = LIMIT_HEADERS.map((name) => [name, headers.get(name)]).filter(([, value]) => value);
  return said.length ? ` [${said.map(([name, value]) => `${name}=${value}`).join(', ')}]` : '';
}

/**
 * retryAfterMs answers the wait a refusal asked for, in milliseconds, or null when it asked for none.
 *
 * @param {Headers} headers
 */
export function retryAfterMs(headers) {
  const said = headers.get('retry-after');
  if (!said) return null;
  const seconds = Number(said);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(said);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * exchange trades an identity token for an Anthropic access token on the team's federation rule.
 *
 * @param {{assertion: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{accessToken: string, expiresIn: number, requestId: string}>}
 */
export async function exchange({ assertion, env, fetchImpl = fetch }) {
  const url = exchangeUrl(env);
  const response = await fetchImpl(url, {
    method: 'POST',
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'anthropic-beta': BETAS },
    body: JSON.stringify({
      grant_type: GRANT_TYPE,
      assertion,
      federation_rule_id: env.ANTHROPIC_FEDERATION_RULE_ID,
      organization_id: env.ANTHROPIC_ORGANIZATION_ID,
      service_account_id: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
      workspace_id: env.ANTHROPIC_WORKSPACE_ID,
    }),
  });
  const requestId = response.headers.get('request-id') ?? 'none';
  if (!response.ok) {
    const detail = await response.text();
    const error = /** @type {Error & {status?: number, retryAfterMs?: number | null}} */ (
      new Error(
        `token exchange failed at ${url}: HTTP ${response.status} (request-id ${requestId})${limitsOf(response.headers)} ${detail}`,
      )
    );
    error.status = response.status;
    error.retryAfterMs = retryAfterMs(response.headers);
    throw error;
  }
  const body = /** @type {{access_token?: string, expires_in?: number}} */ (await response.json());
  if (!body.access_token) {
    throw new Error(`token exchange returned no access_token (request-id ${requestId})`);
  }
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in), requestId };
}

/**
 * assertionClaims answers the identifiers a GitHub OIDC JWT carries, or null when it cannot read them.
 *
 * `jti`, `iat` and `exp` are identifiers and timestamps rather than credential material, and they are
 * the three that separate the two readings of a refused exchange: a `jti` repeated across attempts is
 * GitHub handing back a cached assertion and Anthropic refusing a replay, and a fresh `jti` with time
 * left on it is a limit being enforced on something other than this request's identity.
 *
 * @param {string} assertion
 * @returns {{jti: string | null, iat: number | null, exp: number | null} | null}
 */
export function assertionClaims(assertion) {
  try {
    const payload = String(assertion).split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return {
      jti: typeof decoded.jti === 'string' ? decoded.jti : null,
      iat: Number.isFinite(decoded.iat) ? decoded.iat : null,
      exp: Number.isFinite(decoded.exp) ? decoded.exp : null,
    };
  } catch {
    return null;
  }
}

/**
 * identity answers the runner's own OIDC token as the bearer, which is what the gateway validates.
 *
 * There is no exchange on this path: Kong AI Gateway serves no `/v1/oauth/token`, holds the Anthropic
 * credential itself, and reads the assertion as the caller's identity. The token lives about five
 * minutes, which is why the renewal beside this one runs for the whole review rather than once.
 *
 * `exp` is read from the assertion rather than assumed, and an assertion whose claims cannot be read
 * is held for four minutes - the same life the Claude engine's credential helper assumes.
 *
 * @param {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (value: string) => void}} options
 * @returns {Promise<{accessToken: string, expiresIn: number, requestId: string}>}
 */
export async function identity({ env, fetchImpl = fetch, mask = () => {} }) {
  const audience = originOf(env);
  const assertion = await requestIdentity({ env, fetchImpl, mask });
  const claims = assertionClaims(assertion);
  // An assertion whose claims cannot be read and one that has already expired are two states, and
  // answering both with the assumed life would serve a dead token for four minutes: `fresh` holds
  // anything more than 120 seconds from its recorded expiry, so nothing would renew while every
  // model call answered 401. Only the unreadable one is assumed; a past `exp` is refused, which
  // leaves the renewal holding the token in hand rather than replacing it with a worse one.
  const left = claims === null || claims.exp === null ? null : claims.exp - Math.floor(Date.now() / 1000);
  console.error(
    `ksai: holding an identity token for ${audience} jti=${claims?.jti ?? 'none'} exp=${claims?.exp ?? 'none'} (${left === null ? '?' : `${left}s`} left)`,
  );
  if (left !== null && left <= 0) {
    throw new Error(`the runner answered an identity token that expired ${-left}s ago, which no origin will accept`);
  }
  return { accessToken: assertion, expiresIn: left ?? OIDC_ASSUMED_SECONDS, requestId: claims?.jti ?? 'none' };
}

/**
 * mint answers a short-lived bearer for the origin this run calls, by whichever way it authenticates.
 *
 * @param {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (value: string) => void}} options
 */
export async function mint({ env, fetchImpl = fetch, mask = () => {} }) {
  if (authOf(env) === 'oidc-bearer') return identity({ env, fetchImpl, mask });
  const absent = missingIdentifiers(env);
  if (absent.length) {
    throw new Error(`the federation identifiers this run would mint on are blank: ${absent.join(', ')}`);
  }
  const assertion = await requestIdentity({ env, fetchImpl, mask });
  const claims = assertionClaims(assertion);
  if (claims) {
    const left = claims.exp === null ? '?' : `${claims.exp - Math.floor(Date.now() / 1000)}s`;
    console.error(`ksai: exchanging assertion jti=${claims.jti} iat=${claims.iat} exp=${claims.exp} (${left} left)`);
  }
  return exchange({ assertion, env, fetchImpl });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `--print` writes the minted token to stdout for a caller holding the pipe, rather than to the
  // job environment. It exists so the renewal can mint through this runtime instead of its own:
  // every exchange that has ever succeeded ran here, under node, and every one that was refused ran
  // inside opencode's Bun. Nothing reaches a file on either path.
  const printing = process.argv.includes('--print');
  try {
    const { accessToken, expiresIn, requestId } = await mint({ env: process.env, mask: maskValue });
    maskValue(accessToken);
    if (printing) {
      process.stdout.write(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }));
      console.error(`minted a bearer for a caller, expires_in ${expiresIn}s (request-id ${requestId})`);
      process.exit(0);
    }
    appendFileSync(process.env.GITHUB_ENV, `ANTHROPIC_FEDERATED_TOKEN=${accessToken}\n`);
    // The renewing plugin holds this one first. Without the expiry it would mint again on the very
    // first request, one second after this, which is what the exchange answered 429 to.
    appendFileSync(
      process.env.GITHUB_ENV,
      `ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT=${Date.now() + Number(expiresIn) * 1000}\n`,
    );
    console.error(`minted a bearer for ${originOf(process.env)}, expires_in ${expiresIn}s (request-id ${requestId})`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
