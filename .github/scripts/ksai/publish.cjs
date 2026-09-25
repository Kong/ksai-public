const { writerFor } = require('../lib/cp-effects.cjs');
const fs = require('node:fs');
const { react } = require('../lib/react.cjs');
const { updateOrCreate } = require('../lib/comment.cjs');
const { watchdogDetail } = require('../lib/watchdog.cjs');
const { plural } = require('../lib/text.cjs');
const { releaseKind, renderReleased, renderWaiting, withPhaseRelease } = require('./checkpoint.cjs');
const {
  continueThroughControlPlane,
  decideContinuation,
  decidesLocally,
  dispatchSuccessor,
  renderStop,
  renderUndispatched,
  remainingOf,
  reportOf,
  stopsHere,
} = require('./continue.cjs');
const { finish } = require('./finish.cjs');
const { renderAwaiting, awaitingKind } = require('./gate.cjs');
const { workRefFor } = require('./context.cjs');
const { KINDS, KIND_TABLE, payloadFor, marked } = require('./marker.cjs');
const { decideFinish } = require('./phase.cjs');
const { checkStep, creditOf, scrub } = require('./plan.cjs');
const { asAlert } = require('../lib/select-arm.cjs');
const { renderClassifierFooter } = require('./classify.cjs');
const { NOTICE_KEYS, pick, renderedNotice } = require('../lib/cp-render.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');

async function commentNotice({ github, owner, repo, env, fetch, number, notice, local, what }) {
  const writer = writerFor({ github, owner, repo, env, fetch });
  const viaControlPlane = usingControlPlane(env);
  if (viaControlPlane) {
    try {
      const facts = pick(env, NOTICE_KEYS);
      if (notice.kind === 'tester_facts') {
        delete facts.NOTICE;
        delete facts.NOTICE_KIND;
      }
      if (notice.kind === 'stopped_selection' || notice.kind === 'stopped_preflight') {
        for (const ordered of NOTICE_ORDER) delete facts[ordered.body];
      }
      return await writer.noticeComment({ number, notice: { ...notice, env: facts } });
    } catch (error) {
      if (error.cpUnavailable !== true) throw error;
      process.stdout.write(`::warning::the control plane would not take this notice: ${error.message}\n`);
    }
  }
  const body = await renderedNotice({ notice, env, local, what, fetch });
  const fallback = viaControlPlane
    ? writerFor({ github, owner, repo, env: { ...env, KSAI_GITHUB_CALLS: 'local' }, fetch })
    : writer;
  return fallback.comment({ number, body });
}

function decideFinished(env) {
  const out = decideFinish({
    total: env.TOTAL,
    remainingAfter: env.REMAINING_AFTER,
    hasStep: env.HAS_STEP,
    isDraft: env.IS_DRAFT,
  });
  const outputs = {
    finish: out.finish ? 'true' : 'false',
  };
  return { outputs, notices: [`finish=${out.finish} (${out.reason})`] };
}

async function markReady({ github, core, owner, repo, env, fetch = globalThis.fetch }) {
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: Number(env.PR_NUMBER),
  });

  const out = await finish({
    github,
    core,
    owner,
    repo,
    prNumber: Number(env.PR_NUMBER),
    issueNumber: env.ISSUE_NUM,
    requester: creditOf(pull.body ?? ''),
    runId: env.RUN_ID,
    pull,
    triggerPhrase: env.TRIGGER,
    command: env.COMMAND,
    ask: env.KSAI_ASK,
    dryRun: env.DRY_RUN === 'true',
    env,
    fetch,
  });

  if (out.error) return { outputs: {}, notices: [], failure: out.error };
  return { outputs: {}, notices: [`ready=${out.ready}, notified=${out.notified ?? 'nobody'}`], failure: null };
}

async function say({ github, owner, repo, target, notice, request, env, warnings, fetch = globalThis.fetch }) {
  const local = () => ({ body: marked(notice, payloadFor(env, { kind: 'chain-stopped' })) });
  try {
    const stopped = { kind: 'chain_stopped', ...request };
    await commentNotice({ github, owner, repo, env, fetch, number: Number(target), notice: stopped,
      local, what: 'why this chain stopped' });
  } catch (error) {
    warnings.push(`the chain stopped and this could not say so: ${error.message}`);
  }
}

