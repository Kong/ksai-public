import { createHash } from 'node:crypto';

import { admitReviewDeadline, reviewMinuteBudget } from '../../scripts/lib/review-deadline.mjs';

const RECORD_ID = /^[0-9a-f]{32}$/;

export const TIMEOUT = 10000;

export const DELAYS = Object.freeze([2000, 4000, 8000, 15000, 30000, 30000]);

export const BUDGET = 150000;

const STAGE_RECORD_VERSION = 'ksai.konghq.com/stage-record/v1alpha1';

const STAGE_EXECUTION = 'stage';

const STAGE_JOB = /^job_[0-9a-f]{32}$/;

const STAGE_INSTANCE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\[(?:0|[1-9][0-9]*)\])?$/;

const STAGE_LEASE = /^[\w.-]{1,128}$/;

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const COMMIT = /^[0-9a-f]{40}$/;

const COUNT = /^[1-9][0-9]{0,18}$/;

const DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const MINUTE = 60_000;

const TOLD_MAX = 300;

const STEERING_MAX = 1 << 20;

const STEERING_DIGEST = /^sha256:[0-9a-f]{64}$/;

const NO_RECORD_HEADER = 'Ksai-No-Record';

const WRITE_PROFILE = 'workflow-write';

const PREPARABLE = Object.freeze(['tools', 'dependencies']);

const WHY_STATUS = Object.freeze({
  401: 'the control plane did not accept this run token',
  403: 'the control plane refused this run',
  404: 'the control plane has no dispatch record for this run',
  503: 'the control plane has not bound this dispatch record yet',
});

const NO_RECORD = Object.freeze({ read: false });

const shaped = (value, shape) => typeof value === 'string' && shape.test(value);

const stopped = (why) => new Error(`${why} - so this run starts nothing`);

const policyStopped = (why) => Object.assign(stopped(why), { code: 'security_policy_refused' });

export const isPolicyRefusal = (error) => error?.code === 'security_policy_refused';

const pullOf = (subject) =>
  (subject?.type === 'pull-request' && Number.isSafeInteger(subject.number) && subject.number > 0
    ? String(subject.number)
    : '');

function budgetOf(deadline, at) {
  if (deadline === undefined) return { stageMinutes: '', stageJobMinutes: '' };
  const due = typeof deadline === 'string' && DEADLINE.test(deadline) ? Date.parse(deadline) : Number.NaN;
  if (!Number.isFinite(due)) throw policyStopped('the record names a stage deadline that is not a UTC time');
  const left = Math.floor((due - at) / MINUTE);
  if (left < 5) throw stopped(`the stage's attempt is reaped in ${Math.max(0, left)} minutes, too few to run it`);
  return { stageMinutes: String(left - 3), stageJobMinutes: String(left - 1) };
}

function preparationOf(prepare, profile) {
  if (prepare === undefined) return { prepareTools: '', prepareDependencies: '' };
  const named = typeof prepare === 'string' ? prepare.split(',') : [];
  if (named.length === 0 || named.some((one) => !PREPARABLE.includes(one)) || new Set(named).size !== named.length) {
    throw policyStopped('the record names something to prepare that a stage cannot prepare');
  }
  if (profile !== WRITE_PROFILE) throw policyStopped('the record names something to prepare for a stage that does not write');
  return {
    prepareTools: named.includes('tools') ? 'true' : '',
    prepareDependencies: named.includes('dependencies') ? 'true' : '',
  };
}

function mergeOf(base, profile) {
  if (base === undefined) return '';
  if (!shaped(base, COMMIT)) throw policyStopped('the record names a merge base that is not a whole commit');
  if (profile !== WRITE_PROFILE) throw policyStopped('the record names a merge base for a stage that does not write');
  return base;
}

