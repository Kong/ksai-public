const fs = require('node:fs');
const { EXTRA_ARGS_REFUSAL, toolPolicy, validateExtraArgs } = require('../lib/claude-args.cjs');
const { ceilingMinutes } = require('../lib/watchdog.cjs');
const {
  asAlert,
  planMode,
  renderDisabled,
  renderHelp,
  renderUnauthorized,
  renderUnimplemented,
  renderUnnamedCommand,
  renderWrongSurface,
  resolveWriteAccess,
  undecidedWriteAccess,
  WRITE_BAR,
} = require('../lib/select-arm.cjs');
const {
  CLARIFY_VERDICT,
  classifierModel,
  renderClarification,
  renderClassifierSpend,
  renderCommandClassifierPrompt,
  surfaceForComment,
  verdictFromExecution,
} = require('./classify.cjs');
const { bareMode, ownPull, ownSurface, renderNudge, renderUnaddressed } = require('./bare.cjs');
const { DEFAULT_TRIGGER_PHRASE, afterTrigger } = require('../lib/text.cjs');
const { labelReaders, readLabelBasis, readReviewBasis, recordBasis } = require('./label-basis.cjs');
const loadKsaiConfig = require('./config.cjs');
const {
  COMMENT_EVENT,
  CONTINUATION_EVENT,
  REVIEW_COMMENT_EVENT,
  asCommentEvent,
  commentReaders,
  resolveAuthorization,
  resolveContext,
  resolveDispatchedComment,
  resolveOnIssue,
  withLastEdit,
} = require('./context.cjs');
const { classifyTarget, nextStep, resolveRequest } = require('./dispatch.cjs');
const { approvalApplies, describeApproval, resolveApproval } = require('./gate.cjs');
const {
  alreadyReleased,
  needsReleaseRead,
  decideCheckpoint,
  gateWaiting,
  isApprove,
  isResume,
  pendingSince,
  releasedNothing,
  releaseTokenFor,
} = require('./checkpoint.cjs');
const {
  renderClosed,
  renderPhaseNotice,
  renderPhaseStop,
  renderSubjectStop,
  resolvePhase,
  resolveSubject,
} = require('./phase.cjs');
const path = require('node:path');
const { isPlanFile, planDirOf, planFilePathFor, readRelease, scrub, withoutHold } = require('./plan.cjs');
const {
  renderDirectPrompt,
  renderDoPrompt,
  renderFixPrompt,
  renderPlanPrompt,
  renderRevisePrompt,
  renderStepPrompt,
  stripOwnComments,
} = require('./prompt.cjs');
const { MAX_DIRECT_COMMITS, PLAN_ONLY_PHASES, deniedFor, soleWritable } = require('./verify-chunk.cjs');
const { createScope, renderAllowed } = require('./change-scope.cjs');
const { plansWork } = require('./write-triage.cjs');

function refusedByBar({ command, bar, undecided }, { outputs, notices }) {
  notices.push(
    `Comment names the \`${command}\` command, whose bar here is ` +
      `${bar === WRITE_BAR ? 'write access on the repository' : 'owning a path in CODEOWNERS'}.`,
  );
  return { outputs, notices, failure: undecided ? undecidedWriteAccess(command) : null };
}

async function resolveBareGate({ github, core, owner, repo, env }) {
  const outputs = {
    mode: 'off',
    mine: 'false',
    stop_mode: '',
    stop_grace_seconds: '',
    stop_warn_seconds: '',
    stop_preserve: '',
    plan_mode: '',
  };
  const asked = bareMode({ input: env.BARE_COMMENTS });
  if (asked.error) return { outputs, notices: [], failure: asked.error };
  const config = await loadKsaiConfig({ github, core, owner, repo });
  if (config.error) {
    outputs.plan_mode = 'always';
    return {
      outputs,
      notices: [
        `${config.error}; comments naming no command are not read on this run, and this work is planned ` +
          'rather than built directly, because a file that may require a plan could not be read',
      ],
      failure: null,
    };
  }
  const halt = config.halt ?? {};
  outputs.stop_mode = String(halt.mode ?? '');
  outputs.stop_grace_seconds = halt.grace === undefined ? '' : String(halt.grace);
  outputs.stop_warn_seconds = halt.warn === undefined ? '' : String(halt.warn);
  outputs.stop_preserve = String(halt.preserve ?? '');
  outputs.plan_mode = String(config.planning ?? '');
  const narrowed = bareMode({ input: env.BARE_COMMENTS, fromFile: asked.mode === 'auto' ? config.bareComments : '' });
  if (narrowed.error) return { outputs, notices: [], failure: narrowed.error };
  outputs.mode = narrowed.mode;
  if (narrowed.mode === 'off') {
    return { outputs, notices: ['Comments naming no command are not read here.'], failure: null };
  }

  const said = String(env.COMMENT_BODY ?? '');
  const addressed =
    env.ON_ISSUE !== 'true' &&
    env.ON_REVIEW !== 'true' &&
    env.IS_CONTINUATION !== 'true' &&
    said.trim() !== '' &&
    afterTrigger(said, env.TRIGGER) === null;
  if (!addressed) return { outputs, notices: [], failure: null };

  const rootId = String(env.THREAD_ROOT_ID ?? '').trim();
  const mine = await ownSurface({ github, core, owner, repo, rootId, prNumber: env.THREAD_NUM, botLogin: env.BOT_LOGIN });
  outputs.mine = mine ? 'true' : 'false';
  const where = rootId ? 'This thread opened with a finding this flow posted' : 'This pull request is one this flow opened';
  return {
    outputs,
    notices: mine ? [`${where}, so a comment naming no command steers it.`] : [],
    failure: null,
  };
}

async function resolveCourierPull({ github, core, owner, repo, env }) {
  const outputs = {
    mine: 'false',
  };
  const mine =
    env.BARE_MODE === 'auto' &&
    (await ownPull({ github, core, owner, repo, prNumber: env.PR_NUMBER, botLogin: env.BOT_LOGIN }));
  outputs.mine = mine ? 'true' : 'false';
  return { outputs, notices: [], failure: null };
}

