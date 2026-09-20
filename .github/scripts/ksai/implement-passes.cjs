'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { finalResult } = require('./classify.cjs');
const { deniedPaths } = require('./prepare.cjs');
const { bounded, evidence } = require('../lib/evidence.cjs');
const { extractReviewJson } = require('../lib/review-output.cjs');
const { SINKS, renderRequest } = require('../lib/render-request.cjs');

const MAX_FINDINGS = 12;
const MAX = Object.freeze({ manifest: 131_072, findings: 131_072, diff: 512 << 20, changedFiles: 16 << 20, prompt: 2 << 20 });
const PHASES = Object.freeze(['direct', 'do', 'fix', 'plan', 'revise', 'step']);
const MANIFEST = '.ksai-manifest.json';

function contextOf(env) {
  const phase = String(env.PHASE ?? '');
  if (!PHASES.includes(phase)) throw new Error(`no governed pass for phase: ${phase || '(none)'}`);
  return {
    base_sha: String(env.BASE_SHA ?? ''),
    branch: String(env.BRANCH ?? ''),
    phase,
    pr_number: String(env.PR_NUMBER ?? ''),
    repository: String(env.REPO ?? ''),
  };
}

function workOf(env) {
  return {
    changed_files: evidence(env.CHANGED_FILES_FILE, 'the changed-file list', MAX.changedFiles),
    diff: evidence(env.DIFF_FILE, "the pass's diff", MAX.diff),
    prompt: evidence(env.PROMPT_FILE, 'the prompt the pass ran on', MAX.prompt),
  };
}

function manifestAt(env) {
  return path.join(String(env.GITHUB_WORKSPACE ?? ''), MANIFEST);
}

function manifestOf(env) {
  return bounded(manifestAt(env), 'the manifest the pass wrote', MAX.manifest);
}

function manifestIfAny(env) {
  try {
    if (!fs.statSync(manifestAt(env)).isFile()) return null;
  } catch {
    return null;
  }
  return manifestOf(env);
}

function adversarialRequest(env = process.env) {
  return renderRequest({
    promptId: 'runtime.implement.adversarial',
    sink: SINKS.implement,
    model: String(env.MODEL ?? ''),
    inputs: [
      { name: 'context', value: { ...contextOf(env), max_findings: MAX_FINDINGS } },
      { name: 'work', value: workOf(env) },
      { name: 'manifest', value: manifestOf(env) },
      { name: 'denied_paths', value: deniedPaths(env) },
    ],
  });
}

function findingsOf(env) {
  const { result } = finalResult(fs.readFileSync(String(env.ADVERSARIAL_EXECUTION ?? ''), 'utf8'));
  const said = typeof result?.result === 'string' ? result.result : '';
  if (said.trim() === '') throw new Error('the adversarial run answered nothing, so there is nothing to repair from');
  if (Buffer.byteLength(said) > MAX.findings) throw new Error(`the adversarial run answered more than ${MAX.findings} bytes`);
  return said;
}

function defects(findings) {
  const answered = extractReviewJson(findings);
  return answered?.verdict !== 'clean' || answered.findings.length > 0;
}

function repairRequest(env = process.env) {
  const findings = findingsOf(env);
  return {
    request: renderRequest({
      promptId: 'runtime.implement.repair',
      sink: SINKS.implement,
      model: String(env.MODEL ?? ''),
      inputs: [
        { name: 'context', value: contextOf(env) },
        { name: 'work', value: workOf(env) },
        { name: 'findings', value: findings },
        { name: 'manifest', value: manifestOf(env) },
        { name: 'denied_paths', value: deniedPaths(env) },
      ],
    }),
    needed: defects(findings),
  };
}

module.exports = { adversarialRequest, defects, manifestIfAny, repairRequest };
