const TIMEOUT = 10000;

const NONE = Object.freeze({ datadog_key: '', model_gateway_url: '', model_auth_mode: '', model_auth_arm: '', model_origin: '', model_audience: '', read: false });

const GATEWAY = /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/;
const AUDIENCE = /^https:\/\/[^\s/?#@\\]+$/;

const baseOf = (endpoint) => {
  let held;
  try {
    held = new URL(String(endpoint));
  } catch {
    return '';
  }
  const bare = held.protocol === 'https:' && held.hostname !== '' && held.search === ''
    && held.hash === '' && held.username === '' && held.password === '';
  return bare ? `${held.origin}${held.pathname}`.replace(/\/+$/, '') : '';
};

/**
 * @param {{
 *   endpoint?: string,
 *   audience?: string,
 *   env?: Record<string, string | undefined>,
 *   mint: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 *   note?: (why: string) => void,
 * }} asked
 * @returns {Promise<{ datadog_key: string, model_gateway_url: string, model_auth_mode: string, model_auth_arm: string, model_origin: string, model_audience: string, read: boolean }>}
 */
export async function readCredentials({
  endpoint = '',
  audience = 'ksai-cp',
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = TIMEOUT,
  note = () => {},
}) {
  const base = baseOf(endpoint);
  if (endpoint === '' || base === '') {
    if (endpoint !== '') {
      note('the control plane endpoint is not a bare https URL');
    }
    return NONE;
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    note('this job holds no id-token: write, so it cannot say which run it is');
    return NONE;
  }

  let token = '';
  try {
    token = await mint(audience);
  } catch {
    note('the OIDC token could not be minted');
    return NONE;
  }
  if (typeof token !== 'string' || token === '') return NONE;
  secret(token);

  /** @type {Record<string, unknown>} */
  let served = {};
  try {
    const answer = await fetch(`${base}/v1/run/credentials`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!answer.ok) {
      await Promise.resolve().then(() => answer.body?.cancel()).catch(() => {});
      note(`the control plane answered ${answer.status}`);
      return NONE;
    }
    const parsed = await answer.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      note('the control plane returned invalid run credentials');
      return NONE;
    }
    served = { ...parsed };
  } catch {
    note('the control plane could not be reached');
    return NONE;
  }

  const key = served.datadog_key;
  const gateway = served.model_gateway_url;
  if (served.model_auth_mode === 'cp_exchange') {
    if (typeof served.model_origin !== 'string' || !GATEWAY.test(served.model_origin)
      || /\/v1\/?$/i.test(served.model_origin)
      || typeof served.model_audience !== 'string' || !AUDIENCE.test(served.model_audience)
      || !URL.parse(served.model_audience)?.hostname
      || typeof served.model_auth_arm !== 'string' || served.model_auth_arm === ''
      || (gateway !== undefined && gateway !== '')) {
      throw new Error('the control plane returned an invalid token exchange route');
    }
    return {
      datadog_key: typeof key === 'string' ? key : '',
      model_gateway_url: '',
      model_auth_mode: 'cp_exchange',
      model_auth_arm: served.model_auth_arm,
      model_origin: served.model_origin,
      model_audience: served.model_audience,
      read: true,
    };
  }
  if (served.model_auth_mode !== undefined && served.model_auth_mode !== '') {
    throw new Error('the control plane returned an unknown model authorization mode');
  }
  return {
    datadog_key: typeof key === 'string' ? key : '',
    model_gateway_url: typeof gateway === 'string' && GATEWAY.test(gateway) ? gateway : '',
    model_auth_mode: '',
    model_auth_arm: '',
    model_origin: '',
    model_audience: '',
    read: true,
  };
}