async function selectImplementArm({ github, core, owner, repo, env }) {
  const out = await resolveRequest({
    github,
    core,
    owner,
    repo,
    prompt: env.PROMPT ?? '',
    onIssue: env.ON_ISSUE,
    threadRootId: env.THREAD_ROOT_ID,
    onReview: env.ON_REVIEW,
    reviewState: env.REVIEW_STATE,
    bare: env.ON_OWN_PULL === 'true',
    commented: String(env.COMMENT_ID ?? '').trim() !== '',
    label: env.REQUEST_LABEL,
    labelReview: env.REQUEST_REVIEW === 'true',
    flow: 'implement',
    trigger: env.TRIGGER,
    continuation: env.IS_CONTINUATION,
    arm: {
      defaultModel: env.DEFAULT_MODEL,
      defaultEffort: env.DEFAULT_EFFORT,
      allowedModels: env.ALLOWED_MODELS,
      disabledCommands: env.DISABLED_COMMANDS,
      writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
      legacyAllowedCommands: env.LEGACY_ALLOWED_COMMANDS,
      maxEffort: env.MAX_EFFORT,
      minEffort: env.MIN_EFFORT,
    },
    codeowner: env.CODEOWNER,
    write: env.WRITE_ACCESS,
    classifiedCommand: env.CLASSIFIED_COMMAND,
  });

  const named = `${owner}/${repo}`;
  const wrongSurfaceNotice = out.wrongSurface
    ? renderWrongSurface(out.wrongSurface.command, { triggerPhrase: env.TRIGGER })
    : '';
  const inThread = String(env.THREAD_ROOT_ID ?? '').trim() !== '';
  const answersRejection = env.ON_ISSUE === 'true' || inThread || out.mine === true;

  const notice =
    (answersRejection ? (out.rejection ?? '') : '') ||
    (out.help
      ? renderHelp({
          onIssue: env.ON_ISSUE,
          threadRootId: env.THREAD_ROOT_ID,
          triggerPhrase: env.TRIGGER,
          disabledCommands: env.DISABLED_COMMANDS,
        })
      : '') ||
    (out.unimplemented
      ? renderUnimplemented(out.unimplemented, {
          repo: named,
          triggerPhrase: env.TRIGGER,
          classified: out.classified === true,
        })
      : '') ||
    (out.disabled ? renderDisabled(out.disabled, { repo: named, triggerPhrase: env.TRIGGER }) : '') ||
    (out.unauthorized
      ? renderUnauthorized({
          repo: named,
          triggerPhrase: env.TRIGGER,
          write: env.WRITE_ACCESS,
          ...out.unauthorized,
        })
      : '') ||
    (out.nudge ? renderNudge({ triggerPhrase: env.TRIGGER }) : '') ||
    (out.unaddressed ? renderUnaddressed(out.unaddressed, { triggerPhrase: env.TRIGGER }) : '') ||
    (out.clarify
      ? renderClarification({ triggerPhrase: env.TRIGGER, disabledCommands: env.DISABLED_COMMANDS })
      : '') ||
    wrongSurfaceNotice ||
    (out.unnamed
      ? renderUnnamedCommand({
          onIssue: env.ON_ISSUE,
          triggerPhrase: env.TRIGGER,
          flow: 'implement',
          disabledCommands: env.DISABLED_COMMANDS,
        })
      : '');

  const outputs = {
    command: '',
    model: '',
    effort: '',
    model_source: '',
    effort_source: '',
    guidance_html: '',
    plan_mode: '',
    route_source: out.routeSource ?? '',
    route_surface: '',
    receipt: '',
    write_access_commands: '',
    mine: out.mine ? 'true' : 'false',
    notice,
    notice_kind: out.help ? 'guide' : '',
  };

  const notices = [];
  if (out.unnamed) notices.push('Comment carries the phrase and names no command; answering with the command list.');

  if (out.error) {
    if (answersRejection) return { outputs, notices, failure: out.error };
    notices.push('Comment carries a malformed request that another flow answers; declining quietly.');
    return { outputs, notices, failure: null };
  }
  if (out.help) {
    notices.push('Comment asks for help; answering with the command guide and starting no model work.');
    return { outputs, notices, failure: null };
  }
  if (out.delivered) {
    notices.push(`Comment names the \`${out.delivered}\` command, which the courier carries into the run already going.`);
    return { outputs, notices, failure: null };
  }
  if (out.unimplemented) {
    notices.push(`Comment names the \`${out.unimplemented}\` command, which no action implements yet.`);
    return { outputs, notices, failure: null };
  }
  if (out.disabled) {
    notices.push(`Comment names the \`${out.disabled}\` command, which this repository turned off.`);
    return { outputs, notices, failure: null };
  }
  if (out.unauthorized) return refusedByBar(out.unauthorized, { outputs, notices });
  if (out.nudge) {
    notices.push('Comment reads as consent to the plan, which is named rather than classified; asking for the command.');
    return { outputs, notices, failure: null };
  }
  if (out.unaddressed) {
    notices.push(`Comment names no command and reads as \`${out.unaddressed}\`, which another flow runs; asking for the command.`);
    return { outputs, notices, failure: null };
  }
  if (out.clarify) {
    notices.push('The request did not resolve to one available result; asking for a clearer outcome.');
    return { outputs, notices, failure: null };
  }
  if (out.wrongSurface) {
    notices.push(wrongSurfaceNotice);
    return { outputs, notices, failure: null };
  }
  if (out.foreign) {
    notices.push(`Comment names the \`${out.foreign}\` command, which this action does not own.`);
    return { outputs, notices, failure: null };
  }
  if (out.mine) {
    const planning = planMode({
      input: env.PLAN_MODE,
      fromFile: env.FILE_PLAN_MODE,
      asked: out.planAsk,
    });
    if (planning.error) {
      outputs.notice = asAlert('WARNING', scrub(`**${planning.error}**`, { triggerPhrase: env.TRIGGER }));
      return { outputs, notices, failure: planning.error };
    }
    outputs.plan_mode = planning.mode;
    const how = out.classified === true ? 'read out of the comment' : 'named in the comment';
    notices.push(`Answering the \`${out.command}\` command (${how}) at ${out.model} / ${out.effort}.`);
    Object.assign(outputs, {
      command: out.command,
      write_access_commands: (out.writeAccessCommands ?? []).join(' '),
      model: out.model,
      effort: out.effort,
      model_source: out.modelSelectedBy,
      effort_source: out.effortSelectedBy,
      guidance_html: out.guidanceHtml,
      plan_given: out.planGiven === true ? 'true' : 'false',
      route_surface: out.routeSurface,
      receipt: out.receipt,
    });
  }
  return { outputs, notices, failure: null };
}

/**
 * testModeFor answers the mode a resolved request runs under. `--dry-run` asks for one on the
 * request rather than through `test_mode`, which a comment cannot reach: a comment runs the
 * workflow file on the default branch, so that input is only settable by merging it.
 *
 * @param {boolean | undefined} asked
 * @param {string | undefined} configured
 * @returns {string}
 */
function testModeFor(asked, configured) {
  if (asked === true) return 'dry-run';
  return String(configured ?? '') === '' ? 'test' : String(configured);
}

async function selectTesterArm({ github, core, owner, repo, env }) {
  const out = await resolveRequest({
    github,
    core,
    owner,
    repo,
    prompt: env.PROMPT ?? '',
    onIssue: env.ON_ISSUE,
    threadRootId: env.THREAD_ROOT_ID,
    classifiedCommand: env.CLASSIFIED_COMMAND,
    commented: String(env.COMMENT_ID ?? '').trim() !== '',
    flow: 'tester',
    trigger: env.TRIGGER,
    arm: {
      defaultModel: env.DEFAULT_MODEL,
      defaultEffort: env.DEFAULT_EFFORT,
      allowedModels: env.ALLOWED_MODELS,
      disabledCommands: env.DISABLED_COMMANDS,
      writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
      legacyAllowedCommands: env.LEGACY_ALLOWED_COMMANDS,
      maxEffort: env.MAX_EFFORT,
      minEffort: env.MIN_EFFORT,
    },
    codeowner: env.CODEOWNER,
    write: env.WRITE_ACCESS,
  });

  const named = `${owner}/${repo}`;
  const wrongSurfaceNotice = out.wrongSurface
    ? renderWrongSurface(out.wrongSurface.command, { triggerPhrase: env.TRIGGER })
    : '';

  const answersRejection = out.mine === true;
  const notice =
    (answersRejection ? out.rejection ?? '' : '') ||
    (out.unimplemented
      ? renderUnimplemented(out.unimplemented, {
          repo: named,
          triggerPhrase: env.TRIGGER,
          classified: out.classified === true,
        })
      : '') ||
    (out.disabled ? renderDisabled(out.disabled, { repo: named, triggerPhrase: env.TRIGGER }) : '') ||
    (out.unauthorized
      ? renderUnauthorized({
          repo: named,
          triggerPhrase: env.TRIGGER,
          write: env.WRITE_ACCESS,
          ...out.unauthorized,
        })
      : '') ||
    (out.clarify
      ? renderClarification({ triggerPhrase: env.TRIGGER, disabledCommands: env.DISABLED_COMMANDS })
      : '') ||
    wrongSurfaceNotice ||
    (out.unnamed
      ? renderUnnamedCommand({
          onIssue: env.ON_ISSUE,
          triggerPhrase: env.TRIGGER,
          flow: 'tester',
          disabledCommands: env.DISABLED_COMMANDS,
        })
      : '');

  // `command` and `route_surface` lost their only reader with the Claude tester and were dropped
  // rather than left unread. The tester's telemetry reads them now, so they are published again -
  // without them a test run bills with no command and no surface to group it by
  const outputs = {
    model: '',
    effort: '',
    mine: out.mine ? 'true' : 'false',
    notice,
    notice_kind: out.help ? 'guide' : '',
    command: out.command ?? '',
    route_source: out.routeSource ?? '',
    route_surface: out.routeSurface ?? '',
    receipt: '',
    test_mode: testModeFor(out.dryRun, env.TEST_MODE),
  };
  const notices = [];
  if (out.unnamed) notices.push('Comment carries the phrase and names no command; answering with the command list.');

  if (out.error) {
    if (answersRejection) return { outputs, notices, failure: out.error };
    notices.push('Comment carries a malformed request that another flow answers; declining quietly.');
    return { outputs, notices, failure: null };
  }
  if (out.unimplemented) {
    notices.push(`Comment names the \`${out.unimplemented}\` command, which no action implements yet.`);
    return { outputs, notices, failure: null };
  }
  if (out.disabled) {
    notices.push(`Comment names the \`${out.disabled}\` command, which this repository turned off.`);
    return { outputs, notices, failure: null };
  }
  if (out.unauthorized) return refusedByBar(out.unauthorized, { outputs, notices });
  if (out.clarify) {
    notices.push('The request did not resolve to one available result; asking for a clearer outcome.');
    return { outputs, notices, failure: null };
  }
  if (out.wrongSurface) {
    notices.push(wrongSurfaceNotice);
    return { outputs, notices, failure: null };
  }
  if (out.foreign) {
    notices.push(`Comment names the \`${out.foreign}\` command, which this action does not own.`);
    return { outputs, notices, failure: null };
  }
  if (out.mine) {
    const mode = out.dryRun ? ' as a dry run, starting no tester,' : '';
    notices.push(`Answering the \`${out.command}\` command${mode} at ${out.model} / ${out.effort}.`);
    Object.assign(outputs, {
      model: out.model,
      effort: out.effort,
      receipt: out.receipt,
      test_mode: testModeFor(out.dryRun, env.TEST_MODE),
    });
  }
  return { outputs, notices, failure: null };
}

