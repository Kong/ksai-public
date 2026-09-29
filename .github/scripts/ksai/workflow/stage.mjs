import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import controlPlane from '../../lib/control-plane.cjs';
import { canonicalJson, parseIJson } from '../../lib/json.cjs';
import { runMain } from '../../lib/main.mjs';
import { withinBytes } from '../../lib/prompt-text.cjs';
import { sha256 } from './manifest.mjs';
import { candidateEnvelope, object } from './runner.mjs';

const require = createRequire(import.meta.url);
const { finalResult } = require('../classify.cjs');

const { answeredRetrying, held, holdsFor, mask, reachedFor } = controlPlane;

export const COMPLETION_SCHEMA = JSON.parse(readFileSync(new URL('../../lib/stage-contract/stage-completion.schema.json', import.meta.url), 'utf8'));
const COMPLETION_VERSION = COMPLETION_SCHEMA.properties.apiVersion.const;
const FENCED = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/;
const MAX_FAILURE_BYTES = COMPLETION_SCHEMA.properties.failure.maxLength;
const TOO_LARGE = 413;
const TIMEOUT_MS = 30_000;

const said = (value) => String(value ?? '').trim();

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

export function outputOf(answer) {
  const text = said(answer);
  let candidate;
  try {
    candidate = parseIJson(FENCED.exec(text)?.[1] ?? text, 'stage candidate');
  } catch {
    throw new Error('the stage answered no JSON stage candidate');
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

export function completionOf(stage, { conclusion, execution }) {
  const failed = (reason) => ended(stage, 'failed', reason);
  if (said(conclusion) === 'cancelled') return ended(stage, 'cancelled', 'the run executing the stage was cancelled');
  const { result, why } = finalResult(execution);
  if (!result) return failed(`the model ${why}`);
  if (said(conclusion) !== 'success' || result.is_error) {
    return failed(result.stop_reason || `the model run concluded ${said(conclusion) || 'nothing'}`);
  }
  let output;
  try {
    output = outputOf(result.result);
  } catch (error) {
    return failed(error.message);
  }
  return { apiVersion: COMPLETION_VERSION, ...stage, status: 'succeeded', result_digest: sha256(canonicalJson(output)), output };
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
  let completion = completionOf(stage, { conclusion: env.CONCLUSION, execution: executionOf(env.EXECUTION_FILE) });
  const reached = await reachedFor({ env, fetch, timeout: TIMEOUT_MS, holds: holdsFor(TIMEOUT_MS), secret });
  if (reached.why) throw new Error(`the stage's completion could not be sent: ${reached.why}`);
  const send = () => answeredRetrying(fetch, `${reached.base}/run/complete`, {
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
