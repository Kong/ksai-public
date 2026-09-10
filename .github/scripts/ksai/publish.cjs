const fs = require('node:fs');
const { react } = require('../lib/react.cjs');
const { updateOrCreate } = require('../lib/comment.cjs');
const { watchdogDetail } = require('../lib/watchdog.cjs');
const { plural } = require('../lib/text.cjs');
const { releaseKind, renderReleased, renderWaiting, withPhaseRelease } = require('./checkpoint.cjs');
const {
  decideContinuation,
  dispatchSuccessor,
  renderStop,
  renderUndispatched,
  stopsHere,
} = require('./continue.cjs');
const { finish } = require('./finish.cjs');
const { renderAwaiting, awaitingKind } = require('./gate.cjs');
const { workRefFor } = require('./context.cjs');
const { KINDS, KIND_TABLE, payloadFor, marked } = require('./marker.cjs');
const { decideFinish } = require('./phase.cjs');
const { checkStep, creditOf, oneLine, parseBody, scrub } = require('./plan.cjs');
const { asAlert } = require('../lib/select-arm.cjs');
const { renderClassifierFooter } = require('./classify.cjs');

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

async function markReady({ github, core, owner, repo, env }) {
  const outputs = {
    ready: 'false',
    reason: '',
  };
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
    dryRun: env.DRY_RUN === 'true',
  });

  if (out.error) return { outputs, notices: [], failure: out.error };
  if (out.ready === true) outputs.ready = 'true';
  else if (out.ready === false) outputs.reason = oneLine(out.reason ?? '', { triggerPhrase: env.TRIGGER });
  else outputs.ready = '';
  return { outputs, notices: [`ready=${out.ready}, notified=${out.notified ?? 'nobody'}`], failure: null };
}

async function say({ github, owner, repo, target, notice, env, warnings }) {
  try {
    const body = marked(notice, payloadFor(env, { kind: 'chain-stopped' }));
    await github.rest.issues.createComment({ owner, repo, issue_number: Number(target), body });
  } catch (error) {
    warnings.push(`the chain stopped and this could not say so: ${error.message}`);
  }
}

async function dispatchNext({ github, core, owner, repo, env }) {
  const outputs = {
    stops_here: '',
  };
  const answer = (started) => {
    outputs.stops_here = stopsHere({ handsOff: env.HANDS_OFF, started });
    return outputs;
  };

  const verdict = decideContinuation({
    phase: env.PHASE,
    remaining: env.REMAINING,
    prevRemaining: env.PREV_REMAINING,
    prevStall: env.STALL,
    attempt: env.ATTEMPT,
    handsOff: env.HANDS_OFF,
  });

  if (!verdict.go) {
    const notices = [`not dispatching: ${verdict.reason}`];
    const warnings = [];
    const notice = renderStop({ ...verdict, remaining: env.REMAINING, triggerPhrase: env.TRIGGER });
    const target = env.REPORT_NUM;
    if (notice && target) {
      await say({ github, owner, repo, target, notice, env, warnings });
    } else if (notice) {
      warnings.push(`the flow stopped and there was nowhere to say so: ${notice}`);
    }
    return { outputs: answer(false), notices, warnings };
  }

  const undispatched = async (reason) => {
    const warnings = [`the next run was not started, so this flow stops after this step: ${reason}`];
    const notice = renderUndispatched({ reason, remaining: env.REMAINING, triggerPhrase: env.TRIGGER });
    const target = env.REPORT_NUM;
    if (target) {
      await say({ github, owner, repo, target, notice, env, warnings });
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
      ...(workRef ? { work_ref: workRef } : { issue_number: env.ISSUE_NUM }),
      attempt: String(verdict.attempt + 1),
      stall: String(verdict.stall),
      prev_remaining: verdict.remainingForSuccessor,
    },
  });

  if (!out.ok) return undispatched(out.reason);
  return { outputs: answer(true), notices: [], warnings: [] };
}

const NOTICE_ORDER = Object.freeze([
  Object.freeze({ body: 'SELECT_NOTICE', at: 'THREAD_NUM', reason: false, kind: 'SELECT_NOTICE_KIND' }),
  Object.freeze({ body: 'SUBJECT_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'CLOSED_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'STOP_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'PHASE_NOTICE', at: 'THREAD_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'MERGE_NOTICE', at: 'THREAD_NUM', reason: true, kind: '' }),
  Object.freeze({ body: 'PLAN_NOTICE', at: 'REPORT_NUM', reason: false, kind: '' }),
  Object.freeze({ body: 'JIRA_ERROR', at: 'THREAD_NUM', reason: true, kind: '' }),
]);

async function publishNotice({ github, owner, repo, env }) {
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
  const body = marked(
    footer ? `${text}\n\n${footer}` : text,
    payloadFor(env, { kind: KINDS.includes(named) ? named : 'notice' }),
  );
  await github.rest.issues.createComment({ owner, repo, issue_number: target, body });
  outputs.posted = 'true';
  return { outputs, notices: [`published the notice for a run that stopped before the model, on #${target}`] };
}