function reportTo({ core, env, workRef, report, fetch, pause }) {
  return continueThroughControlPlane({
    endpoint: env.CONTINUE_ENDPOINT,
    workRef,
    issueNumber: env.ISSUE_NUM,
    phase: env.PHASE,
    remaining: remainingOf(env),
    handsOff: env.HANDS_OFF,
    report,
    env,
    mint: (audience) => core.getIDToken(audience),
    secret: (token) => core.setSecret(token),
    fetch,
    pause,
  });
}

async function dispatchNext({ github, core, owner, repo, env, fetch: call = globalThis.fetch, pause }) {
  const outputs = {
    stops_here: '',
    successor: '',
  };
  const answer = (started) => {
    outputs.stops_here = stopsHere({ handsOff: env.HANDS_OFF, started });
    return outputs;
  };

  const report = reportOf(env);
  const remaining = remainingOf(env);

  const waiting = (unheard = '') => ({
    outputs: answer(false),
    notices: [`not dispatching: this run is waiting for a person (${report.reason || 'the control plane said so'})`],
    warnings:
      unheard === ''
        ? []
        : [`the control plane did not hear that this run waits for a person, so it may start the next run anyway: ${unheard}`],
  });

  const stopped = async (verdict) => {
    const notices = [`not dispatching: ${verdict.reason}`];
    const warnings = [];
    if (verdict.noticed === true) {
      notices.push('the control plane said the chain stopped, and said so on the pull request');
      return { outputs: answer(false), notices, warnings };
    }
    const notice = renderStop({ ...verdict, remaining, triggerPhrase: env.TRIGGER });
    const target = env.REPORT_NUM;
    if (notice && target) {
      const request = { reason: String(verdict.reason ?? ''), stall: String(verdict.stall ?? ''), attempt: String(verdict.attempt ?? '') };
      await say({ github, owner, repo, target, notice, request, env, warnings, fetch: call });
    } else if (notice) {
      warnings.push(`the flow stopped and there was nowhere to say so: ${notice}`);
    } else if (verdict.reason !== 'finished') {
      warnings.push(`the chain stopped for a reason this runner cannot say on the page: ${verdict.reason}`);
    }
    return { outputs: answer(false), notices, warnings };
  };

  const undispatched = async (reason) => {
    const warnings = [`the next run was not started, so this flow stops after this step: ${reason}`];
    const notice = renderUndispatched({ reason, remaining, triggerPhrase: env.TRIGGER });
    const target = env.REPORT_NUM;
    if (target) {
      await say({ github, owner, repo, target, notice, request: { reason: String(reason ?? '') }, env, warnings, fetch: call });
    } else {
      warnings.push(`the chain stopped and there was nowhere to say so: ${notice}`);
    }
    return { outputs: answer(false), notices: [], warnings };
  };

  const asked = String(env.JIRA_KEY ?? '').trim();
  const workRef = workRefFor(asked);
  if (asked !== '' && workRef === '') {
    return undispatched('the ticket this run is about is not a key the successor could be handed');
  }

  const through = await reportTo({ core, env, workRef, report, fetch: call, pause });
  if (through.outcome === 'dispatched') {
    outputs.successor = 'asked';
    const named = through.run === '' ? '' : ` ${through.run}`;
    return {
      outputs: answer(true),
      notices: [`the control plane started the next run${named}, with the work this job carries`],
      warnings: [],
    };
  }
  if (through.outcome === 'owed') {
    outputs.successor = 'asked';
    return {
      outputs: answer(false),
      notices: [`the control plane owes the next run and starts it again itself: ${through.reason}`],
      warnings: [],
    };
  }
  if (through.outcome === 'stopped') return stopped(through);
  if (through.outcome === 'waiting' || report.outcome === 'waiting') {
    return waiting(through.outcome === 'failed' ? through.reason : '');
  }
  if (!decidesLocally(env)) {
    return {
      outputs: answer(false),
      notices: ['not deciding here: this run reports what it did, and no successor follows it'],
      warnings: [],
    };
  }
  if (through.outcome === 'failed') {
    const done = decideContinuation({ phase: env.PHASE, remaining });
    return done.reason === 'finished' ? stopped(done) : undispatched(through.reason);
  }
  if (workRef !== '') {
    return undispatched(
      'no control plane holds the work for this ticket, and a run started without its record could not read the work item',
    );
  }

  const verdict = decideContinuation({
    phase: env.PHASE,
    remaining,
    prevRemaining: env.PREV_REMAINING,
    prevStall: env.STALL,
    attempt: env.ATTEMPT,
    handsOff: env.HANDS_OFF,
  });
  if (!verdict.go) return stopped(verdict);

  const out = await dispatchSuccessor({
    github,
    core,
    owner,
    repo,
    workflowFile: env.WORKFLOW,
    defaultBranch: env.DEFAULT_BRANCH,
    ref: env.REF,
    checkProtection: verdict.attempt === 0,
    inputs: {
      issue_number: env.ISSUE_NUM,
      attempt: String(verdict.attempt + 1),
      stall: String(verdict.stall),
      prev_remaining: verdict.remainingForSuccessor,
    },
  });

  if (!out.ok) return undispatched(out.reason);
  return { outputs: answer(true), notices: [], warnings: [] };
}

