import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import controlPlane from '../../lib/control-plane.cjs';
import { canonicalJson, parseIJson } from '../../lib/json.cjs';
import { runMain } from '../../lib/main.mjs';
import { keepMarker, unkeptWarning } from '../../lib/keep-work.mjs';
import { BASE_SHA_FIELD, DEADLINES_MODE, ENGINE_STOP_MS, FAILURES, HOST_EXIT_MARGIN_MS, PROFILE, UNVERIFIED_ANSWER, factsFileOf, harnessDeadlines, modelLaunchRefused, setupTreeOf, stateDirOf,
  stateFileOf, stepFailure, validatePlan } from '../harness/contract.mjs';
import { WRITE_PROFILE, captureChangeset, stepOutputsOf, uploadChangeset } from './changeset.mjs';

const { answeredRetrying, held, holdsFor, mask, reachedFor } = controlPlane;

export const COMPLETION_SCHEMA = JSON.parse(readFileSync(new URL('../../lib/stage-contract/stage-completion.schema.json', import.meta.url), 'utf8'));
const COMPLETION_VERSION = COMPLETION_SCHEMA.properties.apiVersion.const;
const FENCED = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/;
const OPENED = /\n(?=[ \t]*(?:[{[]|```))/g;
const MAX_FAILURE_BYTES = COMPLETION_SCHEMA.properties.failure.maxLength;
const TOO_LARGE = 413;
const MALFORMED = 400;
const TIMEOUT_MS = 30_000;
const COMPLETION_MINT_MS = 300_000;
const JOB_END_RESERVE_MS = 60_000;
const MIN_REQUEST_MS = 5000;

const CANDIDATE_VERSION = 'ksai.konghq.com/stage-candidate/v1alpha1';

const said = (value) => String(value ?? '').trim();
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const withinBytes = (value, limit) => {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
};

function finalResult(raw) {
  let log;
  try {
    log = JSON.parse(String(raw ?? ''));
  } catch {
    return { result: null, why: 'left no readable execution log' };
  }
  if (!Array.isArray(log)) return { result: null, why: 'run wrote no message list' };
  const result = log.findLast((entry) => entry?.type === 'result') ?? null;
  return result ? { result, why: '' } : { result: null, why: 'run wrote no result' };
}

function candidateEnvelope(candidate) {
  if (!object(candidate) || candidate.apiVersion !== CANDIDATE_VERSION
    || !Object.hasOwn(candidate, 'output') || !Array.isArray(candidate.artifacts)) {
    throw new Error('stage candidate version or artifacts are invalid');
  }
}

function asEnvelope(answered) {
  let candidate = answered;
  if (object(candidate) && object(candidate.output) && candidate.output.apiVersion === CANDIDATE_VERSION
    && object(candidate.output.output)) {
    candidate = {
      ...candidate,
      output: candidate.output.output,
      artifacts: Array.isArray(candidate.output.artifacts) ? candidate.output.artifacts : candidate.artifacts,
    };
  }
  if (object(candidate) && !Object.hasOwn(candidate, 'output') && Object.hasOwn(candidate, 'apiVersion')) {
    const { artifacts, ...output } = candidate;
    candidate = Array.isArray(artifacts) && artifacts.length === 0
      ? { apiVersion: CANDIDATE_VERSION, output, artifacts }
      : { apiVersion: CANDIDATE_VERSION, output: candidate, artifacts: [] };
  }
  return candidate;
}

export function stageOf(env) {
  const stage = {
    job: said(env.WORKFLOW_JOB), instance: said(env.WORKFLOW_INSTANCE),
    attempt: Number(said(env.WORKFLOW_ATTEMPT)), lease: said(env.WORKFLOW_LEASE),
  };
  if (!stage.job || !stage.instance || !Number.isSafeInteger(stage.attempt) || stage.attempt < 1 || !stage.lease) {
    throw new Error('dispatch record does not name a package stage attempt to complete');
  }
  return stage;
}

function parsedTail(tail) {
  try {
    return { candidate: parseIJson(FENCED.exec(tail)?.[1] ?? tail, 'stage candidate') };
  } catch {
    return null;
  }
}

function answeredCandidate(text) {
  for (const at of [0, ...Array.from(text.matchAll(OPENED), (line) => line.index + 1)]) {
    const read = parsedTail(text.slice(at).trim());
    if (read) return read.candidate;
  }
  throw new Error('stage answer is not a JSON stage candidate');
}

export function outputOf(answer) {
  let candidate = answeredCandidate(said(answer));
  if (Array.isArray(candidate) && candidate.length === 1) [candidate] = candidate;
  candidate = asEnvelope(candidate);
  if (object(candidate) && !Object.hasOwn(candidate, 'artifacts') && object(candidate.output) &&
    Array.isArray(candidate.output.artifacts) && candidate.output.artifacts.length === 0) {
    const { artifacts, ...output } = candidate.output;
    candidate = { ...candidate, output, artifacts };
  }
  let enveloped = true;
  try {
    candidateEnvelope(candidate);
  } catch {
    enveloped = false;
  }
  if (!enveloped || !object(candidate.output) || candidate.artifacts.length) {
    throw new Error('stage answer is not a single stage candidate without artifacts');
  }
  return candidate.output;
}

function ended(stage, status, reason) {
  return {
    apiVersion: COMPLETION_VERSION, ...stage, status,
    failure: withinBytes(said(reason).replace(/\s+/g, ' ') || 'no failure reason given', MAX_FAILURE_BYTES),
  };
}

function beforeModel(model, tools) {
  if (said(model) !== 'skipped') return '';
  return said(tools) === 'failure' ? 'stage tools install failed, the model did not run' : 'the stage stopped before its model ran';
}

export function completionOf(stage, { conclusion, execution, notice, unmerged = '', model = '', tools = '' }) {
  const failed = (reason) => ended(stage, 'failed', reason);
  if (said(conclusion) === 'cancelled') return ended(stage, 'cancelled', 'the run executing the stage was cancelled');
  if (said(unmerged) !== '') return failed(`merging the base into the checkout failed: ${said(unmerged)}`);
  if (said(notice) !== '') {
    const output = { status: 'skipped', summary: said(notice) };
    return {
      apiVersion: COMPLETION_VERSION,
      ...stage,
      status: 'succeeded',
      result_digest: `sha256:${sha256(canonicalJson(output))}`,
      output,
    };
  }
  const { result, why } = finalResult(execution);
  if (!result) return failed(beforeModel(model, tools) || `the model ${why}`);
  if (said(conclusion) !== 'success' || result.is_error) {
    return failed(result.stop_reason || `the model run concluded ${said(conclusion) || 'nothing'}`);
  }
  let output;
  try {
    output = outputOf(result.result);
  } catch (error) {
    return failed(error.message);
  }
  return { apiVersion: COMPLETION_VERSION, ...stage, status: 'succeeded', result_digest: `sha256:${sha256(canonicalJson(output))}`, output };
}

function keepAsked(env) {
  const marker = keepMarker(env);
  return marker !== '' && existsSync(marker);
}

export async function withChangeset(completion, stage, env, {
  reached, fetch, pause, capture = captureChangeset, upload = uploadChangeset, git = null, kept = keepAsked,
  warn = unkeptWarning,
}) {
  if (said(env.STAGE_PROFILE) !== WRITE_PROFILE) return completion;
  const keeping = completion.status !== 'succeeded' && kept(env);
  if (completion.status !== 'succeeded' && !keeping) return completion;
  try {
    if (!said(env.RUNNER_TEMP) || !said(env.GITHUB_WORKSPACE)) throw new Error('checkout or temporary directory is not set');
    const [{ default: trustedGit }, { collectSecrets }] = await Promise.all([
      import('../trusted-git.cjs'), import('../../kreview/secrets.cjs'),
    ]);
    const { body } = capture({
      git: git ?? trustedGit.directGit(said(env.GITHUB_WORKSPACE)),
      base: said(env.BOUND_HEAD_SHA),
      mergeBase: said(env.MERGE_BASE),
      index: join(said(env.RUNNER_TEMP), 'ksai-changeset.index'),
      stageAttempt: stage,
      maxBytes: Number(said(env.CHANGESET_MAX_BYTES)),
      maxFiles: Number(said(env.CHANGESET_MAX_FILES)),
      secrets: collectSecrets(env),
      events: said(env.EVENTS_FILE),
      stepOutputs: stepOutputsOf([said(env.STEP_OUTPUTS_BEFORE), said(env.STEP_OUTPUTS)], Number(said(env.CHANGESET_MAX_FILES))),
    });
    const artifact = await upload({ fetch, base: reached.base, token: reached.token, body, pause });
    return { ...completion, artifacts: [artifact] };
  } catch (error) {
    if (keeping) {
      warn(`unfinished change of the stopped stage was not saved: ${error.message}`);
      return completion;
    }
    return ended(stage, 'failed', `saving the stage change failed: ${error.message}`);
  }
}

export function completionWait(env, now = Date.now()) {
  const minutes = Number(said(env.JOB_TIMEOUT_MINUTES));
  if (!Number.isSafeInteger(minutes) || minutes < 1) return COMPLETION_MINT_MS;
  const started = Number(env.KSAI_JOB_STARTED_AT_MS) || now;
  const left = minutes * 60_000 - Math.max(0, now - started) - JOB_END_RESERVE_MS - holdsFor(TIMEOUT_MS);
  return Math.min(COMPLETION_MINT_MS, Math.max(TIMEOUT_MS, left));
}

function executionOf(at) {
  try {
    return readFileSync(said(at), 'utf8');
  } catch {
    return '';
  }
}

const epoch = (value) => /^\d+$/.test(said(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function jobDeadlineOf(env) {
  const established = epoch(env.JOB_DEADLINE_AT);
  if (established) return established;
  const gate = epoch(env.GATE_JOB_DEADLINE_AT);
  const record = epoch(env.RECORD_JOB_DEADLINE_AT);
  return Math.min(gate, record);
}

export function deadlinesFor(env) {
  const plan = validatePlan(readFileSync(env.HARNESS_PLAN_FILE, 'utf8'));
  const deadlines = harnessDeadlines(jobDeadlineOf(env), plan.budget, ENGINE_STOP_MS);
  return {
    ...deadlines,
    relay_deadline_at: deadlines.setup_deadline_at + plan.budget.mint_seconds * 1000,
    host_deadline_at: deadlines.kill_at + ENGINE_STOP_MS + HOST_EXIT_MARGIN_MS,
  };
}

export function harnessModelCutoff(env, now = Date.now()) {
  const { kill_at, launch_at } = deadlinesFor(env);
  if (now > launch_at) throw new Error('the harness model start reserve ended');
  const started = epoch(env.KSAI_JOB_STARTED_AT_MS) || now;
  return { kill_at, launch_at, job_timeout_minutes: Math.floor((kill_at - started) / 60_000) + 1 };
}

function harnessInput(env, mode) {
  const plan = env.HARNESS_PLAN_FILE ? validatePlan(readFileSync(env.HARNESS_PLAN_FILE, 'utf8')) : null;
  const stateDir = stateDirOf(env.RUNNER_TEMP);
  const setup = {
    plan, setup_tree: setupTreeOf(env.RUNNER_TEMP),
    setup_deadline_at: epoch(env.KSAI_STEP_DEADLINE_AT),
  };
  switch (mode) {
    case 'restore':
      return { plan, workspace: env.GITHUB_WORKSPACE, setup_deadline_at: setup.setup_deadline_at,
        record: { [BASE_SHA_FIELD]: env.HARNESS_BASE_SHA } };
    case 'files':
      return { ...setup, workspace: env.GITHUB_WORKSPACE };
    case 'up': {
      const jobDeadline = epoch(env.JOB_DEADLINE_AT);
      return jobDeadline ? { ...setup, job_deadline_at: jobDeadline } : setup;
    }
    case 'down':
      return { plan, setup_tree: setup.setup_tree, state_file: stateFileOf(stateDir),
        teardown_deadline_at: setup.setup_deadline_at, cancelled: env.CONCLUSION === 'cancelled' };
    case 'relay':
      return { endpoints: plan.endpoints, facts_file: factsFileOf(stateDir), start_deadline_at: setup.setup_deadline_at,
        kill_at: epoch(env.KSAI_CHANNEL_KILL_AT) };
    default:
      throw new Error('unknown harness action input');
  }
}

export function saveHarnessAnswer(env) {
  const { result } = finalResult(executionOf(env.EXECUTION_FILE));
  if (!result || result.is_error || typeof result.result !== 'string') return {};
  const bytes = Buffer.from(result.result);
  const answer_file = join(mkdtempSync(join(env.RUNNER_TEMP, 'ksai-harness-answer-')), 'answer');
  writeFileSync(answer_file, bytes, { flag: 'wx', mode: 0o600 });
  return { answer_file, answer_digest: sha256(bytes) };
}

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));

function harnessFacts(env) {
  const file = factsFileOf(stateDirOf(env.RUNNER_TEMP));
  try {
    const facts = JSON.parse(readFileSync(file, 'utf8'));
    const steps = facts.steps.map((step) => pick(step, ['id', 'result', 'exit_code', 'seconds']));
    const endpoints = facts.endpoints.map((endpoint) => ({
      ...pick(endpoint, ['endpoint', 'owned']),
      ...(endpoint.probe && { probe: pick(endpoint.probe, ['ready', 'status']) }),
      ...(endpoint.instance && { instance: pick(endpoint.instance, ['id', 'started_at', 'pid', 'pgid']) }),
    }));
    const codes = COMPLETION_SCHEMA.$defs.harness.properties.failure.properties;
    const failure = codes.phase.enum.includes(facts.failure?.phase) && codes.reason.enum.includes(facts.failure?.reason)
      ? pick(facts.failure, ['phase', 'step', 'endpoint', 'reason']) : undefined;
    return { steps, endpoints, failure };
  } catch {
    return { steps: [], endpoints: [], failure: undefined };
  }
}

function harnessConclusion(stage, env) {
  const { failure: saved, ...facts } = harnessFacts(env);
  const [step, exit] = said(env.HARNESS_FAILED_STEP).split(':');
  const cancelled = env.CONCLUSION === 'cancelled' || Number(exit) === 130 || Number(env.MODEL_EXIT_CODE) === 130;
  const recorded = !cancelled && Number(exit) === 124 && saved?.reason === 'cancelled' ? undefined : saved;
  const failure = recorded ?? (env.STAGE_LATE === 'true' ? FAILURES.stageLate
    : step ? stepFailure(step, exit, cancelled)
      : env.SESSION_REFUSED === 'true' || modelLaunchRefused(env.MODEL_EXIT_CODE, { launched: env.MODEL_LAUNCHED, conclusion: env.MODEL_CONCLUSION })
        ? FAILURES.sessionRefused : undefined);
  const harness = failure ? { ...facts, failure } : facts;
  if (cancelled) return { ...ended(stage, 'cancelled', 'the run executing the stage was cancelled'), harness };
  if (failure) return { apiVersion: COMPLETION_VERSION, ...stage, status: 'succeeded', harness };
  if (env.CONCLUSION === 'success') {
    try {
      const bytes = readFileSync(env.HARNESS_ANSWER_FILE);
      if (sha256(bytes) !== env.HARNESS_ANSWER_DIGEST) throw new Error('the saved stage answer changed');
      const output = outputOf(bytes.toString('utf8'));
      return { apiVersion: COMPLETION_VERSION, ...stage, status: 'succeeded',
        result_digest: `sha256:${sha256(canonicalJson(output))}`, output, harness };
    } catch {
      return { ...ended(stage, 'failed', UNVERIFIED_ANSWER), harness: facts };
    }
  }
  return { ...ended(stage, 'failed', 'the governed stage did not succeed'), harness: facts };
}

async function completeHarness(stage, env, { fetch, secret, pause, now }) {
  const completion = harnessConclusion(stage, env);
  const absolute = jobDeadlineOf(env);
  const oneTry = env.STAGE_LATE === 'true' || !absolute;
  if (!absolute && (env.STAGE_LATE === 'true' || !epoch(env.JOB_TIMEOUT_MINUTES))) return null;
  const minimum = oneTry ? MIN_REQUEST_MS : TIMEOUT_MS;
  const deadline = { at: absolute || now() + completionWait(env, now()), now, minimum, tries: oneTry ? 1 : 3 };
  if (deadline.at - now() < (oneTry ? 2 * minimum : minimum)) return null;
  const mintDeadline = oneTry ? { ...deadline, minimum: 2 * minimum, share: 0.5 } : deadline;
  const reached = await reachedFor({
    env, fetch, timeout: TIMEOUT_MS, tries: deadline.tries, holds: holdsFor(TIMEOUT_MS), secret, pause, deadline: mintDeadline,
  });
  if (reached.why) throw new Error(`sending the stage completion failed: ${reached.why}`);
  const send = (body) => answeredRetrying(fetch, `${reached.base}/run/complete`, {
    token: reached.token, body: canonicalJson(body), timeout: TIMEOUT_MS, deadline,
  }, pause);
  const { taken, sent } = oneTry ? { taken: completion, sent: await send(completion) } : await delivered(completion, stage, send);
  if (sent.why) throw new Error(`control plane did not accept the stage completion: ${sent.why}`);
  return taken;
}

export async function main(env = process.env, { fetch = globalThis.fetch, secret = mask, pause = held, now = Date.now } = {}) {
  const stage = stageOf(env);
  if (env.STAGE_PROFILE === PROFILE) return completeHarness(stage, env, { fetch, secret, pause, now });
  let completion = completionOf(stage, {
    conclusion: env.CONCLUSION,
    execution: executionOf(env.EXECUTION_FILE),
    notice: env.CONTROL_PLANE_NOTICE,
    unmerged: env.MERGE_FAILURE,
    model: env.MODEL_STEP,
    tools: env.TOOLS_STEP,
  });
  const reached = await reachedFor({
    env, fetch, timeout: completionWait(env), tries: Infinity, holds: holdsFor(TIMEOUT_MS), secret, pause,
  });
  if (reached.why) throw new Error(`sending the stage completion failed: ${reached.why}`);
  completion = await withChangeset(completion, stage, env, { reached, fetch, pause });
  const send = (body) => answeredRetrying(fetch, `${reached.base}/run/complete`, {
    token: reached.token, body: canonicalJson(body), timeout: TIMEOUT_MS,
  }, pause);
  const { taken, sent } = await delivered(completion, stage, send);
  if (sent.why) throw new Error(`control plane did not accept the stage completion: ${sent.why}`);
  return taken;
}

export async function delivered(completion, stage, send, warn = unkeptWarning) {
  let taken = completion;
  let sent = await send(taken);
  if (sent.why && taken.status === 'succeeded' && sent.status === TOO_LARGE) {
    taken = ended(stage, 'failed', `the control plane refused the stage's result: ${sent.why}`);
    if (completion.harness) {
      const { failure: _dropped, ...facts } = completion.harness;
      taken.harness = facts;
    }
    sent = await send(taken);
  }
  if (sent.why && taken.status !== 'succeeded' && taken.artifacts && sent.status === MALFORMED) {
    warn(`control plane refused the unfinished change of the stopped stage, not keeping it: ${sent.why}`);
    const { artifacts: _refused, ...unkept } = taken;
    taken = unkept;
    sent = await send(taken);
  }
  return { taken, sent };
}

await runMain(import.meta.url, async () => {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'harness-input') {
    process.stdout.write(JSON.stringify(harnessInput(process.env, argument)));
    return;
  }
  const render = { [DEADLINES_MODE]: deadlinesFor, 'harness-cutoff': harnessModelCutoff, 'harness-save': saveHarnessAnswer };
  if (Object.hasOwn(render, mode)) {
    const { writeOutputs } = await import('../../lib/outputs.mjs');
    writeOutputs(process.env.GITHUB_OUTPUT, render[mode](process.env));
    return;
  }
  const completion = await main();
  if (!completion) return;
  const why = 'failure' in completion ? `: ${completion.failure}` : '';
  console.log(`the control plane took ${completion.instance} attempt ${completion.attempt} of ${completion.job} as ${completion.status}${why}`);
});
