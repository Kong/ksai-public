'use strict';

const { effortBounds, writeEvidence } = require('./write-triage.cjs');
const {
  ALLOWED_EFFORTS,
  MODEL_SHAPE,
  parseAllowedModels,
  defaultEffortFor,
} = require('../lib/select-arm.cjs');

const API_VERSION = 'triage/v1';

const RECORD_SHAPE = /^[0-9a-f]{32}$/;

const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$/;

const MAX_MODELS = 16;

const MAX_REASON_BYTES = 1024;

const VERDICTS = Object.freeze(['routine', 'uncertain', 'critical', 'small', 'planned']);

const PLAN_MODES = Object.freeze(['auto', 'always', 'never']);

const SOURCES = Object.freeze(['input', 'comment', 'triage', 'fallback']);

const RUNNER_VERDICT = Object.freeze(
  Object.assign(Object.create(null), { planned: 'planning' }),
);

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

function holds(models, one) {
  const wanted = String(one ?? '').trim().toLowerCase();
  return wanted !== '' && models.some((held) => held.toLowerCase() === wanted);
}

/**
 * capabilityModels offers exactly what `controlPlaneArm` will take back: the
 * allowed models where a caller pinned any, and the configured model alone where
 * it pinned none. Offering a model the re-check refuses buys a decision this run
 * announces and then drops.
 */
function capabilityModels(env, configured) {
  const allowed = parseAllowedModels(env.ALLOWED_MODELS);
  const kept = [];
  for (const model of allowed.length === 0 ? [configured] : allowed) {
    const one = String(model ?? '').trim();
    if (one !== '' && NAME_SHAPE.test(one) && !holds(kept, one)) kept.push(one);
  }
  return kept.slice(0, MAX_MODELS);
}

function effortIn(value) {
  const named = String(value ?? '').trim();
  return ALLOWED_EFFORTS.includes(named) ? named : '';
}

/** writeTriageRequest builds the bounded request the control plane decides from. */
function writeTriageRequest(env = process.env) {
  const triage = String(env.TRIAGE ?? '').trim();
  if (triage === 'off') return { error: 'write triage is off, so this run keeps the arm it resolved' };
  if (triage !== 'auto') return { error: 'triage is neither auto nor off' };

  const record = String(env.RECORD_ID ?? '').trim().toLowerCase();
  const runHead = String(env.RUN_HEAD_SHA ?? '').trim().toLowerCase();
  const head = String(env.HEAD_SHA ?? '').trim().toLowerCase();
  if (!RECORD_SHAPE.test(record)) return { error: 'this run carries no control-plane record' };
  if (!COMMIT_SHAPE.test(runHead) || !COMMIT_SHAPE.test(head)) {
    return { error: 'this run carries no head to bind a decision to' };
  }

  const configured = String(env.DEFAULT_MODEL ?? '').trim();
  if (!MODEL_SHAPE.test(configured)) return { error: 'this run carries no configured model' };
  const configuredEffort = effortIn(env.DEFAULT_EFFORT) || defaultEffortFor(configured);
  if (configuredEffort === '') return { error: 'this run carries no configured effort' };

  const models = capabilityModels(env, configured);
  const commentModel = String(env.MODEL_SOURCE ?? '') === 'comment' ? String(env.EARLY_MODEL ?? '').trim() : '';
  if (commentModel !== '' && !holds(models, commentModel)) {
    return { error: 'the comment named a model this run cannot declare' };
  }

  const evidence = writeEvidence(env);
  if (evidence.pull_request === 0 && evidence.issue_number === 0 && evidence.work_ref === '') {
    return { error: 'this run names nothing a decision can be bound to' };
  }

  return {
    body: {
      api_version: API_VERSION,
      record_id: record,
      run_head_sha: runHead,
      head_sha: head,
      capabilities: { reviewer_skills: [], models },
      enforcement: {
        triage,
        configured_model: configured,
        configured_effort: configuredEffort,
        comment_model: commentModel,
        comment_effort: String(env.EFFORT_SOURCE ?? '') === 'comment' ? effortIn(env.EARLY_EFFORT) : '',
        minimum_effort: effortIn(env.MIN_EFFORT),
        maximum_effort: effortIn(env.MAX_EFFORT),
      },
      evidence,
    },
  };
}

/**
 * withinBounds asks the selector's own question, through the selector's own rule:
 * an unpinned floor is `medium` and an unpinned ceiling is the run's default
 * effort, not unbounded. Answering a wider question here accepted efforts
 * `controlPlaneArm` then refused, and the step said the control plane had
 * decided a write the run went on to decide itself.
 */