const NOTICE_ORDER = Object.freeze([
  Object.freeze({ body: 'CONTEXT_NOTICE', at: 'REFUSED_ON', reason: true, kind: '' }),
  Object.freeze({ body: 'SELECT_NOTICE', at: 'THREAD_NUM', reason: false, kind: 'SELECT_NOTICE_KIND' }),
  Object.freeze({ body: 'SUBJECT_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'CLOSED_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'STOP_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'PHASE_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'MERGE_NOTICE', at: 'THREAD_NUM', reason: true, kind: '' }),
  Object.freeze({ body: 'PLAN_NOTICE', at: 'REPORT_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'JIRA_ERROR', at: 'THREAD_NUM', reason: true, kind: '' }),
  Object.freeze({ body: 'HELD_NOTICE', at: 'REPORT_NUM', reason: true, kind: '' }),
]);

function preflightNoticeFacts(said, env) {
  const serialized = {
    SUBJECT_NOTICE: 'SUBJECT_FACTS', CLOSED_NOTICE: 'CLOSED_FACTS', STOP_NOTICE: 'STOP_FACTS',
    PHASE_NOTICE: 'PHASE_FACTS', PLAN_NOTICE: 'PLAN_FACTS',
  }[said.body];
  if (serialized) {
    const facts = JSON.parse(String(env[serialized] ?? ''));
    if (facts === null || typeof facts !== 'object' || typeof facts.source !== 'string') {
      throw new Error('the stopped preflight has no structured facts');
    }
    return facts;
  }
  switch (said.body) {
    case 'CONTEXT_NOTICE': return { source: 'context', detail: String(env.CONTEXT_NOTICE) };
    case 'MERGE_NOTICE': return { source: 'merge', detail: String(env.MERGE_NOTICE) };
    case 'JIRA_ERROR': return { source: 'jira', detail: String(env.JIRA_ERROR) };
    case 'HELD_NOTICE': return { source: 'held', held_by: String(env.HELD_BY ?? '') };
    default: throw new Error('the stopped preflight has no known source');
  }
}

async function publishNotice({ github, owner, repo, env, fetch = globalThis.fetch }) {
  const outputs = { posted: 'false' };
  const said = NOTICE_ORDER.find((notice) => String(env[notice.body] ?? '').trim() !== '');

  if (said === undefined) {
    return { outputs, notices: ['nothing stopped this run before the model, so no notice was posted'] };
  }

  const target = Number(env[said.at] || env.THREAD_NUM);
  if (!Number.isInteger(target) || target <= 0) {
    return { outputs, warnings: ['a run stopped and there was nowhere to say so'], notices: [] };
  }

  const text = said.reason
    ? asAlert('WARNING', scrub(`Nothing ran: ${String(env[said.body])}`, { triggerPhrase: env.TRIGGER }))
    : String(env[said.body]);
  const named = said.kind ? String(env[said.kind] ?? '').trim() : '';
  const footer = renderClassifierFooter(env.ROUTE_SOURCE, { triggerPhrase: env.TRIGGER });
  let selected = { kind: 'stopped' };
  if (usingControlPlane(env) && said.body === 'SELECT_NOTICE') {
    const selection = JSON.parse(String(env.SELECT_FACTS ?? ''));
    if (selection === null || typeof selection !== 'object' || typeof selection.reason !== 'string') {
      throw new Error('the stopped selection has no structured facts');
    }
    selected = { kind: 'stopped_selection', selection, repository: `${owner}/${repo}` };
  } else if (usingControlPlane(env)) {
    selected = { kind: 'stopped_preflight', preflight: preflightNoticeFacts(said, env) };
  }
  await commentNotice({
    github, owner, repo, number: target,
    notice: selected,
    env,
    local: () => ({
      body: marked(footer ? `${text}\n\n${footer}` : text, payloadFor(env, { kind: KINDS.includes(named) ? named : 'notice' })),
    }),
    what: 'why this run stopped before the model',
    fetch,
  });
  outputs.posted = 'true';
  return { outputs, notices: [`published the notice for a run that stopped before the model, on #${target}`] };
}

/** publishTesterNotice posts the tester's own already-scrubbed notice, when the request earned one. */
async function publishTesterNotice({ github, owner, repo, env, fetch = globalThis.fetch }) {
  const notice = String(env.NOTICE ?? '');
  if (notice === '') return { outputs: { posted: 'false' }, notices: [] };

  const target = Number(env.THREAD_NUM);
  if (!Number.isInteger(target) || target <= 0) {
    return { outputs: { posted: 'false' }, warnings: ['the tester declined a request and there was nowhere to say so'], notices: [] };
  }

  const named = String(env.NOTICE_KIND ?? '').trim();
  const footer = renderClassifierFooter(env.ROUTE_SOURCE, { triggerPhrase: env.TRIGGER });
  try {
    const viaControlPlane = usingControlPlane(env);
    const facts = viaControlPlane ? JSON.parse(String(env.NOTICE_FACTS ?? '')) : null;
    if (viaControlPlane && (facts === null || typeof facts !== 'object' || typeof facts.reason !== 'string')) {
      throw new Error('the tester notice has no structured facts');
    }
    await commentNotice({
      github, owner, repo, number: target,
      notice: viaControlPlane
        ? { kind: 'tester_facts', tester: facts, repository: `${owner}/${repo}` }
        : { kind: 'tester' },
      env,
      local: () => ({
      body: marked(
        footer ? `${notice}\n\n${footer}` : notice,
        payloadFor(env, { kind: KINDS.includes(named) ? named : 'notice', pr: env.THREAD_NUM }),
      ),
      }),
      what: "the tester's notice",
      fetch,
    });
  } catch (error) {
    /*
     * The tester's own job holds read-only GitHub access on purpose, so the token it comments with
     * may not be allowed to. Losing the notice costs a sentence; throwing costs the run that was
     * about to provision the environments, before it has read the contract or started anything.
     */
    return {
      outputs: { posted: 'false' },
      warnings: [`the tester had a notice for #${target} and could not post it: ${error.message}`],
      notices: [],
    };
  }
  return { outputs: { posted: 'true' }, notices: [`published the tester's notice on #${target}`] };
}

async function releaseCheckpoint({ github, core, owner, repo, env, fetch = globalThis.fetch }) {
  const pull_number = Number(env.PR_NUMBER);
  const outputs = { remaining: '' };
  if (usingControlPlane(env)) {
    const released = await writerFor({ env, fetch }).releaseCheckpoint({
      number: pull_number, title: env.STEP_TITLE, token: env.COMMENT_ID,
      notice: { kind: 'released', env: pick(env, NOTICE_KEYS) },
    });
    if (!released.released) {
      core?.info?.(`\`${env.STEP_TITLE}\` was already ticked, so this release paid for no checkpoint and none was recorded`);
      return { outputs, notices: [], failure: null };
    }
    outputs.remaining = String(released.remaining);
    core?.info?.(`released the phase behind \`${env.STEP_TITLE}\`, ${released.remaining} ${plural(released.remaining, 'box', 'boxes')} left`);
    return { outputs, notices: [], failure: null };
  }
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number });
  const flipped = checkStep(pull.body ?? '', env.STEP_TITLE, { triggerPhrase: env.TRIGGER });
  if (flipped.error) return { outputs, notices: [], failure: `the checkpoint could not be ticked: ${flipped.error}` };

  if (!flipped.changed) {
    core?.info?.(
      `\`${env.STEP_TITLE}\` was already ticked, so this release paid for no checkpoint and none was recorded`,
    );
    return { outputs, notices: [], failure: null };
  }

  const at = flipped.at;
  if (at === 0) {
    return {
      outputs,
      notices: [],
      failure: 'the row this release ticked is not a phase boundary, so there is no boundary for it to name',
    };
  }
  const spent = withPhaseRelease(flipped.body, env.COMMENT_ID, at);
  if (spent === null) {
    return { outputs, notices: [], failure: 'the release this checkpoint took is not one this may record' };
  }

  const left = flipped.remaining;
  outputs.remaining = String(left);
  await sayReleased({ github, owner, repo, env, fetch, number: pull_number, remaining: left, at });
  const writer = writerFor({ github, owner, repo });
  await writer.setDescription({ number: pull_number, body: spent.body });
  core?.info?.(`released the phase behind \`${env.STEP_TITLE}\`, ${left} ${plural(left, 'box', 'boxes')} left`);
  return { outputs, notices: [], failure: null };
}

