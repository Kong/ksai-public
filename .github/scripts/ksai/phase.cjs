'use strict';

const { BRANCH_SHAPE, JIRA_BRANCH_SHAPE, safeEcho } = require('./verify-chunk.cjs');
const { readCount } = require('./continue.cjs');

const { pagedProbe } = require('./pages.cjs');
const { scrub, hasPlanRegion, heldBy, planFileIn } = require('./plan.cjs');
const { asAlert, canonicalCommand, JIRA_KEY_SHAPE, plansWorkHere } = require('../lib/select-arm.cjs');
const { EXPLICIT_SOURCE } = require('../lib/request-intent.cjs');

const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * WORK_SCOPES is every kind of work a dispatch record may narrow a run to, and the names a record
 * spells them with. The control plane writes the work the label that started the run admits, so a
 * pull request labelled for its build alone does not get its review threads answered, and one
 * labelled for reviews does not fall through to the build.
 *
 * A copy of this list ships in `.github/actions/dispatch-record/record.mjs`, which refuses a record
 * before this ever sees it; a parity test beside that copy holds the two together.
 */
const WORK_SCOPES = Object.freeze(['builds', 'reviews']);

/**
 * scopeAdmits reads what a record narrowed a run to, and answers null where it names work this
 * runner does not know.
 *
 * An empty scope narrows nothing: that is every run a comment started, and every dispatch from a
 * control plane old enough to write none. Unknown work is refused rather than read as an empty
 * scope, because reading it as empty would widen the run to everything rather than narrow it - the
 * opposite of what whoever wrote it asked for.
 */
function scopeAdmits(scope) {
  const named = String(scope ?? '').trim();
  if (named === '') return { builds: true, reviews: true };
  const parts = named.split(',');
  if (new Set(parts).size !== parts.length || parts.some((one) => !WORK_SCOPES.includes(one))) return null;
  return { builds: parts.includes('builds'), reviews: parts.includes('reviews') };
}

const { NUMBER_SHAPE: ISSUE_NUMBER_SHAPE } = require('./context.cjs');

function issueForBranch(branch) {
  const name = String(branch ?? '');
  if (!BRANCH_SHAPE.test(name)) return null;
  const [prefix, number] = name.slice(name.indexOf('/') + 1).split('-', 2);
  if (prefix !== 'issue' || !ISSUE_NUMBER_SHAPE.test(String(number ?? ''))) return null;
  return Number(number);
}

function isBranchForIssue(branch, issueNumber) {
  const number = String(issueNumber ?? '');
  if (!ISSUE_NUMBER_SHAPE.test(number)) return false;
  return issueForBranch(branch) === Number(number);
}

function jiraForBranch(branch) {
  const name = String(branch ?? '');
  if (!JIRA_BRANCH_SHAPE.test(name)) return null;
  const [prefix, project, number] = name.slice(name.indexOf('/') + 1).split('-', 3);
  if (prefix !== 'jira') return null;
  const key = `${project}-${number}`;
  return JIRA_KEY_SHAPE.test(key) ? key : null;
}

function isBranchForWork(branch, workRef) {
  const ref = String(workRef ?? '');
  const key = ref.toUpperCase();
  if (JIRA_KEY_SHAPE.test(key)) return jiraForBranch(branch) === key;
  return isBranchForIssue(branch, ref);
}