function withinBounds(effort, bounds, model) {
  const checked = effortBounds({
    fallback: String(bounds?.fallback ?? '').trim() || defaultEffortFor(model),
    max: bounds?.max,
    min: bounds?.min,
  });
  const at = ALLOWED_EFFORTS.indexOf(effort);
  if (!checked || at < 0) return false;
  return at >= ALLOWED_EFFORTS.indexOf(checked.floor) && at <= ALLOWED_EFFORTS.indexOf(checked.ceiling);
}

/**
 * readDecision answers what the control plane decided, or why this run will not act on it.
 *
 * @param {unknown} answer
 * @param {ReturnType<typeof writeTriageRequest>['body']} request
 * @param {{ min?: string, max?: string, fallback?: string }} [bounds]
 */
function readDecision(answer, request, bounds) {
  if (answer === null || typeof answer !== 'object') return { why: 'the control plane answered nothing' };
  const said = /** @type {Record<string, unknown>} */ (answer);
  if (said.api_version !== API_VERSION) return { why: 'the control plane answered another contract' };
  for (const field of ['policy_version', 'evidence_revision', 'request_id']) {
    const value = said[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return { why: `the control plane bound no ${field.replace(/_/g, ' ')} to its decision` };
    }
  }
  if (typeof said.head_sha !== 'string' || said.head_sha.toLowerCase() !== request.head_sha) {
    return { why: 'the control plane decided against another head' };
  }
  if (typeof said.verdict !== 'string' || !VERDICTS.includes(said.verdict)) {
    return { why: 'the control plane answered a verdict this run does not know' };
  }
  if (typeof said.model !== 'string' || !holds(request.capabilities.models, said.model)) {
    return { why: 'the control plane chose a model this run did not offer' };
  }
  if (typeof said.effort !== 'string' || !withinBounds(said.effort, bounds, said.model)) {
    return { why: 'the control plane chose an effort outside this run bounds' };
  }
  if (typeof said.plan_mode !== 'string' || !PLAN_MODES.includes(said.plan_mode)) {
    return { why: 'the control plane answered a plan mode this run does not know' };
  }
  for (const field of ['model_source', 'effort_source']) {
    const value = said[field];
    if (typeof value !== 'string' || !SOURCES.includes(value)) {
      return { why: `the control plane named no ${field.replace(/_/g, ' ')}` };
    }
  }
  const reason = typeof said.reason === 'string' ? said.reason.trim() : '';
  if (reason === '' || Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES) {
    return { why: 'the control plane gave no readable reason' };
  }

  return {
    decision: {
      verdict: RUNNER_VERDICT[said.verdict] ?? said.verdict,
      reason,
      model: said.model,
      effort: said.effort,
      plan_mode: said.plan_mode,
      model_source: said.model_source,
      effort_source: said.effort_source,
    },
  };
}

/**
 * decideWrite asks the control plane for this run's write profile.
 *
 * Every failure is this run keeping the profile it would have chosen on its own,
 * because a control plane that is down, slow, or answering something this action
 * will not act on costs the run nothing it was not already going to spend.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   mint?: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 * }} asked
 */
async function decideWrite({
  env = process.env,
  mint = async () => '',
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = 30000,
} = {}) {
  const kept = (why) => ({ decided: false, why });

  if (String(env.TRIAGE_WRITE ?? '').trim() !== 'cp') return kept('');
  const endpoint = String(env.ENDPOINT ?? '').trim();
  if (endpoint === '') return kept('no control plane serves this repository');
  if (!bare(endpoint)) return kept('the control plane endpoint is not a bare https URL');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return kept('this job holds no id-token: write, so it cannot say which repository it is');
  }

  const { body, error } = writeTriageRequest(env);
  if (error) return kept(error);

  let token = '';
  try {
    token = await mint(String(env.AUDIENCE ?? '').trim() || 'ksai-cp');
  } catch {
    return kept('the OIDC token could not be minted');
  }
  if (typeof token !== 'string' || token === '') return kept('the OIDC token endpoint answered with no token');
  secret(token);

  let answer;
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/triage/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 409) return kept('the evidence this run sent is no longer current');
    if (!response.ok) return kept('the control plane did not decide this run');
    answer = await response.json();
  } catch {
    return kept('the control plane did not decide this run');
  }

  const { decision, why } = readDecision(answer, body, {
    fallback: String(env.DEFAULT_EFFORT ?? env.EARLY_EFFORT ?? ''),
    max: env.MAX_EFFORT,
    min: env.MIN_EFFORT,
  });
  if (!decision) return kept(why);

  return { decided: true, why: '', ...decision };
}

module.exports = {
  API_VERSION,
  VERDICTS,
  decideWrite,
  readDecision,
  writeTriageRequest,
};
