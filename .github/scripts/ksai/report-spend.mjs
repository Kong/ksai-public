import { createRequire } from 'node:module';

const { ATTEMPT_ID_SHAPE, compactJob } = createRequire(import.meta.url)('../lib/write-record.cjs');

function attemptOf(raw) {
  const parts = String(raw).trim().split(':');
  if (parts.length !== 4) return '';
  const [runId, runAttempt, job, jobIndex] = parts;
  const id = [runId, runAttempt, compactJob(job), jobIndex].join(':');
  return ATTEMPT_ID_SHAPE.test(id) ? id : '';
}

const MAX_USD = 1000;

export const ATTEMPTS = 3;

export const TIMEOUT = 10000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

export async function reportSpend({
  endpoint = '',
  audience = 'ksai-cp',
  attempt = '',
  cost = '',
  env = process.env,
  mint = async (_audience = '') => '',
  secret = (_token = '') => {},
  fetch: call = fetch,
  pause = wait,
  timeout = TIMEOUT,
} = {}) {
  const named = String(endpoint).trim();
  if (named === '') return { reported: false, why: '' };
  if (!bare(named)) return { reported: false, why: 'the endpoint is not a bare https URL' };

  const piece = attemptOf(attempt);
  if (piece === '') {
    return { reported: false, why: 'this job could not name the piece of work it is reporting' };
  }

  const said = String(cost).trim();
  const usd = said === '' ? Number.NaN : Number(said);
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    return { reported: false, why: 'this run measured no cost it could pass on' };
  }

  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { reported: false, why: 'this job holds no id-token: write, so it cannot name itself' };
  }

  let token = '';
  try {
    token = String((await mint(audience)) ?? '');
  } catch {
    return { reported: false, why: 'a token for the control plane could not be minted' };
  }
  if (token === '') return { reported: false, why: 'the token endpoint answered with no token' };
  secret(token);

  const at = `${named.replace(/\/+$/, '')}/spend`;
  const body = JSON.stringify({ attempt: piece, cost_usd: usd });

  let last = '';
  for (let tries = 0; tries < ATTEMPTS; tries += 1) {
    if (tries > 0) await pause(2 ** tries * 1000);

    let answer;
    try {
      answer = await call(at, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      last = 'the control plane could not be reached';
      continue;
    }

    if (answer.ok) return { reported: true, why: '' };
    if (answer.status < 500) return { reported: false, why: `the control plane refused this report with ${answer.status}` };
    last = `the control plane answered ${answer.status}`;
  }
  return { reported: false, why: last };
}
