'use strict';

const fs = require('node:fs');
const { finalResult } = require('./classify.cjs');
const { readWorkRef } = require('./context.cjs');
const { doRequestOf, renderDoMarker } = require('./do.cjs');
const { href, marker, positive } = require('./marker.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');
const { STATUS_BEGIN, STATUS_END, URL_SHAPE, locateStatus, oneLine, scrub, spliceStatus } = require('./plan.cjs');
const { probeComments } = require('./pages.cjs');
const { LOCK_TIMEOUT_MS, withIssueLock } = require('./write-lock.cjs');
const { withControlPlaneLock } = require('./cp-lock.cjs');

const MAX_SELECTION_CHARS = 80;

function cutSelection(said) {
  const text = String(said ?? '');
  if (text.length <= MAX_SELECTION_CHARS) return text;
  let end = MAX_SELECTION_CHARS - 1;
  const at = text.codePointAt(end);
  if (at >= 0xdc00 && at <= 0xdfff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}
const { neutralize } = require('../lib/prompt-text.cjs');
const {
  MAX_HISTORY,
  BLANK_CELL,
  appendHistory,
  carriesHeading,
  cutNote,
  headedBlock,
  historyLines,
  reportTable,
  spendSaid,
  statusLine,
} = require('../lib/run-progress.cjs');
const { markerJson } = require('../lib/run-record.cjs');
const {
  ARMS,
  ARM_EFFORT_SHAPE,
  ARM_MODEL_SHAPE,
  ATTEMPT_ID_SHAPE,
  IDENTITY_PREFIX,
  MAX_ATTEMPTS,
  MAX_PAID_RUNS,
  PREFIX: STATE_PREFIX,
  REASON_SHAPE,
  SHAPE: STATE_SHAPE,
  SHAPE_ALL: STATE_SHAPE_ALL,
  UNCLASSIFIED_REASON,
  VERSION,
  armFields,
  compactJob,
  unpackAttempt,
  validAttempt,
  validLabelSource,
  writeStateMarker,
} = require('../lib/write-record.cjs');
const { RUN_SETTINGS_ARM_SHAPE, armLabel, asAlert } = require('../lib/select-arm.cjs');
const { counted, safeText } = require('../lib/text.cjs');
const cpRender = require('../lib/cp-render.cjs');
const cpReport = require('./cp-report.cjs');
const { STATUS_TABLE, reporting } = require('./publish.cjs');

const MAX_PAGES = 20;
const MAX_PASSES = 5;
const LOCKED_RENDER_BUDGET = Math.floor(LOCK_TIMEOUT_MS / 6);
const MAX_CURRENT_CHARS = 7_000;
const MAX_STATUS_RUNS = 200;
const PLAN_KINDS = Object.freeze(['implement', 'revise']);
const REQUEST_KINDS = Object.freeze(['fix', 'do', 'unlock']);
const PLAN_PHASES = Object.freeze(['plan', 'plan-review', 'step', 'direct', 'revise']);
const PLAN_IDENTITY_KIND = 'implement';
const LABEL_KIND = 'fix';
const PLAN_PHASE = 'plan';
const DIRECT_PHASE = 'direct';
const MAX_ARM_ROWS = 12;
const WORKING_OUTCOMES = Object.freeze(['initializing', 'running']);
const PUBLISHED_LIMIT = 65_536;
const RESERVED_BODY_CHARS = 64;

function plansIn(env) {
  return PLAN_KINDS.includes(String(env.COMMAND ?? '')) || PLAN_PHASES.includes(String(env.PHASE ?? ''));
}

function identityOf(env = process.env) {
  const pr = positive(env.PR_NUMBER);
  const command = String(env.COMMAND ?? '');
  if (plansIn(env)) {
    if (pr === null && String(env.PHASE ?? '') !== DIRECT_PHASE) {
      return { error: 'the write report has no implementation pull request to identify' };
    }
    const at = pr === null ? {} : { pr };
    const jira = String(env.JIRA_KEY ?? '').trim().toUpperCase();
    const issue = positive(env.ISSUE_NUM);
    if (jira !== '') return { identity: { v: VERSION, kind: PLAN_IDENTITY_KIND, source: `jira/${jira}`, ...at } };
    if (issue !== null) return { identity: { v: VERSION, kind: PLAN_IDENTITY_KIND, source: `github/${issue}`, ...at } };
    return { error: 'the implementation report has no issue or Jira work source to identify' };
  }
  if (pr === null) return { error: 'the write report has no implementation pull request to identify' };
  if (!REQUEST_KINDS.includes(command)) return { error: `\`${command}\` has no durable write-report identity` };
  const request = positive(env.COMMENT_ID);
  if (request !== null) return { identity: { v: VERSION, kind: command, pr, request } };
  const labelled = command === LABEL_KIND ? labelSourceOf(env) : '';
  if (labelled !== '') return { identity: { v: VERSION, kind: command, pr, source: labelled } };
  return { error: `the \`${command}\` report has no triggering comment id to identify` };
}

function labelSourceOf(env) {
  const source = `label/${String(env.REQUEST_LABEL ?? '')}@${String(env.REQUEST_HEAD ?? '').trim().toLowerCase()}`;
  return validLabelSource(source) ? source : '';
}

function liveEnv(env) {
  return { ...env, COMMENT_ID: env.REQUEST_COMMENT_ID };
}

function liveIdentityOf(env) {
  return identityOf(liveEnv(env));
}

function identityMarker(identity) {
  return `${IDENTITY_PREFIX}${markerJson(identity)} -->`;
}

const SHAPES = Object.freeze([
  { linkRuns: true, withArms: true, notes: null, withHistoricalSelections: true },
  { linkRuns: true, withArms: true, notes: null, withHistoricalSelections: false },
  { linkRuns: false, withArms: true, notes: null, withHistoricalSelections: false },
  { linkRuns: true, withArms: false, notes: null, withHistoricalSelections: false },
  { linkRuns: false, withArms: false, notes: null, withHistoricalSelections: false },
  { linkRuns: false, withArms: false, notes: 4, withHistoricalSelections: false },
  { linkRuns: false, withArms: false, notes: 1, withHistoricalSelections: false },
  { linkRuns: false, withArms: false, notes: 0, withHistoricalSelections: false },
  { linkRuns: false, withArms: false, notes: 0, withHistoricalSelections: false, withoutOldVerificationCommands: true },
  { linkRuns: false, withArms: false, notes: 0, withHistoricalSelections: false, withoutOldVerification: true },
]);

function historyOf(state, triggerPhrase = null) {
  const all = Array.isArray(state?.history) ? state.history : [];
  const held = all.length > MAX_HISTORY ? all.slice(-MAX_HISTORY) : all;
  return held
    .filter((entry) => Number.isSafeInteger(entry?.at) && entry.at > 0 && typeof entry?.said === 'string')
    .map((entry) => ({ at: entry.at, said: oneLine(cutNote(entry.said), { triggerPhrase }) }))
    .filter((entry) => entry.said !== '')
    .slice(-MAX_HISTORY);
}

const STAGED = (history) => history.map((entry) => ({ ...entry, stage: 'working' }));

function noted(state, said, at, triggerPhrase) {
  const when = Number(at);
  const words = oneLine(String(said ?? ''), { triggerPhrase });
  if (words === '' || !Number.isFinite(when) || when <= 0) return historyOf(state, triggerPhrase);
  const grown = appendHistory(STAGED(historyOf(state, triggerPhrase)), {
    at: Math.trunc(when),
    stage: 'working',
    said: words,
  });
  return grown.map((entry) => ({ at: entry.at, said: entry.said }));
}

function stateMarker(state) {
  return writeStateMarker({
    v: state.v,
    identity: state.identity,
    run_base: state.run_base,
    history: historyOf(state),
    attempts: state.attempts,
  });
}

const sameIdentity = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function parseState(body, identity) {
  const matches = [...String(body ?? '').matchAll(STATE_SHAPE_ALL)];
  if (matches.length !== 1) return { error: `the write report carries ${matches.length} state markers instead of one` };
  let state;
  try {
    state = JSON.parse(matches[0][1]);
  } catch {
    return { error: 'the write report state marker is not valid JSON' };
  }
  if (!state || state.v !== VERSION || !sameIdentity(state.identity, identity) ||
      !/^https:\/\/[^\s]{1,240}$/.test(String(state.run_base ?? '')) || !Array.isArray(state.a)) {
    return { error: 'the write report state marker has the wrong version or identity' };
  }
  const kinds = Array.isArray(state.k) ? state.k : [];
  const attempts = state.a.map((attempt) => unpackAttempt(attempt, kinds));
  if (attempts.length > MAX_ATTEMPTS || !attempts.every((attempt) => validAttempt(attempt))) {
    return { error: 'the write report state marker carries invalid attempts' };
  }
  const ids = attempts.map((attempt) => attempt.id);
  if (new Set(ids).size !== ids.length) return { error: 'the write report state marker repeats an attempt id' };
  const history = historyOf({
    history: (Array.isArray(state.h) ? state.h : []).map((entry) => ({ at: entry?.[0], said: entry?.[1] })),
  });
  return { state: { v: state.v, identity: state.identity, run_base: state.run_base, history, attempts } };
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function spendFromExecution(raw, called) {
  if (!called) return { paid: false };
  const { result } = finalResult(raw);
  if (!result) {
    return { paid: true, duration_s: null, turns: null, input_tokens: null, output_tokens: null, cost_usd: null };
  }
  const usage = result.usage;
  const inputParts = usage && [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  const input = inputParts && inputParts.every((value) => numberOrNull(value) !== null)
    ? inputParts.reduce((sum, value) => sum + Number(value), 0)
    : null;
  return {
    paid: true,
    duration_s: numberOrNull(result.duration_ms) === null ? null : Math.round(Number(result.duration_ms) / 1000),
    turns: numberOrNull(result.num_turns),
    input_tokens: input,
    output_tokens: numberOrNull(usage?.output_tokens),
    cost_usd: numberOrNull(result.total_cost_usd),
  };
}

function spendFromFields({ called, cost, input, output, duration = null, turns = null }) {
  if (!called) return { paid: false };
  return {
    paid: true,
    duration_s: numberOrNull(duration),
    turns: numberOrNull(turns),
    input_tokens: numberOrNull(input),
    output_tokens: numberOrNull(output),
    cost_usd: numberOrNull(cost),
  };
}

function spendFromStatus(raw) {
  let record;
  try {
    record = JSON.parse(String(raw ?? ''));
  } catch {
    return { paid: false };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { paid: false };
  const requests = Number(record.summary_requests);
  const answers = Number(record.summary_answers);
  if (!Number.isSafeInteger(requests) || requests <= 0 || requests > MAX_STATUS_RUNS) return { paid: false };
  const complete = Number.isSafeInteger(answers) && answers === requests && record.usage_complete === true;
  return {
    paid: true,
    paid_runs: requests,
    duration_s: null,
    turns: null,
    input_tokens: complete ? numberOrNull(record.input_tokens) : null,
    output_tokens: complete ? numberOrNull(record.output_tokens) : null,
    cost_usd: complete ? numberOrNull(record.cost_usd) : null,
  };
}

function sumMetric(parts, key) {
  const paid = parts.filter((part) => part.paid);
  if (paid.length === 0 || paid.some((part) => part[key] === null)) return null;
  return paid.reduce((sum, part) => sum + part[key], 0);
}

function aggregateSpend(parts) {
  return {
    paid_runs: parts.reduce((sum, part) => sum + (part.paid ? Number(part.paid_runs ?? 1) : 0), 0),
    duration_s: sumMetric(parts, 'duration_s'),
    turns: sumMetric(parts, 'turns'),
    input_tokens: sumMetric(parts, 'input_tokens'),
    output_tokens: sumMetric(parts, 'output_tokens'),
    cost_usd: sumMetric(parts, 'cost_usd'),
  };
}

function readExecution(file) {
  const named = String(file ?? '').trim();
  if (named === '') return '';
  try {
    return fs.readFileSync(named, 'utf8');
  } catch {
    return '';
  }
}

function currentOfEnv(env) {
  const named = String(env.CURRENT_FILE ?? '').trim();
  if (named !== '') {
    try {
      return fs.readFileSync(named, 'utf8');
    } catch {
      return env.CURRENT;
    }
  }
  return env.CURRENT;
}

function verificationOfEnv(env) {
  const named = String(env.VERIFICATION_FILE ?? '').trim();
  if (named === '') return null;
  try {
    return JSON.parse(fs.readFileSync(named, 'utf8'));
  } catch {
    return null;
  }
}

function wasCalled(value) {
  return ['success', 'failure', 'cancelled', 'true'].includes(String(value ?? ''));
}

function attemptId(env) {
  const runId = String(env.RUN_ID ?? '');
  const runAttempt = String(env.RUN_ATTEMPT ?? '');
  const job = String(env.JOB ?? '');
  const jobIndex = String(env.JOB_INDEX ?? '');
  if (!/^\d{1,20}$/.test(runId) || !/^\d{1,10}$/.test(runAttempt) ||
      !/^[A-Za-z0-9_.-]{1,136}$/.test(job) || !/^\d{1,10}$/.test(jobIndex)) return '';
  const id = [runId, runAttempt, compactJob(job), jobIndex].join(':');
  return ATTEMPT_ID_SHAPE.test(id) ? id : '';
}

function runOfAttempt(id) {
  const runId = String(id ?? '').split(':')[0];
  return /^\d{1,20}$/.test(runId) ? runId : '';
}

function actionsClient(github, env = process.env) {
  const token = String(env.EVIDENCE_TOKEN ?? '');
  return token === '' ? github : new github.constructor({ auth: token, baseUrl: env.GITHUB_API_URL });
}

function refusalOf(error) {
  const said = String(error?.message ?? error ?? '')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const code = Number(error?.status ?? 0);
  const reason = said === '' ? 'no reason given' : said;
  return code > 0 ? `${code} ${reason}` : reason;
}

async function planHeldBy({
  github, actionsGithub = null, owner, repo, state, attempt, unreadable = [],
  env = process.env, fetch = globalThis.fetch,
}) {
  const client = actionsGithub ?? github;
  const mine = runOfAttempt(attempt.id);
  const working = state.attempts
    .filter((entry) => WORKING_OUTCOMES.includes(entry.outcome))
    .map((entry) => runOfAttempt(entry.id))
    .filter((runId) => runId !== '' && runId !== mine);
  const asked = [...new Set(working)];
  if (asked.length === 0) return '';

  for (const { runId, status, why } of await runStates({ client, owner, repo, runs: asked, env, fetch })) {
    if (why !== '') {
      unreadable.push(
        `the plan claim could not read whether run ${runId} is still working this plan (${why}), ` +
        'so it was treated as finished and this run went ahead',
      );
      continue;
    }
    if (status !== '' && status !== 'completed') return runId;
  }
  return '';
}

async function runStates({ client, owner, repo, runs, env = process.env, fetch = globalThis.fetch }) {
  if (usingControlPlane(env)) {
    const read = await cpReport.readRunStates({ runs, env, fetch });
    if (read.why) return runs.map((runId) => ({ runId: String(runId), status: '', why: read.why }));
    const answered = Array.isArray(read.answer?.runs) ? read.answer.runs : [];
    const held = answered.map((one) => ({
      runId: String(one?.run ?? ''),
      status: String(one?.status ?? ''),
      why: String(one?.unreadable ?? ''),
    }));
    const named = new Set(held.map((one) => one.runId));
    for (const runId of runs) {
      if (!named.has(String(runId))) {
        held.push({ runId: String(runId), status: '', why: 'the control plane answered nothing for this run' });
      }
    }
    return held;
  }

  const held = [];
  for (const runId of runs) {
    try {
      const { data } = await client.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) });
      held.push({ runId: String(runId), status: String(data?.status ?? ''), why: '' });
    } catch (error) {
      held.push({ runId: String(runId), status: '', why: refusalOf(error) });
    }
  }
  return held;
}

function armModel(value) {
  const said = String(value ?? '').trim();
  return ARM_MODEL_SHAPE.test(said) ? said : '';
}

function armEffort(value) {
  const said = String(value ?? '').trim();
  return ARM_EFFORT_SHAPE.test(said) ? said : '';
}

function armsOf(env, parts) {
  const named = [
    [armModel(env.CLASSIFIER_MODEL), armEffort(env.CLASSIFIER_EFFORT)],
    [armModel(env.WRITE_TRIAGE_MODEL), armEffort(env.WRITE_TRIAGE_EFFORT)],
    [armModel(env.DISPUTE_MODEL), armEffort(env.DISPUTE_EFFORT)],
    [armModel(env.MODEL), armEffort(env.EFFORT)],
    [armModel(env.STATUS_MODEL), armEffort(env.STATUS_EFFORT)],
  ];
  const arms = [];
  for (const [index, name] of ARMS.entries()) {
    const part = parts[index];
    if (!part?.paid) continue;
    const runs = Number(part.paid_runs ?? 1);
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_PAID_RUNS) continue;
    const cost = part.cost_usd ?? null;
    arms.push([name, named[index][0], named[index][1], runs, cost === null ? null : Math.round(cost * 1e4) / 1e4]);
  }
  return arms;
}