async function sayReleased({ github, owner, repo, env, fetch, number, remaining, at }) {
  await commentNotice({
    github, owner, repo, number,
    notice: { kind: 'released', remaining: String(remaining), at: String(at) },
    env,
    local: () => ({
      body: marked(
        renderReleased({
          approvedBy: env.APPROVED_BY,
          commentId: env.COMMENT_ID,
          triggerPhrase: env.TRIGGER,
          remaining: remaining + 1,
          at,
        }),
        payloadFor(env, { kind: releaseKind(remaining + 1), pr: number }),
      ),
    }),
    what: 'this release',
    fetch,
  });
}

async function publishAwaiting({ github, owner, repo, env, fetch = globalThis.fetch }) {
  await commentNotice({
    github, owner, repo, number: Number(env.PR_NUMBER),
    notice: { kind: 'awaiting' },
    env,
    local: () => ({
      body: marked(
        renderAwaiting({
          reason: env.REASON,
          triggerPhrase: env.TRIGGER,
          openThreads: env.OPEN_THREADS,
          writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
        }),
        payloadFor(env, { kind: awaitingKind(env.REASON), reason: env.REASON }),
      ),
    }),
    what: 'why this plan is waiting',
    fetch,
  });
  return { notices: [`the plan is waiting on an approver (${env.REASON})`] };
}

