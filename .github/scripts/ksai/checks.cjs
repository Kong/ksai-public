'use strict';

/*
 * What CI says about one commit, bounded, and never a reason to fail a run.
 *
 * The `do` phase answers a free-form request on a pull request, and "fix the broken CI" is the request it
 * exists for. A model told only that cannot see the failure: the run has no GitHub token, so it cannot ask,
 * and re-running the build inside the sandbox is a different build. So a trusted step reads the checks and the
 * prompt carries the evidence.
 *
 * **Everything here fails open, which is the opposite bias to the rest of this flow.** Evidence is policy, not
 * a boundary - the same split AGENTS.md records for triage, which "fails open everywhere: a truncated file
 * list, an unreadable rules file or a thrown policy all resolve to no opinion". A 403 on the logs endpoint
 * degrades to names and conclusions; an unreadable check list degrades to nothing at all. Nothing in this
 * module returns an `error` a caller would publish instead of running, because the alternative is a request to
 * fix a test refused on the grounds that the log could not be fetched.
 *
 * **It reports facts and counts, never sentences.** ksai-prompt.cjs is "the only place their text lives", so the
 * bounds below are to be stated to the model rather than applied silently - which means the renderer will need the
 * numbers and import these constants rather than restate them. That wiring is not here yet: nothing in the tree
 * requires this module, and the `do` phase that will is the next change. Written as intent rather than as fact,
 * because a header describing a caller that does not exist reads as a contract something already keeps. The reason
 * for the split holds either way: a bound restated in two places drifts, and the direction it drifts is the bad
 * one, the prompt understating what was withheld while a model reads a partial log as the whole failure.
 *
 * **Two surfaces, because CI is not one API.** Check runs cover GitHub Actions and every app that adopted the
 * Checks API; commit statuses cover everything that did not, which is still most self-hosted Jenkins, older
 * CircleCI and every deploy-preview bot. Reading only check runs made a red pull request look green on those
 * repositories, and "no failing check run was found" is a sentence with a very different meaning from "CI
 * passes" - so both are read, and they stay separate fields because their shapes are not the same thing. A
 * check run has a conclusion and sometimes a log; a status has a state and one line of description.
 *
 * **Log text is evidence, never instruction.** A pull request's own test output is written by the pull request,
 * so it can print anything, including a convincing closing tag for the prompt's constraint block. Nothing here
 * neutralises that, deliberately: `neutralize` in ksai-prompt.cjs is applied to every untrusted value at the
 * boundary into the prompt, and having a second owner is how one of them comes to be skipped. What this module
 * owns is the shape and the size.
 */

/*
 * Check runs per page, and pages to walk.
 *
 * 100 is the API's maximum and three pages is 300 check runs on one commit, which is far past any real matrix.
 *
 * **Exceeding it is reported, not an error, which is the opposite of `readThreads`.** There a short list reads
 * as "nothing left to answer" and would report a review as addressed, so the bound fails the run. Here a short
 * list costs the model some evidence it could have had, and refusing to work on a red pull request because it
 * has 400 checks is a worse answer than working on the 300 that were read - as long as the prompt says the
 * count was cut, which `listTruncated` is for.
 */
const { counted } = require('../lib/text.cjs');

const CHECKS_PER_PAGE = 100;
const MAX_CHECK_PAGES = 3;

/*
 * How many failing checks are named, and how many still-running ones.
 *
 * A model given 60 names reads none of them. 20 is more than enough to see the shape of a broken build, and the
 * real count travels beside the list so the prompt can say what it did not show.
 *
 * Applied to each list separately rather than to their sum: 20 failures and 20 pending checks are two different
 * facts, and a shared budget would let a long pending list crowd out the failures the request is about.
 */
const MAX_NAMED_CHECKS = 20;

/*
 * How many failing Actions jobs get their log fetched.
 *
 * One call each, and the calls are the expensive part - a matrix of 30 failing jobs is 30 log downloads of
 * several hundred KB apiece, fetched to be thrown away by the character budget below. Three is what fits in a
 * prompt while still covering the ordinary shape of a broken build, which is one job failing and a couple of
 * dependent jobs failing with it.
 *
 * Overrunning it costs the model the fourth job's log, and `logsDeferred` says how many were passed over so the
 * prompt can name them without their text.
 */