function reasonToken(value) {
  const said = oneLine(value ?? '').toLowerCase();
  if (!said) return null;
  return REASON_SHAPE.test(said) ? said : UNCLASSIFIED_REASON;
}

function runSettingsArm(value) {
  const named = oneLine(value ?? '').trim();
  return named !== '' && RUN_SETTINGS_ARM_SHAPE.test(named) ? named : null;
}

function spendOfEnv(env) {
  const parts = [
    spendFromFields({
      called: String(env.CLASSIFIER_MODEL ?? '') !== '',
      cost: env.CLASSIFIER_COST,
      input: env.CLASSIFIER_INPUT,
      output: env.CLASSIFIER_OUTPUT,
      duration: env.CLASSIFIER_DURATION,
      turns: env.CLASSIFIER_TURNS,
    }),
    spendFromFields({
      called: wasCalled(env.WRITE_TRIAGE_CALLED),
      cost: env.WRITE_TRIAGE_COST,
      input: env.WRITE_TRIAGE_INPUT,
      output: env.WRITE_TRIAGE_OUTPUT,
      duration: env.WRITE_TRIAGE_DURATION,
      turns: env.WRITE_TRIAGE_TURNS,
    }),
    spendFromFields({
      called: wasCalled(env.DISPUTE_CALLED),
      cost: env.DISPUTE_COST,
      input: env.DISPUTE_INPUT,
      output: env.DISPUTE_OUTPUT,
      duration: env.DISPUTE_DURATION,
      turns: env.DISPUTE_TURNS,
    }),
    spendFromExecution(readExecution(env.MAIN_EXECUTION), wasCalled(env.MAIN_CALLED)),
    spendFromStatus(env.STATUS),
  ];
  return { ...aggregateSpend(parts), arms: armsOf(env, parts) };
}