async function publishRefusedRelease({ github, owner, repo, env, fetch = globalThis.fetch }) {
  let said = '';
  try {
    said = fs.readFileSync(String(env.MESSAGE_FILE ?? ''), 'utf8').trim();
  } catch {
    said = '';
  }
  if (said === '') {
    return { notices: ['the release was refused and left no message, so nothing was published'] };
  }
  const notice = usingControlPlane(env)
    ? { kind: 'refused_release', refusal: JSON.parse(fs.readFileSync(String(env.REFUSAL_FILE ?? ''), 'utf8')) }
    : { kind: 'refused_release', message: said };
  await commentNotice({
    github, owner, repo, number: Number(env.PR_NUMBER),
    notice,
    env,
    local: () => ({
      body: marked(asAlert('WARNING', scrub(said, { triggerPhrase: env.TRIGGER })), payloadFor(env, { kind: 'plan-blocked' })),
    }),
    what: 'why this plan was not released',
    fetch,
  });
  return { notices: [`the plan was not released: ${said}`] };
}

async function publishWaiting({ github, owner, repo, env, fetch = globalThis.fetch }) {
  if (env.REASON === 'already-released') {
    return { notices: ['this approval already released a phase, so there is nothing to say again'] };
  }

  await commentNotice({
    github, owner, repo, number: Number(env.PR_NUMBER),
    notice: { kind: 'waiting' },
    env,
    local: () => {
      const waiting = renderWaiting({
        remaining: env.REMAINING,
        triggerPhrase: env.TRIGGER,
        reason: env.REASON,
        detail: env.DETAIL,
        writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
      });
      return { body: marked(waiting.body, payloadFor(env, { kind: waiting.kind, reason: env.REASON })) };
    },
    what: 'why this phase is waiting',
    fetch,
  });
  return { notices: [`the phase is waiting on an approver (${env.REASON})`] };
}

const reporting = (kind, over = {}) => {
  const { said, mark, next } = KIND_TABLE[kind];
  return { kind, reacts: false, silent: false, said, mark, next, ...over };
};

const FIX_ANSWERED = Object.freeze(reporting('fix-answered', { reacts: true }));

