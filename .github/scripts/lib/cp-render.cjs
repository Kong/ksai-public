'use strict';

const { isDeepStrictEqual } = require('node:util');
const { renderingModeOf, mask, minter, reachControlPlane, unanswered } = require('./control-plane.cjs');
const { annotation } = require('./text.cjs');

const API_VERSION = 'report/v1';
const DEFAULT_TIMEOUT = 30_000;

const RUN_REPORT_KEYS = Object.freeze([
  'PR_NUMBER', 'RUN_ID', 'COMMAND', 'TRIGGER', 'CANCELLED', 'SELECT_ERROR', 'SELECT_ERROR_NOTICE', 'BUILD_ERROR',
  'STAND_DOWN', 'DRY_RUN', 'VALIDATE_OUTCOME', 'PARSE_OUTCOME', 'AUTHORIZED', 'TRIAGE_SKIP', 'TRIAGE_SKIP_REASON',
  'SELECT_OUTCOME', 'SELECT_SKIPPED', 'RESULT_OUTCOME', 'WATCHDOG_FIRED', 'WATCHDOG_CAUSE', 'WATCHDOG_REASON',
  'CEILING', 'STOP_REASON', 'ENDED_ON', 'RULES_NOTICE', 'CONCLUSION', 'COMMIT_ID', 'MODEL', 'EFFORT', 'ENGINE',
  'SELECTED_BY', 'DIALS_ARM', 'REQUESTER', 'TRIAGE_MODE', 'TRIAGE_FILES', 'TRIAGE_LINES', 'TRIAGE_RISK',
  'TRIAGE_API_SURFACE', 'TRIAGE_SKILLS', 'TRIAGE_TIER', 'TRIAGE_WHY', 'REPO_RULES_MODE', 'REPO_RULES_ENABLED',
  'REPO_RULES_PATH', 'REPO_RULES_SHA', 'REPO_RULES_BYTES', 'REPO_RULES_PACKS', 'PROMPT_REPORT', 'REVIEW_PROTOCOL',
  'HAS_RESULT', 'DURATION', 'NUM_TURNS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'UNCACHED_INPUT_TOKENS',
  'CACHE_READ_TOKENS', 'CACHE_WRITE_TOKENS', 'DENIALS', 'COST', 'CLASSIFIER_COST', 'RUN_URL', 'CHANNEL_NOTES',
  'STATUS', 'ROUTE_SOURCE', 'REPORT_PUBLISHED',
]);

const NOTICE_KEYS = Object.freeze([
  'COMMAND', 'TRIGGER', 'ISSUE_NUM', 'PR_NUMBER', 'RUN_ID', 'JIRA_KEY', 'KSAI_ASK', 'ROUTE_SOURCE', 'THREAD_NUM',
  'REPORT_NUM', 'REFUSED_ON', 'CONTEXT_NOTICE', 'SELECT_NOTICE', 'SELECT_NOTICE_KIND', 'SUBJECT_NOTICE',
  'CLOSED_NOTICE', 'STOP_NOTICE', 'PHASE_NOTICE', 'MERGE_NOTICE', 'PLAN_NOTICE', 'JIRA_ERROR', 'HELD_NOTICE',
  'NOTICE', 'NOTICE_KIND', 'APPROVED_BY', 'COMMENT_ID', 'REASON', 'OPEN_THREADS', 'WRITE_ACCESS_COMMANDS',
  'REMAINING', 'DETAIL', 'STATUS', 'PHASE', 'WATCHDOG_FIRED', 'WATCHDOG_CAUSE', 'WATCHDOG_REASON', 'HELD', 'CEILING',
  'PRESERVED', 'PRESERVE_REASON', 'RUN_URL',
]);

const RENDER_ENV_KEYS = Object.freeze([
  'KSAI_REPORT_RENDERING', 'KSAI_CP_ENDPOINT', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID',
]);

function renderingMode(env = process.env) {
  return renderingModeOf(env?.KSAI_REPORT_RENDERING);
}

function pick(env, names) {
  const held = env ?? {};
  return Object.fromEntries(
    names.filter((name) => held[name] !== undefined && held[name] !== null).map((name) => [name, String(held[name])]),
  );
}