function attemptOf(env = process.env, now = Date.now()) {
  const id = attemptId(env);
  const url = String(env.RUN_URL ?? '');
  const runId = String(env.RUN_ID ?? '');
  const suffix = `/actions/runs/${runId}`;
  if (id === '' || !/^https:\/\/[^\s]{1,280}$/.test(url) || !url.endsWith(suffix)) {
    return { error: 'the write report could not identify this run attempt' };
  }
  const runBase = url.slice(0, -String(runId).length - 1);
  if (!/^https:\/\/[^\s]{1,240}$/.test(runBase)) return { error: 'the write report run base is invalid' };
  const model = String(env.MODEL ?? '');
  const effort = String(env.EFFORT ?? '');
  const modelSource = String(env.MODEL_SOURCE ?? 'input');
  const effortSource = String(env.EFFORT_SOURCE ?? 'input');
  const attempt = {
    id,
    phase: oneLine(env.PHASE || env.COMMAND || 'write').slice(0, 24),
    outcome: oneLine(env.OUTCOME || 'running').slice(0, 24),
    model,
    effort,
    model_source: modelSource,
    effort_source: effortSource,
    selection: cutSelection(oneLine(env.SELECTION || 'selection pending')),
    route_command: String(env.ROUTE_COMMAND ?? ''),
    route_surface: String(env.ROUTE_SURFACE ?? ''),
    route_source: String(env.ROUTE_SOURCE ?? ''),
    at: Number.isSafeInteger(now) && now > 0 ? Math.floor(now / 1000) : null,
    reason: reasonToken(env.REASON),
    run_settings_arm: runSettingsArm(env.RUN_SETTINGS_ARM),
    verification: verificationOfEnv(env),
    commit_sha: /^[a-f0-9]{40}$/.test(String(env.COMMIT_SHA ?? '')) ? String(env.COMMIT_SHA) : null,
    ...spendOfEnv(env),
  };
  return validAttempt(attempt) ? { attempt, run_base: runBase } : { error: 'this run attempt is not valid write-report state' };
}

