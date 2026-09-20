const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
export const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

const ARM = new RegExp(`^${SEGMENT}(:${SEGMENT})?$`);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const WHOLE = /^(?:0|[1-9][0-9]*)$/;

/**
 * @param {number} low
 * @param {number} high
 */
const between = (low, high) => (/** @type {string} */ value) =>
  WHOLE.test(value) && Number(value) >= low && Number(value) <= high;

const SHARE = /^(?:0|[1-9][0-9]*)(\.[0-9]+)?$/;

export const ALIASES = ['fast', 'balanced', 'flagship', 'opus', 'sonnet', 'haiku'];

const WHERE = (/** @type {string} */ value) => ['local', 'shadow', 'cp'].includes(value);

export const PINNED = {
  shadow_percent: (/** @type {string} */ value) =>
    SHARE.test(value) && Number(value) >= 0 && Number(value) <= 100,
  review_triage_mode: WHERE,
  allowed_models: (/** @type {string} */ value) => {
    const named = value.split(/[,\s]+/).filter((one) => one !== '');
    return named.length > 0
      && named.every((one) => MODEL.test(one) && !ALIASES.includes(one.toLowerCase()));
  },
  max_effort: (/** @type {string} */ value) => EFFORTS.includes(value),
  min_effort: (/** @type {string} */ value) => EFFORTS.includes(value),
  job_timeout_minutes: between(2, 1440),
  max_consecutive_tool_failures: between(0, 100000),
  max_repeated_tool_calls: (/** @type {string} */ value) =>
    between(0, 100000)(value) && Number(value) !== 1,
  triage_write: (/** @type {string} */ value) => value === 'off' || value === 'cp',
  report_rendering: WHERE,
  run_tokens: WHERE,
  prompt_rendering: WHERE,
};

/**
 * @param {Record<string, string>} dials
 * @param {string} effort
 */
function inverted(dials, effort) {
  const floor = EFFORTS.indexOf(dials.min_effort || 'medium');
  const ceiling = EFFORTS.indexOf(dials.max_effort || effort);
  return floor >= 0 && ceiling >= 0 && floor > ceiling;
}

/** @param {Record<string, string>} pinned */
const kept = (pinned) => Object.fromEntries(
  Object.keys(PINNED).map((name) => [name, pinned[name] ?? '']),
);

/**
 * @param {string} model
 * @param {string} effort
 * @param {Record<string, string>} pinned
 * @param {string} why
 */
const held = (model, effort, pinned, why) => ({
  model,
  effort,
  arm: '',
  dials: kept(pinned),
  catalog: /** @type {unknown} */ (null),
  refused: /** @type {string[]} */ ([]),
  served: false,
  why,
});

export function keyless(answer, keyHeld) {
  if (keyHeld === 'true') return answer;
  return { ...answer, dials: { ...answer.dials, run_tokens: 'cp' } };
}

export function catalogOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const models = /** @type {{ models?: unknown }} */ (value).models;
  return Array.isArray(models) && models.length > 0 ? value : null;
}

export function runs(catalog, wanted) {
  const models = /** @type {{ models: unknown[] }} */ (catalog).models;
  return models.some((one) => {
    if (one === null || typeof one !== 'object') return false;
    const model = /** @type {{ id?: unknown, aliases?: unknown, opencode?: unknown }} */ (one);
    if (model.opencode === null || typeof model.opencode !== 'object') return false;
    const names = [model.id, ...(Array.isArray(model.aliases) ? model.aliases : [])];
    return names.some((name) => String(name ?? '').toLowerCase() === wanted.toLowerCase());
  });
}

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
 *   pinned?: Record<string, string>,
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
  pinned = {},
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = 10000,
}) {
  const keep = (why) => held(model, effort, pinned, why);

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

  const catalog = catalogOf(served.catalog);
  if (catalog !== null && !runs(catalog, servedModel)) {
    return keep('the control plane served a model its own catalog says this runner cannot run');
  }

  const arm = typeof served.arm === 'string' && ARM.test(served.arm) ? served.arm : '';

  const dials = kept(pinned);
  const refused = [];
  for (const [name, shaped] of Object.entries(PINNED)) {
    const value = served[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !shaped(value)) {
      refused.push(name);
      continue;
    }
    dials[name] = value;
  }
  if (inverted(dials, servedEffort)) {
    for (const name of ['min_effort', 'max_effort']) {
      dials[name] = pinned[name] ?? '';
      if (!refused.includes(name)) refused.push(name);
    }
  }

  return { model: servedModel, effort: servedEffort, arm, dials, catalog, refused, served: true, why: '' };
}
