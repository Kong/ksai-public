'use strict';

const MINTED_SHAPE = /^[0-9a-f]{32}$/;
const RENDERING_MODES = Object.freeze(['local', 'shadow', 'cp']);

function renderingModeOf(value) {
  const said = String(value ?? '').trim();
  return RENDERING_MODES.includes(said) ? said : 'local';
}

const minter = ({ env, fetch, signal }) => async (audience) => {
  const response = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal,
  });
  if (!response.ok) return '';
  const body = await response.json();
  return typeof body?.value === 'string' ? body.value : '';
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

function unanswered(error) {
  return error?.name === 'TimeoutError' ? 'the control plane did not answer in time' : unreached(error);
}

module.exports = {
  RENDERING_MODES, renderingModeOf, minter, mask, mintedId, reachControlPlane, postTo, unreached, unanswered,
};
