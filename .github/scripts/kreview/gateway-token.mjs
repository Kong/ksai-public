import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import controlPlane from '../lib/control-plane.cjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { annotation } from '../lib/text.cjs';

const OIDC_ASSUMED_SECONDS = 240;
const MINT_ANSWER_MS = 10_000;
const MINT_BUDGET_MS = 25_000;

/** @param {string} value */
export function maskValue(value) {
  console.error(`::add-mask::${value}`);
}

/** @param {string | undefined} said @returns {string | null} */
export function originProblem(said) {
  const trimmed = String(said ?? '').trim().replace(/\/+$/, '');
  if (!trimmed.startsWith('https://')) return `must start with https://, got: ${trimmed || '(empty)'}`;
  if (/\/v1$/i.test(trimmed)) {
    return `names an endpoint rather than an origin - the version segment is appended for you, so this would be called at ${trimmed}/v1. Drop the /v1, got: ${trimmed}`;
  }
  return null;
}

/** @param {Record<string, string | undefined>} env */
export function originOf(env) {
  const said = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const problem = originProblem(said);
  if (problem) throw new Error(`anthropic_base_url ${problem}`);
  return said;
}

/** @param {Record<string, string | undefined>} env */
export function identityAudience(env) {
  return env.KSAI_MODEL_AUTH_MODE === 'cp_exchange' ? 'ksai-cp' : originOf(env);
}

/**
 * @param {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (value: string) => void, pause?: (ms: number, signal?: AbortSignal) => Promise<unknown>}} options
 * @returns {Promise<string>}
 */
export async function requestIdentity({ env, fetchImpl = fetch, mask = () => {}, pause = controlPlane.pausing }) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('no OIDC endpoint on this job, so it is missing permissions: id-token: write');
  }
  let value;
  try {
    value = await controlPlane.minter({
      env,
      fetch: fetchImpl,
      signal: AbortSignal.timeout(MINT_BUDGET_MS),
      holds: undefined,
      pause,
      answer: MINT_ANSWER_MS,
    })(identityAudience(env));
  } catch (error) {
    throw new Error(`identity token request failed: ${error?.message ?? error}`, { cause: error });
  }
  mask(value);
  return value;
}

/**
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
 * @param {{env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (value: string) => void, pause?: (ms: number, signal?: AbortSignal) => Promise<unknown>}} options
 * @returns {Promise<{accessToken: string, expiresIn: number, requestId: string}>}
 */
export async function mint({ env, fetchImpl = fetch, mask = () => {}, pause = controlPlane.pausing }) {
  const audience = identityAudience(env);
  const assertion = await requestIdentity({ env, fetchImpl, mask, pause });
  const claims = assertionClaims(assertion);
  const left = claims === null || claims.exp === null ? null : claims.exp - Math.floor(Date.now() / 1000);
  console.error(
    `ksai: holding a gateway identity token for ${audience} jti=${claims?.jti ?? 'none'} exp=${claims?.exp ?? 'none'} (${left === null ? '?' : `${left}s`} left)`,
  );
  if (left !== null && left <= 0) {
    throw new Error(`the runner answered an identity token that expired ${-left}s ago, which the gateway will not accept`);
  }
  return { accessToken: assertion, expiresIn: left ?? OIDC_ASSUMED_SECONDS, requestId: claims?.jti ?? 'none' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const printing = process.argv.includes('--print');
  try {
    const { accessToken, expiresIn, requestId } = await mint({ env: process.env, mask: maskValue });
    maskValue(accessToken);
    if (printing) {
      process.stdout.write(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }));
      console.error(`minted a gateway bearer for a caller, expires_in ${expiresIn}s (request-id ${requestId})`);
      process.exit(0);
    }
    writeOutputs(process.env.GITHUB_OUTPUT, {
      token: accessToken,
      expires_at: Date.now() + Number(expiresIn) * 1000,
    });
    console.error(`minted a gateway bearer for ${originOf(process.env)}, expires_in ${expiresIn}s (request-id ${requestId})`);
  } catch (error) {
    console.error(annotation(error.message));
    process.exit(1);
  }
}
