export const GRANTS = Object.freeze(['source', 'read', 'write', 'modules', 'step']);

export const TIMEOUT = 10000;

export const ASK_TIMEOUT = 30000;

export const DELAYS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);

export const BUDGET = 60000;

export const UNREACHED = 'KSAI_CP_UNREACHED';

export const API = process.env.GITHUB_API_URL || 'https://api.github.com';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const JOB = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/;

const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const STEP = /^[a-z][a-z0-9-]{0,63}$/;

const CREDENTIAL = /^[A-Z_][A-Z0-9_]{0,63}$/;

const TOLD_MAX = 300;

const text = (value) => (typeof value === 'string' ? value : '');

export const OUTCOME_HEADER = 'ksai-cp-outcome';

const answeredItself = (answer) => (answer.headers?.get(OUTCOME_HEADER) ?? '') !== '';

const passing = (answer) => answer.status === 408 || (answer.status >= 500 && !(answer.status === 502 && answeredItself(answer)));

const rest = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function release(answer) {
  await Promise.resolve(answer.body?.cancel()).catch(() => {});
}

async function told(answer) {
  let said = '';
  try {
    said = text(await answer.text()).replace(/\s+/g, ' ').trim().slice(0, TOLD_MAX);
  } catch {
    said = '';
  }
  return said || 'empty response body';
}

export class Refused extends Error {}

export class Unreached extends Error {}

export const unreachedBy = (thrown) => thrown instanceof Unreached || thrown?.cause instanceof Unreached;

export const messageOf = (thrown) => (thrown instanceof Error ? thrown.message : String(thrown));

export function bare(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
}

function waitAsked(answer) {
  const header = (answer.headers?.get('retry-after') ?? '').trim();
  return /^\d+$/.test(header) ? Number(header) * 1000 : null;
}

export function because(thrown) {
  const cause = thrown instanceof Error && thrown.cause instanceof Error ? thrown.cause : null;
  const coded = cause && 'code' in cause ? cause.code : undefined;
  const said = (typeof coded === 'string' && coded) || cause?.message || (thrown instanceof Error ? thrown.message : '');
  return said || 'no error message';
}

export function checkedJob(job) {
  if (job !== '' && !JOB.test(job)) throw new Refused(`invalid job name: ${JSON.stringify(job)}`);
  return job;
}