function dispatchedActor(env) {
  const named = String(env.IN_ACTOR ?? '');
  return env.FLOW === 'review' && named !== '' ? named : String(env.IN_TRIGGERING_ACTOR ?? '');
}

function labelledContext(labelled) {
  return resolveContext({
    eventName: CONTINUATION_EVENT,
    payload: {},
    inputs: {
      issue_number: String(labelled.pr),
      comment_body: `${DEFAULT_TRIGGER_PHRASE} ${labelled.command}`,
      triggering_actor: labelled.login,
      on_issue: 'false',
    },
  });
}

const QUIET = Object.freeze({ info() {}, warning() {} });
const SECURED_AUTOFIX_CAPABILITY = 'secured-context-output/v1';

async function reviewBasisOf({ github, context, env, read }) {
  if (read.onReview !== true || read.reviewState === 'approved' || read.reviewActorType === 'Bot') return null;
  const own = await ownPull({
    github,
    core: QUIET,
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: read.issueNumber,
    botLogin: env.IN_BOT_LOGIN,
  });
  if (own) return null;
  return readReviewBasis({
    pr: read.issueNumber,
    reviewCommit: read.reviewCommitId,
    reviewer: read.commenter,
    ...labelReaders({ github, context }),
  });
}

async function eventContext({ github, context, env, commented }) {
  const dispatched = await resolveDispatchedComment({
    eventName: context.eventName,
    commentId: env.IN_COMMENT_ID,
    commentKind: env.IN_COMMENT_KIND,
    issueNumber: env.IN_ISSUE_NUMBER,
    actor: env.IN_TRIGGERING_ACTOR,
    appSlug: env.IN_APP_SLUG,
    ...commentReaders({ github, context }),
  });
  if (dispatched.error) return { error: dispatched.error, securityPolicyRefused: dispatched.securityPolicyRefused };

  const pullsGet = (pull_number) => github.rest.pulls.get({ ...context.repo, pull_number });

  const surface = dispatched.review
    ? { onIssue: false }
    : await resolveOnIssue({
        eventName: dispatched.held ? CONTINUATION_EVENT : context.eventName,
        commentBody: dispatched.held ? String(dispatched.comment?.body ?? '') : env.IN_COMMENT_BODY,
        issueNumber: dispatched.held ? String(dispatched.number) : env.IN_ISSUE_NUMBER,
        pullsGet,
      });
  if (surface.error) return { error: surface.error, securityPolicyRefused: surface.securityPolicyRefused };

  const carried = dispatched.held
    ? asCommentEvent({ dispatched, onIssue: surface.onIssue, payload: context.payload })
    : null;
  const comment = commented ? await withLastEdit(github, context.payload?.comment) : undefined;

  const out = resolveContext({
    eventName: carried?.eventName ?? context.eventName,
    payload: carried?.payload ?? (comment ? { ...context.payload, comment } : context.payload),
    inputs: {
      issue_number: env.IN_ISSUE_NUMBER,
      work_ref: env.IN_WORK_REF,
      work_actor: env.IN_WORK_ACTOR,
      attempt: env.IN_ATTEMPT,
      stall: env.IN_STALL,
      prev_remaining: env.IN_PREV_REMAINING,
      comment_body: env.IN_COMMENT_BODY,
      triggering_actor: dispatchedActor(env),
      comment_id: env.IN_COMMENT_ID,
      on_issue: surface.onIssue ? 'true' : 'false',
    },
  });
  return out.error ? { ...out, securityPolicyRefused: true } : out;
}

async function resolveRunContext({ github, context, env }) {
  const commented = context.eventName === COMMENT_EVENT || context.eventName === REVIEW_COMMENT_EVENT;
  const surfaced = String(context.payload?.issue?.number ?? context.payload?.pull_request?.number ?? '');
  const secured = String(env.RECORD_AUTOFIX_CAPABILITY ?? '') === SECURED_AUTOFIX_CAPABILITY;
  const refuse = (failure, securityPolicyRefused = true) => ({
    outputs: { refusal: failure, refused_on: commented ? surfaced : '' },
    failure,
    securityPolicyRefused: secured && securityPolicyRefused,
  });

  const basis = recordBasis(env);
  if (basis?.error) return refuse(basis.error);
  const labelled = basis ? await readLabelBasis({ basis, ...labelReaders({ github, context }) }) : null;
  if (labelled?.error) return refuse(labelled.error, labelled.securityPolicyRefused);

  const securedReview = labelled && secured && String(env.SAW_TRIGGER ?? '') === 'review_submitted';
  const exactReview = securedReview
    ? await eventContext({
        github,
        context,
        env: { ...env, IN_ISSUE_NUMBER: String(basis.pr) },
        commented: false,
      })
    : null;
  if (exactReview?.error) return refuse(exactReview.error, exactReview.securityPolicyRefused);
  if (securedReview && (exactReview?.onReview !== true || exactReview.reviewId == null)) {
    return refuse(
      `the secured review autofix record names no submitted review on pull request #${String(basis.pr)}, so nothing ran`,
    );
  }
  if (securedReview && !['changes_requested', 'commented'].includes(exactReview.reviewState)) {
    return refuse(
      `review #${String(exactReview.reviewId)} is not a change request or comment, so it asks for no autofix and nothing ran`,
    );
  }
  if (securedReview && String(exactReview.reviewId) !== String(env.IN_COMMENT_ID ?? '').trim()) {
    return refuse(
      `the secured review autofix record names review #${String(env.IN_COMMENT_ID ?? '')}, but GitHub read back ` +
        `review #${String(exactReview.reviewId)}, so nothing ran`,
    );
  }
  if (securedReview && String(exactReview.reviewCommitId ?? '').toLowerCase() !== basis.headSha) {
    return refuse(
      `the review on pull request #${String(basis.pr)} was left on a commit the pull request has moved past, ` +
        'so it stood down rather than work on a head the reviewer never saw',
    );
  }

  const read = labelled ? labelledContext(labelled) : await eventContext({ github, context, env, commented });
  if (read.error) return refuse(read.error, read.securityPolicyRefused);
  const reviewed = labelled ? null : await reviewBasisOf({ github, context, env, read });
  if (reviewed?.error) return refuse(reviewed.error, reviewed.securityPolicyRefused);
  if (reviewed && read.reviewId == null) {
    return refuse(
      `the submitted review on pull request #${String(read.issueNumber)} names no review id, so its autofix ` +
        'context cannot be scoped and nothing ran',
    );
  }
  const rested = labelled ?? reviewed;
  const out = reviewed ? labelledContext(reviewed) : read;
  const scopedReview = exactReview ?? (reviewed ? read : null);
  if (scopedReview) {
    Object.assign(out, {
      commenter: scopedReview.commenter,
      reviewId: scopedReview.reviewId,
      reviewSubmittedAt: scopedReview.reviewSubmittedAt,
      reviewCommitId: scopedReview.reviewCommitId,
      reviewUrl: scopedReview.reviewUrl,
      reviewAssociation: scopedReview.reviewAssociation,
      reviewActorType: scopedReview.reviewActorType,
    });
  }

  const outputs = {
    issue_number: out.issueNumber == null ? '' : String(out.issueNumber),
    jira_key: out.jiraKey ?? '',
    threadless: out.jiraKey ? 'true' : 'false',
    default_branch: String(context.payload?.repository?.default_branch ?? ''),
    is_private: context.payload?.repository?.private === true ? 'true' : 'false',
    is_continuation: out.isContinuation ? 'true' : 'false',
    on_issue: out.onIssue ? 'true' : 'false',
    dispatched: out.dispatched === true ? 'true' : 'false',
    on_review: out.onReview === true ? 'true' : 'false',
    review_state: out.reviewState ?? '',
    review_id: out.reviewId == null ? '' : String(out.reviewId),
    review_submitted_at: out.reviewSubmittedAt ?? '',
    review_commit_id: out.reviewCommitId ?? '',
    review_url: out.reviewUrl ?? '',
    review_association: out.reviewAssociation ?? '',
    review_actor_type: out.reviewActorType ?? '',
    commenter: out.commenter ?? '',
    work_actor: out.workActor ?? '',
    comment_id: out.commentId == null ? '' : String(out.commentId),
    comment_body: out.commentBody,
    comment_edited: out.commentEdited ?? '',
    comment_created_at: out.commentCreatedAt ?? '',
    label: rested?.label ?? '',
    label_head: rested?.headSha ?? '',
    label_review: scopedReview ? 'true' : '',
    thread_root_id: out.threadRootId == null ? '' : String(out.threadRootId),
    attempt: String(out.attempt),
    stall: String(out.stall),
    prev_remaining: out.prevRemaining == null ? '' : String(out.prevRemaining),
    refusal: '',
    refused_on: '',
  };
  return { failure: null, outputs, securityPolicyRefused: false };
}

