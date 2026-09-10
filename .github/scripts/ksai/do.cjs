'use strict';

/*
 * One named piece of work on a pull request, and whether this run is the one that does it.
 *
 * The fourth phase of the implement flow. `implement` plans from an issue, `approve` releases a plan, `fix`
 * answers the review threads, and this answers the comment itself: "fix the broken CI", "add a test for the
 * empty-slice case", "the deploy preview is failing, sort it out". It exists because `fix` cannot serve those -
 * a pull request with nothing unresolved has no thread to answer, so the run posts "No review thread here is
 * waiting on an answer" and stops before the model, which is the wrong answer to a request that never mentioned
 * a review.
 *
 * **Three inputs, and only one of them is the request.** The request is the trailing text of the triggering
 * comment, which already reaches every phase as `guidance_html` from the selector, HTML-escaped. The diff is the
 * branch under work, checked out with full history and a fetched base ref, exactly as the fix phase does it. The
 * evidence is whatever CI says about the head, when it says anything.
 *
 * **No thread list, deliberately.** A `do` run never replies in a review thread and never marks one answered,
 * because that record belongs to `fix`: a run that touched a thread without answering its point would make the
 * point unanswerable, since a reply is what `pendingThreads` reads.
 *
 * **The record is a report comment naming the request it answers.** Every other phase derives its state from
 * something GitHub already holds - the plan phase from the checklist in the draft pull request body, the fix
 * phase from its own reply in the thread. A free-form request has no such place, so the run posts one comment
 * carrying the triggering comment's id in a marker, and a later run treats a request whose id already appears in
 * a comment from `bot_login` as answered. The part that matters is that the marker alone is never trusted:
 * the author's login is checked as well, and `RESERVED_COMMENT` matches
 * `ksai-do` so `scrub` strips a forged copy out of every untrusted string before it can be rendered.
 *
 * Consequences worth stating rather than discovering: a duplicate webhook or a re-run does nothing and posts
 * nothing, a retry is a new comment, and a push that lands while the comment fails costs a duplicate attempt
 * rather than a lost commit. That last one is the trade the fix phase already takes.
 */

const MAX_REPORT_CHARS = 6000;

/*
 * The marker this phase writes and reads, and the prefix it is built from.
 *
 * Both halves in one module, which is `criteriaOf`'s rule and its recorded bug: there the finder matched on the
 * constant while the parser restated it as a literal, so changing the prefix would have left the writer writing
 * and the reader rejecting. So the reader below builds its pattern from this constant rather than spelling it.
 *
 * `ksai-do:` rather than `ksai-plan:`-anything, because `RESERVED_COMMENT` matches on the family name and a
 * shared prefix would make a forged plan marker and a forged request marker the same forgery.
 */
const DO_MARKER_PREFIX = '<!-- ksai-do:';

/*
 * The same prefix under the name this flow shipped with, read but never written.
 *
 * A request answered before the rename carries the old marker on its report comment, and that comment IS the
 * record. Reading only the new prefix would make every one of those requests look unanswered, and this module's
 * whole bias is that a missed report costs a duplicate commit on somebody's branch - so the legacy prefix is read
 * for exactly as long as those comments exist. `RESERVED_COMMENT` matches both families for the same reason it
 * matched this one: a forged copy of either is worth the same commit.
 */
const LEGACY_DO_MARKER_PREFIX = '<!-- muthur-do:';

/*
 * A comment id, bounded at 19 digits rather than at `NUMBER_SHAPE`'s ten.
 *
 * They are different classes of value and this module used the wrong one. `NUMBER_SHAPE` bounds a pull request
 * number, where ten digits is far past anything real; a comment id is a global counter already near 4x10^9, so the
 * ten-digit bound is a dated break rather than a limit - once ids cross 10^10, `renderDoMarker` answers the empty
 * string, `alreadyReported` refuses every request, and the phase stops before the model on every comment. Same
 * bound as `COMMENT_ID_SHAPE` in ksai/fix.mjs, which reached the right one first.
 *
 * The pull request number needs no shape here at all: `resolvePullTarget` checks it before any call, which is why
 * this module stopped importing `NUMBER_SHAPE` rather than keeping it for a second reader.
 */
/*
 * The escape the marker's own reader needs, from the module that owns the scrub the marker is protected by.
 *
 * No cycle: `ksai/plan.cjs` requires nothing at all, which is the property its own header states and which
 * every module here relies on.
 */
const { markerValue, POSITIVE_ID_SHAPE } = require('./plan.cjs');
const { counted } = require('../lib/text.cjs');

const COMMENT_ID_SHAPE = POSITIVE_ID_SHAPE;
/* One answer to "which branch, and may this push to it", shared with every other pull-surface phase. */
const { probeComments } = require('./pages.cjs');