function mergeAttempt(state, attempt) {
  const attempts = [...state.attempts];
  const index = attempts.findIndex((entry) => entry.id === attempt.id);
  if (index === -1) attempts.push(attempt);
  else attempts[index] = attempt;
  if (attempts.length > MAX_ATTEMPTS) return { error: `the write report already holds ${MAX_ATTEMPTS} run attempts` };
  return {
    state: {
      v: VERSION,
      identity: state.identity,
      run_base: state.run_base,
      history: historyOf(state),
      attempts,
    },
  };
}

function armCostOf(attempt) {
  let known = 0;
  let missing = false;
  for (const arm of attempt.arms ?? []) {
    const fields = armFields(arm);
    if (fields === null) continue;
    if (fields.cost === null) missing = true;
    else known += fields.cost;
  }
  return { known, missing };
}

function tickingAttempt(state, live) {
  if (live === null) return null;
  const named = String(live.attempt ?? '');
  const found = named === '' ? state.attempts.at(-1) : state.attempts.find((entry) => entry.id === named);
  return WORKING_OUTCOMES.includes(found?.outcome) ? found : null;
}

function totalOf(state, live = null) {
  const on = tickingAttempt(state, live);
  const ticking = on !== null;
  const estimated = live?.cost;
  const priced = ticking && typeof estimated === 'number' && Number.isFinite(estimated);
  const running = priced && estimated > 0 ? estimated : null;
  const paid = state.attempts.reduce((sum, attempt) => sum + attempt.paid_runs, 0) + (ticking ? 1 : 0);
  let known = 0;
  let unknown = ticking && !priced;
  for (const attempt of state.attempts) {
    if (attempt.cost_usd !== null) {
      known += attempt.cost_usd;
      continue;
    }
    const arms = armCostOf(attempt);
    known += arms.known;
    if (attempt.paid_runs > 0 && (arms.missing || arms.known === 0)) unknown = true;
  }
  if (running !== null) known += running;
  return { paid, known, unknown, running, ticking, on: on?.id ?? null };
}

const REPORT_COLUMNS = Object.freeze(['#', 'Phase', 'Request', 'Result', 'Model', 'Turns', 'Cost']);

const usd = (dollars) => `$${dollars.toFixed(4)}`;

function costCell(attempt, running) {
  if (running !== null) return `~${usd((attempt.cost_usd ?? 0) + running)}`;
  return attempt.cost_usd === null ? BLANK_CELL : usd(attempt.cost_usd);
}

function attemptCells(attempt, runBase, at, linkRun, running) {
  const runId = attempt.id.split(':', 1)[0];
  return [
    linkRun ? `[${at}](${runBase}/${runId})` : String(at),
    `\`${attempt.phase}\``,
    attempt.route_command === '' ? BLANK_CELL : `\`${attempt.route_command}\``,
    `\`${attempt.outcome}\``,
    `\`${armLabel(attempt.model, attempt.effort)}\``,
    attempt.turns === null ? BLANK_CELL : String(attempt.turns),
    costCell(attempt, running),
  ];
}

function attemptTable(attempts, runBase, linkRun, running, on = null) {
  const ticking = on ?? attempts.at(-1)?.id ?? null;
  return reportTable(
    REPORT_COLUMNS,
    attempts.map((attempt, at) =>
      attemptCells(attempt, runBase, at + 1, linkRun, attempt.id === ticking ? running : null)),
  );
}

function armTotals(state) {
  const held = new Map();
  for (const attempt of state.attempts) {
    for (const arm of attempt.arms ?? []) {
      const fields = armFields(arm);
      if (fields === null) continue;
      const { name, model, effort, runs, cost } = fields;
      const key = `${name}\u0000${model}`;
      const row = held.get(key) ?? { name, model, effort, runs: 0, cost: 0, unknown: false };
      if (row.effort !== effort) row.effort = '';
      row.runs += runs;
      if (cost === null) row.unknown = true;
      else row.cost += cost;
      held.set(key, row);
    }
  }
  const rows = [...held.values()].sort(
    (left, right) => ARMS.indexOf(left.name) - ARMS.indexOf(right.name) || left.model.localeCompare(right.model),
  );
  return rows.length > MAX_ARM_ROWS ? perArm(rows) : rows;
}

function perArm(rows) {
  const held = new Map();
  for (const row of rows) {
    const kept = held.get(row.name);
    if (kept === undefined) {
      held.set(row.name, { ...row });
      continue;
    }
    if (kept.model !== row.model) kept.model = '';
    if (kept.effort !== row.effort) kept.effort = '';
    kept.runs += row.runs;
    kept.cost += row.cost;
    kept.unknown = kept.unknown || row.unknown;
  }
  return [...held.values()].sort((left, right) => ARMS.indexOf(left.name) - ARMS.indexOf(right.name));
}

const ASIDE = Object.freeze(
  Object.assign(Object.create(null), {
    classifier: 'reading the comment',
    triage: 'deciding how to run it',
    dispute: 'judging the review threads',
    status: 'saying what it was doing',
  }),
);

const MANY_ASIDES = 'the runs around it';

function spendSplit(state) {
  const rows = armTotals(state);
  if (rows.length === 0) return null;
  const work = rows.filter((row) => row.name === 'main');
  const aside = rows.filter((row) => row.name !== 'main');
  const money = (some) => some.reduce((held, row) => held + row.cost, 0);
  const vague = some => some.some((row) => row.unknown);
  const names = [...new Set(aside.map((row) => row.name))];
  return {
    work: { cost: money(work), unknown: vague(work), any: work.length > 0 },
    aside: {
      cost: money(aside),
      unknown: vague(aside),
      any: aside.length > 0,
      said: names.length === 1 ? ASIDE[names[0]] ?? MANY_ASIDES : MANY_ASIDES,
    },
  };
}

const spentSaid = (part) => `${usd(part.cost)}${part.unknown ? ' known' : ''}`;

function spendLine(state) {
  const split = spendSplit(state);
  if (split === null) return [];
  const said = [];
  if (split.work.any) said.push(`Doing the work cost ${spentSaid(split.work)}`);
  if (split.aside.any) said.push(`${split.aside.said} cost ${spentSaid(split.aside)}`);
  return spendSaid(said);
}

function currentText(value, triggerPhrase) {
  const safe = neutralize(scrub(String(value ?? ''), { triggerPhrase }).trim());
  const points = [...safe];
  const current = points.length > MAX_CURRENT_CHARS
    ? `${points.slice(0, MAX_CURRENT_CHARS - 1).join('')}…`
    : safe;
  return current || 'Work is in progress.';
}

const REPORT_HEADING = Object.freeze(
  Object.assign(Object.create(null), {
    initializing: reporting('run-started'),
    running: reporting('write-report'),
    blocked: reporting('plan-blocked'),
    failed: reporting('run-failed'),
    paused: reporting('run-paused', { next: 'somebody resumes the plan' }),
    ...STATUS_TABLE,
  }),
);