const MAX_LOGGED_JOBS = 3;

/*
 * How much of one job's log reaches the prompt, and how much all of them together do.
 *
 * Both are needed and neither implies the other: without the per-job cap one enormous log crowds out the other
 * two, and without the total cap three jobs at the per-job cap are 36 KB of prompt for a run that also carries
 * the diff, the request and the constraint block.
 *
 * The line cap comes first because it is the one that matches how a log fails - the error is at the end, under
 * a few hundred lines of setup nobody needs. The character caps are the backstop for a log whose 200 lines are
 * minified bundles.
 *
 * **Every cut is taken from the FRONT, keeping the tail.** `cap` in ksai/plan.cjs is the wrong tool here and
 * that is worth saying: it keeps the beginning and appends an ellipsis, which on a build log keeps the
 * `actions/checkout` banner and drops the failure. The one thing it is right about is cutting on code points,
 * so a character at the boundary is not left as half a surrogate pair.
 */
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS_PER_JOB = 12 * 1024;
const MAX_LOG_CHARS_TOTAL = 32 * 1024;

/*
 * How much of a non-Actions check's own report reaches the prompt: per summary, per title, and across all of them.
 *
 * A check run from another app has no log this token can fetch, but it usually has `output.summary`, which is the
 * app's own account of what failed - often the whole failure. 1 KB is a screen of it. `output.text` is not read at
 * all: it is where apps put the full report, and a 200 KB one would be the whole prompt.
 *
 * **A title is a line, so it gets a line's budget rather than a summary's.** Both shared `MAX_SUMMARY_CHARS`,
 * which meant 2 KB per entry for one sentence and one screen.
 *
 * **And the total is what was missing.** Logs have `MAX_LOG_CHARS_TOTAL` as a backstop for precisely this shape -
 * a per-item cap bounds one item and says nothing about twenty - so twenty entries from a verbose app added about
 * 40 KB of prompt with nothing to stop it, on a run that also carries the diff, the request and the constraint
 * block. 8 KB across every named entry is several screens of app-reported text, and it is spent oldest-first so
 * the checks the prompt lists first are the ones that keep their detail.
 */
const MAX_SUMMARY_CHARS = 1024;
const MAX_TITLE_CHARS = 200;
const MAX_REPORTED_CHARS_TOTAL = 8 * 1024;

/*
 * How much of a commit status's description reaches the prompt.
 *
 * GitHub caps the field at 140 characters, so this is a promise about the shape rather than a real cut. It is
 * declared anyway, because a bound the renderer can state is worth more than one it has to assume, and the API
 * limit is not this module's to guarantee.
 */
const MAX_DESCRIPTION_CHARS = 140;

/*
 * The conclusions that mean a check is failing, and the ones that deliberately do not.
 *
 * A `Set` rather than an object, which is the null-prototype rule arrived at from the safer end: `has` answers
 * about members only, so there is no `constructor` to answer with a function. The value being looked up comes
 * from GitHub rather than from a model, but the rule is about the lookup and not about the provenance.
 *
 * **`cancelled` is not a failure, and this repository is the reason.** Its own concurrency groups cancel a
 * review in flight whenever a second comment arrives - AGENTS.md records that as the accepted cost of the
 * routing choice - so a cancelled check run is the ordinary state of a busy pull request rather than a broken
 * build. Treating it as failing would hand the model a superseded run's log and ask it to fix a job that was
 * never allowed to finish. The honest cost is a job the *workflow* cancelled after a timeout, which reads as
 * cancelled and is real; `cancelledTotal` is what keeps that from being silent.
 *
 * `neutral`, `skipped` and `stale` are not failures by the API's own definition. `action_required` is: it is a
 * check saying it wants something, and the conclusion travels with every entry so a model can see that what it
 * wants is a human rather than a patch.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

/** The commit status states that mean it is failing. `pending` is running; everything else is not a failure. */
const FAILING_STATUS_STATES = new Set(['failure', 'error']);