const { resolvePullTarget } = require('./pull.cjs');

const MERGE_BLOCKING_RULES = Object.freeze(
  Object.assign(Object.create(null), {
    required_linear_history: (base) =>
      `\`${base}\` requires a linear history, so a merge commit cannot land on it. Rebase the branch onto ` +
      `\`${base}\` and push it yourself - this flow does not rebase, because rewriting a branch needs a ` +
      'force-push its own gate refuses.',
    required_signatures: (base) =>
      `\`${base}\` requires signed commits. A merge commit has two parents and the API that signs for this flow ` +
      'takes one, so this merge would be pushed unsigned and refused. Resolve the conflict yourself, or ask a ' +
      'maintainer whether that rule can admit this flow.',
  }),
);

async function mergeBlockedBy({ github = null, core = null, owner = null, repo = null, base = null } = {}) {
  const branch = String(base ?? '').trim();
  if (!branch || typeof github?.paginate !== 'function') return '';
  let rules;
  try {
    rules = await github.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner,
      repo,
      branch,
      per_page: 100,
    });
  } catch (error) {
    core?.warning?.(
      `the rules on \`${branch}\` could not be read (${error?.message ?? error}), so this run assumes a merge ` +
        'commit can land there. Nothing checks that again: the merge is pushed to the head branch, which those ' +
        'rules do not govern, so a base that refuses a merge commit refuses it at the merge rather than at the ' +
        'push, and the branch has to be rebased by hand.',
    );
    return '';
  }
  for (const rule of Array.isArray(rules) ? rules : []) {
    const named = String(rule?.type ?? '');
    if (Object.prototype.hasOwnProperty.call(MERGE_BLOCKING_RULES, named)) return MERGE_BLOCKING_RULES[named](branch);
  }
  return '';
}

/* What CI says about the head, bounded and failing open. Required late, in `resolveDoPhase`, see there. */

/** Whether a login is this flow's own bot, tolerant of the `[bot]` suffix on either side. */
const { hydrateScopedThread, readThreads, selectThreads } = require('./threads.cjs');
const { vouchedOwn } = require('./approval.cjs');

/*
 * Issue comments to read when looking for a report this flow already posted, and how many pages to walk.
 *
 * **Walked rather than sorted, because this endpoint has no sort control.** The first version passed
 * `direction: 'desc'` reasoning that a report for THIS request was posted after it and is therefore near the end.
 * `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` takes no such parameter: GitHub drops it and answers
 * oldest-first, which ksai/gate.cjs already records where it reasons about its own cap. So the scan read the one
 * page that cannot hold the report, and on a pull request with more than 100 comments a re-run answered the same
 * request again and pushed a second commit.
 *
 * Ten pages is 1000 comments, past anything real, and exceeding it is "cannot tell" rather than "not answered" -
 * which is the direction this whole check fails in. See `alreadyReported`.
 */
const MAX_REPORT_PAGES = 10;

/** The marker for one request, as this phase writes it. One line, and the id is checked before it is written. */
function renderDoMarker(commentId) {
  const id = String(commentId ?? '');
  if (!COMMENT_ID_SHAPE.test(id)) return '';
  return `${DO_MARKER_PREFIX}${id} -->`;
}

/**
 * The request id a report comment says it answers, or null.
 *
 * Built from `DO_MARKER_PREFIX` rather than a second spelling of it, for the reason above. One line, found by
 * scanning lines rather than by a pattern over the whole body, so a marker cannot be smuggled inside a fenced
 * block that happens to contain a newline - the same shape `criteriaOf` uses.
 */
function doRequestOf(body) {
  const readId = (value) => (COMMENT_ID_SHAPE.test(value) ? value : null);
  for (const prefix of [DO_MARKER_PREFIX, LEGACY_DO_MARKER_PREFIX]) {
    const found = markerValue(body, prefix, readId);
    if (found) return found;
  }
  return null;
}

/**
 * Whether this flow has already reported on this request.
 *
 * Returns `{ answered, unreadable }`. Both the marker AND the author are checked, because a marker is a claim
 * anybody with write access to a comment box can make, so it identifies the content
 * and the login identifies the author. Either alone is forgeable by somebody who can comment.
 *
 * **An unreadable comment list is not "not answered".** Reading it that way would answer the same request twice
 * on a 502 - a second commit for work already pushed - so it comes back as unreadable and the caller refuses.
 * That is the opposite bias to `readFailingChecks` next door, and the difference is what the answer costs: a
 * missing log costs the model some context, and a missed report costs a duplicate commit on somebody's branch.
 */