const STATUS_TABLE = Object.freeze(
  Object.assign(Object.create(null), {
    planned: reporting('plan-published', { reacts: true }),
    released: reporting('plan-approved', { said: 'Plan released', next: 'the first unchecked step runs' }),
    built: reporting('run-finished', { said: 'Change built', next: 'the pull request opens for review' }),
    stepped: reporting('step-done', { reacts: true, silent: true, next: '' }),
    fixed: FIX_ANSWERED,
    answered: FIX_ANSWERED,
    changed: reporting('do-reported', { reacts: true }),
    unchanged: reporting('do-reported', { reacts: true, said: 'No change needed' }),
  }),
);

for (const row of Object.values(STATUS_TABLE)) Object.freeze(row);

const STATUSES = Object.freeze(Object.keys(STATUS_TABLE));

const REACTABLE = Object.freeze(STATUSES.filter((status) => STATUS_TABLE[status].reacts));

const SILENT = Object.freeze(STATUSES.filter((status) => STATUS_TABLE[status].silent));

function resultKind(env) {
  const named = STATUS_TABLE[String(env.STATUS ?? '')]?.kind;
  if (named) return named;
  return String(env.PHASE ?? '') === 'plan' ? 'plan-blocked' : 'notice';
}

async function publishResult({ github, core, owner, repo, env, fetch = globalThis.fetch }) {
  const outputs = {
    posted: 'false',
    replaced: 'false',
  };

  const at = String(env.MESSAGE_FILE ?? '');
  const said = env.ALREADY_SAID === 'success';
  if (at !== '' && !said) {
    let out;
    if (usingControlPlane(env)) {
      const writer = writerFor({ github, owner, repo, env, fetch });
      const workResult = ['planned', 'released', 'built'].includes(String(env.STATUS ?? ''));
      let notice;
      if (workResult) {
        notice = { kind: 'work_result', repository: `${owner}/${repo}`, env: pick(env, NOTICE_KEYS) };
      } else if (env.STATUS === 'stepped') {
        const facts = JSON.parse(fs.readFileSync(String(env.RESULT_FACTS_FILE ?? ''), 'utf8'));
        notice = { kind: 'step_result', ...facts, env: pick(env, NOTICE_KEYS) };
      } else {
        notice = { kind: 'status_result', env: pick(env, NOTICE_KEYS) };
      }
      const result = await writer.runResult({ number: Number(env.REPORT_NUM), notice });
      out = { mode: result.updated ? 'updated' : 'created' };
    } else {
      const message = fs.readFileSync(at, 'utf8');
      const body = await renderedNotice({
        notice: { kind: 'result', message },
        env,
        local: () => ({ body: marked(message, payloadFor(env, { kind: resultKind(env) })) }),
        what: 'what this run did',
        fetch,
      });
      out = await updateOrCreate({
        github,
        core,
        owner,
        repo,
        issueNumber: env.REPORT_NUM,
        body,
        commentId: env.START_COMMENT_ID,
      });
    }
    outputs.posted = 'true';
    outputs.replaced = out.mode === 'updated' ? 'true' : 'false';
  }

  const status = String(env.STATUS ?? '');
  const spoke = outputs.posted === 'true' || env.REPORTED === 'true' || said || SILENT.includes(status);
  if (!spoke || !REACTABLE.includes(status)) return { outputs, notices: [] };

  const out = await react({ github, core, owner, repo, commentId: env.COMMENT_ID, threadRootId: env.THREAD_ROOT_ID, env, fetch });
  return { outputs, notices: [`reacted=${out.reacted}${out.reason === '' ? '' : ` (${out.reason})`}`] };
}

const KEPT = Object.freeze(
  Object.assign(Object.create(null), {
    pushed: ' What it had not committed is on the branch as one `chore(stop):` commit, and the same tree is attached to the run as an artifact.',
    committed: ' Everything it did is on the branch; it left nothing uncommitted.',
  }),
);

function keptSaid(env) {
  const held = KEPT[String(env.PRESERVED ?? '')];
  if (held) return held;
  const why = String(env.PRESERVE_REASON ?? '').trim();
  return why === '' ? '' : ` Nothing uncommitted was kept: ${why}.`;
}

const LONGER_CEILING = 'A longer `job_timeout_minutes` is what fixes that';

const OUT_OF_TIME = Object.freeze(
  Object.assign(Object.create(null), {
    direct:
      'A whole issue in one run wants more of it than a plan step does, so a longer ' +
      '`job_timeout_minutes` is what fixes that - or `--plan`, which splits the work into steps that get ' +
      'the ceiling each',
    plan: LONGER_CEILING,
    'plan-review': LONGER_CEILING,
    revise: LONGER_CEILING,
    step: 'A longer `job_timeout_minutes`, or a shorter plan step, is what fixes that',
    fix: LONGER_CEILING,
    do: LONGER_CEILING,
  }),
);

