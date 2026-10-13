import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { annotation } from '../lib/text.cjs';
import { measure, stamps } from '../ksai/phases.mjs';
import { recorded } from '../ksai/stages.mjs';
import { servedRules } from './load-suppressions.mjs';
import { stagesSource } from './opencode-progress.mjs';

const require = createRequire(import.meta.url);
const postReview = require('./post-review.cjs');
const { asJsonl, evalRunRecord, loadSuppressionRules, runSpend, splitPublished } = require('./publish.cjs');
const { readPull } = require('../lib/cp-report.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');

export const STATS_ROOM = (1 << 20) - 4096;
export const LISTED_MOST = 1000;
export const TEXT_MOST = 64 * 1024;
export const RECORD_INPUTS = Object.freeze([
  'PHASES_FILE', 'PROFILE', 'ENGINE', 'SELECTED_BY', 'RUN_SETTINGS_ARM', 'SHADOW', 'PUBLISH', 'REVIEWER_ID', 'TRIAGE_MODE', 'TRIAGE_TIER', 'TRIAGE_SKIP_BY',
  'TRIAGE_SKILLS', 'TRIAGE_FILES', 'TRIAGE_LINES', 'TRIAGE_RISK', 'TRIAGE_API_SURFACE', 'TRIAGE_SOURCE', 'TRIAGE_POLICY_VERSION', 'TRIAGE_LOCAL_POLICY_VERSION',
  'TRIAGE_CP_POLICY_VERSION', 'TRIAGE_MISMATCH', 'REPO_RULES_ENABLED', 'REPO_RULES_MODE', 'PLUGIN_REF', 'COMMIT_ID', 'BASE_REF', 'CLASSIFIER_MODEL', 'VERDICT',
  'CLASSIFIER_COST', 'CLASSIFIER_INPUT', 'CLASSIFIER_OUTPUT', 'ROUTE_COMMAND', 'ROUTE_SURFACE', 'ROUTE_SOURCE', 'WORKFLOW_ID', 'WORKFLOW_VERSION',
]);
export const RECORD_FILE = 'ksai-record-inputs.json';

export function describe(env = process.env) {
  const at = join(String(env.RUNNER_TEMP ?? ''), RECORD_FILE);
  writeFileSync(at, JSON.stringify(Object.fromEntries(RECORD_INPUTS.map((name) => [name, String(env[name] ?? '')]))), { mode: 0o600 });
  writeOutputs(env.GITHUB_OUTPUT, { file: at });
  return 0;
}

function recordedOf(env, warn) {
  const at = String(env.KSAI_RECORD_INPUTS ?? '').trim();
  if (!at) return {};
  try {
    const held = JSON.parse(readFileSync(at, 'utf8'));
    return Object.fromEntries(RECORD_INPUTS.filter((name) => typeof held?.[name] === 'string').map((name) => [name, held[name]]));
  } catch (error) {
    warn(`what the action handed for this run's stats record could not be read: ${error?.message ?? error}`);
    return {};
  }
}

const REPORTED = Object.freeze({
  COST: 'total_cost', REVIEW_PROTOCOL: 'review_protocol', HAS_RESULT: 'has_result', ENDED_ON: 'ended_on', RUN_RESULT: 'run_result',
  CONCLUSION: 'conclusion', INPUT_TOKENS: 'input_tokens', OUTPUT_TOKENS: 'output_tokens', NUM_TURNS: 'num_turns', DURATION: 'duration',
  DENIALS: 'permission_denials', UNCACHED_INPUT_TOKENS: 'uncached_input_tokens', CACHE_READ_TOKENS: 'cache_read_tokens',
  CACHE_WRITE_TOKENS: 'cache_write_tokens', CACHE_WRITE_5M_TOKENS: 'cache_write_5m_tokens', CACHE_WRITE_1H_TOKENS: 'cache_write_1h_tokens',
  BILLED: 'billed', DENIED: 'denied',
});