/*
 * The job id inside a GitHub Actions check run's link.
 *
 * The Checks API does not report a job id, and `actions.downloadJobLogsForWorkflowRun` takes nothing else. Two
 * ways to bridge that: list the workflow runs for the sha, list each run's jobs, and match a job to a check run
 * by name - or read the id out of the link the check run already carries. The first is a call per workflow run
 * and matches on a name that a matrix repeats verbatim, so `build (ubuntu, 20)` picks whichever of the two the
 * iteration order reached first. The second is exact and free.
 *
 * Anchored on the whole URL rather than searched for a `/job/<digits>` anywhere in one, so a query string or a
 * fragment cannot supply the number. The host is deliberately unpinned, because GitHub Enterprise Server serves
 * this from the customer's own domain - and the extracted value only ever becomes a numeric `job_id` against the
 * caller's own `owner/repo`, never a URL to fetch, so a value from an unexpected host 404s and fails open rather
 * than reaching anything.
 */
const JOB_LINK = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/actions\/runs\/\d{1,20}\/job\/(\d{1,20})(?:[?#]|$)/;

/*
 * ESC and BEL, by code point, because no control character is typed into this file.
 *
 * A pasted one is invisible in review and in a diff, and the first thing an editor or a formatter that
 * normalises a file does to it is drop it - leaving a pattern that still compiles and quietly matches nothing.
 * Naming them also lets the pattern below be read as a sentence rather than as a row of escapes.
 */
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

/*
 * Terminal control sequences, stripped so a log reads as text.
 *
 * Both families, because a build log carries both: CSI is the colour and cursor-movement one every test runner
 * emits, and OSC is what a progress bar uses to retitle the window. Left in, they are several bytes of noise per
 * line charged against the character budget, and a model reading a colour code as part of an identifier.
 *
 * Built rather than written as a literal, for the reason the two constants above give. The OSC branch ends at a
 * BEL or a string terminator and admits neither in its middle, so an unterminated one cannot run to the end of
 * the log and take the whole log with it.
 */
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
);

/*
 * The timestamp GitHub puts in front of every log line.
 *
 * `2026-08-18T09:41:02.7183926Z ` on all of them, which is 29 characters of the character budget per line spent
 * on a clock the model has no use for - about 6 KB of a 200-line log, or half of one job's allowance. Stripped
 * rather than kept, because relative ordering is what a log is read for and the lines are already in order.
 */
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** Every value as the API reported it, or the empty string. Nothing here throws on a missing field. */
const text = (value) => String(value ?? '');

/**
 * One log line as a terminal would show it, with the timestamp and the control sequences gone.
 *
 * A carriage return *inside* a line is a progress bar overwriting itself, so only the last segment is kept -
 * which is what the terminal displays, and what turns 400 redraws of a percentage counter into one line rather
 * than into 400 of the 200 the tail is allowed.
 *
 * **A carriage return at the END of a line is a line ending, and telling the two apart is load-bearing.** The
 * redraw rule alone destroyed every CRLF log: `tailOf` splits on `\n`, so each line arrived with a trailing
 * `\r`, read as a redraw that ended in nothing, and became the empty string. The joined tail was then newlines
 * only - non-empty, so it passed the caller's own guard, and the run reported a captured log with the failure
 * gone. That is the one thing this module must not do, which is present evidence as something it is not.
 *
 * The control sequences go before the timestamp, because a log line can carry a colour code in front of its own
 * clock and an anchored timestamp pattern would then match nothing.
 */
function cleanLine(line) {
  const noEol = line.endsWith('\r') ? line.slice(0, -1) : line;
  const shown = noEol.includes('\r') ? noEol.slice(noEol.lastIndexOf('\r') + 1) : noEol;
  return shown.replace(ANSI, '').replace(LOG_TIMESTAMP, '');
}

/**
 * A raw job log, reduced to the tail a prompt can carry.
 *
 * Returns `{ text, lines, truncated }`. `truncated` is true when anything was dropped, whichever bound did it,
 * because the prompt says the same thing either way: what you are reading is the end of a longer log.
 *
 * The order is lines, then characters, and it matters. Cutting characters first would spend the whole budget on
 * the setup banner and leave nothing for the failure; the line cap discards the head cheaply, and the character
 * cap then only bites on a log whose lines are enormous.
 */
function tailOf(raw, { maxLines = MAX_LOG_LINES, maxChars = MAX_LOG_CHARS_PER_JOB } = {}) {
  /*
   * A trailing newline is one empty line at the end of every log, which would otherwise take a slot in the tail.
   *
   * `\r?\n` rather than `\n`, because a CRLF log puts a carriage return between its terminators - so `/\n+$/`
   * removed only the last one and left the rest as blank entries that spent tail slots and inflated the reported
   * line count. Measured: `a\r\nb\r\n\r\n\r\n` reported four lines where the LF form reports two. The same CRLF
   * family as the `cleanLine` defect, one function along.
   */
  const all = text(raw).replace(/(?:\r?\n)+$/, '').split('\n');
  const kept = all.length > maxLines ? all.slice(all.length - maxLines) : all;
  const truncated = kept.length < all.length;

  const joined = kept.map((line) => cleanLine(line)).join('\n');
  // Code points rather than UTF-16 units, for `cap`'s reason read from the other end: a cut in the middle of a
  // surrogate pair leaves a lone half, which is not a character in any encoding the model is reading.
  const chars = Array.from(joined);
  if (chars.length <= maxChars) return { text: joined, lines: kept.length, truncated };
  const cutTo = chars.slice(chars.length - maxChars).join('');
  return { text: cutTo, lines: cutTo.split('\n').length, truncated: true };
}

/**
 * The Actions job id a check run's own link carries, or null.
 *
 * Null covers everything: a check run from another app, a link shape GitHub changes, an absent field. The caller
 * treats null as "no log for this one" and says so, which is the same answer it gives when the fetch fails - so
 * a changed URL shape degrades to names and conclusions rather than to a broken run.
 *
 * `details_url` first because that is the field the Checks API documents as the app's own link for the run, with
 * `html_url` behind it because GitHub Actions has populated one or the other at different times and a reader
 * that picks only one silently loses every log the year that changes.
 */
function jobIdOf(run) {
  for (const candidate of [run?.details_url, run?.html_url]) {
    const found = JOB_LINK.exec(text(candidate));
    if (found) return Number(found[1]);
  }
  return null;
}

/**
 * Whatever shape the log endpoint answered with, as a string.
 *
 * Octokit follows the redirect this endpoint replies with and hands back the body, but not always as the same
 * type: a plain string from `github-script`, an `ArrayBuffer` under some request hooks, a typed array under
 * others. A reader that assumed one of the three got `[object ArrayBuffer]` as the log text, which is a log the
 * model reads as evidence that nothing was captured.
 */
function logText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (data && typeof data === 'object' && typeof data.byteLength === 'number') {
    return Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).toString('utf8');
  }
  return text(data);
}

