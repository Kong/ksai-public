import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deliveriesAt, governanceOptions, governedRoot, rendererFor, trustedRootAt } from '../governance/anchors.mjs';
import { bounded, evidence } from '../lib/evidence.cjs';
import { conclusionOf } from '../lib/execution-log.mjs';
import { SINKS, parityOf, promptRendering, renderRequest, renderThroughControlPlane, reportDeliveries, writeRenderRequest } from '../lib/cp-prompts.mjs';
import prepare from './prepare.cjs';
import reviewPipeline from './review-pipeline.cjs';
import reviewRequest from './review-request.cjs';

export const REVIEW_TOOLS = Object.freeze(['bash', 'glob', 'grep', 'read']);

const PIPELINE = Object.freeze(['evidence', 'dual']);

const PASS_NAMES = Object.freeze(['phase', 'adversarial', 'repair']);
const CANDIDATE_BYTES = 512 * 1024;
const MANDATE_BYTES = 256 * 1024;
const EXECUTION_BYTES = 8 * 1024 * 1024;
const PROMPT_BYTES = 2 * 1024 * 1024;
const CHANGED_FILES_BYTES = 16 * 1024 * 1024;
const DIFF_BYTES = 512 * 1024 * 1024;

export const rootOf = governedRoot;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function resultOf(execution, phase) {
  const log = typeof execution === 'string' ? JSON.parse(execution) : execution;
  if (!Array.isArray(log) || log.length !== 1 || log[0]?.type !== 'result') throw new Error(`the ${phase} run left no single result`);
  return log[0];
}

function succeeded(result) {
  return result.subtype === 'success' && result.is_error === false && typeof result.result === 'string' && result.result.trim() !== '';
}

function pipelineBeside(prompt, from, text) {
  const held = JSON.parse(readFileSync(`${from}.pipeline.json`, 'utf8'));
  held.identity = { ...held.identity, prompt_sha256: sha256(text) };
  held.resultTransport = 'text';
  writeFileSync(`${prompt}.pipeline.json`, JSON.stringify(held), { mode: 0o600 });
}

export function optionsOf(env, root, rendered, steps, pinned) {
  return {
    ...governanceOptions({
      endpoint: env.KSAI_CP_ENDPOINT,
      artifacts: rendered.dir,
      report: deliveriesAt(root),
      trustedRoot: trustedRootAt(root),
      expect: rendered.expect,
      tools: REVIEW_TOOLS,
      arm: rendered.arm,
    }, pinned),
    ...(steps ? { steps } : {}),
  };
}

function governing(env, root, rendered, name, steps, pinned) {
  const file = join(root, `${name}.options.json`);
  writeFileSync(file, JSON.stringify(optionsOf(env, root, rendered, steps, pinned)), { mode: 0o600 });
  return file;
}

