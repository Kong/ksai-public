'use strict';

function bareEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint ?? ''));
  } catch {
    return false;
  }

  return url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
}

function controlPlaneBase(endpoint) {
  const named = String(endpoint ?? '').trim();
  return bareEndpoint(named) ? named.replace(/\/+$/, '') : '';
}

async function controlPlaneToken({ audience = 'ksai-cp', env, mint, secret }) {
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

function unreached(error) {
  return `the control plane could not be reached: ${error?.cause?.code || error?.message || 'it said nothing'}`;
}

module.exports = { bareEndpoint, controlPlaneBase, controlPlaneToken, unreached };
