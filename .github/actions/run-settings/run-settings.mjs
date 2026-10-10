import { fetchRunSettings } from './migration.mjs';

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
export const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

const ARM = new RegExp(`^${SEGMENT}(:${SEGMENT})?$`);

const JIRA_ATTEMPTS = 8;
const JIRA_DELAY_MS = 250;
const pause = (milliseconds = 0) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

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

const namedModels = (/** @type {string} */ value) => value.split(/[,\s]+/).filter((one) => one !== '');

export const PINNED = {
  shadow_percent: (/** @type {string} */ value) =>
    SHARE.test(value) && Number(value) >= 0 && Number(value) <= 100,
  review_triage_mode: WHERE,
  allowed_models: (/** @type {string} */ value) => {
    const named = namedModels(value);
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
  engine: (/** @type {string} */ value) => ['opencode', 'opencode2'].includes(value),
  review_strategy: (/** @type {string} */ value) => ['baseline', 'evidence', 'dual'].includes(value),
  review_diff_mib: between(1, 64),
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
  jira_site: '',
  jira_projects: '',
  fix_review_bots: '',
  blocker: '',
  said: '',
};

const REVIEW_BOT = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?`;

const REVIEW_BOTS = new RegExp(`^${REVIEW_BOT}(?:[ ,] ?${REVIEW_BOT})*$`);

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

const JIRA_SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

const JIRA_PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;

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

  if (typeof served.jira_site === 'string' && JIRA_SITE.test(served.jira_site)
    && typeof served.jira_projects === 'string' && JIRA_PROJECT.test(served.jira_projects)
    && settings.require_plan_approval === 'true') {
    settings.jira_site = served.jira_site;
    settings.jira_projects = served.jira_projects;
  }

  const bots = served.fix_review_bots;
  if (bots === '') settings.fix_review_bots = 'none';
  else if (typeof bots === 'string' && REVIEW_BOTS.test(bots)) settings.fix_review_bots = bots;

  const workflow = served.continuation_workflow;
  if (typeof workflow === 'string' && WORKFLOW_FILE.test(workflow)) settings.continuation_workflow = workflow;

  if (served.clear_request === true) settings.clear_request = 'true';
  if (served.blocker === true) settings.blocker = 'true';
  if (served.said === true) settings.said = 'true';

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

function runnableModel(catalog, wanted) {
  const models = /** @type {{ models: unknown[] }} */ (catalog).models;
  return /** @type {{ id?: unknown } | undefined} */ (models.find((one) => {
    if (one === null || typeof one !== 'object') return false;
    const model = /** @type {{ id?: unknown, aliases?: unknown, runnable?: unknown }} */ (one);
    if (model.runnable !== true) return false;
    const names = [model.id, ...(Array.isArray(model.aliases) ? model.aliases : [])];
    return names.some((name) => String(name ?? '').toLowerCase() === wanted.toLowerCase());
  }));
}

export function runs(catalog, wanted) {
  return runnableModel(catalog, wanted) !== undefined;
}

export function runnableAllowed(catalog, allowed, model) {
  const named = namedModels(allowed);
  if (named.length === 0) return '';
  const runnable = [...new Set(named.filter((name) => runs(catalog, name)))];
  if (runnable.length > 0) return runnable.join(',');
  return [runnableModel(catalog, model)?.id, model]
    .find((one) => typeof one === 'string' && MODEL.test(one) && PINNED.allowed_models(one)) ?? null;
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
}, wait = pause) {
  let jira = false;
  const keep = (why) => {
    if (jira) throw new Error(`The control plane did not return valid Jira context. Reason: ${why}.`);
    return held(model, effort, pinned, why);
  };

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
  for (let attempt = 0; attempt < JIRA_ATTEMPTS; attempt += 1) {
    let answer;
    let body;
    try {
      answer = await fetchRunSettings(fetch, endpoint, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (answer.ok || answer.status === 503) body = await answer.json();
    } catch {
      return keep('the control plane did not answer with run settings');
    }
    if (answer.status === 503 && body?.error === 'jira_context_unavailable') {
      throw new Error('The control plane refused the Jira context.');
    }
    if (answer.status === 503 && body?.error === 'jira_context_pending') {
      jira = true;
      if (attempt + 1 === JIRA_ATTEMPTS) {
        throw new Error(`The Jira context is unavailable after ${JIRA_ATTEMPTS} attempts.`);
      }
      await wait(JIRA_DELAY_MS * (2 ** attempt));
      continue;
    }
    if (!answer.ok) return keep('the control plane did not answer with run settings');
    served = body;
    break;
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
  if (catalog !== null) {
    const allowed = runnableAllowed(catalog, runSettings.allowed_models, servedModel);
    if (allowed === null) return keep('the control plane served a model no allowed list can name');
    runSettings.allowed_models = allowed;
  }

  const settings = settingsOf(served);
  if (jira && (settings.jira_site === '' || settings.jira_projects === '' || settings.require_plan_approval !== 'true')) {
    return keep('the control plane did not answer with valid Jira context');
  }
  for (const name of [...Object.keys(GUARDS), 'fix_review_bots', 'jira_site', 'jira_projects']) {
    if (served[name] !== undefined && served[name] !== '' && settings[name] === '') refused.push(name);
  }

  return {
    model: servedModel, effort: servedEffort, arm, runSettings, settings,
    catalog, refused, served: true, why: '',
  };
}