/** publishTesterNotice posts the tester's own already-scrubbed notice, when the request earned one. */
async function publishTesterNotice({ github, owner, repo, env }) {
  const notice = String(env.NOTICE ?? '');
  if (notice === '') return { outputs: { posted: 'false' }, notices: [] };

  const target = Number(env.THREAD_NUM);
  if (!Number.isInteger(target) || target <= 0) {
    return { outputs: { posted: 'false' }, warnings: ['the tester declined a request and there was nowhere to say so'], notices: [] };
  }

  const named = String(env.NOTICE_KIND ?? '').trim();
  const footer = renderClassifierFooter(env.ROUTE_SOURCE, { triggerPhrase: env.TRIGGER });
  const body = marked(
    footer ? `${notice}\n\n${footer}` : notice,
    payloadFor(env, { kind: KINDS.includes(named) ? named : 'notice', pr: env.THREAD_NUM }),
  );
  try {
    await github.rest.issues.createComment({ owner, repo, issue_number: target, body });
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

async function releaseCheckpoint({ github, core, owner, repo, env }) {
  const pull_number = Number(env.PR_NUMBER);
  const outputs = { remaining: '' };
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

  const after = parseBody(spent.body);
  const left = after.error ? null : after.steps.filter((step) => !step.done).length;
  if (left !== null) outputs.remaining = String(left);
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_number,
    body: marked(
      renderReleased({
        approvedBy: env.APPROVED_BY,
        commentId: env.COMMENT_ID,
        triggerPhrase: env.TRIGGER,
        remaining: env.REMAINING,
        at,
      }),
      payloadFor(env, { kind: releaseKind(env.REMAINING), pr: pull_number }),
    ),
  });
  await github.rest.pulls.update({ owner, repo, pull_number, body: spent.body });
  core?.info?.(
    `released the phase behind \`${env.STEP_TITLE}\`, ${left ?? 'an unreadable number of'} ${plural(left, 'box', 'boxes')} left`,
  );
  return { outputs, notices: [], failure: null };
}

async function publishAwaiting({ github, owner, repo, env }) {
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(env.PR_NUMBER),
    body: marked(
      renderAwaiting({
        reason: env.REASON,
        triggerPhrase: env.TRIGGER,
        openThreads: env.OPEN_THREADS,
        writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
      }),
      payloadFor(env, { kind: awaitingKind(env.REASON), reason: env.REASON }),
    ),
  });
  return { notices: [`the plan is waiting on an approver (${env.REASON})`] };
}

async function publishRefusedRelease({ github, owner, repo, env }) {
  let said = '';
  try {
    said = fs.readFileSync(String(env.MESSAGE_FILE ?? ''), 'utf8').trim();
  } catch {
    said = '';
  }
  if (said === '') {
    return { notices: ['the release was refused and left no message, so nothing was published'] };
  }
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(env.PR_NUMBER),
    body: marked(
      asAlert('WARNING', scrub(said, { triggerPhrase: env.TRIGGER })),
      payloadFor(env, { kind: 'plan-blocked' }),
    ),
  });
  return { notices: [`the plan was not released: ${said}`] };
}

async function publishWaiting({ github, owner, repo, env }) {
  if (env.REASON === 'already-released') {
    return { notices: ['this approval already released a phase, so there is nothing to say again'] };
  }

  const waiting = renderWaiting({
    remaining: env.REMAINING,
    triggerPhrase: env.TRIGGER,
    reason: env.REASON,
    detail: env.DETAIL,
    writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
  });
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(env.PR_NUMBER),
    body: marked(waiting.body, payloadFor(env, { kind: waiting.kind, reason: env.REASON })),
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

async function publishResult({ github, core, owner, repo, env }) {
  const outputs = {
    posted: 'false',
    replaced: 'false',
  };

  const at = String(env.MESSAGE_FILE ?? '');
  const said = env.ALREADY_SAID === 'success';
  if (at !== '' && !said) {
    const out = await updateOrCreate({
      github,
      core,
      owner,
      repo,
      issueNumber: env.REPORT_NUM,
      body: marked(fs.readFileSync(at, 'utf8'), payloadFor(env, { kind: resultKind(env) })),
      commentId: env.START_COMMENT_ID,
    });
    outputs.posted = 'true';
    outputs.replaced = out.mode === 'updated' ? 'true' : 'false';
  }

  const status = String(env.STATUS ?? '');
  const spoke = outputs.posted === 'true' || env.REPORTED === 'true' || said || SILENT.includes(status);
  if (!spoke || !REACTABLE.includes(status)) return { outputs, notices: [] };

  const out = await react({ github, core, owner, repo, commentId: env.COMMENT_ID, threadRootId: env.THREAD_ROOT_ID });
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
        `left to spend the rest of the job.${watchdogDetail(env)}`,
    },
    ceiling: {
      kind: 'run-failed',
      opening: '❌ This run did not complete.',
      said: (env) =>
        `The watchdog stopped it about a minute short of the job's ${env.CEILING}-minute ceiling, so the work ` +
        `ran out of time rather than failing. ${outOfTimeAdvice(env)}`,
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

async function publishRunFailed({ github, owner, repo, env }) {
  const fired = env.WATCHDOG_FIRED === 'true';
  const notice = fired ? STOPPED_BY[causeOf(env)] ?? STOPPED_BY.ceiling : STOPPED_BY.ceiling;
  const reason = fired ? notice.said(env) : `See the [workflow run](${env.RUN_URL}) for details.`;

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(env.REPORT_NUM),
    body: marked(
      scrub(`${notice.opening} ${reason}`, { triggerPhrase: env.TRIGGER }),
      payloadFor(env, { kind: notice.kind }),
    ),
  });
  return { notices: [`reported the run as incomplete (watchdog fired: ${fired})`] };
}

module.exports = {
  decideFinished,
  markReady,
  dispatchNext,
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
};