const UNVERIFIED_HEADING = reporting('do-unverified');
const UNVERIFIED_SUMMARY = 'The targeted check was not reproduced. This report makes no verification claim.';
const FIX_CLAIM_OUTCOMES = Object.freeze(['changed', 'unchanged']);

const standingHold = (env) => String(env?.PLAN_HELD ?? '').trim() !== '';
const unverifiedReport = (state) => {
  const last = state.attempts.at(-1);
  return FIX_CLAIM_OUTCOMES.includes(String(last?.outcome ?? '')) &&
    last?.verification?.status === 'unverified';
};

function headingRow(state, paused) {
  if (unverifiedReport(state)) return UNVERIFIED_HEADING;
  const outcome = paused ? 'paused' : String(state.attempts.at(-1)?.outcome ?? '');
  return REPORT_HEADING[outcome] ?? REPORT_HEADING.running;
}

function reportHeading({ row, command, said, triggerPhrase, fields, paused = false, standing = false }) {
  if (carriesHeading(said)) return '';
  const shown = standing && !paused ? { ...row, next: REPORT_HEADING.paused.next } : row;
  const heading = headedBlock(shown, { command, flow: 'implement', href: href(fields), triggerPhrase });
  if (row !== UNVERIFIED_HEADING || heading === '') return heading;
  return asAlert(
    'WARNING',
    `${heading}\n\nThe targeted check was not reproduced, so this report does not claim the failure is fixed.`,
  );
}

function commandsBlock(verification) {
  if (verification === null || verification === undefined) return [];
  const commands = Array.isArray(verification.commands) ? verification.commands : [];
  const codeCell = (value) => {
    const text = String(value).replace(/\|/g, '\\|').replace(/\r\n?|\n/g, ' ');
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  };
  const rows = commands.map(([command, exit], index) => [
    String(index + 1),
    codeCell(command),
    exit === null ? 'unavailable' : `\`${exit}\``,
  ]);
  const notes = [];
  if (verification.commands_state === 'unavailable') {
    notes.push('The command event stream was unavailable, so executed commands cannot be listed.');
  } else if (verification.commands_state === 'incomplete') {
    notes.push('The command event stream was malformed or incomplete; only its readable prefix is listed.');
  } else if (verification.commands_state === undefined) {
    notes.push('The command ledger was not recorded for this attempt.');
  } else if (commands.length === 0) {
    rows.push(['—', 'No completed Bash command was recorded', '—']);
  }
  if (verification.commands_capped === true) {
    notes.push('The command ledger reached its display/storage bound; only the bounded prefix is listed.');
  }
  const table = rows.length === 0 ? [] : ['', ...reportTable(['#', 'Command', 'Exit status'], rows)];
  return ['', '### Commands executed', ...table, ...notes.flatMap((note) => ['', note])];
}

function renderWriteReport({
  state,
  current,
  issue,
  run,
  triggerPhrase,
  command = '',
  ask = null,
  doRequest = null,
  budget = PUBLISHED_LIMIT,
  live = null,
  historyMode = 'auto',
  paused = false,
  standing = false,
}) {
  const total = totalOf(state, live);
  const spent = usd(total.known);
  const cost = total.unknown
    ? `${spent} known${total.ticking ? ' so far' : ''}; some cost is unavailable`
    : `${spent} ${total.ticking ? 'so far' : 'total'}`;
  const row = headingRow(state, paused);
  const fields = {
    kind: paused || standing ? REPORT_HEADING.paused.kind : row.kind,
    flow: 'implement',
    issue,
    pr: state.identity.pr,
    run,
    command,
    jira: readWorkRef(state.identity.source).key ?? '',
    ask,
  };
  const doMarker = renderDoMarker(doRequest);
  const headingFor = (said) => reportHeading({ row, command, said, triggerPhrase, fields, paused, standing });
  const kept = row === UNVERIFIED_HEADING ? [] : historyOf(state, triggerPhrase);
  const follow = URL_SHAPE.test(String(live?.link ?? '')) ? `[Follow it](${live.link})` : '';
  const counters = [statusLine(live?.arm, live?.cells), follow].filter(Boolean).join(' · ');
  const render = (
    linkRuns,
    withArms,
    notes,
    withHistoricalSelections = true,
    withoutOldVerificationCommands = false,
    withoutOldVerification = false,
  ) => {
    const history = notes === null ? kept : kept.slice(Math.max(0, kept.length - notes));
    const trimmed = { ...state, history };
    const leaner = (attempt, index) => ({
      ...attempt,
      ...(withArms ? {} : { arms: [] }),
      ...(withHistoricalSelections || index === trimmed.attempts.length - 1 ? {} : { selection: '' }),
      ...(index < trimmed.attempts.length - 1 && attempt.verification
        ? withoutOldVerification
          ? { verification: null }
          : withoutOldVerificationCommands
            ? { verification: { ...attempt.verification, command: '', commands: [], commands_capped: false } }
            : {}
        : {}),
    });
    const held = withArms && withHistoricalSelections && !withoutOldVerificationCommands && !withoutOldVerification
      ? trimmed
      : { ...trimmed, attempts: trimmed.attempts.map(leaner) };
    const unverified = unverifiedReport(held);
    const selection = safeText(held.attempts.at(-1)?.selection);
    const lines = unverified ? [] : historyLines(STAGED(history), historyMode);
    const said = unverified
      ? [UNVERIFIED_SUMMARY]
      : lines.length === 0
        ? [currentText(current, triggerPhrase)]
        : lines;
    const heading = headingFor(said[0] ?? '');
    const commands = commandsBlock(held.attempts.at(-1)?.verification);
    return [
      ...(heading ? [heading, ''] : []),
      ...said,
      ...commands,
      ...(counters === '' ? [] : ['', counters]),
      ...(selection === '' ? [] : ['', `Selection: ${selection}`]),
      '',
      '---',
      '',
      '<details>',
      `<summary>Implementation report · ${counted(total.paid, 'paid run')} · ${cost}</summary>`,
      '',
      ...attemptTable(held.attempts, held.run_base, linkRuns, total.running, total.on),
      ...spendLine(held),
      '',
      '</details>',
      '',
      identityMarker(held.identity),
      stateMarker(held),
      ...(doMarker ? [doMarker] : []),
      marker(fields),
      '',
    ].join('\n');
  };
  let body = '';
  for (const shape of SHAPES) {
    body = render(
      shape.linkRuns,
      shape.withArms,
      shape.notes,
      shape.withHistoricalSelections,
      shape.withoutOldVerificationCommands,
      shape.withoutOldVerification,
    );
    if (body.length < budget) break;
  }
  return body;
}

function renderBudget(now) {
  const until = now() + LOCKED_RENDER_BUDGET;
  return () => Math.max(0, until - now());
}

function writing(store) {
  if (store.write) return store;
  return {
    ...store,
    write: async (ref, args, opts) => store.save(ref, await renderedReport(args, opts)),
  };
}