function recordFrom(served, at) {
  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    throw policyStopped('the control plane answered something other than a record');
  }

  const {
    record_id: recordId,
    workflow_execution: execution,
    workflow_record: written,
    workflow_job: job,
    workflow_instance: instance,
    workflow_attempt: tried,
    workflow_lease: lease,
    workflow_deadline: deadline,
    workflow_steering: workflowSteering,
    workflow_steering_sha256: workflowSteeringDigest,
    issue_number: issueNumber,
    work_ref: workRef,
    plan_path: planPath,
    changeset_max_bytes: changesetMaxBytes,
    changeset_max_files: changesetMaxFiles,
    prepare,
    profile,
    merge_base: mergeBase,
  } = /** @type {Record<string, unknown>} */ (served);
  for (const bound of [changesetMaxBytes, changesetMaxFiles]) {
    if (bound !== undefined && (!shaped(bound, COUNT) || !Number.isSafeInteger(Number(bound)))) {
      throw policyStopped('the record bounds a stage\'s change with something other than a count');
    }
  }
  const preparation = preparationOf(prepare, profile);
  const merging = mergeOf(mergeBase, profile);

  if (!shaped(recordId, RECORD_ID)) {
    throw policyStopped('the record does not name the control-plane decision that started this run');
  }
  if (execution !== STAGE_EXECUTION) {
    throw policyStopped('the record does not dispatch a package stage');
  }
  if (!shaped(job, STAGE_JOB) || !shaped(instance, STAGE_INSTANCE) || !shaped(lease, STAGE_LEASE)
    || !shaped(tried, COUNT) || !Number.isSafeInteger(Number(tried))) {
    throw policyStopped('the record dispatches a package stage it does not fully name');
  }

  let record;
  try {
    record = typeof written === 'string' ? JSON.parse(written) : null;
  } catch {
    record = null;
  }
  const revision = record?.job?.sourceRevision;
  if (record?.apiVersion !== STAGE_RECORD_VERSION || typeof revision !== 'string' || !REVISION.test(revision)) {
    throw policyStopped('the record dispatches a package stage its stage record does not describe');
  }
  const hasSteering = typeof workflowSteering === 'string' && workflowSteering !== '';
  const hasSteeringDigest = typeof workflowSteeringDigest === 'string' && workflowSteeringDigest !== '';
  if (!hasSteering || !hasSteeringDigest) {
    throw policyStopped('the record carries an incomplete workflow steering decision');
  }
  const bytes = Buffer.from(workflowSteering, 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let envelope;
  try {
    envelope = JSON.parse(workflowSteering);
  } catch {
    envelope = null;
  }
  if (bytes.length > STEERING_MAX || envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || !STEERING_DIGEST.test(workflowSteeringDigest) || digest !== workflowSteeringDigest) {
    throw policyStopped('the record carries workflow steering bytes that do not match their digest');
  }

  let reviewAdmission;
  try {
    reviewAdmission = admitReviewDeadline(served, record, envelope, at);
  } catch (error) {
    throw policyStopped(error.message);
  }

  return {
    read: true,
    recordId,
    workflowJob: job,
    workflowInstance: instance,
    workflowAttempt: tried,
    workflowLease: lease,
    sourceRevision: revision,
    stagePull: pullOf(record.job.subject),
    workflowSteering,
    workflowSteeringDigest,
    stageIssue: typeof issueNumber === 'string' ? issueNumber : '',
    stageWorkRef: typeof workRef === 'string' ? workRef : '',
    planPath: typeof planPath === 'string' ? planPath : '',
    changesetMaxBytes: changesetMaxBytes ?? '',
    changesetMaxFiles: changesetMaxFiles ?? '',
    mergeBase: merging,
    ...preparation,
    ...(reviewAdmission ? {
      reviewAdmission: JSON.stringify(reviewAdmission),
      ...reviewMinuteBudget(reviewAdmission, at),
    } : budgetOf(deadline, at)),
  };
}

const passing = (status) => status === 408 || status === 429 || status >= 500;

const rest = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const release = (answer) => Promise.resolve().then(() => answer.body?.cancel()).catch(() => {});

const told = (answer) =>
  Promise.resolve()
    .then(() => answer.text())
    .then((said) => (typeof said === 'string' ? said : '').replace(/\s+/g, ' ').trim().slice(0, TOLD_MAX), () => '')
    .then((said) => said || 'it said nothing');