const LISTED_FILES = 'pulls.listFiles';

export function filesOf(patch) {
  return String(patch ?? '').split(/(?=^diff --git )/m).filter((block) => block.startsWith('diff --git ')).map((block) => {
    const filename = block.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? block.match(/^--- a\/(.+)$/m)?.[1] ?? block.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? '';
    const at = block.search(/^@@ /m);
    return at < 0 ? { filename } : { filename, patch: block.slice(at).replace(/\n$/, '') };
  });
}

export function linkedGithub({ env, fetch, diff }) {
  const files = () => filesOf(diff());
  return {
    rest: {
      pulls: {
        get: async ({ pull_number: number }) => {
          const said = await readPull({ number, env, fetch });
          if (said.why) throw new Error(`the control plane could not read pull request #${number}: ${said.why}`);
          const pull = said.answer;
          return {
            data: {
              number: pull.number, head: { sha: pull.head_sha, ref: pull.head_ref }, base: { sha: pull.base_sha, ref: pull.base_ref },
              created_at: pull.created_at ?? null, changed_files: pull.changed_files, additions: pull.additions, deletions: pull.deletions,
            },
          };
        },
        listFiles: LISTED_FILES,
      },
      repos: { compareCommitsWithBasehead: async () => ({ data: { files: files() } }) },
    },
    paginate: async (listed) => {
      if (listed !== LISTED_FILES) throw new Error('a linked run lists only the files of the diff it reviewed');
      return files();
    },
  };
}

export const annotated = (level) => (line) => console.log(annotation(line, level));

const said = (warn) => ({ warning: warn, notice: annotated('notice') });

export function reportedEnv(report) {
  return Object.fromEntries(Object.entries(REPORTED).map(([name, output]) => [name, String(report[output] ?? '')]));
}

function stagesOf(env, events) {
  const observed = stagesSource({ ...env, OPENCODE_EVENTS_FILE: events });
  if (observed.why) return '';
  const record = recorded(observed, env);
  return record ? JSON.stringify(record) : '';
}

function phasesOf(env, now) {
  try {
    const { marks, dropped } = stamps(readFileSync(String(env.PHASES_FILE ?? ''), 'utf8'));
    const measured = measure(marks, now.getTime());
    return measured ? JSON.stringify({ ...measured, dropped }) : '';
  } catch {
    return '';
  }
}

export function handedRules(handed, scope, warn) {
  let served = null;
  try {
    served = JSON.parse(handed);
  } catch {
    warn('The suppression rules the engine handed on are not JSON; posting every finding.');
    return { scope, rules: [] };
  }
  return { scope, rules: servedRules(served, scope, warn).rules ?? [] };
}

async function pullOf(github, owner, repo, number) {
  const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return {
    created_at: data?.created_at ?? null, base_ref: data?.base?.ref ?? null, base_sha: data?.base?.sha ?? null, head_sha: data?.head?.sha ?? null,
    changed_files: data?.changed_files ?? null, additions: data?.additions ?? null, deletions: data?.deletions ?? null,
  };
}

function clipped(text, most) {
  let held = String(text ?? '');
  while (Buffer.byteLength(held) > most) held = held.slice(0, Math.floor((held.length * most) / Buffer.byteLength(held)));
  return held;
}

export function boundedSuppression(fires, findings, room) {
  for (let most = TEXT_MOST; ; most = Math.floor(most / 2)) {
    const kept = JSON.stringify({
      fires: fires.slice(0, LISTED_MOST),
      findings: findings.slice(0, LISTED_MOST).map((one) => (typeof one?.text === 'string' ? { ...one, text: clipped(one.text, most) } : one)),
    });
    if (Buffer.byteLength(kept) <= room || most === 0) return kept;
  }
}

const reviewedDiff = (env) => () => (String(env.DIFF_PATCH ?? '').trim() ? readFileSync(String(env.DIFF_PATCH), 'utf8') : '');