async function discoverPhase({
  github = null,
  core = null,
  owner = null,
  repo = null,
  issueNumber = null,
  jiraKey = null,
  defaultBranch = null,
  maxPages = MAX_PAGES,
} = {}) {
  if (!github?.rest) return { error: 'no authenticated GitHub client was passed' };
  const key = String(jiraKey ?? '').toUpperCase();
  if (key && !JIRA_KEY_SHAPE.test(key)) return { error: `\`${key}\` is not a Jira issue key` };
  const number = String(issueNumber ?? '');
  if (!key && !ISSUE_NUMBER_SHAPE.test(number)) return { error: `\`${number}\` is not an issue number` };
  const workRef = ISSUE_NUMBER_SHAPE.test(number) ? number : key;
  const named = ISSUE_NUMBER_SHAPE.test(number) ? `Issue #${number}` : key;
  const ref = String(defaultBranch ?? '').trim();
  if (!ref) return { error: 'no default branch was passed to fall back to' };

  const candidates = [];
  const probe = await pagedProbe({
    perPage: PER_PAGE,
    maxPages,
    fetchPage: async (page) => {
      const response = await github.rest.pulls.list({ owner, repo, state: 'open', per_page: PER_PAGE, page });
      return response?.data;
    },
    take: (pull) => {
      const head = pull?.head?.ref;
      if (!isBranchForWork(head, workRef)) return;
      candidates.push({
        prNumber: pull.number,
        ref: String(head),
        isDraft: pull.draft === true,
        planned: hasPlanRegion(pull?.body),
        planFile: planFileIn(pull?.body) ?? '',
        held: heldBy(pull?.body) ?? '',
      });
    },
  });

  if (probe.threw) return { error: `could not list open pull requests in ${owner}/${repo}: ${probe.failed}` };
  if (!probe.listed) return { error: `${owner}/${repo} returned no pull request list on page ${probe.page}` };
  if (!probe.complete) {
    return {
      error:
        `${owner}/${repo} has more than ${maxPages * PER_PAGE} open pull requests, so this cannot tell ` +
        'whether one already exists for this work. Planning again would open a duplicate, so it stops here.',
    };
  }

  if (candidates.length === 0) {
    core?.info?.(`No branch for ${named} yet, so this run plans.`);
    return { phase: 'plan', ref };
  }
  if (candidates.length > 1) {
    const listed = candidates.map((found) => `#${found.prNumber} (${found.ref})`).join(', ');
    core?.warning?.(
      `${named} has ${candidates.length} open pull requests on branches this flow names: ${listed}. ` +
        'Close or rename all but one, then re-trigger. Continuing would run two implementations of one piece ' +
        'of work in parallel, each ticking boxes the other cannot see.',
    );
    return { phase: 'ambiguous', ref, candidates };
  }
  const [only] = candidates;
  if (!only.planned && only.planFile !== '') {
    core?.info?.(`Pull request #${only.prNumber} carries a plan document nobody has approved yet.`);
    return {
      phase: 'plan-review',
      ref: only.ref,
      prNumber: only.prNumber,
      isDraft: only.isDraft,
      planFile: only.planFile,
      held: only.held,
    };
  }
  if (!only.planned) {
    core?.info?.(`Pull request #${only.prNumber} carries no plan yet, so this run writes one into it.`);
    return { phase: 'plan', ref: only.ref, prNumber: only.prNumber, isDraft: only.isDraft, held: only.held };
  }
  core?.info?.(`Continuing pull request #${only.prNumber} on ${only.ref}.`);
  return { phase: 'step', ref: only.ref, prNumber: only.prNumber, isDraft: only.isDraft, held: only.held };
}

function decideFinish({ total = null, remainingAfter = null, hasStep = null, isDraft = null } = {}) {
  const planned = readCount(total, { max: 9999 });
  if (planned === null || planned === 0) {
    return { finish: false, reason: 'no-plan' };
  }
  const remaining = readCount(remainingAfter, { max: 9999 });
  if (remaining === 0) {
    return { finish: true, reason: 'last-box' };
  }
  if (String(hasStep) === 'false' && String(isDraft) === 'true') {
    return { finish: true, reason: 'earlier-finish-incomplete' };
  }
  if (String(hasStep) === 'false') {
    return { finish: false, reason: 'already-ready' };
  }
  return { finish: false, reason: remaining === null ? 'step-outcome-unknown' : 'steps-remain' };
}

const REVISE_STOP = Object.freeze(
  Object.assign(Object.create(null), {
    plan: 'there is no plan document on this pull request yet, so there is nothing to rework',
    step: 'this plan has already been released, so the review on it is answered against the code rather than the plan',
    ambiguous: 'more than one open pull request names this work, so which plan to rework is not decided here',
    answered: 'every review thread on the plan document is either resolved or already answered',
    other: 'this run found no plan document under review, so there is nothing to rework',
  }),
);

const PHASE_FLOWS = Object.freeze(
  Object.assign(Object.create(null), {
    implement: 'plan',
    approve: 'plan',
    resume: 'plan',
    revise: 'plan',
    fix: 'work',
    unlock: 'work',
  }),
);

const PHASE_FIELDS = Object.freeze([
  'phase',
  'request',
  'ref',
  'isDraft',
  'prNumber',
  'pending',
  'deferred',
  'disputed',
  'baseRef',
  'threadsFile',
  'threadStateFile',
  'checksFile',
  'onBranch',
  'handsOff',
  'planFile',
  'conflicting',
  'held',
]);

