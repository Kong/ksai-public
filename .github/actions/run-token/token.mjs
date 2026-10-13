export const GRANTS = Object.freeze(['source', 'read', 'write', 'modules']);

export const TIMEOUT = 10000;

export const ASK_TIMEOUT = 30000;

export const DELAYS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);

export const BUDGET = 60000;

export const UNREACHED = 'KSAI_CP_UNREACHED';

export const API = process.env.GITHUB_API_URL || 'https://api.github.com';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const JOB = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/;

const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TOLD_MAX = 300;

const text = (value) => (typeof value === 'string' ? value : '');

export const OUTCOME_HEADER = 'ksai-cp-outcome';

const answeredItself = (answer) => (answer.headers?.get(OUTCOME_HEADER) ?? '') !== '';

const passing = (answer, path) => answer.status === 408 || (answer.status >= 500 && !(answer.status === 502 && answeredItself(answer))) ||
  (path === '/run/no-work' && [404, 405].includes(answer.status));

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
  return said || 'it said nothing';
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
  return said || 'it said nothing';
}

export function checkedJob(job) {
  if (job !== '' && !JOB.test(job)) throw new Refused(`job is ${JSON.stringify(job)}, which is not a job name`);
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
    return { retry: `the OIDC token could not be minted: ${because(refused)}`, asked: null };
  }
  if (typeof token !== 'string' || token === '') {
    return { retry: 'the OIDC token endpoint answered with no token', asked: null };
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

  if (passing(answer, path)) {
    const asked = waitAsked(answer);
    return { retry: `the control plane answered ${answer.status}: ${await told(answer)}`, asked };
  }
  if (!answer.ok) {
    throw new Refused(`the control plane answered ${answer.status}: ${await told(answer)}`);
  }
  if (path === '/run/no-work' && answer.status !== 204) {
    await release(answer);
    throw new Refused(`the control plane answered ${answer.status} without the terminal 204 required for no work`);
  }
  if (answer.status === 204) {
    await release(answer);
    return { served: null };
  }
  try {
    return { served: await answer.json() };
  } catch (unparsed) {
    return { retry: `the control plane answered with a body that did not parse: ${because(unparsed)}`, asked: null };
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
    throw new Refused('this job holds no id-token: write, so it cannot say which run it is');
  }

  const asked = { url: `${endpoint.replace(/\/+$/, '')}${path}`, path, body, audience, mint, secret, fetch };
  const longest = Math.max(0, ...delays);
  const started = now();
  for (let tried = 0; ; tried += 1) {
    const outcome = await attempt({ ...asked, timeout: Math.max(1, Math.min(timeout, budget - (now() - started))) });
    if ('served' in outcome) return outcome.served;
    if (tried === delays.length) {
      throw new Unreached(`${outcome.retry}, on the last of ${delays.length + 1} attempts`);
    }
    const wait = Math.min(Math.max(delays[tried], outcome.asked ?? 0), longest);
    if (now() - started + wait >= budget) {
      throw new Unreached(`${outcome.retry}, and the ${Math.round(budget / 1000)}s allowed to ask ran out`);
    }
    note(outcome.retry, wait);
    await sleep(wait);
  }
}

function mintedFrom(served) {
  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    throw new Error('the control plane answered something other than a token');
  }
  const token = text(served.token);
  const appSlug = text(served.app_slug);
  if (token === '' || /\s/.test(token)) throw new Error('the control plane answered with no token');
  if (!APP_SLUG.test(appSlug)) throw new Error('the control plane answered with no App it minted the token as');
  return { token, appSlug };
}

export function checkedAsk({ grant, owner = '', job = '' }) {
  if (!GRANTS.includes(grant)) throw new Refused(`grant is ${JSON.stringify(grant)}, and a run asks for one of ${GRANTS.join(', ')}`);
  if (grant === 'modules' && !OWNER.test(owner)) {
    throw new Refused(`a modules token names the owner whose repositories it reads, and ${JSON.stringify(owner)} is not one`);
  }
  if (grant !== 'modules' && owner !== '') throw new Refused('only a modules token names an owner');
  checkedJob(job);
  return grant === 'modules' ? { grant, owner, job } : { grant, job };
}

export async function mintRun({ grant, owner = '', job = '', secret = (_token) => {}, ...asking }) {
  const body = checkedAsk({ grant, owner, job });
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
    throw new Error(`GitHub answered ${answer.status} to revoking the token`);
  }
}

export async function runToken({
  mode = '',
  keyToken = '',
  keyAppSlug = '',
  keyOutcome = '',
  unreached = false,
  grant,
  owner = '',
  job = '',
  api = API,
  notice = (_said) => {},
  warn = (_said) => {},
  ...asking
}) {
  if (mode === 'cp') {
    const minted = await mintRun({ ...asking, grant, owner, job, ...(unreached ? { delays: [] } : {}) });
    notice(`ksai asked the control plane for its ${grant} token, because this run is on run_tokens: cp`);
    return { token: minted.token, appSlug: minted.appSlug, revokeAfter: true };
  }

  if (keyOutcome !== 'success') {
    throw new Refused(`the App key minted no ${grant} token, so read the step above for what GitHub answered`);
  }

  if (mode === 'shadow') {
    try {
      const minted = await mintRun({ ...asking, grant, owner, job, delays: [] });
      try {
        await revoke({ token: minted.token, api, fetch: asking.fetch });
        notice(`ksai shadowed its ${grant} token: the control plane served one, and it was revoked unused`);
      } catch (unrevoked) {
        warn(`ksai shadowed its ${grant} token and could not revoke what the control plane served, so it lapses on its own: ${because(unrevoked)}`);
      }
    } catch (refused) {
      warn(`ksai shadowed its ${grant} token and the control plane served none: ${because(refused)}`);
    }
  }

  return { token: keyToken, appSlug: keyAppSlug, revokeAfter: false };
}