function baseOf(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return '';
  }
  const bare = url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
  return bare ? `${url.origin}${url.pathname}`.replace(/\/+$/, '') : '';
}

function waitAsked(answer) {
  const header = (answer.headers?.get('retry-after') ?? '').trim();
  return /^\d+$/.test(header) ? Number(header) * 1000 : null;
}

function because(thrown) {
  const cause = thrown instanceof Error && thrown.cause instanceof Error ? thrown.cause : null;
  const coded = /** @type {{ code?: unknown }} */ (cause ?? {}).code;
  const said = (typeof coded === 'string' && coded) || cause?.message
    || (thrown instanceof Error ? thrown.message : '');
  return said || 'it said nothing';
}

async function attempt({ url, audience, mint, secret, fetch, timeout, named = false }) {
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
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (unreached) {
    return { retry: `the control plane could not be reached: ${because(unreached)}`, asked: null };
  }

  const why = WHY_STATUS[/** @type {401|403|404|503} */ (answer.status)]
    ?? `the control plane answered ${answer.status}`;
  if (passing(answer.status)) {
    await release(answer);
    return { retry: why, asked: waitAsked(answer) };
  }
  if (answer.status === 403) throw stopped(`${why}: ${await told(answer)}`);
  if (answer.status === 404) {
    const mine = answer.headers?.get?.(NO_RECORD_HEADER) === '1';
    await release(answer);
    if (mine || named) return { none: true };
    throw stopped(why);
  }
  if (!answer.ok) {
    await release(answer);
    throw stopped(why);
  }

  try {
    return { served: await answer.json() };
  } catch (unparsed) {
    return { retry: `the control plane answered with a body that did not parse: ${because(unparsed)}`, asked: null };
  }
}

/** Report one authenticated, body-free policy refusal without changing the original failure. */
export async function reportPolicyRefusal({ endpoint, audience, mint, secret, fetch = globalThis.fetch }) {
  const base = baseOf(endpoint);
  if (base === '') return false;
  const token = await mint(audience);
  if (typeof token !== 'string' || token === '') return false;
  secret(token);
  const answer = await fetch(`${base}/v1/run/security-refusal`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  await release(answer);
  return answer.ok;
}

/**
 * @param {{
 *   endpoint?: string,
 *   audience?: string,
 *   named?: boolean,
 *   env?: Record<string, string | undefined>,
 *   mint: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 *   delays?: readonly number[],
 *   sleep?: (ms: number) => Promise<void>,
 *   note?: (why: string, wait: number) => void,
 *   budget?: number,
 *   now?: () => number,
 * }} asked
 */
export async function readRecord({
  endpoint = '',
  audience = 'ksai-cp',
  named = false,
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = TIMEOUT,
  delays = DELAYS,
  sleep = rest,
  note = () => {},
  budget = BUDGET,
  now = Date.now,
}) {
  if (endpoint === '') return NO_RECORD;
  const base = baseOf(endpoint);
  if (base === '') throw stopped('the control plane endpoint is not a bare https URL');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw stopped('this job holds no id-token: write, so it cannot say which run it is');
  }

  const asked = { url: `${base}/v1/run`, audience, mint, secret, fetch, named };
  const longest = Math.max(0, ...delays);
  const started = now();
  const tries = async (left) => {
    const elapsed = now() - started;
    if (elapsed >= budget) throw stopped(`the ${Math.round(budget / 1000)}s allowed to read the record ran out`);
    const outcome = await attempt({ ...asked, timeout: Math.max(1, Math.min(timeout, budget - elapsed)) });
    if ('none' in outcome) return NO_RECORD;
    if ('served' in outcome) return recordFrom(outcome.served, now());
    if (left.length === 0) {
      throw stopped(`${outcome.retry}, on the last of ${delays.length + 1} attempts`);
    }
    const wait = Math.min(Math.max(left[0], outcome.asked ?? 0), longest);
    if (now() - started + wait >= budget) {
      throw stopped(`${outcome.retry}, and the ${Math.round(budget / 1000)}s allowed to read the record ran out`);
    }
    note(outcome.retry, wait);
    await sleep(wait);
    return tries(left.slice(1));
  };
  return tries(delays);
}
