'use strict';

const MINTED_SHAPE = /^[0-9a-f]{32}$/;
const RENDERING_MODES = Object.freeze(['local', 'shadow', 'cp']);

function renderingModeOf(value) {
  const said = String(value ?? '').trim();
  return RENDERING_MODES.includes(said) ? said : 'local';
}

const DEFAULT_TIMEOUT = 30_000;

const OUTCOME_HEADER = 'ksai-cp-outcome';

const HANDOVER_HEADER = 'X-Ksai-Gateway-Token';

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

const MINT_TRIES = 3;

const MINT_PAUSE_MS = 500;

const OIDC = 'GitHub\'s OIDC token endpoint';

const passing = (status) => status === 408 || status === 429 || status >= 500;

class MintFailed extends Error {}

const NATIVE_ERRORS = new Set(['AbortError', 'TimeoutError', 'TypeError', 'Error']);

const unminted = (error) => {
  const code = String(error?.cause?.code ?? '');
  const name = String(error?.name ?? '');
  return `${OIDC} could not be reached (${/^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : NATIVE_ERRORS.has(name) ? name : 'Error'})`;
};

const GAVE_UP = `the caller gave up before ${OIDC} minted a token`;

const pausing = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted === true) {
    resolve();
    return;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

const minter = ({ env, fetch, signal, now = Date.now, held = tokens, holds, pause = pausing }) => async (audience) => {
  const asking = [audience, env.ACTIONS_ID_TOKEN_REQUEST_URL, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN].join('\n');
  const was = held.get(asking);
  const stated = Number.isFinite(holds) && holds >= 0;
  if (was !== undefined && stated && now() + holds + EARLY < was.exp) return was.token;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted === true) throw new MintFailed(GAVE_UP);
    const last = attempt >= MINT_TRIES;
    let response;
    try {
      response = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, {
        headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        signal,
      });
    } catch (error) {
      if (signal?.aborted === true) throw new MintFailed(GAVE_UP, { cause: error });
      if (last) throw new MintFailed(unminted(error), { cause: error });
      await pause(MINT_PAUSE_MS * attempt, signal);
      continue;
    }
    if (!response.ok) {
      await released(response);
      if (passing(response.status) && !last) {
        await pause(MINT_PAUSE_MS * attempt, signal);
        continue;
      }
      throw new MintFailed(`${OIDC} answered ${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (signal?.aborted === true) throw new MintFailed(GAVE_UP, { cause: error });
      throw new MintFailed(`${OIDC} answered ${response.status} with a body that is not JSON`, { cause: error });
    }
    const token = typeof body?.value === 'string' ? body.value : '';
    if (token === '') throw new MintFailed(`${OIDC} answered ${response.status} with no token`);

    const exp = expiryOf(token);
    if (exp > 0) held.set(asking, { token, exp });
    return token;
  }
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
  } catch (error) {
    return { failure: error instanceof MintFailed ? `a token for the control plane could not be minted: ${error.message}` : 'a token for the control plane could not be minted' };
  }
  if (typeof token !== 'string' || token === '') return { failure: `a token for the control plane could not be minted: ${OIDC} answered with no token` };
  secret(token);
  return { token };
}

async function reachControlPlane({ endpoint, audience = 'ksai-cp', env, mint, secret }) {
  const { base, failure } = controlPlaneBase(endpoint);
  if (failure) return { failure };
  const minted = await controlPlaneToken({ audience, env, mint, secret });
  return minted.failure ? minted : { base, token: minted.token };
}

async function gatewayHandover({ env, mint, secret }) {
  if (String(env.ANTHROPIC_AUTH ?? '').trim() !== 'oidc-bearer') return {};
  if (String(env.KSAI_MODEL_AUTH_MODE ?? '').trim() === 'cp_exchange') return {};
  const gateway = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!gateway.startsWith('https://') || /\/v1$/i.test(gateway)) return {};
  const minted = await controlPlaneToken({ audience: gateway, env, mint, secret });
  return minted.token ? { [HANDOVER_HEADER]: minted.token } : {};
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

const ATTEMPTS = 3;

const backoffFor = (tries) => 2 ** tries * 1000;

const holdsFor = (timeout) => Array.from({ length: ATTEMPTS }, (_, tries) => timeout + (tries > 0 ? backoffFor(tries) : 0))
  .reduce((all, one) => all + one, 0);

const held = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function answeredRetrying(call, url, options, pause = held) {
  for (let tries = 0; ; tries += 1) {
    if (tries > 0) await pause(backoffFor(tries));
    const said = await answered(call, url, options);
    if (!said.why) return said;
    const unavailable = said.status === undefined || said.status >= 500 || said.status === 429;
    if (!unavailable || tries + 1 >= ATTEMPTS) return { ...said, unavailable };
  }
}

function usingControlPlane(env) {
  return String(env?.KSAI_GITHUB_CALLS ?? '').trim() === 'cp';
}

function postTo(call, url, { token, body, timeout, signal = AbortSignal.timeout(timeout), headers = {} }) {
  return call(url, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
  DEFAULT_TIMEOUT, OUTCOME_HEADER, renderingModeOf, usingControlPlane, minter, mask, mintedId, reachControlPlane, reachedFor,
  gatewayHandover, answered, answeredRetrying, held, holdsFor, postTo, released, unreached, unanswered,
};