/** One character-capped field, cut from the end: an app's own summary reads from the top, unlike a log. */
function head(value, limit) {
  const chars = Array.from(text(value).trim());
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('');
}

/**
 * The check runs on one commit.
 *
 * Returns `{ runs, total, listTruncated, unreadable }` and never throws. `unreadable` carries the API's own
 * message when the list could not be read at all, and then `runs` is empty and nothing may be inferred from it -
 * which is the one distinction a caller must not collapse, because an empty list and an unread one look
 * identical and mean opposite things.
 *
 * `filter: 'latest'` is load-bearing. Without it a re-run returns the failed attempt beside the passing one, so
 * a model is handed the log of a job that is already green and spends its single turn fixing a fixed bug.
 *
 * Pages are walked by hand rather than with `github.paginate`, because `total_count` is the only way to know the
 * list was cut and paginate returns the array without it.
 */
async function readCheckRuns({ github = null, owner = null, repo = null, sha = null, maxPages = MAX_CHECK_PAGES } = {}) {
  const runs = [];
  let total = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      ({ data } = await github.rest.checks.listForRef({
        owner,
        repo,
        ref: sha,
        filter: 'latest',
        per_page: CHECKS_PER_PAGE,
        page,
      }));
    } catch (error) {
      /*
       * Fail open, and only for what was not read: pages already collected stay. A 502 on page 3 of 4 is still
       * 200 check runs of real evidence, and discarding them would turn a flaky call into a run with no idea why
       * CI is red. `unreadable` is set only when nothing at all was read, because it is the field that says
       * "infer nothing from this list" and a partial list supports plenty.
       *
       * **The status is the fallback when there is no message, and without it this field lied.** A thrown value
       * with no `message` - a rejected promise carrying a plain object, which octokit hooks can produce - made
       * this the empty string, and every reader tests truthiness, so an unread list took the same branch as an
       * empty one: the run log said "0 failing check(s)" for a commit whose checks nobody had seen. That is
       * exactly the unread-versus-empty collapse this module's header forbids, arriving through the field that
       * exists to prevent it. `logsUnavailable` below already had the fallback.
       */
      const why = text(error?.message) || `HTTP ${error?.status ?? 0}`;
      return { runs, total, listTruncated: true, unreadable: runs.length === 0 ? why : null };
    }
    if (Number.isInteger(data?.total_count)) total = data.total_count;
    const nodes = Array.isArray(data?.check_runs) ? data.check_runs : [];
    runs.push(...nodes);
    if (nodes.length < CHECKS_PER_PAGE) return { runs, total, listTruncated: false, unreadable: null };
  }
  // Out of pages with a full one in hand, so there is more. Compared against `total_count` rather than assumed,
  // for triage's reason about the changed-file endpoint: a list that says nothing when it truncates has to be
  // checked against a count from somewhere else. An unreported count is truncated, because unknown is what the
  // flag exists to say.
  return { runs, total, listTruncated: total === null || total > runs.length, unreadable: null };
}