function outOfTimeAdvice(env) {
  return OUT_OF_TIME[String(env.PHASE ?? '')] ?? LONGER_CEILING;
}

const STOPPED_BY = Object.freeze(
  Object.assign(Object.create(null), {
    halt: {
      kind: 'run-stopped',
      opening: '🛑 This run was stopped.',
      said: (env) =>
        'Somebody asked it to stop, and it was given until its grace ran out to finish what it had started.' +
        `${watchdogDetail(env)}${keptSaid(env)}`,
    },
    progress: {
      kind: 'run-failed',
      opening: '❌ This run did not complete.',
      said: (env) =>
        'The watchdog stopped it because it had stopped making progress, so it was ended early rather than ' +
        `left to spend the rest of the job.${watchdogDetail(env)}${keptSaid(env)}`,
    },
    ceiling: {
      kind: 'run-failed',
      opening: '❌ This run did not complete.',
      said: (env) =>
        `The watchdog stopped it about a minute short of the job's ${env.CEILING}-minute ceiling, so the work ` +
        `ran out of time rather than failing. ${outOfTimeAdvice(env)}${keptSaid(env)}`,
    },
    paused: {
      kind: 'run-paused',
      opening: '⏸️ This plan is paused.',
      said: (env) =>
        'Somebody asked it to pause, and it was given until its grace ran out to finish what it had started. ' +
        'The plan is held where it stopped, so a run already queued behind this one reads that and stops too, ' +
        'and nothing more happens here until somebody resumes it.' +
        `${watchdogDetail(env)}${keptSaid(env)}`,
    },
  }),
);

function causeOf(env) {
  const cause = String(env.WATCHDOG_CAUSE ?? '');
  return cause === 'halt' && String(env.HELD ?? '') === 'true' ? 'paused' : cause;
}

async function publishRunFailed({ github, owner, repo, env, fetch = globalThis.fetch }) {
  const fired = env.WATCHDOG_FIRED === 'true';
  const notice = fired ? STOPPED_BY[causeOf(env)] ?? STOPPED_BY.ceiling : STOPPED_BY.ceiling;
  const reason = fired
    ? notice.said(env)
    : `See the [workflow run](${env.RUN_URL}) for details.${keptSaid(env)}`;
  const said = `${notice.opening} ${reason}`;

  const target = env.REPORT_NUM;
  if (!target) {
    return {
      notices: [],
      warnings: [`the run stopped and there was nowhere to say so: ${said}`],
    };
  }

  await commentNotice({
    github, owner, repo, number: Number(target),
    notice: { kind: 'run_failed' },
    env,
    local: () => ({ body: marked(scrub(said, { triggerPhrase: env.TRIGGER }), payloadFor(env, { kind: notice.kind })) }),
    what: 'why this run did not complete',
    fetch,
  });
  return { notices: [`reported the run as incomplete (watchdog fired: ${fired})`] };
}

async function stopSuccessor({ core = null, env, fetch: call = globalThis.fetch, pause }) {
  const report = { ...reportOf(env), outcome: 'waiting', reason: 'blocked' };
  const workRef = workRefFor(String(env.JIRA_KEY ?? '').trim());
  const heard = await reportTo({ core, env, workRef, report, fetch: call, pause });
  if (heard.outcome === 'waiting') {
    return { notices: ['the control plane holds this chain for the person this step stopped for'], warnings: [] };
  }
  if (heard.outcome === 'stopped') {
    return { notices: [`the chain had already stopped: ${heard.reason}`], warnings: [] };
  }
  const why = heard.reason === '' ? `it answered ${heard.outcome}` : heard.reason;
  return {
    notices: [],
    warnings: [`the control plane did not hear that this step stopped for a person, so the next run may meet the same wall: ${why}`],
  };
}

module.exports = {
  decideFinished,
  markReady,
  dispatchNext,
  stopSuccessor,
  publishNotice,
  publishTesterNotice,
  releaseCheckpoint,
  publishAwaiting,
  publishRefusedRelease,
  publishWaiting,
  publishResult,
  publishRunFailed,
  NOTICE_ORDER,
  REACTABLE,
  STATUS_TABLE,
  reporting,
};
