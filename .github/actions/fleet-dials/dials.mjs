const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

const ARM = new RegExp(`^${SEGMENT}(:${SEGMENT})?$`);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const held = (model, effort, why) => ({ model, effort, arm: '', served: false, why });

/**
 * bare reports whether an endpoint is an https URL with a host and nothing a request would carry
 * past its path. The token goes out in a header, so a query, a fragment or credentials would put the
 * read somewhere other than the control plane's root: a bare `https://` resolves `/fleetconfig` as
 * a host, and a query string swallows the path the read appends.
 *
 * @param {string} endpoint
 */
function bare(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
}

/**
 * @param {{
 *   endpoint?: string,
 *   audience?: string,
 *   model: string,
 *   effort: string,
 *   env?: Record<string, string | undefined>,
 *   mint: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 * }} asked
 */
export async function readDials({
  endpoint = '',
  audience = 'ksai-cp',
  model,
  effort,
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = 10000,
}) {
  const keep = (why) => held(model, effort, why);

  if (endpoint === '') return keep('');
  if (!bare(endpoint)) return keep('the control plane endpoint is not a bare https URL');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return keep('this job holds no id-token: write, so it cannot say which repository it is');
  }

  let token = '';
  try {
    token = await mint(audience);
  } catch {
    return keep('the OIDC token could not be minted');
  }
  if (typeof token !== 'string' || token === '') {
    return keep('the OIDC token endpoint answered with no token');
  }
  secret(token);

  let served = /** @type {Record<string, unknown>} */ ({});
  try {
    const answer = await fetch(`${endpoint.replace(/\/+$/, '')}/fleetconfig`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!answer.ok) return keep('the control plane did not answer with dials');
    served = /** @type {Record<string, unknown>} */ (await answer.json());
  } catch {
    return keep('the control plane did not answer with dials');
  }

  const servedModel = served?.model;
  const servedEffort = served?.effort;
  if (typeof servedModel !== 'string' || !MODEL.test(servedModel)) {
    return keep('the control plane served a model this workflow will not pass on');
  }
  if (typeof servedEffort !== 'string' || !EFFORTS.includes(servedEffort)) {
    return keep('the control plane served an effort this workflow will not pass on');
  }

  const arm = typeof served.arm === 'string' && ARM.test(served.arm) ? served.arm : '';

  return { model: servedModel, effort: servedEffort, arm, served: true, why: '' };
}