function reportRequest(args) {
  return {
    state: args.state,
    ...(args.event ? { event: args.event } : { current: String(args.current ?? '') }),
    issue: String(args.issue ?? ''),
    run: String(args.run ?? ''),
    trigger: String(args.triggerPhrase ?? ''),
    command: String(args.command ?? ''),
    ask: String(args.ask ?? ''),
    do_request: String(args.doRequest ?? ''),
    budget: args.budget ?? null,
    live: args.live ?? null,
    history_mode: String(args.historyMode ?? ''),
    paused: args.paused === true,
    standing: args.standing === true,
  };
}

async function renderedReport(args, { env = process.env, fetch = globalThis.fetch, timeout = LOCKED_RENDER_BUDGET } = {}) {
  const { value } = await cpRender.rendered({
    kind: 'write_report',
    request: reportRequest(args),
    local: () => ({ body: renderWriteReport(args) }),
    fallback: (why, mine) => ({
      body: mine
        ? cpRender.withMarkers(cpRender.unrendered('this report', why, env), mine.body)
        : [cpRender.unrendered('this report', why, env), '', identityMarker(args.state.identity), stateMarker(args.state), ''].join('\n'),
    }),
    env,
    fetch,
    timeout,
  });
  return String(value?.body ?? '');
}

const sameLogin = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();

function hasExactMarker(body, exact) {
  return String(body ?? '').split('\n').some((line) => line.replace(/\r$/, '') === exact);
}

function trusted(comment, logins) {
  return logins.some((login) => login !== '' && sameLogin(comment?.user?.login, login));
}

async function readPull({ github, owner, repo, prNumber }) {
  try {
    return { pull: (await github.rest.pulls.get({ owner, repo, pull_number: prNumber })).data ?? {} };
  } catch (error) {
    return {
      missing: Number(error?.status) === 404,
      error: `the implementation pull request could not be read (${error.message})`,
    };
  }
}

async function reportContext({ github, owner, repo, identity, botLogin }) {
  const logins = [String(botLogin ?? '').trim()];
  if (positive(identity.pr) !== null) {
    const got = await readPull({ github, owner, repo, prNumber: identity.pr });
    if (got.error) return { error: got.error };
    if (identity.kind === PLAN_IDENTITY_KIND) logins.push(String(got.pull?.user?.login ?? '').trim());
  }
  if (logins.every((login) => login === '')) return { error: 'no trusted write-report author could be resolved' };
  return { logins };
}

async function findReport({ github, owner, repo, identity, logins, thread }) {
  const matches = [];
  const exact = identityMarker(identity);
  const { unreadable } = await probeComments({
    github,
    owner,
    repo,
    prNumber: thread,
    maxPages: MAX_PAGES,
    cannot: 'write-report lookup cannot be trusted',
    take: (comment) => {
      if (trusted(comment, logins) && hasExactMarker(comment?.body, exact)) matches.push(comment);
    },
  });
  if (unreadable) return { error: unreadable };
  if (matches.length > 1) return { error: `write-report lookup found ${matches.length} trusted comments for one logical unit` };
  return { comment: matches[0] ?? null };
}

async function readComment({ github, owner, repo, id, identity, logins }) {
  let comment;
  try {
    comment = (await github.rest.issues.getComment({ owner, repo, comment_id: id })).data;
  } catch (error) {
    return { missing: Number(error?.status) === 404, error: error.message };
  }
  if (!trusted(comment, logins) || !hasExactMarker(comment?.body, identityMarker(identity))) {
    return { error: 'the write-report comment failed its author or identity verification' };
  }
  const parsed = parseState(comment.body, identity);
  return parsed.error ? parsed : { comment, state: parsed.state };
}

function reportThread(identity, thread) {
  return positive(identity?.pr) ?? positive(thread);
}

function commentStore({ github, owner, repo, identity, logins, knownId = null, thread = null }) {
  const at = reportThread(identity, thread);
  return {
    idOf: (ref) => String(ref?.id ?? ''),
    budget: () => PUBLISHED_LIMIT,
    async load() {
      let id = positive(knownId);
      if (id === null) {
        const found = await findReport({ github, owner, repo, identity, logins, thread: at });
        if (found.error) return { error: found.error };
        if (!found.comment) return { ref: null, state: null };
        id = found.comment.id;
      }
      const read = await readComment({ github, owner, repo, id, identity, logins });
      if (read.missing) return { missing: true };
      if (read.error) return { error: read.error };
      return { ref: { id: read.comment.id, body: read.comment.body }, state: read.state };
    },
    async save(ref, rendered) {
      if (ref === null) {
        const posted = await github.rest.issues.createComment({ owner, repo, issue_number: at, body: rendered });
        const id = positive(posted?.data?.id);
        if (id === null) return { error: 'GitHub created the write report without returning its comment id' };
        return { ref: { id } };
      }
      if (String(ref.body ?? '') === rendered) return { ref, unchanged: true };
      try {
        await github.rest.issues.updateComment({ owner, repo, comment_id: ref.id, body: rendered });
      } catch (error) {
        return { missing: Number(error?.status) === 404, error: error.message };
      }
      return { ref };
    },
  };
}

function bodyStore({ github, owner, repo, identity, mayCreate = false }) {
  return {
    idOf: () => '',
    budget: (ref) => {
      const body = String(ref?.body ?? '');
      const found = locateStatus(body);
      const held = body.length - (found.absent || found.error ? 0 : found.end - found.start);
      return Math.max(0, PUBLISHED_LIMIT - held - STATUS_BEGIN.length - STATUS_END.length - RESERVED_BODY_CHARS);
    },
    async load() {
      const got = await readPull({ github, owner, repo, prNumber: identity.pr });
      if (got.missing) return { missing: true };
      if (got.error) return { error: got.error };
      const body = String(got.pull.body ?? '');
      const found = locateStatus(body);
      if (found.error) return { error: found.error };
      const ref = { body };
      if (found.absent) {
        if (!mayCreate) {
          return {
            error:
              'the pull request body carries no run report, and this phase cannot be the one that opens it - ' +
              'the report is written before any step runs, so an absent region here means it was removed from ' +
              'the description. Restore it from the edit history, or the spend already accounted for is lost.',
          };
        }
        return { ref, state: null };
      }
      if (!hasExactMarker(body, identityMarker(identity))) {
        return {
          error:
            'the pull request body carries a run report written for different work, so this run will not ' +
            'overwrite it. Remove the ksai-status region from the description if it was pasted in from ' +
            'another pull request.',
        };
      }
      const parsed = parseState(body, identity);
      return parsed.error ? parsed : { ref, state: parsed.state };
    },
    async save(ref, rendered) {
      const spliced = spliceStatus(String(ref?.body ?? ''), rendered);
      if (spliced.error) return { error: spliced.error };
      if (!spliced.changed) return { ref, unchanged: true };
      try {
        await github.rest.pulls.update({ owner, repo, pull_number: identity.pr, body: spliced.body });
      } catch (error) {
        return {
          missing: Number(error?.status) === 404,
          error: `the pull request body could not be updated (${error.message})`,
        };
      }
      return { ref: { body: spliced.body } };
    },
  };
}