const warning = (message) => process.stdout.write(`${annotation(message, 'warning')}\n`);

function runUrl(env = process.env) {
  const server = String(env?.GITHUB_SERVER_URL ?? '').trim();
  const repository = String(env?.GITHUB_REPOSITORY ?? '').trim();
  const run = String(env?.GITHUB_RUN_ID ?? '').trim();
  return server === '' || repository === '' || run === '' ? '' : `${server}/${repository}/actions/runs/${run}`;
}

function unrendered(what, why, env = process.env) {
  const run = runUrl(env);
  const where = run === '' ? '' : ` The [workflow run](${run}) has what it found.`;
  return `_KSAI could not render ${what}, because ${why}.${where}_`;
}

function withMarkers(text, body) {
  return [text, ...(String(body ?? '').match(/^<!--.*-->$/gm) ?? [])].join('\n\n').concat('\n');
}

async function settled(local) {
  try {
    return await local();
  } catch {
    return null;
  }
}


async function askControlPlane({ kind, request, expect = null, accept, env, fetch, timeout, secret }) {
  const endpoint = String(env.KSAI_CP_ENDPOINT ?? '').trim();
  if (endpoint === '') return { why: 'no control plane serves this repository' };
  if (!(timeout > 0)) return { why: 'the control plane did not answer in time' };
  const signal = AbortSignal.timeout(timeout);
  const reached = await reachControlPlane({ endpoint, env, mint: minter({ env, fetch, signal }), secret });
  if (reached.failure) return { why: reached.failure };
  try {
    const response = await fetch(`${reached.base}/v1/report/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reached.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ api_version: API_VERSION, [kind]: request, ...(expect === null ? {} : { expect }) }),
      signal,
    });
    if (!response.ok) return { why: `the control plane answered ${response.status}` };
    const answer = await response.json();
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer) || !accept(answer)) {
      return { why: 'the control plane answered with nothing this run could post' };
    }
    return { answer };
  } catch (error) {
    return { why: unanswered(error) };
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

async function rendered({
  kind,
  request,
  local,
  fallback,
  accept = (answer) => typeof answer.body === 'string',
  env = process.env,
  fetch = globalThis.fetch,
  timeout = DEFAULT_TIMEOUT,
  warn = warning,
  secret = mask,
}) {
  const mode = renderingMode(env);
  if (mode === 'local') return { value: await local(), parity: '' };
  if (mode === 'cp') {
    const asked = await askControlPlane({ kind, request, accept, env, fetch, timeout, secret });
    if (asked.answer !== undefined) return { value: asked.answer, parity: '' };
    warn(`the control plane did not render this ${kind}, so a minimal one was posted: ${asked.why}`);
    return { value: fallback(asked.why, await settled(local)), parity: '' };
  }
  const mine = await local();
  const expect = plain(mine);
  const asked = await askControlPlane({ kind, request, expect, accept, env, fetch, timeout, secret });
  if (asked.answer === undefined) {
    warn(`the control plane could not shadow this ${kind}: ${asked.why}`);
    return { value: mine, parity: 'unavailable' };
  }
  if (isDeepStrictEqual(expect, asked.answer)) return { value: mine, parity: 'match' };
  warn(`the control plane rendered this ${kind} differently from the runner, and the runner's was posted`);
  return { value: mine, parity: 'differ' };
}

async function renderedNotice({ notice, local, what, fields = null, env = process.env, fetch = globalThis.fetch }) {
  const { value } = await rendered({
    kind: 'notice',
    request: { ...notice, env: pick(fields ?? env, NOTICE_KEYS) },
    local,
    fallback: (why, mine) => ({ body: withMarkers(unrendered(what, why, env), mine?.body) }),
    env,
    fetch,
  });
  return String(value.body);
}

module.exports = {
  API_VERSION,
  NOTICE_KEYS,
  RENDER_ENV_KEYS,
  RUN_REPORT_KEYS,
  pick,
  rendered,
  renderedNotice,
  renderingMode,
  unrendered,
  withMarkers,
};
