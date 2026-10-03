import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleeping } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { retryAfterMs } from '../kreview/federated-token.mjs';

const require = createRequire(import.meta.url);
const { answered, reachedFor, OUTCOME_HEADER } = require('../lib/control-plane.cjs');
const { ceilingMinutes, wholeNumber } = require('../lib/watchdog.cjs');
const { counted } = require('../lib/text.cjs');

export const COMMIT_TIMEOUT = 90_000;
export const SIGN_IN_WAIT = 15 * 60_000;
export const COMMIT_WAIT_LIMIT = SIGN_IN_WAIT + 3 * COMMIT_TIMEOUT;
const SIGN_IN_MARGIN = 5 * 60_000;
const SIGN_IN_POLL = 20_000;
const SHORTEST_SIGN_IN_WAIT = 60_000;
const SHORTEST_BACKOFF = 1_000;

const AWAITING_SIGN_IN = 'awaiting_sign_in';
const SIGN_IN_REQUIRED = 'sign_in_required';
const CONTROL_PLANE_ONLY_HEADER = 'X-Ksai-Control-Plane-Only';

const OID = /^[0-9a-f]{40}$/;

const text = (value) => (typeof value === 'string' ? value : '');

const maskOnStderr = (token) => process.stderr.write(`::add-mask::${token}\n`);

const noteOnStderr = (line) => process.stderr.write(`${line}\n`);

export const fallsBack = (input) =>
  !input.merge && !input.controlPlaneOnly && (input.fileChanges?.additions ?? []).every((one) => one.mode === undefined);

export function signInDeadline(env, now) {
  const started = wholeNumber(env.KSAI_JOB_STARTED_MS);
  const asked = String(env.JOB_TIMEOUT_MINUTES ?? '').trim();
  const minutes = asked === '0' ? null : ceilingMinutes(asked);
  if (!started || minutes === null) return now;
  return Math.max(now, Math.min(now + SIGN_IN_WAIT, started + minutes * 60_000 - SIGN_IN_MARGIN));
}

async function askOnce({ input, env, fetch, timeout, secret, until, now, awaited }) {
  const reached = await reachedFor({ env, fetch, timeout, secret });
  if (reached.why) return { why: reached.why };

  const { controlPlaneOnly, ...commit } = input;
  const asked = { ...commit, job: text(env.GITHUB_JOB) };
  const wait = until === null ? 0 : until - now();
  if (wait > 0) asked.awaitSignIn = Math.ceil(wait / 1000);
  if (awaited) asked.awaitedSignIn = true;
  return answered(fetch, `${reached.base}/run/commit`, {
    token: reached.token,
    headers: controlPlaneOnly ? { [CONTROL_PLANE_ONLY_HEADER]: 'true' } : {},
    body: JSON.stringify(asked),
    timeout,
    signal: reached.signal,
    said: true,
  });
}

export async function askToCommit({
  input, env = process.env, fetch = globalThis.fetch, timeout = COMMIT_TIMEOUT, secret = maskOnStderr,
  now = Date.now, sleep = sleeping, note = noteOnStderr,
}) {
  const until = signInDeadline(env, now());
  let offered = false;
  let awaited = false;
  let said;
  for (;;) {
    const wait = Math.max(0, until - now());
    said = await askOnce({ input, env, fetch, timeout, secret, until: offered ? until : null, now, awaited });
    const outcome = said.headers?.get(OUTCOME_HEADER);
    if (!said.why || wait <= 0) break;
    const left = Math.max(0, until - now());
    const told = said.headers ? retryAfterMs(said.headers, now) : null;
    const backoff = Math.min(Math.max(told ?? SIGN_IN_POLL, SHORTEST_BACKOFF), left);
    const retryable = said.status === undefined || said.status === 408 || said.status === 429 || said.status >= 500;
    if (left > 0 && retryable && !outcome && (offered || awaited)) {
      await sleep(backoff);
      continue;
    }
    if (outcome === SIGN_IN_REQUIRED && !offered && left >= SHORTEST_SIGN_IN_WAIT) {
      offered = true;
      continue;
    }
    if (outcome !== AWAITING_SIGN_IN) break;
    if (!awaited) {
      const minutes = Math.max(1, Math.ceil(left / 60_000));
      const then = fallsBack(input) ? 'KSAI commits as itself' : 'the run stops without committing';
      note(`note: ${said.why}. The run waits up to ${counted(minutes, 'minute')}, then ${then}`);
    }
    offered = true;
    awaited = true;
    await sleep(backoff);
  }
  if (said.why) return { why: said.why };

  const { oid, tree, signature, author } = said.answer ?? {};
  if (!OID.test(text(oid)) || text(tree) === '' || text(signature) === '' || text(author) === '') {
    return { why: 'the control plane answered a commit this could not read' };
  }
  return { commit: { oid, tree: { oid: tree }, signature: { state: signature } }, author };
}

export async function main(argv = process.argv, env = process.env, fetch = globalThis.fetch) {
  let input;
  try {
    input = JSON.parse(readFileSync(argv[2], 'utf8'))?.variables?.input;
  } catch {
    input = null;
  }
  const said = input ? await askToCommit({ input, env, fetch }) : { why: 'the commit to ask for could not be read' };
  process.stdout.write(`${JSON.stringify(said)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