function storesInBody(identity) {
  return identity?.kind === PLAN_IDENTITY_KIND && positive(identity?.pr) !== null;
}

function controlPlaneStore({ identity, number, where, env = process.env, fetch = globalThis.fetch }) {
  const kind = 'write_report';
  const asking = { state: { identity } };
  return {
    idOf: (ref) => String(ref?.id ?? ''),
    budget: () => PUBLISHED_LIMIT,
    async load() {
      const held = await cpReport.heldReport({ kind, request: asking, number, where, env, fetch });
      if (held.none) return { ref: null, state: null };
      if (held.why) return { error: held.why };
      const parsed = parseState(held.body, identity);
      return parsed.error ? parsed : { ref: { id: held.comment, body: held.body }, state: parsed.state };
    },
    /**
     * @param {{ id?: number, body?: string } | null} ref
     * @param {*} args
     * @param {{ fetch?: typeof globalThis.fetch, timeout?: number }} [asked]
     */
    async write(ref, args, { fetch: called = fetch, timeout } = {}) {
      const said = await cpReport.sayReport({
        kind,
        request: reportRequest(args),
        number,
        where,
        env,
        fetch: called,
        ...(timeout > 0 ? { timeout } : {}),
      });
      if (said.why) return { error: said.why };
      if (said.none) return { missing: true };
      return { ref: { id: said.comment, body: said.body }, unchanged: String(ref?.body ?? '') === said.body };
    },
  };
}

async function storeFor({
  github, owner, repo, identity, botLogin, knownId = null, phase = '', thread = null,
  env = process.env, fetch = globalThis.fetch,
}) {
  const inBody = storesInBody(identity);
  if (usingControlPlane(env)) {
    return {
      store: controlPlaneStore({
        identity,
        number: reportThread(identity, thread),
        where: inBody ? 'description' : 'comment',
        env,
        fetch,
      }),
    };
  }
  if (inBody) {
    const mayCreate = String(phase ?? '') === PLAN_PHASE;
    return { store: bodyStore({ github, owner, repo, identity, mayCreate }) };
  }
  const context = await reportContext({ github, owner, repo, identity, botLogin });
  if (context.error) return { error: context.error };
  return { store: commentStore({ github, owner, repo, identity, logins: context.logins, knownId, thread }) };
}

async function updateWriteProgressUnlocked({
  github,
  owner,
  repo,
  env = process.env,
  current = '',
  note = null,
  live = null,
  now = Date.now,
  fetch = globalThis.fetch,
}) {
  const blank = { recorded: '' };
  const identified = liveIdentityOf(env);
  if (identified.error) return { outputs: blank, failure: identified.error };
  const identity = identified.identity;
  const reading = live === null ? null : { ...live, attempt: attemptId(env) };
  const chosen = await storeFor({
    github,
    owner,
    repo,
    identity,
    botLogin: env.BOT_LOGIN,
    knownId: env.COMMENT_ID,
    thread: env.ISSUE_NUM,
    env,
    fetch,
  });
  if (chosen.error) return { outputs: blank, failure: chosen.error };
  const store = writing(chosen.store);
  const renderLeft = renderBudget(now);
  const cp = usingControlPlane(env);

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const read = await store.load();
    if (read.missing) return { outputs: blank, failure: 'the durable write report disappeared before its live update' };
    if (read.error) return { outputs: blank, failure: read.error };
    if (read.state === null) return { outputs: blank, failure: 'there is no durable write report to publish live progress into' };
    const before = read.state.attempts.map((entry) => entry.id);
    const existingRequest = doRequestOf(read.ref.body);
    const doRequest = existingRequest === String(identity.request) ? existingRequest : null;
    const grown = cp || note === null
      ? historyOf(read.state)
      : noted(read.state, currentText(note.said, env.TRIGGER), note.at ?? now(), env.TRIGGER);
    const saved = await store.write(read.ref, {
      state: { ...read.state, history: grown },
      current: cp ? '' : note === null ? current : note.said,
      ...(cp ? { event: { kind: 'progress', at: note?.at ?? now(), stage: note?.stage ?? '' } } : {}),
      issue: env.ISSUE_NUM,
      run: env.RUN_ID,
      triggerPhrase: env.TRIGGER,
      command: env.COMMAND,
      ask: env.KSAI_ASK,
      doRequest,
      budget: store.budget(read.ref),
      live: reading,
      historyMode: env.STATUS_HISTORY,
      standing: standingHold(env),
    }, { env, fetch, timeout: renderLeft() });
    if (saved.missing) return { outputs: blank, failure: 'the durable write report disappeared during its live update' };
    if (saved.error) return { outputs: blank, failure: `the durable write report could not publish live progress (${saved.error})` };
    const landed = { recorded: 'true' };
    if (saved.unchanged) return { outputs: landed, notices: ['the live status said nothing new, so nothing was published'] };
    const verified = await store.load();
    if (verified.missing) return { outputs: blank, failure: 'the durable write report disappeared after its live update' };
    if (verified.error) return { outputs: blank, failure: verified.error };
    const after = new Set((verified.state?.attempts ?? []).map((entry) => entry.id));
    if (!before.every((entryId) => after.has(entryId))) continue;
    return { outputs: landed };
  }
  return { outputs: blank, failure: 'the durable write report kept changing and could not publish live progress safely' };
}

