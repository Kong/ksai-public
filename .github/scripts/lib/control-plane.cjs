'use strict';

const MINTED_SHAPE = /^[0-9a-f]{32}$/;
const RENDERING_MODES = Object.freeze(['local', 'shadow', 'cp']);

function renderingModeOf(value) {
  const said = String(value ?? '').trim();
  return RENDERING_MODES.includes(said) ? said : 'local';
}

const DEFAULT_TIMEOUT = 30_000;

const OUTCOME_HEADER = 'ksai-cp-outcome';

const EARLY = 30_000;

const tokens = new Map();

function expiryOf(token) {
  const [, claims] = String(token).split('.');
  if (claims === undefined) return 0;
  try {
    const { exp } = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const minter = ({ env, fetch, signal, now = Date.now, held = tokens, holds }) => async (audience) => {
  const asking = [audience, env.ACTIONS_ID_TOKEN_REQUEST_URL, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN].join('\n');
  const was = held.get(asking);
  const stated = Number.isFinite(holds) && holds >= 0;
  if (was !== undefined && stated && now() + holds + EARLY < was.exp) return was.token;

  const response = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal,
  });
  if (!response.ok) {
    await released(response);
    return '';
  }
  const body = await response.json();
  const token = typeof body?.value === 'string' ? body.value : '';

  const exp = expiryOf(token);
  if (token !== '' && exp > 0) held.set(asking, { token, exp });
  return token;
};

const mask = (token) => process.stdout.write(`::add-mask::${token}\n`);

function mintedId(value) {
  const said = String(value ?? '').trim().toLowerCase();
  return MINTED_SHAPE.test(said) ? said : '';
}

function controlPlaneBase(endpoint) {
  const named = String(endpoint ?? '').trim();
  let url;
  try {
    url = new URL(named);
  } catch {
    url = null;
  }

  const bare = url?.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
  if (!bare) return { failure: 'the control plane endpoint is not a bare https URL' };
  return { base: `${url.origin}${url.pathname}`.replace(/\/+$/, '') };
}

async function controlPlaneToken({ audience, env, mint, secret }) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { failure: 'this job holds no id-token: write, so it cannot name itself to the control plane' };
  }

  let token;
  try {
    token = await mint(audience);
  } catch {
    return { failure: 'a token for the control plane could not be minted' };
  }
  if (typeof token !== 'string' || token === '') return { failure: 'the token endpoint answered with no token' };
  secret(token);
  return { token };
}

async function reachControlPlane({ endpoint, audience = 'ksai-cp', env, mint, secret }) {
  const { base, failure } = controlPlaneBase(endpoint);
  if (failure) return { failure };
  const minted = await controlPlaneToken({ audience, env, mint, secret });
  return minted.failure ? minted : { base, token: minted.token };
}

async function reachedFor({ env, fetch, timeout, secret, holds = timeout, audience = 'ksai-cp', endpoint = env.KSAI_CP_ENDPOINT }) {
  const named = String(endpoint ?? '').trim();
  if (named === '') return { why: 'no control plane serves this repository' };
  if (!(timeout > 0)) return { why: 'the control plane did not answer in time' };
  const signal = AbortSignal.timeout(timeout);
  const mint = minter({ env, fetch, signal, holds });
  const reached = await reachControlPlane({ endpoint: named, audience, env, mint, secret });
  return reached.failure ? { why: reached.failure } : { base: reached.base, token: reached.token, signal };
}

const SAID_MAX = 500;

async function saidBy(response) {
  try {
    return String(await response.text()).replace(/\s+/g, ' ').trim().slice(0, SAID_MAX);
  } catch {
    return '';
  }
}

async function answered(call, url, options) {
  try {
    const response = await postTo(call, url, options);
    if (!response.ok) {
      const { status, headers } = response;
      const said = options.said && headers?.get(OUTCOME_HEADER) ? await saidBy(response) : '';
      if (!said) await released(response);
      return { status, headers, why: said || `the control plane answered ${status}` };
    }
    return { answer: await response.json() };
  } catch (error) {
    return { why: unanswered(error) };
  }
}

function usingControlPlane(env) {
  return String(env?.KSAI_GITHUB_CALLS ?? '').trim() === 'cp';
}

function postTo(call, url, { token, body, timeout, signal = AbortSignal.timeout(timeout) }) {
  return call(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal,
  });
}

const released = (response) => Promise.resolve()
  .then(() => response.body?.cancel())
  .catch(() => {});

function unreached(error) {
  return `the control plane could not be reached: ${error?.cause?.code || error?.message || 'it said nothing'}`;
}

function unanswered(error) {
  return error?.name === 'TimeoutError' ? 'the control plane did not answer in time' : unreached(error);
}

module.exports = {
  DEFAULT_TIMEOUT, renderingModeOf, usingControlPlane, minter, mask, mintedId, reachControlPlane, reachedFor, answered, postTo,
  unreached, unanswered,
};
