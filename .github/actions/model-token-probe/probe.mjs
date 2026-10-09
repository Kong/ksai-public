import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';

import { oidcMinter } from '../run-token/token.mjs';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT = 'urn:ietf:params:oauth:token-type:jwt';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const ARM = 'cp-token-exchange:variant';
const TIMEOUT = 10_000;
const MAX_JSON_BYTES = 65_536;
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HTTPS_ORIGIN = /^https:\/\/[^\s/?#@\\]+$/;

function origin(value, name) {
  const parsed = URL.parse(value);
  if (!parsed || !HTTPS_ORIGIN.test(value) || parsed.protocol !== 'https:' || !parsed.hostname ||
      parsed.username || parsed.password) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return value;
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decoded(value, name) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function jwkThumbprint(key) {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

function dpop(token, url, key, publicJwk) {
  const claims = {
    htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
    ath: createHash('sha256').update(token).digest('base64url'),
  };
  const content = `${encoded({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })}.${encoded(claims)}`;
  const signature = sign('sha256', Buffer.from(content), { key, dsaEncoding: 'ieee-p1363' });
  return `${content}.${signature.toString('base64url')}`;
}

async function discardBody(response) {
  await Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
}

async function responseJSON(fetchImpl, url, init, name) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`${name} answered HTTP ${response.status}`);
  }
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > MAX_JSON_BYTES) {
    await discardBody(response);
    throw new Error(`${name} answered an oversized body`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${name} answered invalid JSON`);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new Error(`${name} answered an oversized body`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error(`${name} answered invalid JSON`);
  }
}

async function statusOf(fetchImpl, endpoint, token, proof) {
  const response = await fetchImpl(`${endpoint}/v1/model/token-admission`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, dpop: proof }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
  });
  await discardBody(response);
  return response.status;
}

function assertStatus(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name} answered HTTP ${actual}, expected ${expected}`);
}