function resolveAuth(env) {
  const out = resolveAuthorization({
    isContinuation: env.IS_CONTINUATION,
    ownerCheck: env.OWNER_CHECK,
    writeCheck: env.WRITE_CHECK,
    writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
    flow: env.FLOW,
    threadless: env.THREADLESS,
    requirePlanApproval: env.REQUIRE_APPROVAL,
    workActor: env.WORK_ACTOR,
  });
  const outputs = {
    ok: out.ok ? 'true' : 'false',
    why: out.why,
  };
  return { outputs, notices: [`authorized=${out.ok} (${out.why})`] };
}

async function resolveRunSubject({ github, owner, repo, env }) {
  const outputs = { number: '', issue: '', jira_key: '', stop_notice: '' };

  const out = await resolveSubject({
    command: env.COMMAND,
    onIssue: env.ON_ISSUE,
    threadNumber: env.THREAD,
    owner,
    repo,
    pullsGet: async (pull_number) => (await github.rest.pulls.get({ owner, repo, pull_number })).data,
  });

  if (out.error) {
    outputs.stop_notice = renderSubjectStop(out.error, { triggerPhrase: env.TRIGGER });
    return { outputs, notices: [`The subject could not be resolved: ${out.error}`] };
  }

  outputs.number = String(out.number);
  outputs.jira_key = out.jiraKey ?? '';
  outputs.issue = outputs.jira_key === '' ? outputs.number : '';
  return { outputs, notices: [`this run is about #${outputs.number}`] };
}

async function resolveCheckpoint({ github, owner, repo, env }) {
  const token = releaseTokenFor({
    command: env.COMMAND,
    commentId: env.COMMENT_ID,
    threadRootId: env.THREAD_ROOT_ID,
    dispatched: env.DISPATCHED,
    reviewId: env.REVIEW_ID,
  });
  const asked = {
    atCheckpoint: env.AT_CHECKPOINT,
    command: env.COMMAND,
    authorized: env.AUTHORIZED,
    write: env.WRITE_ACCESS,
    writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
    disabledCommands: env.DISABLED_COMMANDS,
    commentEdited: env.COMMENT_EDITED,
    requestedAt: String(env.COMMENT_ID ?? '').trim() === '' ? env.REVIEW_SUBMITTED_AT : env.COMMENT_CREATED_AT,
  };
  const [seen, dated] = needsReleaseRead(asked)
    ? await Promise.all([
        alreadyReleased({
          github,
          owner,
          repo,
          prNumber: env.PR_NUMBER,
          botLogin: env.BOT_LOGIN,
          commentId: token,
        }),
        pendingSince({ github, owner, repo, prNumber: env.PR_NUMBER, botLogin: env.BOT_LOGIN }),
      ])
    : [{ released: false, unreadable: null }, { at: null, unreadable: null }];

  const out = decideCheckpoint({
    ...asked,
    released: seen.released,
    unreadable: seen.unreadable,
    pendingSince: dated.at,
  });

  const detail = String((out.reason === 'undated-request' ? dated.unreadable : seen.unreadable) ?? '');
  const outputs = {
    release: out.release ? 'true' : 'false',
    waiting: out.waiting ? 'true' : 'false',
    reason: out.reason,
    detail,
    release_token: out.release ? token : '',
  };
  const said = `checkpoint: release=${out.release}, waiting=${out.waiting} (${out.reason})`;
  return { outputs, notices: [detail === '' ? said : `${said}: ${detail}`] };
}

/**
 * sawFrom reads what the control plane said it saw, from the values the record action passed on.
 *
 * Every one of them is already bounded by the reader: the trigger and the state are words from sets
 * the control plane chooses from, the run and the attempt are numbers, and the name is drawn from an
 * alphabet that cannot spell the constraint block. This only gathers them.
 */
function sawFrom(env) {
  return {
    trigger: env.SAW_TRIGGER,
    run: env.SAW_RUN,
    attempt: env.SAW_ATTEMPT,
    state: env.SAW_STATE,
    name: env.SAW_NAME,
  };
}

function plannedByDispatch(env) {
  if (String(env.AUTHZ_WHY ?? '') !== 'continuation') return '';
  return (
    'a dispatched run continues work somebody already asked for, and there is no plan here to continue. ' +
    'Dispatching skips the CODEOWNERS check on the argument that it resumes an authorized request, so it ' +
    'may not start one instead. Comment the trigger phrase on the issue and the check will run. Nothing ran'
  );
}

/**
 * noticeFor renders what a phase that found nothing posts, told what the record narrowed this run to so
 * the notice does not offer work the label kept for somebody else.
 *
 * Beside `decidePhase` rather than inside it: the wiring test reads that function's object keys as the
 * outputs the step publishes, so an option named there would read as an output nothing can consume.
 */
function noticeFor(out, env) {
  return renderPhaseNotice(out.phase, {
    pending: out.pending,
    triggerPhrase: env.TRIGGER,
    scope: env.RECORD_SCOPE,
  });
}

const REVIEW_QUIET =
  'nobody typed a command to start this run and nothing here is waiting on it, so nothing ran and no notice was posted';

const { UNASKED_TRIGGERS } = require('./do.cjs');

/**
 * phaseNotice decides what a phase that found nothing says, and whether it says it at all.
 *
 * A run the control plane started on its own answers nobody who asked for it: a person replying in three
 * threads submits three reviews, and every run that then finds them answered posted "nothing ran" under
 * replies that had already closed the conversation. A label or a red build that finds nothing to do is the
 * same noise. A command somebody typed still hears back, and so does an ambiguous branch, which is a fault to
 * fix whoever started the run. `quiet` is published so the failed-run comment does not read the missing
 * notice as a run that stopped without saying why.
 */
function phaseNotice(out, env) {
  const notice = noticeFor(out, env);
  const phase = String(out.phase ?? '').trim().toLowerCase();
  const trigger = String(env.SAW_TRIGGER ?? '').trim().toLowerCase();
  const quiet = notice !== '' && phase !== 'ambiguous' && UNASKED_TRIGGERS.includes(trigger);
  return { notice: quiet ? '' : notice, quiet: quiet ? 'true' : '' };
}