export async function renderReview(env, deps = {}) {
  const mode = promptRendering(env);
  if (mode === 'local') return {};
  const strategy = env.REVIEW_STRATEGY || 'baseline';
  const staged = PIPELINE.includes(strategy);
  if (mode === 'cp' && env.ENGINE !== 'opencode') throw new Error(`a governed review runs on opencode, whose plugin verifies the render, and this one runs on ${env.ENGINE || 'no engine'}`);
  if (mode === 'cp') rendererFor(env.KSAI_CP_ENDPOINT, deps.pinned);
  const experiment = reviewPipeline.experimentOf(env.REVIEW_EXPERIMENT || '', { head: env.COMMIT_ID || '', base: env.BASE_SHA || '', plugin: env.PLUGIN_SHA || '', publish: env.PUBLISH !== 'false' });
  const { options, refusal } = prepare.reviewOptions(env, experiment);
  if (refusal) throw new Error(refusal);
  const request = reviewRequest.reviewRenderRequest({ ...options, ...(staged ? { priorFindings: '' } : {}), model: env.MODEL, baseSha: env.BASE_SHA, additionalPrompt: env.ADDITIONAL_PROMPT, pipeline: staged });
  const root = rootOf(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rendered = await renderThroughControlPlane({ request, dir: join(root, 'review'), tools: [...REVIEW_TOOLS], env, ...deps });
  if (mode === 'shadow') {
    return { shadow: `${rendered.version}${rendered.arm ? ` (${rendered.arm})` : ''}`, parity: parityOf(readFileSync(rendered.prompt, 'utf8'), env.PROMPT_FILE) };
  }
  const prompt = readFileSync(rendered.prompt, 'utf8');
  pipelineBeside(rendered.prompt, env.PROMPT_FILE, prompt);
  if (!staged) return { prompt_file: rendered.prompt, options_file: governing(env, root, rendered, 'review', 0, deps.pinned), version: rendered.version, strategy };
  const plan = { model: String(env.MODEL ?? ''), mandate: bounded(env.AUDITOR_MANDATE, 'the auditor mandate', MANDATE_BYTES) };
  writeFileSync(join(root, 'stages.json'), JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  mkdirSync(join(root, 'stages'), { mode: 0o700 });
  const unrendered = { dir: join(root, 'stages'), expect: null, arm: rendered.arm };
  return { prompt_file: rendered.prompt, options_file: governing(env, root, unrendered, 'review', reviewPipeline.LIMITS.stageSteps, deps.pinned), version: rendered.version, strategy };
}

export function auditRequest(env) {
  const main = resultOf(bounded(env.REVIEW_EXECUTION, 'the review run log', EXECUTION_BYTES), 'review');
  if (!succeeded(main)) throw new Error('the review run did not succeed, so there is no candidate to audit');
  if (Buffer.byteLength(main.result) > CANDIDATE_BYTES) throw new Error(`the candidate review is larger than ${CANDIDATE_BYTES} bytes`);
  return renderRequest({
    promptId: 'runtime.review-audit',
    sink: SINKS.review,
    model: String(env.MODEL ?? ''),
    inputs: [
      {
        name: 'audit_context',
        value: {
          changed_files: evidence(env.DIFF_FILES, 'the changed-file list', CHANGED_FILES_BYTES),
          diff: evidence(env.DIFF_PATCH, 'the diff', DIFF_BYTES),
          review_prompt: evidence(env.REVIEW_PROMPT_FILE, 'the review prompt', PROMPT_BYTES),
        },
      },
      { name: 'auditor_mandate', value: bounded(env.AUDITOR_MANDATE, 'the auditor mandate', MANDATE_BYTES) },
      { name: 'candidate_review', value: main.result },
    ],
  });
}

export async function renderAudit(env, deps = {}) {
  const root = rootOf(env);
  const request = auditRequest(env);
  writeRenderRequest(join(root, 'audit.request.json'), request, { exclusive: true });
  const rendered = await renderThroughControlPlane({ request, dir: join(root, 'audit'), tools: [...REVIEW_TOOLS], env, ...deps });
  const prompt = readFileSync(rendered.prompt, 'utf8');
  pipelineBeside(rendered.prompt, env.REVIEW_PROMPT_FILE, prompt);
  return { prompt_file: rendered.prompt, options_file: governing(env, root, rendered, 'audit', 0, deps.pinned), version: rendered.version };
}

export function verifyAudit(env) {
  const request = JSON.parse(readFileSync(join(rootOf(env), 'audit.request.json'), 'utf8'));
  const expected = request.inputs.find((one) => one.name === 'audit_context').value;
  const actual = {
    changed_files: evidence(expected.changed_files.path, 'the changed-file list', CHANGED_FILES_BYTES),
    diff: evidence(expected.diff.path, 'the diff', DIFF_BYTES),
    review_prompt: evidence(expected.review_prompt.path, 'the review prompt', PROMPT_BYTES),
  };
  for (const [name, now] of Object.entries(actual)) {
    const then = expected[name];
    if (now.sha256 !== then.sha256 || now.bytes !== then.bytes) throw new Error(`${name.replace('_', ' ')} changed after the audit was rendered`);
  }
  return {};
}

function usageOf(result) {
  const usage = result?.usage ?? {};
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((key) => [key, Number(usage[key]) || 0]));
}

function totals(logs, names) {
  return {
    usage: logs.map((one) => usageOf(one)).reduce((sum, one) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + one[key]]))),
    total_cost_usd: logs.some((one) => one.total_cost_usd === null || one.total_cost_usd === undefined)
      ? null
      : logs.reduce((sum, one) => sum + Number(one.total_cost_usd), 0),
    num_turns: logs.reduce((sum, one) => sum + (Number(one.num_turns) || 0), 0),
    duration_ms: logs.reduce((sum, one) => sum + (Number(one.duration_ms) || 0), 0),
    permission_denials: logs.flatMap((one, at) => (Array.isArray(one.permission_denials) ? one.permission_denials.map((denial) => ({ ...denial, phase: names[at] })) : [])),
    ksai_phases: logs.map((one, at) => ({ phase: names[at], subtype: one.subtype, usage: usageOf(one), total_cost_usd: one.total_cost_usd ?? null })),
  };
}

