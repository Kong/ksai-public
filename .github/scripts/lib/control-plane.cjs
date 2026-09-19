'use strict';

const MINTED_SHAPE = /^[0-9a-f]{32}$/;

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
  return bare ? { base: named.replace(/\/+$/, '') } : { failure: 'the control plane endpoint is not a bare https URL' };
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

function postTo(call, url, { token, body, timeout }) {
  return call(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeout),
  });
}

function unreached(error) {
  return `the control plane could not be reached: ${error?.cause?.code || error?.message || 'it said nothing'}`;
}

module.exports = { mintedId, reachControlPlane, postTo, unreached };