async function mutateWriteReportUnlocked({
  github,
  actionsGithub = null,
  owner,
  repo,
  env = process.env,
  now = Date.now,
  fetch = globalThis.fetch,
}) {
  const identified = identityOf(env);
  if (identified.error) return { outputs: {}, failure: identified.error };
  const attempted = attemptOf(env, now());
  if (attempted.error) return { outputs: {}, failure: attempted.error };
  const identity = identified.identity;
  const chosen = await storeFor({
    github,
    owner,
    repo,
    identity,
    botLogin: env.BOT_LOGIN,
    phase: env.PHASE,
    thread: env.ISSUE_NUM,
    env,
    fetch,
  });
  if (chosen.error) return { outputs: {}, failure: chosen.error };
  const store = writing(chosen.store);
  const renderLeft = renderBudget(now);
  const cp = usingControlPlane(env);

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const read = await store.load();
    if (read.missing) continue;
    if (read.error) return { outputs: {}, failure: read.error };
    const fresh = read.state === null;
    if (!fresh && read.state.run_base !== attempted.run_base) {
      return { outputs: {}, failure: 'the durable write report names a different workflow run base' };
    }
    const held = read.state ?? { identity, run_base: attempted.run_base, history: [], attempts: [] };
    const claiming = WORKING_OUTCOMES.includes(attempted.attempt.outcome) &&
      !held.attempts.some((entry) => entry.id === attempted.attempt.id);
    const unreadable = [];
    if (claiming) {
      const holder = await planHeldBy({
        github,
        actionsGithub,
        owner,
        repo,
        state: held,
        attempt: attempted.attempt,
        unreadable,
        env,
        fetch,
      });
      if (holder !== '') {
        const where = `${attempted.run_base}/${holder}`;
        return {
          outputs: { held_by: where },
          notices: [...unreadable, `another run is already working this plan (${where}), so this one recorded nothing`],
        };
      }
    }
    const merged = mergeAttempt(held, attempted.attempt);
    if (merged.error) return { outputs: {}, failure: merged.error };
    const before = held.attempts.map((entry) => entry.id);
    const current = cp ? '' : currentOfEnv(env);
    const noteAt = numberOrNull(env.CURRENT_AT) ?? now();
    const saved = await store.write(read.ref, {
      state: { ...merged.state, history: cp ? historyOf(merged.state) :
        noted(merged.state, currentText(current, env.TRIGGER), noteAt, env.TRIGGER) },
      current,
      ...(cp ? { event: { kind: 'result', at: noteAt, step_title: env.STEP_TITLE ?? '' } } : {}),
      issue: env.ISSUE_NUM,
      run: env.RUN_ID,
      triggerPhrase: env.TRIGGER,
      command: env.COMMAND,
      ask: env.KSAI_ASK,
      doRequest: env.DO_REQUEST,
      budget: store.budget(read.ref),
      historyMode: env.STATUS_HISTORY,
      paused: String(env.HELD ?? '') === 'true',
      standing: standingHold(env),
    }, { env, fetch, timeout: renderLeft() });
    if (saved.missing) continue;
    if (saved.error) return { outputs: {}, failure: `the durable write report could not be updated (${saved.error})` };
    const verified = await store.load();
    if (verified.missing) continue;
    if (verified.error) return { outputs: {}, failure: verified.error };
    const after = new Set((verified.state?.attempts ?? []).map((entry) => entry.id));
    if (![...before, attempted.attempt.id].every((entryId) => after.has(entryId))) continue;
    return {
      outputs: {
        comment_id: store.idOf(verified.ref),
        recorded: 'true',
      },
      notices: [
        ...unreadable,
        fresh ? 'created and verified the durable write report' : 'merged and verified the durable write report',
      ],
    };
  }
  return { outputs: {}, failure: 'the durable write report kept changing and could not be merged safely' };
}

async function lockedMutation({ github, owner, repo, env, fetch, sleep, now, lockKind, recoverKinds, releaseRequired, task }) {
  const identified = identityOf(env);
  if (identified.error) return { outputs: {}, failure: identified.error };
  const lockOwner = String(env.ATTEMPT_ID || attemptId(env));
  const issueNumber = reportThread(identified.identity, env.ISSUE_NUM);
  let locked;
  if (usingControlPlane(env)) {
    locked = await withControlPlaneLock({ env, fetch, issueNumber, lockOwner, lockKind, recoverKinds,
      sleep, now, task });
  } else {
    const context = await reportContext({
      github,
      owner,
      repo,
      identity: identified.identity,
      botLogin: env.BOT_LOGIN,
    });
    if (context.error) return { outputs: {}, failure: context.error };
    locked = await withIssueLock({
      github, owner, repo, issueNumber, lockOwner, lockKind, recoverKinds,
      accept: (comment) => trusted(comment, context.logins), triggerPhrase: env.TRIGGER,
      sleep, task,
    });
  }
  if (locked.error) return { outputs: {}, failure: locked.error };
  const result = locked.value;
  if (locked.releasePending) {
    result.notices = [...(result.notices ?? []), 'the completed write-report mutation lock will be removed by the next mutation'];
  }
  if (locked.releaseError) {
    if (releaseRequired) {
      return { outputs: {}, failure: `the write-report mutation lock could not be released (${locked.releaseError})` };
    }
    result.notices = [...(result.notices ?? []), `the write-report mutation lock could not be released (${locked.releaseError})`];
  }
  return result;
}

async function updateWriteProgress({
  github,
  owner,
  repo,
  env = process.env,
  current = '',
  note = null,
  live = null,
  sleep,
  now = Date.now,
  fetch = globalThis.fetch,
}) {
  const result = await lockedMutation({
    github,
    owner,
    repo,
    env: liveEnv(env),
    fetch,
    sleep,
    now,
    lockKind: 'live',
    recoverKinds: [],
    releaseRequired: false,
    task: () => updateWriteProgressUnlocked({ github, owner, repo, env, current, note, live, now, fetch }),
  });
  const outputs = {
    recorded: result.outputs?.recorded ?? '',
  };
  return { ...result, outputs };
}

async function planHolder({ github, actionsGithub = null, owner, repo, env = process.env, fetch = globalThis.fetch }) {
  const outputs = {
    held_by: '',
  };
  const identified = identityOf(env);
  if (identified.error) return { outputs, notices: [identified.error] };
  const chosen = await storeFor({
    github,
    owner,
    repo,
    identity: identified.identity,
    botLogin: env.BOT_LOGIN,
    phase: env.PHASE,
    thread: env.ISSUE_NUM,
    env,
    fetch,
  });
  if (chosen.error) return { outputs, notices: [chosen.error] };
  const read = await chosen.store.load();
  if (read.error || read.missing || read.state === null) {
    return { outputs, notices: read.error ? [read.error] : [] };
  }
  const unreadable = [];
  const holder = await planHeldBy({
    github,
    actionsGithub,
    owner,
    repo,
    state: read.state,
    attempt: { id: attemptId(env) },
    unreadable,
    env,
    fetch,
  });
  if (holder === '') return { outputs, notices: unreadable };
  outputs.held_by = `${read.state.run_base}/${holder}`;
  return { outputs, notices: [...unreadable, `another run is already working this plan (${outputs.held_by})`] };
}

async function mutateWriteReport({
  github,
  actionsGithub = null,
  owner,
  repo,
  env = process.env,
  sleep,
  now = Date.now,
  fetch = globalThis.fetch,
}) {
  const result = await lockedMutation({
    github,
    owner,
    repo,
    env,
    fetch,
    sleep,
    now,
    lockKind: 'report',
    recoverKinds: ['live'],
    releaseRequired: true,
    task: () => mutateWriteReportUnlocked({ github, actionsGithub, owner, repo, env, now, fetch }),
  });
  const attempted = attemptOf(env, now());
  const outputs = {
    recorded: result.outputs?.recorded ?? '',
    spend_usd: attempted.error ? '' : String(attempted.attempt.cost_usd ?? ''),
  };
  return {
    ...result,
    outputs,
    commentId: result.outputs?.comment_id ?? '',
    heldBy: result.outputs?.held_by ?? '',
  };
}

module.exports = {
  IDENTITY_PREFIX,
  MAX_ATTEMPTS,
  STATE_PREFIX,
  STATE_SHAPE,
  REPORT_HEADING,
  VERSION,
  ARMS,
  actionsClient,
  aggregateSpend,
  armTotals,
  attemptOf,
  findReport,
  controlPlaneStore,
  identityMarker,
  identityOf,
  liveIdentityOf,
  mergeAttempt,
  mutateWriteReport,
  parseState,
  planHeldBy,
  planHolder,
  renderWriteReport,
  renderedReport,
  spendFromExecution,
  spendFromFields,
  spendFromStatus,
  stateMarker,
  storesInBody,
  totalOf,
  updateWriteProgress,
};