const COMMAND_STOP = Object.freeze(
  Object.assign(Object.create(null), {
    revise: 'I did not rework the plan, so nothing changed and nothing else ran:',
  }),
);

const PHASE_PROSE = Object.freeze(
  Object.assign(Object.create(null), {
    plan: Object.freeze({
      stop: 'I could not tell whether I had already started this issue, so I stopped rather than risk opening a second pull request for it:',
      work: 'plan',
      noun: 'This issue',
    }),
    work: Object.freeze({
      stop: 'I did not do the work you asked for:',
      work: 'work on',
      noun: 'This pull request',
    }),
  }),
);

const GENERIC_STOP = 'I stopped rather than guess at what to do here:';

function familyOf(command) {
  const candidate = String(command ?? '')
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(PHASE_FLOWS, candidate) ? PHASE_FLOWS[candidate] : undefined;
}

function familyHere(command, onIssue) {
  const family = familyOf(command);
  if (family !== undefined && plansWorkHere(command, onIssue)) return 'plan';
  return family;
}

function renderPhaseStop(command, error, { triggerPhrase = null, onIssue = null } = {}) {
  const family = familyHere(command, onIssue);
  if (family === undefined) return '';
  const named = String(command ?? '').trim().toLowerCase();
  const lead = COMMAND_STOP[named] ?? PHASE_PROSE[family]?.stop ?? GENERIC_STOP;
  return asAlert('WARNING', scrub(`${lead} ${String(error ?? '').trim()}`, { triggerPhrase }).trim());
}

function renderSubjectStop(error, { triggerPhrase = null } = {}) {
  const said = String(error ?? '').trim();
  if (!said) return '';
  return asAlert('WARNING', scrub(`I could not work out which issue this is about, so nothing ran: ${said}`, { triggerPhrase }));
}

const PHASE_NOTICE = Object.freeze(
  Object.assign(Object.create(null), {
    ambiguous:
      'More than one open branch claims this issue, so I stopped rather than guess which one to continue. ' +
      'Close or rename all but one and comment again',
    fix:
      'No review thread here is waiting on an answer, so nothing ran. Threads I have already replied in count ' +
      'as answered, and so do the ones a human has resolved - resolve or re-open as needed and ask again. If ' +
      'the work you want was never raised in a thread - a red check, a conflict, a missing test - say what you ' +
      'want done after the command and it will do that instead',
    do:
      'Nothing I can see here is waiting on me, so nothing ran: no review thread is unanswered, and nothing ' +
      'I could read is failing or conflicting. Say what you want done after the command - "fix the failing ' +
      'unit test", "add a test for the empty-slice case" - or ask again once a check has gone red and it will ' +
      'work from that',
  }),
);

/**
 * FIX_NOTICE_REVIEWS replaces the last sentence of the `fix` notice for a run the label barred from the
 * build. The offer to say what you want done instead is true of a run that may look anywhere and false
 * of this one: the red check it would point at is the work somebody kept for themselves.
 */
const FIX_NOTICE_REVIEWS =
  'No review thread here is waiting on an answer, so nothing ran. Threads I have already replied in count ' +
  'as answered, and so do the ones a human has resolved - resolve or re-open as needed and ask again. This ' +
  'run was started by a label admitting review comments alone, so a red check or a conflict is not mine to ' +
  'work on here';

function renderPhaseNotice(phase, { pending = null, triggerPhrase = null, scope = null } = {}) {
  const key = String(phase ?? '')
    .trim()
    .toLowerCase();
  const body = PHASE_NOTICE[key];
  if (!body) return '';
  if (key !== 'ambiguous' && String(pending ?? '') !== '0') return '';
  const admits = scopeAdmits(scope);
  const said = key === 'fix' && admits !== null && !admits.builds ? FIX_NOTICE_REVIEWS : body;
  return asAlert('WARNING', scrub(said, { triggerPhrase }));
}

function renderClosed(command, { state = null, triggerPhrase = null, onIssue = null } = {}) {
  const prose = PHASE_PROSE[familyHere(command, onIssue)];
  const work = prose?.work;
  if (!work) return '';
  const noun = prose.noun;
  const shown = String(state ?? '').trim() || 'unknown';
  return asAlert(
    'WARNING',
    scrub(`${noun} is not open (state: \`${shown}\`), so there is nothing to ${work}`, { triggerPhrase }),
  );
}