/**
 * The commit statuses on one commit, rolled up.
 *
 * One call, because `getCombinedStatusForRef` answers with the latest status per context already deduplicated -
 * which is the same job `filter: 'latest'` does above, and the reason this is not `listCommitStatusesForRef`,
 * where a context that failed and was retried appears twice and the older entry reads as a current failure.
 */
async function readStatuses({ github = null, owner = null, repo = null, sha = null } = {}) {
  try {
    const { data } = await github.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
      per_page: CHECKS_PER_PAGE,
    });
    const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
    /*
     * Whether the context list was cut, answered the same way `readCheckRuns` answers it.
     *
     * The two surfaces were answering differently about one question: check runs compare against `total_count` and
     * report it, and this discarded the count - so a commit with more than one page of status contexts lost the rest
     * with no signal anywhere in the evidence. That is the silently-short list this module's header rules out,
     * surviving on the surface nobody had checked.
     */
    const total = Number.isInteger(data?.total_count) ? data.total_count : null;
    return { statuses, truncated: total === null ? false : total > statuses.length, unreadable: null };
  } catch (error) {
    // Fail open. A repository whose statuses cannot be read is one where the check runs above are the evidence.
    // The status is the fallback with no message, for the reason `readCheckRuns` states: an empty reason reads as
    // readable to every caller that tests truthiness.
    return { statuses: [], truncated: false, unreadable: text(error?.message) || `HTTP ${error?.status ?? 0}` };
  }
}

/**
 * What CI says about `sha`, bounded and reported.
 *
 * Every field is a fact or a count. The prompt turns them into sentences, because it owns the wording and
 * because a bound stated in two places is one that drifts.
 *
 *     {
 *       sha,                  the commit these were read for, echoed so a caller can compare it with its own
 *       failing: [...],       at most MAX_NAMED_CHECKS check runs, each with its conclusion and maybe a log
 *       failingTotal,         how many there really are
 *       running: [...],       at most MAX_NAMED_CHECKS names of checks that have not finished
 *       runningTotal,
 *       cancelledTotal,       not counted as failures, and said out loud rather than dropped
 *       statuses: [...],      at most MAX_NAMED_CHECKS failing commit statuses, with their descriptions
 *       statusesTotal,
 *       logged,               how many entries in `failing` carry a log
 *       logsDeferred,         failing Actions jobs that had a log to fetch and did not get one
 *       logsUnavailable,      the message from a refusal, once, when the token cannot read logs at all
 *       total,                check runs on the commit as the API counted them, or null
 *       listTruncated,        the check list was cut, so there may be failures not named here
 *       unreadable,           the check list could not be read at all; `failing` says nothing either way
 *       statusesUnreadable,
 *     }
 *
 * Never throws, and never returns an `error`. See the module comment: this is evidence, and an unreadable log is
 * not a reason to refuse a request to fix a test.
 */
