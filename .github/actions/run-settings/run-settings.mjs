import { fetchRunSettings } from './migration.mjs';

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
 * @param {Record<string, string>} runSettings
 * @param {string} effort
 */
function inverted(runSettings, effort) {
  const floor = EFFORTS.indexOf(runSettings.min_effort || 'medium');
  const ceiling = EFFORTS.indexOf(runSettings.max_effort || effort);
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
  runSettings: kept(pinned),
  settings: NO_SETTINGS,
  catalog: /** @type {unknown} */ (null),
  refused: /** @type {string[]} */ ([]),
  served: false,
  why,
});

const NO_SETTINGS = {
  trigger_phrase: '',
  runs_on: '',
  continuation_workflow: '',
  clear_request: '',
  federation_rule_id: '',
  organization_id: '',
  service_account_id: '',
  workspace_id: '',
  disabled_commands: '',
  write_access_commands: '',
  denied_paths: '',
  bare_comments: '',
  stop_mode: '',
  require_plan_approval: '',
};

const DENIED_PATH = String.raw`(?!\.\.?(?:/|[\n,]|$))[A-Za-z0-9._@+-]+(?:/(?!\.\.?(?:/|[\n,]|$))[A-Za-z0-9._@+-]+)*/?`;

const GUARDS = Object.freeze({
  disabled_commands: /^[a-z][a-z-]{0,31}([ ,] ?[a-z][a-z-]{0,31})*$/,
  write_access_commands: /^[a-z][a-z-]{0,31}([ ,] ?[a-z][a-z-]{0,31})*$/,
  denied_paths: new RegExp(`^${DENIED_PATH}(?:[\n,] ?${DENIED_PATH})*\n?$`),
  bare_comments: /^(auto|off)$/,
  stop_mode: /^(soft|hard)$/,
  require_plan_approval: /^(true|false)$/,
});

const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;

const PHRASE = /^\/[A-Za-z0-9._-]{1,64}$|^@[A-Za-z0-9._-]{1,64}$/;

const FEDERATION = Object.freeze({
  federation_rule_id: /^fdrl_[A-Za-z0-9]{1,64}$/,
  organization_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  service_account_id: /^svac_[A-Za-z0-9]{1,64}$/,
  workspace_id: /^wrkspc_[A-Za-z0-9]{1,64}$/,
});

function settingsOf(served = Object.create(null)) {
  const settings = { ...NO_SETTINGS };
  const phrase = served.trigger_phrase;
  if (typeof phrase === 'string' && PHRASE.test(phrase)) settings.trigger_phrase = phrase;

  for (const [name, shape] of Object.entries(GUARDS)) {
    const value = served[name];
    if (typeof value === 'string' && shape.test(value)) settings[name] = value;
  }

  const workflow = served.continuation_workflow;
  if (typeof workflow === 'string' && WORKFLOW_FILE.test(workflow)) settings.continuation_workflow = workflow;

  if (served.clear_request === true) settings.clear_request = 'true';

  const labels = served.runs_on;
  if (typeof labels === 'string' && labels !== '') {
    let named = [labels];
    if (labels.startsWith('[')) {
      try {
        named = JSON.parse(labels);
      } catch {
        named = [];
      }
    }
    if (Array.isArray(named) && named.length > 0
      && named.every((one) => typeof one === 'string' && RUNNER_LABEL.test(one))) {
      settings.runs_on = labels;
    }
  }

  for (const [name, shape] of Object.entries(FEDERATION)) {
    const value = served[name];
    if (typeof value === 'string' && shape.test(value)) Reflect.set(settings, name, value);
  }
  if (Object.keys(FEDERATION).some((name) => Reflect.get(settings, name) === '')) {
    for (const name of Object.keys(FEDERATION)) Reflect.set(settings, name, '');
  }

  return settings;
}

export function keyless(answer, keyHeld) {
  if (keyHeld === 'true') return answer;
  return { ...answer, runSettings: { ...answer.runSettings, run_tokens: 'cp' } };
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
 * read somewhere other than the control plane's root: a bare `https://` resolves `/v1/run/settings` as
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
export async function readRunSettings({
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
    const answer = await fetchRunSettings(fetch, endpoint, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!answer.ok) return keep('the control plane did not answer with run settings');
    served = /** @type {Record<string, unknown>} */ (await answer.json());
  } catch {
    return keep('the control plane did not answer with run settings');
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

  const runSettings = kept(pinned);
  const refused = [];
  for (const [name, shaped] of Object.entries(PINNED)) {
    const value = served[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !shaped(value)) {
      refused.push(name);
      continue;
    }
    runSettings[name] = value;
  }
  if (inverted(runSettings, servedEffort)) {
    for (const name of ['min_effort', 'max_effort']) {
      runSettings[name] = pinned[name] ?? '';
      if (!refused.includes(name)) refused.push(name);
    }
  }

  const settings = settingsOf(served);
  for (const name of Object.keys(GUARDS)) {
    if (served[name] !== undefined && served[name] !== '' && settings[name] === '') refused.push(name);
  }

  return {
    model: servedModel, effort: servedEffort, arm, runSettings, settings,
    catalog, refused, served: true, why: '',
  };
}