async function alreadyReported({
  github = null,
  owner = null,
  repo = null,
  prNumber = null,
  botLogin = null,
  commentId = null,
} = {}) {
  const wanted = String(commentId ?? '');
  if (!COMMENT_ID_SHAPE.test(wanted)) {
    return {
      answered: false,
      unreadable:
        wanted.trim() === ''
          ? 'no comment id was passed, so this cannot tell whether it has already done this work. A run ' +
            'dispatched with a request in its body carries the id of the comment that asked, in `comment_id`.'
          : `\`${wanted}\` is not a comment id`,
    };
  }
  /*
   * Without a bot login nothing can be attributed, so this cannot answer at all.
   *
   * Unreadable rather than "not answered", for the reason above and one more: `resolveFixPhase` warns and
   * continues without a login because the cost there is a duplicate reply, which is visible and harmless. Here
   * the cost is a duplicate commit, so the same absence has to stop the run.
   */
  if (!String(botLogin ?? '').trim()) {
    return {
      answered: false,
      unreadable:
        'no bot_login was passed, so this cannot tell whether it has already answered this request. Set the ' +
        '`bot_login` input to `<app-slug>[bot]`.',
    };
  }

  let answered = false;
  /*
   * Out of pages, so this cannot tell - which is the answer, not "not answered".
   *
   * The distinction is the whole point of the field: reading an exhausted walk as no report would answer the same
   * request twice and push a second commit onto somebody's branch, which is the cost this check exists to avoid.
   */
  const { unreadable } = await probeComments({
    github,
    owner,
    repo,
    prNumber,
    maxPages: MAX_REPORT_PAGES,
    cannot: 'cannot tell whether it already answered this request',
    stop: (comment) => {
      if (!vouchedOwn(comment, botLogin)) return false;
      answered = doRequestOf(comment?.body) === wanted;
      return answered;
    },
  });

  if (answered) return { answered: true, unreadable: null };
  return { answered: false, unreadable };
}

/*
 * The phase a request that already has a report resolves to.
 *
 * Named rather than written twice, because its second reader is a string comparison in YAML: the run-failed notice
 * has to exclude it, or a duplicate webhook - which is meant to do nothing and say nothing - gets told the run did
 * not complete. A literal here and a literal there is a rename away from that notice firing again, so the wiring
 * test pins the YAML against this constant.
 */
const REPLAYED_PHASE = 'replayed';

/**
 * Everything a `do` run works on: the branch, the request, and what CI says about the head.
 *
 * Returns one of:
 *   `{ phase: 'do', ..., pending: 1, checksFile, threadsFile }`   there is work, and this run does it
 *   `{ phase: 'do', ref, baseRef, prNumber, pending: 0 }`         nothing to work on, and the caller says so
 *   `{ phase: 'replayed', ref, baseRef, prNumber, pending: 0 }`   this request already has a report
 *   `{ error }`                                                  the question could not be answered
 *
 * `threadsFile` is empty unless the request was written inside a review thread, in which case that one thread is
 * written to it in the shape the fix phase writes.
 *
 * `pending` is 0 or 1 rather than a count, and it reuses the fix phase's field on purpose: the action's checkout,
 * model and notice steps already branch on `pending == '0'`, and a second field meaning the same thing is a
 * second place for a wiring fault to hide. What it counts here is requests, and there is at most one.
 *
 * **A request with no text and nothing failing is a success, not an error.** It is the `fix` phase's empty
 * `pending` arrived at from the other direction: there is genuinely nothing to do, the caller posts a notice, and
 * no model runs. A bare `<phrase> do` on a green pull request is a person asking what this can do for them.
 *
 * The evidence goes to a **file** rather than a step output, which is the call `resolveFixPhase` makes about the
 * threads and for the same two reasons: it is untrusted text of unbounded size, so an output is both a size limit
 * and an injection surface.
 */
