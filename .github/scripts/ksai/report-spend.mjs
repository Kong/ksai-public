import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ATTEMPT_ID_SHAPE, compactJob } = require('../lib/write-record.cjs');
const { bareEndpoint } = require('./control-plane.cjs');

function attemptOf(raw) {
  const parts = String(raw).trim().split(':');
  if (parts.length !== 4) return '';
  const [runId, runAttempt, job, jobIndex] = parts;
  const id = [runId, runAttempt, compactJob(job), jobIndex].join(':');
  return ATTEMPT_ID_SHAPE.test(id) ? id : '';
}

const MAX_USD = 1000;

const TALLY = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
]);

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

export function tallyOf(usage) {
  if (usage === null || typeof usage !== 'object') return null;

  const held = {};
  let counted = false;
  for (const name of TALLY) {
    const value = Number(usage[name] ?? 0);
    if (!Number.isFinite(value) || value < 0) return null;
    held[name] = Math.round(value);
    if (held[name] > 0) counted = true;
  }

  return counted ? held : null;
}

export const ATTEMPTS = 3;

export const TIMEOUT = 10000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function reportSpend({
  endpoint = '',
  audience = 'ksai-cp',
  attempt = '',
  cost = '',
  model = '',
  usage = null,
  env = process.env,
  mint = async (_audience = '') => '',
  secret = (_token = '') => {},
  fetch: call = fetch,
  pause = wait,
  timeout = TIMEOUT,
} = {}) {
  const named = String(endpoint).trim();
  if (named === '') return { reported: false, why: '' };
  if (!bareEndpoint(named)) return { reported: false, why: 'the endpoint is not a bare https URL' };

  const piece = attemptOf(attempt);
  if (piece === '') {
    return { reported: false, why: 'this job could not name the piece of work it is reporting' };
  }

  const spelled = String(model).trim();
  const tally = MODEL.test(spelled) ? tallyOf(usage) : null;

  const said = String(cost).trim();
  const usd = said === '' ? Number.NaN : Number(said);
  const priced = Number.isFinite(usd) && usd >= 0 && usd <= MAX_USD;
  if (tally === null && !priced) {
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
  const body = JSON.stringify(
    tally === null
      ? { attempt: piece, cost_usd: usd }
      : { attempt: piece, model: spelled, usage: tally },
  );

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
    } catch (unreached) {
      last = `the control plane could not be reached: ${unreached?.cause?.code || unreached?.message || 'it said nothing'}`;
      continue;
    }

    if (answer.ok) return { reported: true, why: '' };
    if (answer.status < 500) return { reported: false, why: `the control plane refused this report with ${answer.status}` };
    last = `the control plane answered ${answer.status}`;
  }
  return { reported: false, why: last };
}