function normalize(answer) {
  for (const key of Object.keys(answer)) {
    if (key !== 'error' && !PHASE_FIELDS.includes(key)) {
      throw new Error(`\`${key}\` is not a phase field; add it to PHASE_FIELDS`);
    }
  }
  const said = (key) => (answer[key] === undefined || answer[key] === null ? '' : String(answer[key]));
  return Object.fromEntries(['error', ...PHASE_FIELDS].map((key) => [key, said(key)]));
}

const refuse = (error) => normalize({ error });

async function resolveSubject({
  command = null,
  onIssue = null,
  threadNumber = null,
  pullsGet = async (_prNumber) => ({ head: { ref: null } }),
} = {}) {
  const thread = String(threadNumber ?? '').trim();
  if (!ISSUE_NUMBER_SHAPE.test(thread)) return { error: `\`${thread}\` is not a number this run can work on` };

  if (familyOf(command) !== 'plan' || String(onIssue) !== 'false') return { number: Number(thread) };

  let pull;
  try {
    pull = await pullsGet(Number(thread));
  } catch (error) {
    return { error: `could not read #${thread} to find the issue it implements: ${error?.message ?? error}` };
  }

  const branch = String(pull?.head?.ref ?? '');
  const jiraKey = jiraForBranch(branch);
  if (jiraKey !== null) return { number: Number(thread), jiraKey };

  const issueNumber = issueForBranch(branch);
  if (issueNumber === null) {
    return {
      error:
        `#${thread} is on \`${safeEcho(branch)}\`, which is not a branch this flow named, so there is no work ` +
        'behind it to plan or approve against. This command answers a pull request this flow opened from an issue ' +
        'or from a Jira ticket.',
    };
  }
  return { number: issueNumber };
}