async function resolveDoPhase({
  known = null,
  github = null,
  checksGithub = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  botLogin = null,
  guidance = null,
  commentId = null,
  checksFile = null,
  threadRootId = null,
  threadsFile = null,
  sleep = null,
  writeFile = (at, body) => require('node:fs').writeFileSync(at, body),
} = {}) {
  const target = known?.mergeable != null
    ? known
    : await resolvePullTarget({
      github,
      core,
      owner,
      repo,
      prNumber,
      noun: 'branch to work on',
      awaitMergeable: true,
      ...(typeof sleep === 'function' ? { sleep } : {}),
    });
  if (target.error) return { error: target.error };
  const { ref, baseRef, reportedHeadSha } = target;
  const number = String(target.prNumber);
  const conflicting = target.mergeable === false;

  /*
   * The already-answered check runs BEFORE the evidence is read, and before anything is written.
   *
   * A replayed request is the common case for a duplicate webhook, and every call this saves is one made against
   * a run that will do nothing. It also has to run before `writeFile`: a replayed run that had already written
   * the evidence file would leave the caller with a path it must not use, which is the kind of half-state this
   * phase's whole record shape exists to avoid.
   */
  const seen = await alreadyReported({ github, owner, repo, prNumber: number, botLogin, commentId });
  if (seen.unreadable) {
    return { error: `I could not tell whether I had already answered this request: ${seen.unreadable}` };
  }
  if (seen.answered) {
    core?.info?.(`#${number}: comment ${String(commentId)} already has a report from this flow, so nothing runs.`);
    return { phase: REPLAYED_PHASE, ref, baseRef, prNumber: target.prNumber, pending: 0 };
  }

  if (conflicting) {
    const blocked = await mergeBlockedBy({ github, core, owner, repo, base: baseRef });
    if (blocked) return { error: blocked };
  }

  const asked = String(guidance ?? '').trim();
  const wantsThread = String(threadRootId ?? '').trim() !== '';
  let thread = null;
  if (wantsThread) {
    if (!threadsFile) return { error: 'no path was given to write the review thread to' };
    const read = await readThreads({ github, owner, repo, prNumber: number });
    if (read.error) return { error: read.error };
    const hydrated = await hydrateScopedThread({ github, threads: read.threads, threadRootId });
    if (hydrated.error) return { error: hydrated.error };
    const picked = selectThreads(hydrated.threads, { threadRootId, core, botLogin });
    if (picked.lockedScope === true) return { error: picked.error };
    if (picked.disputedScope === true) {
      return {
        error:
          'the review thread this was written in is disputed. Ask for `fix` in that thread so the response ' +
          'can be classified before more work continues.',
      };
    }
    if (picked.error && asked === '') return { error: picked.error };
    if (picked.error) {
      core?.warning?.(
        `the review thread this was asked in is not available, so this runs on the request alone: ${picked.error}`,
      );
    } else {
      [thread] = picked.pending;
    }
  }

  /*
   * Required late rather than at module load, which is `resolvePhase`'s own reason for requiring this module
   * late: a caller that only ever plans should not pull in the checks reader, and every edge here is one-way.
   */
  const { readFailingChecks } = require('./checks.cjs');
  const evidence = await readFailingChecks({
    github: checksGithub ?? github,
    core,
    owner,
    repo,
    sha: reportedHeadSha,
  });

  /*
   * What counts as work: the requester's own words, or something red to fix.
   *
   * Red counts on its own because `<phrase> do` on a broken pull request is an unambiguous ask, and the evidence
   * is what says which. A commit status counts as much as a check run - see `readFailingChecks` on why reading
   * only check runs made a red pull request look green.
   *
   * An unreadable check list contributes nothing here, which is the honest reading: it is not evidence of a
   * failure, it is the absence of an answer. With no request text either, the caller's notice says so.
   */
  const failing = evidence.failingTotal + evidence.statusesTotal;
  if (!asked && failing === 0 && !thread && !conflicting) {
    core?.info?.(`#${number}: the request named no work and nothing is failing on ${reportedHeadSha}, so nothing runs.`);
    return { phase: 'do', ref, baseRef, prNumber: target.prNumber, pending: 0, conflicting: false };
  }

  if (!checksFile) return { error: 'no path was given to write the CI evidence to' };
  /*
   * Written whole, including the counts and the flags, because the prompt renderer states every bound it hit. A
   * caller handed only the failing list would have to re-derive what was withheld, and the renderer is the one
   * place that turns those numbers into sentences.
   */
  writeFile(checksFile, JSON.stringify(evidence));
  if (thread) writeFile(threadsFile, JSON.stringify([thread]));

  core?.info?.(
    `#${number} on ${ref}: ${counted(failing, 'failing check or status', 'failing checks or statuses')} on ${reportedHeadSha}` +
      `${thread ? `, asked inside the review thread opened by comment ${String(threadRootId)}` : ''}` +
      `${conflicting ? `, conflicting with \`${baseRef || '(unknown base)'}\`` : ''}` +
      `${asked ? `, scoped to: ${asked}` : ', with no request text'}.`,
  );
  return {
    phase: 'do',
    ref,
    baseRef,
    held: target.held,
    prNumber: target.prNumber,
    pending: 1,
    checksFile,
    threadsFile: thread ? threadsFile : '',
    conflicting,
  };
}

module.exports = {
  /*
   * `DO_MARKER_PREFIX` and the paging constants stay private, which is the rule ksai/threads.cjs states for
   * `MAX_PAGES`: an exported constant reads as a contract another file depends on. The marker's writer and reader
   * are both exported instead, so nothing outside assembles its own copy of the format - which is the drift
   * `criteriaOf` was bitten by.
   */
  renderDoMarker,
  doRequestOf,
  alreadyReported,
  mergeBlockedBy,
  MERGE_BLOCKING_RULES,
  resolveDoPhase,
  // The exception to the rule above, and the reason is that its other reader is YAML: see the constant.
  MAX_REPORT_CHARS,
};