async function decidePhase({ github, core, owner, repo, env, authorize, writeAccess }) {
  const evidenceClient = env.EVIDENCE_TOKEN
    ? new github.constructor({ auth: env.EVIDENCE_TOKEN, baseUrl: env.GITHUB_API_URL })
    : undefined;

  const out = await resolvePhase({
    command: env.COMMAND,
    github,
    checksGithub: evidenceClient,
    core,
    owner,
    repo,
    number: env.ISSUE_NUM,
    jiraKey: env.JIRA_KEY,
    defaultBranch: env.DEFAULT_BRANCH,
    botLogin: env.BOT_LOGIN,
    guidance: env.GUIDANCE,
    onIssue: env.ON_ISSUE,
    routeSource: env.ROUTE_SOURCE,
    threadsFile: env.THREADS_FILE,
    threadStateFile: env.THREAD_STATE_FILE,
    commentId: env.COMMENT_ID,
    sawTrigger: env.SAW_TRIGGER,
    checksFile: env.CHECKS_FILE,
    retryFile: env.RETRY_FILE,
    threadRootId: env.THREAD_ROOT_ID,
    reviewId: env.REVIEW_ID,
    authorize,
    writeAccess,
    writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
    triggerPhrase: env.TRIGGER,
    scope: env.RECORD_SCOPE,
  });

  const outputs = {
    stop_notice: '',
    notice: '',
    phase: '',
    request: '',
    ref: '',
    is_draft: '',
    pr_number: '',
    pending: '',
    deferred: '',
    disputed: '',
    base_ref: '',
    threads_file: '',
    thread_state_file: '',
    checks_file: '',
    retry_file: '',
    on_branch: '',
    hands_off: '',
    plan_file: '',
    held: '',
    conflicting: '',
    quiet: '',
  };

  if (out.error) {
    outputs.stop_notice = renderPhaseStop(env.COMMAND, out.error, {
      triggerPhrase: env.TRIGGER,
      onIssue: env.ON_ISSUE,
    });
    return { notices: [`The phase could not be decided: ${out.error}`], outputs };
  }

  const dispatched = out.phase === 'plan' ? plannedByDispatch(env) : '';
  if (dispatched) {
    outputs.stop_notice = asAlert('WARNING', scrub(dispatched, { triggerPhrase: env.TRIGGER }));
    return { notices: [`This run may not start work: ${dispatched}`], outputs };
  }

  Object.assign(outputs, {
    phase: out.phase,
    request: out.request,
    ref: out.ref,
    is_draft: out.isDraft,
    pr_number: out.prNumber,
    pending: out.pending,
    deferred: out.deferred,
    disputed: out.disputed,
    base_ref: out.baseRef,
    threads_file: out.threadsFile,
    thread_state_file: out.threadStateFile,
    checks_file: out.checksFile,
    retry_file: out.retryFile,
    on_branch: out.onBranch,
    hands_off: out.handsOff,
    plan_file: out.planFile,
    held: out.held,
    conflicting: out.conflicting,
    ...phaseNotice(out, env),
  });
  return { notices: outputs.quiet === 'true' ? [REVIEW_QUIET] : [], outputs };
}

const IDLE_REASON = Object.freeze(
  Object.assign(Object.create(null), {
    approve: 'This approval released nothing - no checkpoint was waiting',
    resume: 'This resume released nothing - the plan was not paused',
  }),
);

function idleNotice(command) {
  const named = String(command ?? '').trim().toLowerCase();
  return `${IDLE_REASON[named]} - so no successor is dispatched and no step runs`;
}

function resolveWork({ env }) {
  const outputs = {
    works: 'false',
    reads_source: 'false',
    unblocked: 'true',
    released_nothing: 'false',
  };
  const said = (name) => String(env[name] ?? '');
  const blocked = said('BLOCKED') === 'true';
  const idle = releasedNothing({
    command: said('COMMAND'),
    phase: said('PHASE'),
    remaining: said('RELEASED_REMAINING'),
    releaseRef: said('RELEASE_REF'),
    atGate: said('GATE_WAITING'),
    releasedHold: said('RELEASED_HOLD'),
  });
  const planning = said('PHASE') === 'plan';
  const stepping = said('HAS_STEP') === 'true' && !blocked && said('AT_CHECKPOINT') !== 'true' && !idle;
  const onBranch = said('ON_BRANCH') === 'true' && said('PENDING') !== '0' && !idle;
  const reads = planning || stepping;
  const works = reads || onBranch;
  outputs.reads_source = reads ? 'true' : 'false';
  outputs.works = works ? 'true' : 'false';
  outputs.unblocked = blocked ? 'false' : 'true';
  outputs.released_nothing = idle ? 'true' : 'false';
  if (works) return { outputs, notices: [] };
  if (idle) return { outputs, notices: [idleNotice(said('COMMAND'))] };
  return { outputs, notices: ['This run has no work to do, so nothing is sized and no model is called'] };
}

const writesAPlan = (phase) => (PLAN_ONLY_PHASES.includes(String(phase ?? '')) ? 'true' : '');

function resolveSize({ env }) {
  const discovered = String(env.PHASE ?? '');
  const outputs = {
    phase: discovered,
    plans: writesAPlan(discovered),
  };
  if (discovered !== 'plan') return { outputs, notices: [] };
  if (String(env.PR_NUMBER ?? '').trim() !== '') {
    return {
      outputs,
      notices: ['This work already has a pull request open, so it is planned into that one rather than built again'],
    };
  }

  const decision = plansWork({
    mode: env.PLAN_MODE,
    verdict: env.VERDICT,
    requireApproval: env.REQUIRE_APPROVAL,
    jiraKey: env.JIRA_KEY,
  });
  if (decision.plans) return { outputs, notices: [`This run writes a plan first, because ${decision.why}`] };

  outputs.phase = 'direct';
  outputs.plans = writesAPlan(outputs.phase);
  return { outputs, notices: [`This run builds the change directly, because ${decision.why}`] };
}

async function planClassification({ github, core, owner, repo, env }) {
  const outputs = {
    classify: 'false',
    model: '',
    file: '',
  };

  if (String(env.LEGACY_ALLOWED_COMMANDS ?? '').trim() !== '') {
    return {
      outputs,
      notices: ['The `allowed_commands` input was replaced and still carries a value; classifying nothing.'],
      warnings: [],
    };
  }

  const target = await classifyTarget({
    github,
    core,
    owner,
    repo,
    prompt: env.PROMPT ?? '',
    disabledCommands: env.DISABLED_COMMANDS,
    onIssue: env.FLOW === 'review' ? undefined : env.ON_ISSUE === 'true',
    threadRootId: env.THREAD_ROOT_ID,
    onReview: env.ON_REVIEW,
    reviewState: env.REVIEW_STATE,
    bare: env.ON_OWN_PULL === 'true',
    continuation: env.IS_CONTINUATION,
  });
  if (!target.classify) {
    return {
      outputs,
      notices: ['The comment names a command, carries no words of its own, or could not be read; classifying nothing.'],
      warnings: [],
    };
  }

  const arm = classifierModel(env.CLASSIFIER_MODEL);
  if (arm.error) {
    return {
      outputs,
      notices: [],
      warnings: [`${arm.error}; nothing was classified and this run falls back to its default command.`],
    };
  }

  fs.writeFileSync(
    env.PROMPT_FILE,
    renderCommandClassifierPrompt({
      comment: target.comment,
      surface: surfaceForComment({
        onOwnPull: env.ON_OWN_PULL,
        onIssue: env.ON_ISSUE,
        threadRootId: env.THREAD_ROOT_ID,
      }),
      disabledCommands: env.DISABLED_COMMANDS,
    }),
  );
  return {
    outputs: { classify: 'true', model: arm.model, file: env.PROMPT_FILE },
    notices: [`Classifying the comment on ${arm.model}.`],
    warnings: [],
  };
}

function readVerdict({ env, readFile = (at) => fs.readFileSync(at, 'utf8') }) {
  const outputs = {
    verdict: '',
    model: '',
    cost: '',
    input_tokens: '',
    output_tokens: '',
    turns: '',
    duration: '',
  };

  if (env.CALLER_MODEL !== '') {
    Object.assign(outputs, {
      verdict: env.CALLER_VERDICT ?? '',
      model: env.CALLER_MODEL,
      cost: env.CALLER_COST ?? '',
      input_tokens: env.CALLER_INPUT ?? '',
      output_tokens: env.CALLER_OUTPUT ?? '',
      turns: env.CALLER_TURNS ?? '',
      duration: env.CALLER_DURATION ?? '',
    });
    return {
      outputs,
      notices: [
        `The caller classified this comment on ${env.CALLER_MODEL} and read it as ` +
          `\`${env.CALLER_VERDICT || 'nothing'}\`; this action classified nothing.`,
      ],
      warnings: [],
    };
  }

  const warnings = [];
  let raw = '';
  try {
    raw = env.EXECUTION_FILE ? readFile(env.EXECUTION_FILE) : '';
  } catch (error) {
    warnings.push(`the classifier log could not be read (${error.message}), so this run classifies nothing.`);
  }

  const out = verdictFromExecution(
    raw,
    surfaceForComment({ onOwnPull: env.ON_OWN_PULL, onIssue: env.ON_ISSUE, threadRootId: env.THREAD_ROOT_ID }),
  );
  const { spend } = out;
  const { cost, said: spent } = renderClassifierSpend(env.MODEL, spend);
  const notices = [spent];
  Object.assign(outputs, {
    model: env.MODEL ?? '',
    cost,
    input_tokens: String(spend.inputTokens ?? ''),
    output_tokens: String(spend.outputTokens ?? ''),
    turns: String(spend.turns ?? ''),
    duration: String(spend.durationS ?? ''),
  });

  if (!out.available) {
    warnings.push(`${out.reason}, so this run falls back to the command it would have chosen anyway.`);
    return { outputs, notices, warnings };
  }

  const surface = surfaceForComment({ onOwnPull: env.ON_OWN_PULL, onIssue: env.ON_ISSUE, threadRootId: env.THREAD_ROOT_ID });
  outputs.verdict = out.verdict === 'none' && surface === 'pull' ? CLARIFY_VERDICT : out.verdict;
  notices.push(`The comment reads as \`${outputs.verdict}\`.`);
  return { outputs, notices, warnings };
}