async function resolvePhase({
  command = null,
  github = null,
  checksGithub = null,
  core = null,
  owner = null,
  repo = null,
  number = null,
  jiraKey = null,
  defaultBranch = null,
  botLogin = null,
  guidance = null,
  onIssue = null,
  routeSource = null,
  threadsFile = null,
  threadStateFile = null,
  commentId = null,
  checksFile = null,
  threadRootId = null,
  scope = null,
  sleep = null,
  writeFile = (at, body) => require('node:fs').writeFileSync(at, body),
} = {}) {
  const wanted = canonicalCommand(String(command ?? '').trim());
  const family = familyHere(wanted, onIssue);
  const said = String(guidance ?? '').trim();
  const onBranch = family === undefined || plansWorkHere(wanted, onIssue) ? '' : 'true';
  const standingHold = (value) => (wanted === 'resume' ? '' : String(value ?? ''));
  if (family === undefined) {
    return refuse(`\`${wanted}\` is not a command with a phase in this flow, so there is nothing to work on`);
  }

  if (family === 'work') {
    const { namesTheReview, resolveFixPhase } = require('./threads.cjs');
    const scoped = String(threadRootId ?? '').trim() !== '';
    if (wanted === 'unlock' && !scoped) {
      return refuse('`unlock` must be written inside the review thread it releases');
    }
    const admits = scopeAdmits(scope);
    if (admits === null) {
      return refuse(
        `this run was decided for \`${safeEcho(String(scope))}\`, which is not work this flow knows how to do, ` +
          'so nothing ran',
      );
    }
    const request = namesTheReview(said) ? '' : said;
    const asked = request !== '' && String(routeSource ?? '') === EXPLICIT_SOURCE;
    /*
     * Words after the command name the work, and a run free to look anywhere answers them in the do
     * phase rather than reading threads it was not pointed at. A run that may not touch the build has
     * nowhere else to look, so the words scope the thread pass instead of skipping it - otherwise a
     * reviewer who wrote `fix` with a sentence after it on a review-labelled pull request would get a
     * run that answers nothing at all.
     */
    const answersThreads = admits.reviews && (scoped || !asked || !admits.builds);
    let known = null;

    if (answersThreads) {
      const out = await resolveFixPhase({
        github,
        core,
        owner,
        repo,
        prNumber: number,
        botLogin,
        guidance: request,
        threadRootId,
        allowLocked: wanted === 'unlock',
      });
      if (out.error) return refuse(out.error);
      if (!threadsFile) return refuse('no path was given to write the review threads to');
      if (!threadStateFile) return refuse('no path was given to write the review thread state to');
      const { phase, ref, prNumber, pending, threads, deferred, disputed, baseRef, held, target, total } = out;
      known = target ?? null;
      if (scoped || pending.length > 0 || total > 0) {
        writeFile(threadsFile, JSON.stringify(pending));
        writeFile(threadStateFile, JSON.stringify(threads));
        return normalize({
          phase,
          request,
          ref,
          prNumber,
          pending: pending.length,
          disputed,
          deferred,
          baseRef,
          held: standingHold(held),
          threadsFile,
          threadStateFile,
          onBranch,
        });
      }
      core?.info?.(
        `#${String(prNumber ?? number)}: this pull request has no review thread at all, so this run looks for other work.`,
      );
    }

    if (!admits.builds) {
      return refuse(
        'this run was started to answer review comments, and this pull request has no review thread at all, so ' +
          'there was nothing to answer and nothing ran',
      );
    }

    const { resolveDoPhase } = require('./do.cjs');
    const out = await resolveDoPhase({
      known,
      github,
      checksGithub,
      core,
      owner,
      repo,
      prNumber: number,
      botLogin,
      guidance: request,
      commentId,
      checksFile,
      threadRootId,
      threadsFile,
      sleep,
      writeFile,
    });
    if (out.error) return refuse(out.error);
    return normalize({
      phase: out.phase,
      request,
      ref: out.ref,
      prNumber: out.prNumber,
      pending: out.pending,
      baseRef: out.baseRef,
      held: standingHold(out.held),
      onBranch,
      checksFile: out.checksFile,
      threadsFile: out.threadsFile,
      conflicting: out.conflicting === true ? 'true' : '',
    });
  }

  if (family === 'plan') {
    const key = String(jiraKey ?? '').trim();
    const out = await discoverPhase({
      github,
      core,
      owner,
      repo,
      issueNumber: key ? null : number,
      jiraKey: key,
      defaultBranch,
    });
    if (out.error) return refuse(out.error);
    if (wanted !== 'revise') {
      return normalize({
        phase: out.phase,
        request: said,
        ref: out.ref,
        isDraft: out.isDraft,
        prNumber: out.prNumber,
        planFile: out.planFile,
        held: standingHold(out.held),
        handsOff: onBranch,
      });
    }

    if (out.phase !== 'plan-review') {
      return refuse(String(REVISE_STOP[out.phase] ?? REVISE_STOP.other));
    }
    if (!threadsFile) return refuse('no path was given to write the review threads to');
    if (!threadStateFile) return refuse('no path was given to write the review thread state to');
    const { resolveRevisePhase } = require('./revise.cjs');
    const asked = await resolveRevisePhase({
      github,
      core,
      owner,
      repo,
      prNumber: out.prNumber,
      botLogin,
      planFile: out.planFile,
      guidance,
    });
    if (asked.error) return refuse(asked.error);
    if (asked.pending.length === 0) {
      return refuse(String(REVISE_STOP.answered));
    }
    writeFile(threadsFile, JSON.stringify(asked.pending));
    writeFile(threadStateFile, JSON.stringify(asked.threads));
    return normalize({
      phase: 'revise',
      request: said,
      ref: out.ref,
      isDraft: out.isDraft,
      prNumber: out.prNumber,
      planFile: asked.planFile,
      pending: asked.pending.length,
      deferred: asked.deferred,
      disputed: asked.disputed,
      held: standingHold(out.held),
      threadsFile,
      threadStateFile,
      onBranch,
    });
  }

  return refuse(
    `the \`${wanted}\` command belongs to the \`${family}\` phase family, and nothing in this action resolves ` +
      'that family yet, so there is nothing to work on',
  );
}

module.exports = {
  MAX_PAGES,
  WORK_SCOPES,
  GENERIC_STOP,
  COMMAND_STOP,
  PER_PAGE,
  PHASE_FLOWS,
  PHASE_FIELDS,
  resolvePhase,
  renderPhaseStop,
  renderPhaseNotice,
  renderClosed,
  isBranchForIssue,
  isBranchForWork,
  issueForBranch,
  jiraForBranch,
  resolveSubject,
  renderSubjectStop,
  discoverPhase,
  decideFinish,
};