export async function published(given, {
  execution, events, args, recordDir, fetch = globalThis.fetch, github = linkedGithub({ env: given, fetch, diff: reviewedDiff(given) }), now = new Date(),
  warn = annotated('warning'),
}) {
  const env = { ...given, ...recordedOf(given, warn) };
  const report = runSpend(readFileSync(execution, 'utf8'));
  const flow = String(env.FLOW ?? '').trim();
  const number = Number(String(env.PR_NUMBER || env.REPORT_NUM || '').trim());
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  let summary = {};
  let fires = [];
  let findings = [];
  let kept = '';
  if (flow === 'review' && report.has_output === 'true') {
    if (!usingControlPlane(env)) throw new Error('a linked review publishes through the control plane, and this run was not given github_calls: cp');
    mkdirSync(recordDir, { recursive: true });
    const bundle = join(recordDir, 'suppressions.json');
    if (args.suppressions) writeFileSync(bundle, JSON.stringify(handedRules(args.suppressions, `${owner}/${repo}`, warn)));
    const posted = await postReview({
      github, core: said(warn), owner, repo, prNumber: number, commitId: String(env.COMMIT_ID ?? ''),
      runResult: report.run_result, conclusion: report.conclusion, reviewStrategy: String(env.REVIEW_STRATEGY || 'baseline').trim(),
      protocol: JSON.parse(report.review_protocol || 'null'), publish: env.PUBLISH !== 'false',
      suppression: {
        rules: loadSuppressionRules({ bundlePath: bundle, core: said(warn), fs }),
        reviewerId: env.REVIEWER_ID,
        runId: `gh:${env.GITHUB_REPOSITORY}:actions:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}:${String(env.KSAI_JOB_INDEX ?? '').trim() || '0'}`,
      },
      env, fetch,
    });
    ({ fires, records: findings, summary } = splitPublished(posted));
    writeFileSync(join(recordDir, 'fires.jsonl'), asJsonl(fires));
    writeFileSync(join(recordDir, 'findings.jsonl'), asJsonl(findings));
    kept = recordDir;
  }
  let pr = null;
  if (Number.isSafeInteger(number) && number > 0) {
    try {
      pr = await pullOf(github, owner, repo, number);
    } catch (error) {
      warn(`the pull request this run is about could not be read, so its stats record names none of its facts: ${error?.message ?? error}`);
    }
  }
  const narrated = String(env.STATUS_UPDATES ?? '').trim() === 'auto';
  let record = '';
  try {
    record = JSON.stringify(evalRunRecord({
      ...env,
      ...reportedEnv(report),
      MODEL: env.MODEL, EFFORT: env.VARIANT, RUN_MODEL: env.MODEL, RUN_EFFORT: env.VARIANT, ENGINE_VERSION: env.OPENCODE_VERSION,
      PR_NUMBER: number > 0 ? String(number) : '',
      JOB_INDEX: String(env.KSAI_JOB_INDEX ?? '').trim() || '0',
      PUBLISHED: JSON.stringify(summary),
      STOPPED_BY: String(args.stopped_by ?? ''),
      STATUS: narrated ? JSON.stringify({ updates: Number(args.status_updates) || 0 }) : '',
      CHANNEL_NOTES: String(args.channel_notes ?? ''),
      STAGES: stagesOf(env, events),
      PHASES: phasesOf(env, now),
    }, { now }));
  } catch (error) {
    warn(`this run's stats record could not be built: ${error?.message ?? error}`);
  }
  const described = { record, pr: pr === null ? '' : JSON.stringify(pr) };
  const room = STATS_ROOM - Buffer.byteLength(described.record) - Buffer.byteLength(described.pr);
  return { ...described, suppression: boundedSuppression(fires, findings, room), summary: kept ? JSON.stringify(summary) : '', recordDir: kept };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = describe();
}
