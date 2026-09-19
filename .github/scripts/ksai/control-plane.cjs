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

async function controlPlaneToken({ endpoint, audience, env, mint, secret }) {
  const named = String(endpoint ?? '').trim();
  if (!bareEndpoint(named)) return { failure: 'the control plane endpoint is not a bare https URL' };
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { failure: 'this job holds no id-token: write, so it cannot ask the control plane' };
  }

  let token = '';
  try {
    token = String((await mint(audience)) ?? '');
  } catch {
    return { failure: 'a token for the control plane could not be minted' };
  }
  if (token === '') return { failure: 'the token endpoint answered with no token' };
  secret(token);
  return { token, base: named.replace(/\/+$/, '') };
}

function unreached(error) {
  return `the control plane could not be reached: ${error?.cause?.code || error?.message || 'it said nothing'}`;
}

module.exports = { bareEndpoint, controlPlaneToken, unreached };