function verifiedClaims(token, jwks, endpoint, audience, recordId, publicJwk, env, now) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('CP access token is not a JWT');
  const header = decoded(parts[0], 'CP access token header');
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      header.typ !== 'at+jwt' || header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid ||
      header.jwk !== undefined || header.jku !== undefined || header.x5u !== undefined) {
    throw new Error('CP access token header is invalid');
  }
  const matching = Array.isArray(jwks?.keys) ? jwks.keys.filter((key) => key?.kid === header.kid) : [];
  if (matching.length !== 1) throw new Error('CP JWKS has no unique signing key for the token');
  const key = matching[0];
  if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig' ||
      typeof key.x !== 'string' || typeof key.y !== 'string' || key.d !== undefined) {
    throw new Error('CP JWKS signing key is invalid');
  }
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== 64 || !verify('sha256', signingInput, {
    key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  }, signature)) throw new Error('CP access token signature is invalid');
  const claims = decoded(parts[1], 'CP access token claims');
  const current = Math.floor(now() / 1000);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
      claims.iss !== endpoint || claims.aud !== audience || claims.scope !== 'model.invoke' ||
      claims.model_auth_arm !== ARM || claims.repository !== env.GITHUB_REPOSITORY ||
      claims.repository_id !== env.GITHUB_REPOSITORY_ID || claims.run_id !== env.GITHUB_RUN_ID ||
      claims.run_attempt !== env.GITHUB_RUN_ATTEMPT || claims.record_id !== recordId ||
      !/^[1-9][0-9]*$/.test(claims.installation_id ?? '') ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.exp) ||
      claims.exp - claims.iat !== 30 || claims.iat > current + 5 || claims.nbf > current + 5 || claims.exp <= current + 5 ||
      typeof claims.jti !== 'string' || claims.jti.length < 16 ||
      claims.cnf?.jkt !== jwkThumbprint(publicJwk)) {
    throw new Error('CP access token run, audience, time or proof binding is invalid');
  }
  const requester = claims.requester;
  const initiator = claims.initiator;
  const actor = `github-actions:${env.GITHUB_REPOSITORY_ID}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
  if (!requester?.source || !requester.source_id || !requester.github_login ||
      !/^[1-9][0-9]*$/.test(requester.github_id ?? '') || requester.verification !== 'verified' ||
      !initiator?.github_login || !/^[1-9][0-9]*$/.test(initiator.github_id ?? '') ||
      initiator.verification !== 'verified' || claims.sub !== `github:${requester.github_id}` ||
      claims.act?.sub !== actor || claims.client_id !== actor) {
    throw new Error('CP access token requester, initiator or broker actor is invalid');
  }
  return claims;
}

function assertFreshForReplay(exp, now) {
  if (exp <= Math.floor(now() / 1000) + 5) throw new Error('token expired before replay check could prove one-use admission');
}

export async function probeModelToken({ endpoint, audience, recordId, env = process.env, fetchImpl = fetch,
  mint = oidcMinter(env, fetchImpl), mask = (_token) => {}, now = Date.now }) {
  origin(endpoint, 'control plane endpoint');
  origin(audience, 'model audience');
  if (!/^[a-f0-9]{32}$/.test(recordId ?? '')) throw new Error('the probe needs the dispatched record ID');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
      !env.GITHUB_REPOSITORY || !env.GITHUB_REPOSITORY_ID || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) {
    throw new Error('the probe needs a GitHub Actions run with id-token: write and stable run identity');
  }
  const metadata = await responseJSON(fetchImpl, `${endpoint}/.well-known/oauth-authorization-server`, {}, 'CP discovery');
  if (metadata?.issuer !== endpoint || metadata.jwks_uri !== `${endpoint}/v1/model/jwks` ||
      metadata.token_endpoint !== `${endpoint}/v1/model/token`) {
    throw new Error('CP discovery does not describe this issuer and token endpoint');
  }
  const jwks = await responseJSON(fetchImpl, metadata.jwks_uri, {}, 'CP JWKS');
  const githubToken = await mint('ksai-cp');
  if (typeof githubToken !== 'string' || !JWT_FORMAT.test(githubToken)) {
    throw new Error('GitHub returned no OIDC JWT for the CP audience');
  }
  mask(githubToken);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const form = new URLSearchParams({
    grant_type: GRANT, subject_token_type: JWT, requested_token_type: ACCESS,
    audience, scope: 'model.invoke', subject_token: githubToken,
  });
  const exchanged = await responseJSON(fetchImpl, metadata.token_endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${githubToken}`, dpop: dpop(githubToken, metadata.token_endpoint, pair.privateKey, publicJwk),
      'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  }, 'CP token exchange');
  const accessToken = exchanged?.access_token;
  if (typeof accessToken !== 'string' || !JWT_FORMAT.test(accessToken) || exchanged.token_type !== 'DPoP' ||
      exchanged.issued_token_type !== ACCESS || exchanged.scope !== 'model.invoke' || exchanged.expires_in !== 30) {
    throw new Error('CP token exchange returned an invalid access token response');
  }
  mask(accessToken);
  const claims = verifiedClaims(accessToken, jwks, endpoint, audience, recordId, publicJwk, env, now);
  const target = `${audience}/cp-ksai/v1/messages`;
  const wrong = dpop('wrong-token', target, pair.privateKey, publicJwk);
  assertStatus(await statusOf(fetchImpl, endpoint, accessToken, wrong), 401, 'wrong token proof');
  const proof = dpop(accessToken, target, pair.privateKey, publicJwk);
  assertStatus(await statusOf(fetchImpl, endpoint, accessToken, proof), 204, 'first admission');
  assertFreshForReplay(claims.exp, now);
  assertStatus(await statusOf(fetchImpl, endpoint, accessToken, dpop(accessToken, target, pair.privateKey, publicJwk)), 401, 'token replay');
  assertFreshForReplay(claims.exp, now);
  return { repository: claims.repository, runId: claims.run_id };
}