const PLAN_REFUSAL = Object.freeze(
  Object.assign(Object.create(null), {
    unreadable: 'I could not read the plan out of the pull request body, so I stopped rather than assume the work is done:',
    'unreleased-checkpoint':
      'A checkpoint in this plan is ticked and no release of mine accounts for it, so I stopped rather than carry ' +
      'on past an approval nobody gave. A checkpoint row is an ordinary task-list checkbox, so anyone with write ' +
      'access can tick one, and this flow records every phase it releases in a comment of its own. Untick it and ' +
      'release the phase with a comment here:',
    'unreadable-releases':
      'I could not read the comments that record which phases of this plan have been released, so I stopped ' +
      'rather than guess at an approval. The plan itself is fine - what needs looking at is ' +
      '`bot_login` and whether the token may read this conversation:',
    'no-boundary-record':
      'No comment of mine records how many phase boundaries this plan was published with, so there is nothing ' +
      'to check the task list against and I stopped rather than carry on past an approval that may no ' +
      'longer be there. The plan reads fine, the comments read fine, and the token is not the problem: either ' +
      'this plan was published before I started recording that count, or the comment recording it has been ' +
      'deleted. Delete the whole task list to have the work planned again from scratch:',
    'no-release-record':
      'I could not find the comment recording what an approver released, so I stopped rather than reconcile ' +
      'this task list against the record I wrote before the plan was approved. That earlier record seals ' +
      'nothing about the task wording, so carrying on would build from a list nobody has checked since. The ' +
      'plan reads fine, the releases read fine, and the token is not the problem: either this plan was ' +
      'released before I started recording what it sealed, or the comment recording it has been deleted. ' +
      'Delete the whole task list to have the work planned again from scratch:',
    'edited-steps':
      'The task titles in this list are not the ones an approver released, so I stopped rather than build from ' +
      'an instruction nobody reviewed. A title is not a label for the work: it is what this flow is handed ' +
      'verbatim, so rewording an unticked row substitutes what the next run does. The boundaries are intact and ' +
      'the releases read fine - what changed is the wording of the tasks themselves. Restore what was released, ' +
      'or delete the whole task list to have the work planned again from scratch:',
    'edited-plan':
      'This plan holds a different number of phase boundaries from the one it was published with, so I stopped ' +
      'rather than carry on past an approval that may no longer be there. The plan reads fine - what ' +
      'changed is how many boundaries it has. Restore the task list to what it was published as to carry on, or ' +
      'delete the whole task list to have the work planned again from scratch:',
  }),
);

async function releaseHold({ github, owner, repo, prNumber }) {
  let pull;
  try {
    pull = (await github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) })).data;
  } catch (error) {
    return { error: `the pull request could not be read, so the hold on it was not released (${error.message})` };
  }
  const next = withoutHold(pull?.body ?? '');
  if (!next.changed) return { released: false };
  try {
    await github.rest.pulls.update({ owner, repo, pull_number: Number(prNumber), body: next.body });
  } catch (error) {
    return { error: `the hold could not be released, so no step ran (${error.message})` };
  }
  return { released: true };
}

async function readPlan({ github, owner, repo, env }) {
  const outputs = {
    error: '',
    error_notice: '',
    total: '',
    remaining: '',
    remaining_steps: '',
    step_title: '',
    has_step: '',
    at_checkpoint: '',
    jira_key: '',
    release_ref: '',
    requested_by: '',
    held: '',
    gate_waiting: '',
    released_hold: '',
  };

  if (isResume(env.COMMAND)) {
    const released = await releaseHold({ github, owner, repo, prNumber: env.PR_NUMBER });
    if (released.error) return { outputs: { ...outputs, error: released.error } };
    outputs.released_hold = released.released ? 'true' : 'false';
  }
  const out = await nextStep({ github, owner, repo, prNumber: env.PR_NUMBER, botLogin: env.BOT_LOGIN });
  if (out.held) {
    outputs.held = 'true';
    outputs.has_step = 'false';
    outputs.error_notice = asAlert(
      'IMPORTANT',
      scrub(
        `This plan is paused, so no step runs and no successor is started. Somebody paused it during run ${out.held}. ` +
          'Ask this flow to resume it when the work should carry on',
        { triggerPhrase: env.TRIGGER },
      ),
    );
    return { outputs };
  }
  if (out.error) {
    outputs.error = out.error;
    outputs.error_notice = asAlert(
      'WARNING',
      scrub(`${PLAN_REFUSAL[out.errorKind] ?? PLAN_REFUSAL.unreadable} ${out.error}`, { triggerPhrase: env.TRIGGER }),
    );
    return { outputs };
  }

  Object.assign(outputs, {
    total: String(out.total),
    remaining: String(out.remaining),
    remaining_steps: String(out.remainingSteps),
    step_title: out.stepTitle,
    has_step: out.hasStep ? 'true' : 'false',
    at_checkpoint: out.atCheckpoint ? 'true' : 'false',
    jira_key: out.criteria?.kind === 'jira' ? out.criteria.key : '',
    release_ref: out.releasedRef ?? '',
    requested_by: out.requestedBy ?? '',
  });
  if (!out.hasStep || out.atCheckpoint || !isApprove(env.COMMAND)) {
    return { outputs };
  }
  const gate = await gateWaiting({ github, owner, repo, prNumber: env.PR_NUMBER, botLogin: env.BOT_LOGIN });
  outputs.gate_waiting = gate.waiting ? 'true' : 'false';
  return { outputs, notices: gate.unreadable ? [gate.unreadable] : [] };
}

const LOGIN = /^[A-Za-z0-9-[\]]+$/;

async function addressOf({ github, login }) {
  let id = null;
  try {
    const { data } = await github.rest.users.getByUsername({ username: login });
    id = Number.isInteger(data?.id) ? data.id : null;
  } catch {
    id = null;
  }
  return id === null
    ? { address: `${login}@users.noreply.github.com`, linked: false }
    : { address: `${id}+${login}@users.noreply.github.com`, linked: true };
}

function requesterFor(env) {
  const said = String(env.REQUESTER ?? '');
  if (LOGIN.test(said)) return said;
  const recorded = String(env.RECORDED_REQUESTER ?? '');
  if (LOGIN.test(recorded)) return recorded;
  const released = readRelease(String(env.RELEASE_REF ?? ''));
  return released !== null && LOGIN.test(released.login) ? released.login : '';
}

async function resolveIdentities({ github, core, env }) {
  const outputs = {
    author_name: '',
    author_email: '',
    coauthor: '',
  };
  const warnings = [];

  const bot = String(env.BOT_LOGIN ?? '');
  if (!LOGIN.test(bot)) {
    outputs.author_name = 'ksai[bot]';
    outputs.author_email = 'ksai[bot]@users.noreply.github.com';
    warnings.push('bot_login is unset, so commits this run pushes are attributed to nobody. Set it to <app-slug>[bot].');
  } else {
    const { address, linked } = await addressOf({ github, login: bot });
    outputs.author_name = bot;
    outputs.author_email = address;
    if (!linked) warnings.push(`could not read the user id of ${bot}, so its commits will not be attributed to it`);
  }

  const requester = requesterFor(env);
  if (!LOGIN.test(requester)) {
    warnings.push('this run has no requester login, so the commits it lands name nobody but the App');
    core?.info?.(`Commits are authored by ${outputs.author_name} <${outputs.author_email}> and credit nobody.`);
    return { outputs, warnings };
  }

  const { address, linked } = await addressOf({ github, login: requester });
  if (!linked) {
    warnings.push(`could not read the user id of ${requester}, so the co-author names the login without linking it`);
  }
  outputs.coauthor = `${requester} <${address}>`;
  core?.info?.(`Commits are authored by ${outputs.author_name} <${outputs.author_email}> and credit ${requester}.`);
  return { outputs, warnings };
}