export function oidcMinter(env = process.env, fetch = globalThis.fetch, timeout = TIMEOUT) {
  return async (audience) => {
    const url = new URL(text(env.ACTIONS_ID_TOKEN_REQUEST_URL));
    url.searchParams.set('audience', audience);
    const answer = await fetch(url, {
      headers: { authorization: `bearer ${text(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!answer.ok) {
      await release(answer);
      throw new Error(`the OIDC token endpoint answered ${answer.status}`);
    }
    const body = Object.assign({ value: '' }, await answer.json());
    return text(body.value);
  };
}

async function attempt({ url, path, body, audience, mint, secret, fetch, timeout }) {
  let token = '';
  try {
    token = await mint(audience);
  } catch (refused) {
    return { retry: `OIDC token request failed: ${because(refused)}`, asked: null };
  }
  if (typeof token !== 'string' || token === '') {
    return { retry: 'OIDC token response has no token', asked: null };
  }
  secret(token);

  let answer;
  try {
    answer = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (unreached) {
    return { retry: `the control plane could not be reached: ${because(unreached)}`, asked: null };
  }

  if (passing(answer)) {
    const asked = waitAsked(answer);
    return { retry: `the control plane answered ${answer.status}: ${await told(answer)}`, asked };
  }
  if (!answer.ok) {
    throw new Refused(`the control plane answered ${answer.status}: ${await told(answer)}`);
  }
  if (path === '/run/no-work' && answer.status !== 204) {
    await release(answer);
    throw new Refused(`control plane answered ${answer.status}, expected 204 for no work`);
  }
  if (answer.status === 204) {
    await release(answer);
    return { served: null };
  }
  try {
    return { served: await answer.json() };
  } catch (unparsed) {
    return { retry: `control plane response is not valid JSON: ${because(unparsed)}`, asked: null };
  }
}

export async function ask({
  endpoint = '',
  path = '',
  body = {},
  audience = 'ksai-cp',
  env = process.env,
  fetch = globalThis.fetch,
  mint = oidcMinter(env, fetch),
  secret = (_token) => {},
  timeout = ASK_TIMEOUT,
  delays = DELAYS,
  sleep = rest,
  note = (_why, _wait) => {},
  budget = BUDGET,
  now = Date.now,
}) {
  if (endpoint === '') throw new Refused('this workflow names no control plane endpoint');
  if (!bare(endpoint)) throw new Refused('the control plane endpoint is not a bare https URL');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Refused('job lacks the id-token: write permission, cannot identify the run');
  }

  const asked = { url: `${endpoint.replace(/\/+$/, '')}${path}`, path, body, audience, mint, secret, fetch };
  const longest = Math.max(0, ...delays);
  const started = now();
  for (let tried = 0; ; tried += 1) {
    const outcome = await attempt({ ...asked, timeout: Math.max(1, Math.min(timeout, budget - (now() - started))) });
    if ('served' in outcome) return outcome.served;
    if (tried === delays.length) {
      throw new Unreached(`${outcome.retry}, after ${delays.length + 1} attempts`);
    }
    const wait = Math.min(Math.max(delays[tried], outcome.asked ?? 0), longest);
    if (now() - started + wait >= budget) {
      throw new Unreached(`${outcome.retry}, request timed out after ${Math.round(budget / 1000)}s`);
    }
    note(outcome.retry, wait);
    await sleep(wait);
  }
}

function mintedFrom(served) {
  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    throw new Error('control plane response is not a token object');
  }
  const token = text(served.token);
  const appSlug = text(served.app_slug);
  if (token === '' || /\s/.test(token)) throw new Error('control plane response has no token');
  if (!APP_SLUG.test(appSlug)) throw new Error('control plane response has no app slug');
  return { token, appSlug };
}

export function checkedAsk({ grant, owner = '', job = '', step = '', credential = '' }) {
  if (!GRANTS.includes(grant)) throw new Refused(`invalid grant ${JSON.stringify(grant)}, expected one of ${GRANTS.join(', ')}`);
  if (grant === 'modules' && !OWNER.test(owner)) {
    throw new Refused(`invalid owner ${JSON.stringify(owner)} for a modules token`);
  }
  if (grant !== 'modules' && owner !== '') throw new Refused('owner is only valid for a modules token');
  if (grant === 'step' && (!STEP.test(step) || !CREDENTIAL.test(credential))) {
    throw new Refused('a step token needs a valid step id and credential name');
  }
  if (grant !== 'step' && (step !== '' || credential !== '')) throw new Refused('step and credential are only valid for a step token');
  checkedJob(job);
  if (grant === 'modules') return { grant, owner, job };
  return grant === 'step' ? { grant, step, credential, job } : { grant, job };
}

export async function mintRun({ grant, owner = '', job = '', step = '', credential = '', secret = (_token) => {}, ...asking }) {
  const body = checkedAsk({ grant, owner, job, step, credential });
  const minted = mintedFrom(await ask({ ...asking, secret, path: '/run/token', body }));
  secret(minted.token);
  return minted;
}

export async function revoke({ token, api = API, fetch = globalThis.fetch, timeout = TIMEOUT }) {
  const answer = await fetch(`${api.replace(/\/+$/, '')}/installation/token`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeout),
  });
  await release(answer);
  if (answer.status !== 204 && answer.status !== 401) {
    throw new Error(`revoking the token failed, GitHub answered ${answer.status}`);
  }
}

export async function runToken({
  unreached = false,
  grant,
  owner = '',
  job = '',
  notice = (_said) => {},
  ...asking
}) {
  const minted = await mintRun({ ...asking, grant, owner, job, ...(unreached ? { delays: [] } : {}) });
  notice(`ksai asked the control plane for its ${grant} token`);
  return minted;
}