export function combined(mainExecution, auditExecution, auditConclusion = 'success') {
  const main = resultOf(mainExecution, 'review');
  const audit = auditExecution === undefined ? null : resultOf(auditExecution, 'audit');
  const both = [main, ...(audit ? [audit] : [])];
  const passed = audit !== null && auditConclusion === 'success' && succeeded(main) && succeeded(audit);
  return [{
    ...(audit ?? main),
    subtype: passed ? 'success' : 'error_during_execution',
    is_error: !passed,
    result: passed ? audit.result : '',
    ...totals(both, ['review', 'audit']),
  }];
}

export function passes(env) {
  const ran = PASS_NAMES.map((name, at) => [name, String([env.PHASE_EXECUTION, env.ADVERSARIAL_EXECUTION, env.REPAIR_EXECUTION][at] ?? '').trim()])
    .filter(([, at]) => at !== '')
    .map(([name, at]) => [name, resultOf(bounded(at, 'a governed pass log', EXECUTION_BYTES), 'pass')]);
  if (!ran.length) throw new Error('no governed pass of this phase left a run log');
  const logs = ran.map(([, log]) => log);
  const worked = ran.filter(([name]) => name !== 'adversarial').map(([, log]) => log);
  const last = worked.at(-1) ?? logs.at(-1);
  const answered = String(env.REPAIR_CONCLUSION ?? '').trim();
  const repaired = String(env.REPAIR_EXECUTION ?? '').trim() === '' || answered === 'success';
  const merged = [{
    ...last,
    subtype: repaired ? last.subtype : 'error_during_execution',
    is_error: repaired ? last.is_error : true,
    ...totals(logs, ran.map(([name]) => name)),
  }];
  const file = join(rootOf(env), 'passes.json');
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { execution_file: file, conclusion: conclusionOf(file) };
}

export function combine(env) {
  const main = bounded(env.REVIEW_EXECUTION, 'the review run log', EXECUTION_BYTES);
  const audit = env.AUDIT_EXECUTION ? bounded(env.AUDIT_EXECUTION, 'the audit run log', EXECUTION_BYTES) : undefined;
  const file = join(rootOf(env), 'execution.json');
  writeFileSync(file, `${JSON.stringify(combined(main, audit, env.AUDIT_CONCLUSION), null, 2)}\n`, { mode: 0o600 });
  return { execution_file: file, conclusion: conclusionOf(file) };
}

export async function report(env, deps = {}) {
  const root = rootOf(env);
  const { reported } = await reportDeliveries({ files: [deliveriesAt(root)], root, env, ...deps });
  return { reported: String(reported) };
}