async function fetchIssue({ github, core, owner, repo, env }) {
  const outputs = {
    head_file: '',
    state: '',
    default_branch: '',
    closed_notice: '',
  };

  const issue_number = Number(env.ISSUE_NUM);
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number });
  const state = String(issue.state ?? '').toUpperCase();

  if (state !== 'OPEN') {
    outputs.state = state;
    outputs.default_branch = env.DEFAULT_BRANCH ?? '';
    outputs.closed_notice = renderClosed(env.COMMAND, {
      state,
      triggerPhrase: env.TRIGGER,
      onIssue: env.ON_ISSUE,
    });
    if (outputs.closed_notice === '') {
      return { outputs, notices: [], failure: `no closed notice for command: ${env.COMMAND}` };
    }
    core?.info?.(`The conversation is ${state}, so this run stops before any work.`);
    return { outputs, notices: [], failure: null };
  }

  fs.writeFileSync(
    env.HEAD_FILE,
    JSON.stringify(
      {
        number: issue.number,
        title: issue.title ?? '',
        body: issue.body ?? '',
        commentCount: Number.isInteger(issue.comments) && issue.comments >= 0 ? issue.comments : null,
        labels: (issue.labels ?? []).map((label) => ({ name: typeof label === 'string' ? label : (label?.name ?? '') })),
        assignees: (issue.assignees ?? []).map((user) => ({ login: user?.login ?? '' })),
        state,
      },
      null,
      2,
    ),
  );
  outputs.head_file = env.HEAD_FILE;
  outputs.state = state;
  outputs.default_branch = env.DEFAULT_BRANCH ?? '';

  return { outputs, notices: [], failure: null };
}

async function fetchConversation({ github, owner, repo, env }) {
  const outputs = {
    file: '',
  };

  const issue_number = Number(env.ISSUE_NUM);
  const { commentCount, ...head } = readJson(env.HEAD_FILE);
  const phase = String(env.PHASE ?? '');
  const omitComments = env.ON_ISSUE === 'false' && (phase === 'fix' || phase === 'do');
  const comments = omitComments
    ? []
    : await github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number,
        per_page: 100,
      });

  const payload = {
    ...head,
    comments: comments.map((comment) => ({
      author: { login: comment.user?.login ?? '' },
      body: comment.body ?? '',
      createdAt: comment.created_at ?? '',
    })),
  };

  fs.writeFileSync(env.ISSUE_FILE, stripOwnComments(JSON.stringify(payload, null, 2), env.BOT_LOGIN));
  outputs.file = env.ISSUE_FILE;
  return {
    outputs,
    notices: omitComments
      ? [
          'Autofix context: source=pull-request-conversation decision=omit ' +
            `kept=0 omitted=${Number.isInteger(commentCount) ? commentCount : 'unknown'}; ` +
            'comment bodies were not read. Pull request conversation comments were omitted from this autofix prompt.',
        ]
      : [],
  };
}

const readJson = (at) => JSON.parse(fs.readFileSync(at, 'utf8'));

