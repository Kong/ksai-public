import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import controlPlane from '../../lib/control-plane.cjs';
import { canonicalJson, parseIJson } from '../../lib/json.cjs';
import { runMain } from '../../lib/main.mjs';
import { collectSecrets } from '../../kreview/secrets.cjs';
import trustedGit from '../trusted-git.cjs';
import { WRITE_PROFILE, captureChangeset, uploadChangeset } from './changeset.mjs';

const { answeredRetrying, held, holdsFor, mask, reachedFor } = controlPlane;

export const COMPLETION_SCHEMA = JSON.parse(readFileSync(new URL('../../lib/stage-contract/stage-completion.schema.json', import.meta.url), 'utf8'));
const COMPLETION_VERSION = COMPLETION_SCHEMA.properties.apiVersion.const;
const FENCED = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/;
const OPENED = /\n(?=[ \t]*(?:[{[]|```))/g;
const MAX_FAILURE_BYTES = COMPLETION_SCHEMA.properties.failure.maxLength;
const TOO_LARGE = 413;
const TIMEOUT_MS = 30_000;

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
  return result ? { result, why: '' } : { result: null, why: 'run wrote no result, so it did not finish' };
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
    throw new Error('the dispatch record names no whole package stage attempt to complete');
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
  throw new Error('the stage answered no JSON stage candidate');
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
    throw new Error('the stage answered something other than one stage candidate with no artifacts');
  }
  return candidate.output;
}

function ended(stage, status, reason) {
  return {
    apiVersion: COMPLETION_VERSION, ...stage, status,
    failure: withinBytes(said(reason).replace(/\s+/g, ' ') || 'the stage ended without saying why', MAX_FAILURE_BYTES),
  };
}

function beforeModel(model, tools) {
  if (said(model) !== 'skipped') return '';
  return said(tools) === 'failure' ? 'the stage tools could not be installed, so the model never ran' : 'the stage stopped before its model ran';
}

export function completionOf(stage, { conclusion, execution, notice, unmerged = '', model = '', tools = '' }) {
  const failed = (reason) => ended(stage, 'failed', reason);
  if (said(conclusion) === 'cancelled') return ended(stage, 'cancelled', 'the run executing the stage was cancelled');
  if (said(unmerged) !== '') return failed(`the base was not merged into the checkout: ${said(unmerged)}`);
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

export async function withChangeset(completion, stage, env, {
  reached, fetch, pause, capture = captureChangeset, upload = uploadChangeset, git = null,
}) {
  if (completion.status !== 'succeeded' || said(env.STAGE_PROFILE) !== WRITE_PROFILE) return completion;
  try {
    if (!said(env.RUNNER_TEMP) || !said(env.GITHUB_WORKSPACE)) throw new Error('the runner names no checkout or temporary directory');
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
    });
    const artifact = await upload({ fetch, base: reached.base, token: reached.token, body, pause });
    return { ...completion, artifacts: [artifact] };
  } catch (error) {
    return ended(stage, 'failed', `the stage's change was not kept: ${error.message}`);
  }
}

function executionOf(at) {
  try {
    return readFileSync(said(at), 'utf8');
  } catch {
    return '';
  }
}

export async function main(env = process.env, { fetch = globalThis.fetch, secret = mask, pause = held } = {}) {
  const stage = stageOf(env);
  let completion = completionOf(stage, {
    conclusion: env.CONCLUSION,
    execution: executionOf(env.EXECUTION_FILE),
    notice: env.CONTROL_PLANE_NOTICE,
    unmerged: env.MERGE_FAILURE,
    model: env.MODEL_STEP,
    tools: env.TOOLS_STEP,
  });
  const reached = await reachedFor({ env, fetch, timeout: TIMEOUT_MS, holds: holdsFor(TIMEOUT_MS), secret });
  if (reached.why) throw new Error(`the stage's completion could not be sent: ${reached.why}`);
  completion = await withChangeset(completion, stage, env, { reached, fetch, pause });
  const send =() => answeredRetrying(fetch, `${reached.base}/run/complete`, {
    token: reached.token, body: canonicalJson(completion), timeout: TIMEOUT_MS,
  }, pause);
  let sent = await send();
  if (sent.why && completion.status === 'succeeded' && sent.status === TOO_LARGE) {
    completion = ended(stage, 'failed', `the control plane refused the stage's result: ${sent.why}`);
    sent = await send();
  }
  if (sent.why) throw new Error(`the control plane did not take the stage's completion: ${sent.why}`);
  return completion;
}

await runMain(import.meta.url, async () => {
  const completion = await main();
  const why = 'failure' in completion ? `: ${completion.failure}` : '';
  console.log(`the control plane took ${completion.instance} attempt ${completion.attempt} of ${completion.job} as ${completion.status}${why}`);
});
