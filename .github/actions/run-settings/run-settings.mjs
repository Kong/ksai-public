import { isIP } from 'node:net';

const ATTEMPTS = 8;

const DELAY_MS = 250;

const pause = (milliseconds = 0) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const WHOLE = /^(?:0|[1-9][0-9]*)$/;

const between = (low, high) => (value) =>
  typeof value === 'string' && WHOLE.test(value) && Number(value) >= low && Number(value) <= high;

const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DENIED_PATH = String.raw`(?!\.\.?(?:/|[\n,]|$))[A-Za-z0-9._@+-]+(?:/(?!\.\.?(?:/|[\n,]|$))[A-Za-z0-9._@+-]+)*/?`;

const DENIED_PATHS = new RegExp(`^${DENIED_PATH}(?:[\n,] ?${DENIED_PATH})*\n?$`);

const EGRESS_PRESET = /^[a-z][a-z0-9-]{0,63}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const exact = (value, names) => Object.keys(value).every((name) => names.includes(name));

function publicHost(host) {
  if (host !== host.toLowerCase() || host.length > 253 || !host.includes('.') || isIP(host) !== 0) return false;
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function endpointHost(value) {
  if (typeof value !== 'string') return '';
  const split = value.lastIndexOf(':');
  if (split < 1 || value.slice(split + 1) !== '443') return '';
  const host = value.slice(0, split);
  return publicHost(host) ? host : '';
}

export function egressOf(value) {
  if (!record(value) || !exact(value, ['presets', 'definitions'])) return null;
  const { presets, definitions } = value;
  if (!Array.isArray(presets) || presets.length < 1 || presets.length > 16
    || new Set(presets).size !== presets.length
    || !presets.every((name) => typeof name === 'string' && EGRESS_PRESET.test(name))
    || !record(definitions) || Object.keys(definitions).length < 1 || Object.keys(definitions).length > 32
    || !presets.every((name) => Object.hasOwn(definitions, name))) return null;

  const expanded = new Map();
  for (const [name, preset] of Object.entries(definitions)) {
    if (!EGRESS_PRESET.test(name) || !record(preset) || !exact(preset, ['endpoints', 'packages'])) return null;
    const endpoints = preset.endpoints ?? [];
    if (!Array.isArray(endpoints) || endpoints.length > 64 || new Set(endpoints).size !== endpoints.length
      || !endpoints.every((endpoint) => endpointHost(endpoint) !== '')) return null;
    expanded.set(name, endpoints);
  }

  return [...new Set(presets.flatMap((name) => expanded.get(name)))].join(' ');
}

export function egressHostsOf(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || new Set(value).size !== value.length
    || !value.every((endpoint) => endpointHost(endpoint) !== '')) return null;
  return value;
}

function runsOnOf(value) {
  if (typeof value !== 'string' || value === '') return '';
  let labels = [value];
  if (value.startsWith('[')) {
    try {
      labels = JSON.parse(value);
    } catch {
      labels = [];
    }
  }
  return Array.isArray(labels) && labels.length > 0
    && labels.every((label) => typeof label === 'string' && RUNNER_LABEL.test(label)) ? value : '';
}

function settingsOf(served) {
  const dependencyEgress = served.egress === undefined ? '' : egressOf(served.egress);
  const egressHosts = served.egress_hosts === undefined ? [] : egressHostsOf(served.egress_hosts);
  const settings = {
    runs_on: runsOnOf(served.runs_on),
    denied_paths: typeof served.denied_paths === 'string' && DENIED_PATHS.test(served.denied_paths)
      ? served.denied_paths
      : '',
    job_timeout_minutes: between(2, 1440)(served.job_timeout_minutes) ? served.job_timeout_minutes : '',
    max_consecutive_tool_failures: between(0, 100000)(served.max_consecutive_tool_failures)
      ? served.max_consecutive_tool_failures
      : '',
    max_repeated_tool_calls: between(0, 100000)(served.max_repeated_tool_calls)
      && Number(served.max_repeated_tool_calls) !== 1 ? served.max_repeated_tool_calls : '',
    egress_endpoints: '',
  };
  if (dependencyEgress !== null && egressHosts !== null) {
    const endpoints = dependencyEgress === '' ? [] : dependencyEgress.split(' ');
    settings.egress_endpoints = [...new Set([...endpoints, ...egressHosts])].join(' ');
  }
  const refused = Object.entries(settings)
    .filter(([name, value]) => name !== 'egress_endpoints' && value === '')
    .map(([name]) => name);
  if (dependencyEgress === null) refused.push('egress');
  if (egressHosts === null) refused.push('egress_hosts');
  return { refused, settings };
}

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
 *   env?: Record<string, string | undefined>,
 *   mint: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 * }} asked
 * @param {(milliseconds: number) => Promise<void>} wait
 */
export async function readRunSettings({
  endpoint = '',
  audience = 'ksai-cp',
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = 10000,
}, wait = pause) {
  const fail = (why) => {
    throw new Error(`The control plane did not return valid run settings. Reason: ${why}.`);
  };

  if (endpoint === '') return fail('the control plane endpoint is empty');
  if (!bare(endpoint)) return fail('the control plane endpoint is not a bare https URL');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return fail('this job holds no id-token: write, so it cannot say which repository it is');
  }

  let token = '';
  try {
    token = await mint(audience);
  } catch {
    return fail('the OIDC token could not be minted');
  }
  if (typeof token !== 'string' || token === '') return fail('the OIDC token endpoint answered with no token');
  secret(token);

  const url = `${endpoint.replace(/\/+$/, '')}/v1/run/settings`;
  let served = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let answer;
    let body;
    try {
      answer = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (answer.ok || answer.status === 503) body = await answer.json();
    } catch {
      return fail('the control plane did not answer with run settings');
    }
    if (answer.status === 503 && record(body) && body.error === 'jira_context_pending') {
      if (attempt + 1 === ATTEMPTS) return fail(`the settings stayed pending after ${ATTEMPTS} attempts`);
      await wait(DELAY_MS * (2 ** attempt));
      continue;
    }
    if (!answer.ok) return fail('the control plane did not answer with run settings');
    served = body;
    break;
  }
  if (!record(served)) return fail('the control plane answered something other than settings');

  const { refused, settings } = settingsOf(served);
  if (refused.length > 0) {
    return fail(`the control plane served invalid or incomplete fields: ${[...new Set(refused)].join(', ')}`);
  }
  return { settings };
}