async function readFailingChecks({
  github = null,
  core = null,
  owner = null,
  repo = null,
  sha = null,
  maxPages = MAX_CHECK_PAGES,
} = {}) {
  const commit = text(sha);
  const empty = {
    sha: commit,
    failing: [],
    failingTotal: 0,
    running: [],
    runningTotal: 0,
    cancelledTotal: 0,
    statuses: [],
    statusesTotal: 0,
    logged: 0,
    logsDeferred: 0,
    logsUnavailable: null,
    total: null,
    listTruncated: false,
    unreadable: null,
    statusesUnreadable: null,
  };
  /*
   * A missing client or sha is reported the same way an outage is, rather than thrown.
   *
   * It is a caller mistake, and it would be a thrown `TypeError` one line later - which in a `github-script`
   * step is a failed run on the evidence path, the one path that must not be able to fail a run. So it comes
   * back as unreadable, loudly, with the reason naming what is missing rather than an API message.
   */
  if (!github?.rest?.checks || !github?.rest?.repos) {
    core?.warning?.('No GitHub client capable of reading checks was passed, so this run has no CI evidence.');
    return { ...empty, unreadable: 'no checks-capable GitHub client was passed' };
  }
  if (!commit) {
    core?.warning?.('No commit sha was passed, so this run has no CI evidence.');
    return { ...empty, unreadable: 'no commit sha was passed' };
  }

  const [checks, statuses] = await Promise.all([
    readCheckRuns({ github, owner, repo, sha: commit, maxPages }),
    readStatuses({ github, owner, repo, sha: commit }),
  ]);

  const failed = [];
  const running = [];
  let cancelledTotal = 0;
  for (const run of checks.runs) {
    const status = text(run?.status).toLowerCase();
    if (status !== 'completed') {
      /*
       * Not finished is not passing, which is the whole reason these are collected rather than ignored. A model
       * told three checks fail, on a pull request where nine more are still building, would report the build
       * fixed on the strength of the ones that had not run yet.
       *
       * **Every non-`completed` status, with no allowlist of the ones this module has heard of.** An allowlist
       * of `queued`, `in_progress`, `pending`, `waiting` and `requested` sat here, and it dropped anything else
       * out of both lists entirely - so a Checks app reporting a status GitHub adds later, or one of its own,
       * vanished from the evidence altogether. Which is the failure the paragraph above rules out, arriving
       * through the list meant to prevent it: `status !== 'completed'` already IS "not finished", and an
       * allowlist beside it can only subtract.
       */
      running.push(text(run?.name));
      continue;
    }
    const conclusion = text(run?.conclusion).toLowerCase();
    if (conclusion === 'cancelled') {
      cancelledTotal += 1;
      continue;
    }
    if (!FAILING_CONCLUSIONS.has(conclusion)) continue;
    failed.push({
      name: text(run?.name),
      app: text(run?.app?.slug),
      conclusion,
      url: text(run?.details_url || run?.html_url),
      jobId: jobIdOf(run),
      title: head(run?.output?.title, MAX_TITLE_CHARS),
      /*
       * The app's own account of the failure, which for a non-Actions check is the only account there is. Read
       * for every entry rather than only for those without a job id: an Actions check run carries one too, and a
       * job whose log the budget passed over still has something to say.
       */
      summary: head(run?.output?.summary, MAX_SUMMARY_CHARS),
      log: null,
      logLines: 0,
      logTruncated: false,
    });
  }

  const named = failed.slice(0, MAX_NAMED_CHECKS);

  /*
   * The app-reported text, trimmed against one budget shared by every entry the prompt will carry.
   *
   * A second pass over `named` rather than a running budget inside the loop above, and the difference is not
   * cosmetic: the loop walks every check on the commit, so a budget spent there would be consumed by entries the
   * cap drops, and a run with 40 failing checks would leave nothing for the 20 the prompt actually names.
   *
   * The per-field caps above bound one entry and say nothing about twenty, which is the shape `MAX_LOG_CHARS_TOTAL`
   * already exists to close for logs. Spent in order, so the entries the prompt lists first keep their detail; one
   * whose budget has run out still carries its name and conclusion, which is the part that must not be dropped.
   */
  let reportedBudget = MAX_REPORTED_CHARS_TOTAL;
  for (const entry of named) {
    for (const key of ['title', 'summary']) {
      const kept = head(entry[key], Math.max(0, reportedBudget));
      reportedBudget -= kept.length;
      entry[key] = kept;
    }
  }

  /*
   * Logs, for the named entries only and in the order they were reported.
   *
   * Named-only because an entry the prompt does not print has nowhere to put a log, so fetching one is a
   * several-hundred-KB download for nothing.
   *
   * Sequential rather than in parallel, which is the deliberate slower choice. The budget below is shared, so a
   * parallel fetch cannot know what is left when it decides how much to keep - and the refusal path only pays
   * once if it is discovered before the next call is made: a token without `actions: read` fails identically on
   * every job, and three calls learn nothing the first did not.
   */
  let logsUnavailable = null;
  let logsDeferred = 0;
  let budget = MAX_LOG_CHARS_TOTAL;
  let logged = 0;
  /*
   * Fetches, counted apart from kept logs, because the bound is on calls and `logged` is not a count of calls.
   *
   * `MAX_LOGGED_JOBS` guards the several-hundred-KB downloads, and gating on `logged` meant a job whose log
   * cleaned down to nothing spent a call and advanced nothing - so twenty named Actions jobs all failing at
   * startup with empty logs downloaded twenty logs, not three. The kept-log accounting is what the prompt reads
   * and the fetch accounting is what the bound is about; one counter could not be both.
   */
  let fetched = 0;
  for (const entry of named) {
    // Not an Actions job, so there is no log to want. It is not deferred either - nothing was passed over, and
    // counting it would tell the prompt a log exists that a bigger budget would have fetched.
    if (entry.jobId === null) continue;
    if (logsUnavailable !== null || fetched >= MAX_LOGGED_JOBS || budget <= 0) {
      logsDeferred += 1;
      continue;
    }
    fetched += 1;
    let raw;
    try {
      ({ data: raw } = await github.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: entry.jobId }));
    } catch (error) {
      /*
       * A 403 is the token and a 404 is this job, and collapsing them costs one of the two things worth knowing.
       *
       * `source_org_github_token` is a GitHub App installation token, and whether the App holds `actions: read`
       * is organisation configuration this repository cannot assert - so 401 or 403 means no job's log is
       * readable, it is recorded once, and the remaining fetches are skipped rather than repeating one refusal
       * three times. Anything else is one job: logs expire with the repository's retention, so a run whose logs
       * have aged out sits beside jobs whose logs have not.
       */
      const status = error?.status ?? 0;
      if (status === 401 || status === 403) logsUnavailable = text(error?.message) || `HTTP ${status}`;
      logsDeferred += 1;
      continue;
    }
    const tail = tailOf(logText(raw), { maxChars: Math.min(MAX_LOG_CHARS_PER_JOB, budget) });
    /*
     * A log with nothing in it is not a log, so it is not attached and it is counted as one the prompt did not
     * get. A job that failed at startup has nothing captured, and recording it as logged would leave the prompt
     * claiming evidence it does not carry.
     *
     * **Whitespace-only rather than empty, and the difference was a live defect.** A tail of newlines is not the
     * empty string, so `=== ''` passed it through and the prompt reported a captured log holding nothing - which
     * is how a CRLF log destroyed by `cleanLine` reached the model as evidence. That bug is fixed at its source
     * above; this guard is what makes any other way of arriving at a blank tail fail safe rather than silently.
     *
     * `logsDeferred` rather than a silent `continue`: the call was spent and the model got nothing, which is
     * exactly what that count exists to tell the prompt. Silent, it was the one path that spent a fetch and
     * advanced no counter at all.
     */
    if (tail.text.trim() === '') {
      logsDeferred += 1;
      continue;
    }
    entry.log = tail.text;
    entry.logLines = tail.lines;
    entry.logTruncated = tail.truncated;
    budget -= Array.from(tail.text).length;
    logged += 1;
  }

  const failingStatuses = statuses.statuses
    .filter((entry) => FAILING_STATUS_STATES.has(text(entry?.state).toLowerCase()))
    .map((entry) => ({
      context: text(entry?.context),
      state: text(entry?.state).toLowerCase(),
      description: head(entry?.description, MAX_DESCRIPTION_CHARS),
      url: text(entry?.target_url),
    }));

  const evidence = {
    sha: commit,
    failing: named,
    failingTotal: failed.length,
    running: running.slice(0, MAX_NAMED_CHECKS),
    runningTotal: running.length,
    cancelledTotal,
    statuses: failingStatuses.slice(0, MAX_NAMED_CHECKS),
    statusesTotal: failingStatuses.length,
    logged,
    logsDeferred,
    logsUnavailable,
    total: checks.total,
    listTruncated: checks.listTruncated,
    unreadable: checks.unreadable,
    statusesTruncated: statuses.truncated === true,
    statusesUnreadable: statuses.unreadable,
  };

  /*
   * Said out loud in the run log, because every one of these is something a maintainer can act on and none of
   * them fails the run. The `actions: read` line names the permission for the reason AGENTS.md gives about an
   * authorization that cannot resolve: an unexplained absence is undebuggable from the outside.
   */
  // Against `null` rather than truthiness, which is the same guard the fallback above closes from the other side.
  // Two independent ways to reach "unread but falsy" is one too many for the one distinction that must not
  // collapse, so the writer always writes something and the reader tests for absence rather than for emptiness.
  if (evidence.unreadable !== null) {
    core?.warning?.(
      `Could not read the checks on ${commit}: ${evidence.unreadable}. This run has no CI evidence, so a red ` +
        'branch reads to it as a branch with nothing failing. The token this was read on needs `checks: read`, ' +
        '`statuses: read` and `actions: read`. An App installation that does not hold them answers 422 to a ' +
        'token request naming them, and cannot be widened by any workflow - pass a token that does hold them ' +
        'as `ci_evidence_github_token`, such as the job\'s own GITHUB_TOKEN with those three in `permissions:`.',
    );
  } else {
    core?.info?.(
      `${commit}: ${counted(evidence.failingTotal, 'failing check')}, ` +
        `${counted(evidence.statusesTotal, 'failing status', 'failing statuses')}, ` +
        `${evidence.runningTotal} still running, ${evidence.cancelledTotal} cancelled, ` +
        `${counted(evidence.logged, 'log')} attached.`,
    );
  }
  if (evidence.logsUnavailable) {
    core?.warning?.(
      `The job logs on ${commit} could not be read (${evidence.logsUnavailable}), so the prompt carries check ` +
        'names and conclusions without them. Grant the App `actions: read` to include the logs.',
    );
  }
  if (evidence.statusesUnreadable !== null) {
    /*
     * Every other degraded path here warns, and this one reached the evidence object and the run log said nothing -
     * so a maintainer could not tell why a Jenkins or deploy-preview failure was missing from the prompt. The
     * sentence names what is absent rather than the endpoint, because that is the half somebody can act on.
     */
    core?.warning?.(
      `Could not read the commit statuses on ${commit}: ${evidence.statusesUnreadable}, so any build reporting ` +
        'through the statuses API rather than the Checks API is absent from the prompt.',
    );
  }
  if (evidence.listTruncated) {
    core?.warning?.(
      `${commit} has more check runs than this reads (${evidence.total ?? 'an unreported number'}), so there may ` +
        'be failures the prompt does not name.',
    );
  }
  if (evidence.statusesTruncated) {
    core?.warning?.(`${commit} has more commit statuses than this reads, so there may be failures it does not name.`);
  }
  return evidence;
}

module.exports = {
  /*
   * The bounds, exported because `renderDoPrompt` states them to the model rather than applying them silently -
   * which is AGENTS.md's rule that a step must be told the rules it will be judged by, read forwards. The paging
   * constants stay private: nothing outside needs them, and the test drives `maxPages` instead, which is the
   * seam `readThreads` already has for the same reason.
   */
  MAX_NAMED_CHECKS,
  MAX_LOGGED_JOBS,
  MAX_LOG_LINES,
  MAX_LOG_CHARS_PER_JOB,
  MAX_LOG_CHARS_TOTAL,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  MAX_REPORTED_CHARS_TOTAL,
  MAX_DESCRIPTION_CHARS,
  FAILING_CONCLUSIONS,
  cleanLine,
  tailOf,
  jobIdOf,
  readCheckRuns,
  readFailingChecks,
};