const PHASES = Object.freeze(
  Object.assign(Object.create(null), {
    plan: {
      file: 'ksai-plan-prompt.txt',
      writes: false,
      build: ({ env, issueJson, jiraJson }) =>
        renderPlanPrompt({
          repo: env.REPO,
          issueNumber: env.ISSUE_NUM,
          defaultBranch: env.DEFAULT_BRANCH,
          branch: env.BRANCH,
          planPath: planFilePathFor({ branch: env.BRANCH, dir: env.PLAN_DIR }),
          prNumber: env.PR_NUMBER,
          guidance: env.GUIDANCE,
          issueJson,
          jiraJson,
          jiraKey: env.JIRA_KEY,
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
    step: {
      file: 'ksai-step-prompt.txt',
      writes: true,
      build: ({ env, issueJson, jiraJson, denied }) =>
        renderStepPrompt({
          repo: env.REPO,
          issueNumber: env.ISSUE_NUM,
          prNumber: env.PR_NUMBER,
          branch: env.BRANCH,
          baseSha: env.BASE_SHA,
          stepTitle: env.STEP_TITLE,
          remaining: env.REMAINING,
          total: env.TOTAL,
          majorBump: env.MAJOR_BUMP,
          majorBumpSummary: env.MAJOR_BUMP_SUMMARY,
          majorBumpOmitted: env.MAJOR_BUMP_OMITTED,
          majorBumpAmbiguous: env.MAJOR_BUMP_AMBIGUOUS,
          denied,
          issueJson,
          jiraJson,
          jiraKey: env.JIRA_KEY,
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
    direct: {
      file: 'ksai-direct-prompt.txt',
      writes: true,
      build: ({ env, issueJson, jiraJson, denied }) =>
        renderDirectPrompt({
          repo: env.REPO,
          issueNumber: env.ISSUE_NUM,
          branch: env.BRANCH,
          baseSha: env.BASE_SHA,
          guidance: env.GUIDANCE,
          maxCommits: MAX_DIRECT_COMMITS,
          majorBump: env.MAJOR_BUMP,
          majorBumpSummary: env.MAJOR_BUMP_SUMMARY,
          majorBumpOmitted: env.MAJOR_BUMP_OMITTED,
          majorBumpAmbiguous: env.MAJOR_BUMP_AMBIGUOUS,
          denied,
          issueJson,
          jiraJson,
          jiraKey: env.JIRA_KEY,
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
    revise: {
      file: 'ksai-revise-prompt.txt',
      writes: true,
      build: ({ env, issueJson, jiraJson, planDocument, denied }) =>
        renderRevisePrompt({
          repo: env.REPO,
          issueNumber: env.ISSUE_NUM,
          prNumber: env.PR_NUMBER,
          branch: env.BRANCH,
          baseSha: env.BASE_SHA,
          planPath: env.PLAN_FILE,
          planDocument,
          threads: readJson(env.THREADS_FILE),
          scope: env.GUIDANCE,
          deferred: Number.parseInt(env.DEFERRED, 10),
          resumed: env.RESUMED_SESSION === 'true',
          denied,
          issueJson,
          jiraJson,
          jiraKey: env.JIRA_KEY,
          saw: sawFrom(env),
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
    fix: {
      file: 'ksai-fix-prompt.txt',
      writes: true,
      build: ({ env, issueJson, denied, allowed }) =>
        renderFixPrompt({
          repo: env.REPO,
          prNumber: env.ISSUE_NUM,
          branch: env.BRANCH,
          baseSha: env.BASE_SHA,
          threads: readJson(env.THREADS_FILE),
          scope: env.GUIDANCE,
          deferred: Number.parseInt(env.DEFERRED, 10),
          threadScoped: String(env.THREAD_ROOT_ID ?? '') !== '',
          saw: sawFrom(env),
          baseDiffRef: env.BASE_DIFF_REF,
          majorBump: env.MAJOR_BUMP,
          majorBumpSummary: env.MAJOR_BUMP_SUMMARY,
          majorBumpOmitted: env.MAJOR_BUMP_OMITTED,
          majorBumpAmbiguous: env.MAJOR_BUMP_AMBIGUOUS,
          denied,
          allowed,
          issueJson,
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
    do: {
      file: 'ksai-do-prompt.txt',
      writes: true,
      build: ({ env, issueJson, denied, allowed }) =>
        renderDoPrompt({
          repo: env.REPO,
          prNumber: env.ISSUE_NUM,
          branch: env.BRANCH,
          baseSha: env.BASE_SHA,
          request: env.GUIDANCE,
          checks: String(env.CHECKS_FILE ?? '') === '' ? null : readJson(env.CHECKS_FILE),
          retry: String(env.RETRY_FILE ?? '') === '' ? null : readJson(env.RETRY_FILE),
          threads: String(env.THREADS_FILE ?? '') === '' ? null : readJson(env.THREADS_FILE),
          baseDiffRef: env.BASE_DIFF_REF,
          mergedRef: env.MERGED_REF,
          mergedSha: env.MERGED_SHA,
          conflicted: env.MERGE_CONFLICTED,
          majorBump: env.MAJOR_BUMP,
          majorBumpSummary: env.MAJOR_BUMP_SUMMARY,
          majorBumpOmitted: env.MAJOR_BUMP_OMITTED,
          majorBumpAmbiguous: env.MAJOR_BUMP_AMBIGUOUS,
          saw: sawFrom(env),
          denied,
          allowed,
          issueJson,
          budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
          channelNonce: env.CHANNEL_NONCE,
        }),
    },
  }),
);

const merging = (env) => String(env?.PHASE ?? '') === 'do' && String(env?.MERGED_SHA ?? '').trim() !== '';

function buildPrompt({ env }) {
  const outputs = {
    file: '',
    allowed_tools: '',
    disallowed_tools: '',
    change_scope_file: '',
  };

  const phase = String(env.PHASE ?? '');
  const record = PHASES[phase];
  const policy = toolPolicy(merging(env) ? 'do-merge' : phase);
  if (!record || !policy) return { outputs, failure: `no prompt for phase: ${phase || '(none)'}` };

  const named = String(env.PLAN_FILE ?? '').trim();
  if (phase === 'revise' && !isPlanFile(named)) {
    return {
      outputs,
      failure:
        `\`${named || '(none)'}\` is not a plan document this flow wrote, so there is nothing to rework and ` +
        'nothing was run',
    };
  }

  let denied = null;
  if (record.writes) {
    const rule = deniedFor({
      workdir: env.GITHUB_WORKSPACE,
      baseSha: env.BASE_SHA,
      deniedPaths: env.DENIED_PATHS,
      planDir: planDirOf(env.PLAN_DIR),
      onlyPath: soleWritable(phase, named),
    });
    if (rule.unreadable) {
      return {
        outputs,
        failure:
          'the base commit could not be listed, so the instruction files this step may not touch are not ' +
          'known and the push gate would refuse whatever it wrote. Nothing was run. Check that the base ' +
          'ref this run was given is fetched',
      };
    }
    if (rule.truncated) {
      return {
        outputs,
        failure:
          'the instruction files import more than this flow will follow, so the push gate would refuse ' +
          'whatever this step wrote. Nothing was run. Shorten the import chain out of the instruction ' +
          'files this repository names in `denied_paths`',
      };
    }
    denied = rule.stated;
  }

  let changeScope = null;
  if (phase === 'fix' || phase === 'do') {
    const threads = String(env.THREADS_FILE ?? '') === '' ? null : readJson(env.THREADS_FILE);
    const checks = String(env.CHECKS_FILE ?? '') === '' ? null : readJson(env.CHECKS_FILE);
    const scoped = createScope({
      cwd: env.GITHUB_WORKSPACE,
      phase,
      headSha: env.BASE_SHA,
      baseRef: env.BASE_DIFF_REF,
      repo: env.REPO,
      pr: env.PR_NUMBER,
      threads,
      checks,
      merging: merging(env),
      outFile: path.join(env.PROMPT_DIR, 'ksai-change-scope', 'scope.json'),
    });
    if (!scoped.ok) {
      return {
        outputs,
        failure: `the trusted autofix change scope could not be created: ${scoped.reason}. Nothing was run`,
      };
    }
    changeScope = scoped.scope;
    outputs.change_scope_file = scoped.file;
  }

  let planDocument = '';
  if (phase === 'revise') {
    try {
      planDocument = fs.readFileSync(path.join(String(env.GITHUB_WORKSPACE ?? ''), named), 'utf8');
    } catch (error) {
      return {
        outputs,
        failure:
          `the plan document at \`${named}\` could not be read (${error?.message ?? error}), so the rework has ` +
          'nothing to start from and nothing was run',
      };
    }
  }

  const at = `${env.PROMPT_DIR}/${record.file}`;
  const readIfSet = (file) => (String(file ?? '') === '' ? '' : fs.readFileSync(file, 'utf8'));
  const prompt = record.build({
    env,
    issueJson: readIfSet(env.ISSUE_FILE),
    jiraJson: readIfSet(env.JIRA_FILE),
    planDocument,
    denied,
    allowed: changeScope ? renderAllowed(changeScope) : null,
  });
  fs.writeFileSync(at, prompt);

  Object.assign(outputs, {
    file: at,
    allowed_tools: policy.allowed,
    disallowed_tools: policy.disallowed,
  });
  return { outputs, failure: null };
}

async function resolveApprovalGate({ github, core, owner, repo, env, authorize, writeAccess }) {
  const outputs = {
    blocked: 'true',
    reason: '',
    approval_url: '',
    approval_thread: '',
    approval_ref: '',
    approval_login: '',
    approved_at: '',
    approved_head: '',
    needs_ack: 'false',
    release_ref: '',
    released_by: '',
    open_threads: '',
    overrode: 'false',
  };

  const applies = approvalApplies({ required: env.REQUIRE_APPROVAL, phase: env.PHASE });
  const config = applies ? await loadKsaiConfig({ github, core, owner, repo }) : { aliases: null };
  if (config.error) {
    outputs.reason = `could not read the command aliases, so an approval cannot be recognised: ${config.error}`;
    return { outputs, notices: [] };
  }

  const opened = applies
    ? resolveWriteAccess({ input: env.WRITE_ACCESS_COMMANDS, fromFile: config.writeAccess, commandAliases: config.aliases })
    : { commands: [] };
  if (opened.error) {
    outputs.reason = `could not read which commands write access releases here: ${opened.error}`;
    return { outputs, notices: [] };
  }

  const out = await resolveApproval({
    github,
    core,
    owner,
    repo,
    required: env.REQUIRE_APPROVAL,
    phase: env.PHASE,
    issueNumber: env.ISSUE_NUM,
    prNumber: env.PR_NUMBER,
    botLogin: env.BOT_LOGIN,
    planFile: env.PLAN_FILE,
    trigger: env.TRIGGER,
    commandAliases: config.aliases,
    releasedRef: env.RELEASED_REF,
    knownOwner: env.CHECKED_OWNER,
    disabledCommands: env.DISABLED_COMMANDS,
    nativeReview: {
      id: env.REVIEW_ID,
      state: env.REVIEW_STATE,
      submitted_at: env.REVIEW_SUBMITTED_AT,
      commit_id: env.REVIEW_COMMIT_ID,
      html_url: env.REVIEW_URL,
      author_association: env.REVIEW_ASSOCIATION,
      user: { login: env.REVIEWER, type: env.REVIEWER_TYPE },
    },
    controlPlaneApproval: {
      approver: env.CONTROL_PLANE_APPROVER,
      approvalId: env.CONTROL_PLANE_APPROVAL_ID,
      headSha: env.CONTROL_PLANE_HEAD_SHA,
      prNumber: env.CONTROL_PLANE_PR,
    },
    authorize,
    writeAccess,
    writeAccessCommands: opened.commands,
  });

  Object.assign(outputs, {
    blocked: out.blocked ? 'true' : 'false',
    reason: out.reason ?? '',
    approval_url: out.approval?.url ?? '',
    approval_thread: out.approval?.thread == null ? '' : String(out.approval.thread),
    approval_ref: out.approval?.approvalRef ?? '',
    approval_login: out.approval?.login ?? '',
    approved_at: out.blocked === false && out.approval?.at > 0 ? new Date(out.approval.at).toISOString() : '',
    approved_head: out.blocked === false ? (out.approval?.headSha ?? '') : '',
    needs_ack: out.blocked === false && out.acknowledged === false ? 'true' : 'false',
    release_ref: out.blocked === false && out.released !== true ? (out.releaseRef ?? '') : '',
    released_by: out.blocked === false ? (out.releaseRef ?? '') : '',
    open_threads: out.openThreads == null ? '' : String(out.openThreads),
    overrode: out.blocked === false && out.overrode === true ? 'true' : 'false',
  });
  return { outputs, notices: [describeApproval(out)] };
}

module.exports = {
  validateExtraArgs,
  resolveBareGate,
  resolveCourierPull,
  selectImplementArm,
  selectTesterArm,
  resolveRunContext,
  resolveAuth,
  resolveRunSubject,
  resolveCheckpoint,
  decidePhase,
  phaseNotice,
  resolveWork,
  resolveSize,
  planClassification,
  readVerdict,
  readPlan,
  resolveIdentities,
  fetchIssue,
  fetchConversation,
  buildPrompt,
  resolveApprovalGate,
  SECURED_AUTOFIX_CAPABILITY,
  EXTRA_ARGS_REFUSAL,
  PLAN_REFUSAL,
};
