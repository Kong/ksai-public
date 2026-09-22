// Publishes the reviewer's structured JSON output as a single PR review with inline
// comments, one per finding anchored to its diff line. Findings whose line is not part of
// the diff (or that overflow the inline cap) fold into the review body so none are lost.
// On unparseable output it falls back to a single plain PR comment.
//
// This is also where a finding is withheld: the repo's committed suppression list is applied by
// kreview/suppress.cjs before anything is anchored. That is the only reason a finding the model
// produced does not reach the PR, and it happens in trusted code with no model in the loop.

const { parseHunks } = require('../lib/hunks.cjs');
const { writerFor } = require('../lib/cp-effects.cjs');
const { readReviewOutput, REPAIRED } = require('../lib/review-output.cjs');
const { applySuppression } = require('./suppress.cjs');
const { DIGEST_CHARS, MATCH_VERSION } = require('./match-id.cjs');
const { RESERVED_COMMENT } = require('../ksai/plan.cjs');
const { rendered, unrendered } = require('../lib/cp-render.cjs');

const SUCCESS = 'success';

const UNRENDERED = 'unrendered';

/*
 * A run that ended in error publishes no text of its own, whatever it happened to be saying.
 *
 * The reviewer that a gateway 429 cut short at its twelfth step had written "Now let me read the
 * surrounding code", and the unparseable-output fallback posted that sentence on the pull request as
 * though somebody had reviewed it. Which is the rule `executionLog` already keeps for a run a signal
 * ended - a fragment reads as a short review - held one step later, where the reason the run ended is
 * known. The run report beside this names the failure and carries the cost; this says which pull
 * request went unreviewed, and nothing a model wrote.
 */
const ended = (conclusion) => String(conclusion ?? SUCCESS).trim() !== SUCCESS;

const FAILED_NOTICE = '_The review run ended before it produced findings, so this pull request was not reviewed._';

const MARKER = '<!-- kreview-finding -->';
// kreview/fetch-prior.cjs and eval/parse.mjs both match this exact string, so it lives in one
// place here and is scrubbed out of anything the model wrote.
const FOLDED_HEADING = '### Additional findings (not anchored to the diff)';
const BULLET_END = '<!-- kreview-finding-end -->';
const MAX_INLINE = 40;
const MAX_PATCH_LINES = 20_000;
/*
 * Asks the reader to rate the finding with a 👍 or a 👎, which the eval extractor already reads back
 * off the comment for free: the repo-wide `pulls/comments` sweep carries the per-content reaction
 * counts, so a vote costs no API call and no new token scope.
 *
 * Only an inline comment gets one. A pull request *review* has no reactions at all - the REST
 * payload has no `reactions` field and the UI offers no button - so a finding folded into the review
 * body cannot be voted on, and a footer there would ask for something the reader cannot give.
 *
 * Markers on their own lines, one opening and one closing, for two reasons. A comment and text on
 * one line is a single HTML block in CommonMark, so the prose was emitted raw - readers saw literal
 * `_React 👍 …_` underscores outside a paragraph. And a bounded pair is what lets every consumer
 * strip the footer back out by its own delimiters rather than by matching its prose: parse.mjs
 * recovers `body` from that text, so a footer left in appends the publisher's own prose to the
 * recorded body of every finding posted from here on, against a corpus that has none.
 */
const FEEDBACK_OPEN = '<!-- kreview-feedback -->';
const FEEDBACK_CLOSE = '<!-- /kreview-feedback -->';
const FEEDBACK_FOOTER = `${FEEDBACK_OPEN}\n_React 👍 if this finding helped, 👎 if it did not._\n${FEEDBACK_CLOSE}`;
// Null-prototype: the severity comes from model output, and a plain object answers
// SEV_LABEL['constructor'] with a function, which is truthy — so a finding whose severity read
// `constructor` would print a stringified function where its severity label belongs.
const SEV_LABEL = Object.assign(Object.create(null), {
  critical: '❗ **Critical**',
  high: '🔴 **High**',
  medium: '🟠 **Medium**',
  low: '🔵 **Low**',
});
const SEV_RANK = Object.assign(Object.create(null), { critical: 0, high: 1, medium: 2, low: 3 });

const sevKey = (f) => String(f.severity || '').trim().toLowerCase();
// An unrecognized severity is printed as the model wrote it. A finding with no tag gets no publisher
// marker at all, since no tag means no match ID, so a forged marker reaching this line would be the
// only one on the comment.
const sevLabel = (f) => SEV_LABEL[sevKey(f)] || `**${oneLine(f.severity) || 'Note'}**`;
// Empty rather than empty backticks when the tag was nothing but forged markup.
const tagLabel = (f) => {
  const tag = oneLine(f.tag);
  return tag ? ` \`${tag}\`` : '';
};
// Rendered as a number or not at all: the model supplies it, and the anchoring path already reads
// it through Number().
const lineLabel = (f) => (Number.isFinite(Number(f.line)) ? Number(f.line) : '?');


/*
 * The IDs a maintainer needs to suppress this finding later, carried in a hidden comment so they
 * survive on the comment itself without adding a line of visible noise to every review. Both are
 * hashes this code derived, so nothing model-written reaches the markup. Read them with "Quote
 * reply" or the comments API; the run's suppression record artifact carries the same pair.
 * eval/parse.mjs strips this marker back out — it renders the comment body, not part of it.
 */
const MATCH_SHAPE = new RegExp(`^m${MATCH_VERSION}-[0-9a-f]{${DIGEST_CHARS}}$`);
const FINDING_SHAPE = new RegExp(`^f${MATCH_VERSION}-[0-9a-f]{${DIGEST_CHARS}}$`);

const idMarker = (f) =>
  MATCH_SHAPE.test(String(f.match_id ?? ''))
    ? `\n<!-- kreview-ids match=${f.match_id}${FINDING_SHAPE.test(String(f.finding_id ?? '')) ? ` finding=${f.finding_id}` : ''} -->`
    : '';

/*
 * Four literals in a published review mean something structural, and this publisher is the only
 * thing entitled to emit any of them: the dedup marker, the folded-findings heading, the ID marker
 * and the feedback marker.
 * PR content steers what the model writes, so all four are as reachable from a diff as any
 * other model text, and each one lies to a different reader.
 *
 * - the ID marker hands a maintainer someone else's match ID to suppress
 * - the feedback marker is what eval/parse.mjs strips a footer by, so a forged one would delete the
 *   model's own body text out of the recovered finding
 *   (forged footer *prose* is harmless and stays: with no marker, nothing strips it)
 * - the dedup marker leaves a second copy inside the text eval/parse.mjs recovers as the body
 * - the folded heading is the worst: kreview/fetch-prior.cjs scans a review body from that heading
 *   and feeds the bullets under it into the next run as findings already reported, and the reviewer
 *   is told to drop anything restating those. Bullets forged under a forged heading therefore
 *   silence real findings on the next review, with no suppression list involved at all
 *
 * So none of the four may arrive from the model. Each pattern is broader than the exact string its
 * consumer matches on, and the publisher appends its own copies afterwards, where they mean what
 * they say.
 *
 * The match ID still hashes the body as the model wrote it, per the v1 canonical input. Scrubbed
 * text therefore changes the finding's key, which is what exact matching should do with text that
 * differs, and never changes which IDs the marker reports.
 */
/*
 * Comment boundaries first, content second. A single pattern of the form
 * `<!--[\s\S]*?NEEDLE[\s\S]*?-->` reads as "a comment containing NEEDLE" and is not: neither lazy
 * run is bounded to one comment, so it latches onto the first `<!--` and closes at the first `-->`
 * *after* a later NEEDLE, deleting everything in between. A body opening with `<!-- TODO -->` and
 * mentioning kreview-ids further down was erased whole.
 *
 * Matching each comment on its own is bounded, because the lazy run stops at that comment's own
 * `-->` with no needle to drag it further, and it leaves an unrelated comment in place instead of
 * putting it at risk.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const PUBLISHER_COMMENT = /kreview-(?:ids|finding|feedback)/;
const KSAI_COMMENT = /<!--\s*ksai/i;
const ANY_FOLDED_HEADING = /#{1,6}\s*Additional findings \(not anchored to the diff\)/g;

const reserved = (comment) =>
  PUBLISHER_COMMENT.test(comment) || RESERVED_COMMENT.test(comment) || KSAI_COMMENT.test(comment);

const fromModel = (text) =>
  String(text ?? '')
    .replace(HTML_COMMENT, (comment) => (reserved(comment) ? '' : comment))
    .replace(ANY_FOLDED_HEADING, '')
    .replace(HTML_COMMENT, (comment) => (reserved(comment) ? comment.replaceAll('<!--', '&lt;!--') : comment));

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

function scanFences(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE_LINE.exec(lines[i]);
    if (!m) continue;
    const [, indent, marker, rest] = m;
    const info = rest.trim();
    if (!open) {
      if (marker[0] === '`' && info.includes('`')) continue;
      open = { start: i, indent, char: marker[0], len: marker.length, info };
      continue;
    }
    if (marker[0] === open.char && marker.length >= open.len && info === '') {
      blocks.push({ ...open, end: i });
      open = null;
    }
  }
  return { blocks, open };
}

const longestRun = (text, char) => {
  const runs = text.match(char === '`' ? /`+/g : /~+/g);
  return runs ? Math.max(...runs.map((run) => run.length)) : 0;
};

function trimStrayClosers(payload) {
  let kept = payload;
  while (kept.length) {
    const m = FENCE_LINE.exec(kept.at(-1));
    if (!m || m[3].trim() !== '') return kept;
    const inner = kept.slice(0, -1);
    if (scanFences(inner).open) return kept;
    kept = inner;
  }
  return kept;
}

function balanceFences(body) {
  const lines = body.split('\n');
  const { blocks, open } = scanFences(lines);
  if (!open) return body;
  const outer = blocks.at(-1);
  const nested =
    open.info === '' &&
    open.start === lines.length - 1 &&
    outer !== undefined &&
    outer.char === open.char &&
    outer.end === open.start - 1;
  const opener = nested ? outer : open;
  const payload = trimStrayClosers(lines.slice(opener.start + 1, nested ? open.start : lines.length));
  const fence = opener.char.repeat(
    Math.max(opener.len, longestRun(payload.join('\n'), opener.char) + 1),
  );
  return [
    ...lines.slice(0, opener.start),
    `${opener.indent}${fence}${opener.info}`,
    ...payload,
    `${opener.indent}${fence}`,
  ].join('\n');
}

const modelMarkdown = (text) => balanceFences(fromModel(text).trim());

const oneLine = (text) =>
  fromModel(String(text ?? '').replace(/[`*]/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

function renderBody(f) {
  return `${sevLabel(f)}${tagLabel(f)}\n\n${modelMarkdown(f.body)}\n\n${FEEDBACK_FOOTER}\n\n${MARKER}${idMarker(f)}`;
}

function renderSummary(summary, folded, note = '') {
  // The model writes this too, and it is the one string with no per-finding scrub of its own.
  let out = modelMarkdown(summary) || '_Review complete._';
  if (note) out += `\n\n${note}`;
  if (folded.length) {
    out += `\n\n${FOLDED_HEADING}\n`;
    for (const f of folded) {
      const body = modelMarkdown(f.body);
      out += `\n- ${sevLabel(f)}${tagLabel(f)} \`${oneLine(f.path) || '?'}:${lineLabel(f)}\` — ${body}${idMarker(f)}\n${BULLET_END}`;
    }
  }
  // Marker so a later run's fetch-prior recognizes this as one of the bot's own reviews.
  return `${out}\n\n${MARKER}`;
}

const shortSha = (sha) => `\`${String(sha).slice(0, 7)}\``;

function movedNote(reviewed, head) {
  const now = head ? ` to ${shortSha(head)}` : '';
  return (
    `_This review read ${shortSha(reviewed)}. The pull request has moved${now} since, so a comment on a ` +
    'line changed after that commit shows as outdated._'
  );
}

// Raw model text can end inside a construct that would swallow the note: a fence renders it as code,
// an unterminated HTML comment hides it.
const withNote = (text, note) => {
  if (!note) return text;
  const closed = text.lastIndexOf('<!--') > text.lastIndexOf('-->') ? `${text}\n-->` : text;
  return `${closed}\n\n${note}`;
};

/*
 * The files of the reviewed commit, compared from the merge base the way a pull request diff is, so a
 * finding anchors to the lines the reviewer read rather than to a newer head's. The compare answers at
 * most 300 files; a finding on a file past that folds into the body like any other unanchorable one.
 */
async function reviewedFiles({ github, owner, repo, base, commitId }) {
  if (!base) throw new Error('the pull request names no base commit');
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${commitId}`,
  });
  return data?.files ?? [];
}

function planReview({ owner, repo, prNumber, commitId, runResult, read = readReviewOutput(runResult), conclusion, suppression, files, note, later }) {
  const { review: parsed, reason: parseReason } = read;
  const nothing = { inline: [], findings_total: 0, folded: 0, suppressed: 0, fires: [], records: [] };
  if (!parsed) {
    // Scrubbed like every other model-written string, and for a sharper reason than the rest: this
    // comment is posted under the bot's identity, so a marker in it makes kreview/fetch-prior.cjs
    // read the raw output as this PR's prior findings and feed any `- ` line under a heading into
    // the next run, which is told to drop duplicates of them. It also has to carry no marker for
    // parse compliance to stay measurable - the absence is the signal.
    return {
      parse_ok: false,
      parse_reason: parseReason,
      comment: withNote(ended(conclusion) ? FAILED_NOTICE : balanceFences(fromModel(runResult).trim()) || '_The reviewer produced no output._', note),
      ...nothing,
    };
  }

  // A single malformed element (e.g. null) must not crash the publisher once JSON parsing
  // already succeeded — that would skip the graceful "unparseable output" path above.
  const produced = parsed.findings
    .filter((f) => f && typeof f === 'object')
    .sort((a, b) => (SEV_RANK[sevKey(a)] ?? 9) - (SEV_RANK[sevKey(b)] ?? 9));

  // Suppression runs on the sorted list, before anchoring, so a withheld finding consumes no
  // inline slot and the record indexes match the order the review was published in.
  const gated = suppression
    ? applySuppression({
        findings: produced,
        rules: suppression.rules ?? [],
        scope: `${owner}/${repo}`,
        reviewerId: suppression.reviewerId,
        runId: suppression.runId,
        prNumber,
        reviewedHead: commitId,
        firedAt: suppression.firedAt,
      })
    : { kept: produced, fires: [], records: [] };

  const findings = gated.kept;
  // The model's summary is written before suppression and may still mention a withheld finding.
  // Rewriting it would mean putting a model back in the loop, so it is left as written.
  const counted = {
    parse_ok: true,
    parse_reason: parseReason,
    findings_total: findings.length,
    suppressed: gated.fires.length,
    fires: gated.fires,
    records: gated.records,
  };
  if (files === null) {
    return { ...counted, comment: renderSummary(parsed.summary, findings, note), inline: [], folded: findings.length };
  }
  const hunks = new Map(
    files.map((f) => [f.filename, parseHunks(String(f.patch ?? '').split('\n').length > MAX_PATCH_LINES ? '' : f.patch)]),
  );

  const inline = [];
  const folded = [];
  for (const f of findings) {
    const side = String(f.side || '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
    const map = hunks.get(f.path);
    const table = map ? (side === 'LEFT' ? map.left : map.right) : null;
    const line = Number(f.line);
    if (!table || !Number.isInteger(line) || !table.has(line) || inline.length >= MAX_INLINE) {
      folded.push(f);
      continue;
    }
    const comment = { path: f.path, side, line, body: renderBody(f) };
    const start = Number(f.start_line);
    // A range that crosses a hunk boundary makes the whole review 422; only attach start_line
    // when it shares the anchor line's hunk.
    if (
      Number.isInteger(start) &&
      start < line &&
      table.has(start) &&
      table.get(start) === table.get(line)
    ) {
      comment.start_line = start;
      comment.start_side = side;
    }
    inline.push(comment);
  }

  const planned = { ...counted, body: renderSummary(parsed.summary, folded, note), inline, folded: folded.length };
  if (inline.length === 0) return planned;
  // An unmoved review anchored against the pull request's diff as it was read; a push since then
  // is why GitHub refused every anchor, so the body says so.
  const whole = later && later !== commitId ? movedNote(commitId, later) : note;
  return { ...planned, whole_body: renderSummary(parsed.summary, findings, whole) };
}

const unrenderedReview = (why, env, mine) => ({
  parse_ok: mine?.parse_ok === true,
  parse_reason: mine ? mine.parse_reason : UNRENDERED,
  comment: unrendered('this review', why, env),
  inline: [],
  findings_total: mine?.findings_total ?? 0,
  folded: 0,
  suppressed: mine?.suppressed ?? 0,
  fires: mine?.fires ?? [],
  records: mine?.records ?? [],
  unrendered: true,
});

/*
 * Returns a summary of what was published. Whether the model's output parsed is decided here and
 * nowhere else, so this is the only place that can report it — an unparseable run posts a comment
 * carrying no marker, which no later scan can tell apart from a run that found nothing. Callers
 * are free to ignore the return value.
 *
 * `suppression` is optional. Without a `reviewerId` nothing is derived and nothing is withheld,
 * which is the behaviour of every caller that has not wired the rule loader up.
 */
/*
 * `publish: false` runs the whole publisher and posts nothing: the findings are parsed, suppression
 * is applied, and the counts come back exactly as they would have. It exists for the shadow arm of
 * an engine comparison, which has to produce a comparable outcome record without a second review
 * arriving on a pull request nobody asked twice.
 *
 * It is a parameter here rather than a skipped step in the action, because skipping the step loses
 * `findings_total`, `inline`, `folded` and `suppressed` - the columns a comparison is actually for.
 */
module.exports = async ({
  github,
  core,
  owner,
  repo,
  prNumber,
  commitId,
  runResult,
  suppression,
  publish = true,
  conclusion = SUCCESS,
  reviewStrategy = 'baseline',
  protocol = null,
  env = process.env,
  fetch = globalThis.fetch,
}) => {
  if (!['baseline', 'evidence', 'dual'].includes(reviewStrategy)) throw new Error('unknown trusted review strategy');
  /*
   * A commit pushed while the review ran does not stop it publishing. The review is pinned to the
   * commit it read through `commit_id`, anchored against that commit's diff rather than the pull
   * request's current one, and says so in its body; GitHub shows a comment on a line changed since as
   * outdated. An unreadable pull request still refuses: a transport failure says nothing about the head.
   */
  const pull = publish ? (await github.rest.pulls.get({ owner, repo, pull_number: prNumber })).data : null;
  const head = String(pull?.head?.sha ?? '');
  const moved = publish && head !== commitId;
  const note = moved ? movedNote(commitId, head) : '';
  const writer = writerFor({ github, owner, repo });
  const postComment = (said) => writer.comment({ number: prNumber, body: said });
  const read = readReviewOutput(runResult);
  const { review: parsed } = read;
  if (reviewStrategy !== 'baseline' && parsed) {
    const { findingProblem } = require('./review-pipeline.cjs');
    if (protocol?.strategy !== reviewStrategy || protocol?.head_sha !== commitId || !Array.isArray(protocol?.published_candidates)) throw new Error('review protocol does not match the trusted run');
    if (parsed.findings.some((finding) => findingProblem(finding) || !protocol.published_candidates.includes(finding.candidate_id))) throw new Error('review lacks independently audited evidence');
  }

  let files = null;
  if (parsed) {
    try {
      files = moved
        ? await reviewedFiles({ github, owner, repo, base: pull?.base?.sha, commitId })
        : await github.paginate(github.rest.pulls.listFiles, {
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100,
          });
    } catch (e) {
      core.warning(`Could not list PR files (${e.status ?? '?'}): ${e.message}. Posting body-only comment.`);
    }
  }

  const gate = suppression?.reviewerId
    ? { ...suppression, firedAt: suppression.firedAt ?? new Date().toISOString() }
    : null;
  const named = new Set((parsed?.findings ?? []).filter((f) => f && typeof f === 'object').map((f) => f.path));
  const sent = files === null ? null : files.filter((file) => named.has(file?.filename));
  const plan = (later) =>
    rendered({
      kind: 'review',
      request: {
        run_result: String(runResult ?? ''),
        conclusion: String(conclusion ?? SUCCESS),
        pr: prNumber,
        commit: commitId,
        publish,
        head,
        later,
        files: sent === null ? null : sent.map((file) => ({ filename: String(file?.filename ?? ''), patch: String(file?.patch ?? '') })),
        suppression:
          gate === null
            ? null
            : { reviewer_id: String(gate.reviewerId), run_id: String(gate.runId ?? ''), fired_at: gate.firedAt, rules: gate.rules ?? [] },
      },
      local: () => planReview({ owner, repo, prNumber, commitId, runResult, read, conclusion, suppression: gate, files: sent, note, later }),
      fallback: (why, mine) => unrenderedReview(why, env, mine),
      accept: (answer) => typeof answer.parse_ok === 'boolean' && Array.isArray(answer.inline),
      env,
      fetch,
      warn: (message) => core.warning(message),
    });
  const { value: planned, parity } = await plan('');
  const shadowed = parity !== '' ? { render_parity: parity } : planned.unrendered ? { render_parity: 'unrendered' } : {};

  if (!planned.parse_ok) {
    if (planned.parse_reason !== UNRENDERED) {
      core.warning('Structured review output missing or unparseable; posting a single comment.');
    }
    if (publish) {
      await postComment(planned.comment);
    }
    return {
      parse_ok: false,
      parse_reason: planned.parse_reason,
      findings_total: 0,
      inline: 0,
      folded: 0,
      review_id: null,
      mode: publish ? 'published' : 'shadow',
      posted_as: publish ? 'issue-comment' : 'none',
      ...shadowed,
    };
  }

  if (planned.parse_reason === REPAIRED) {
    core.notice('Structured review output was off-contract and recovered; publishing the repaired review.');
  }

  if (planned.fires.length) {
    // An annotation, not a comment: the point of suppression is a quieter PR, but a maintainer
    // still has to be able to see what was withheld and which entry did it.
    core.notice(
      `Suppressed ${planned.fires.length} of ${planned.findings_total + planned.suppressed} findings: ` +
        `${planned.fires.map((fire) => fire.rule_id).join(', ')}`,
    );
  }

  const { body, inline } = planned;

  // findings_total counts what reached the PR, so it stays comparable with what the eval
  // extractor can reconstruct from posted comments. A withheld finding is counted by
  // `suppressed` instead: findings_total + suppressed is what the model produced.
  const summarize = (extra) => ({
    parse_ok: true,
    parse_reason: planned.parse_reason,
    findings_total: planned.findings_total,
    inline: inline.length,
    folded: planned.folded,
    mode: publish ? 'published' : 'shadow',
    review_id: null,
    posted_as: 'review',
    suppressed: planned.suppressed,
    fires: planned.fires,
    records: planned.records,
    ...shadowed,
    ...extra,
  });

  if (planned.comment !== undefined) {
    if (publish) {
      await postComment(planned.comment);
    }
    return summarize({ inline: 0, posted_as: publish ? 'issue-comment' : 'none' });
  }

  const postReview = async (reviewBody, comments) => (await writer.review({
    number: prNumber,
    commit: commitId,
    event: 'COMMENT',
    body: reviewBody,
    ...(comments ? { comments } : {}),
  })).review;

  // Short-circuited above every posting path, so no shadow run can reach a `createReview` at all.
  if (!publish) return summarize({ review_id: null, posted_as: 'none' });

  if (inline.length === 0) {
    try {
      const review = await postReview(body);
      return summarize({ inline: 0, review_id: review });
    } catch (e) {
      core.warning(`Body-only review failed (${e.status ?? '?'}): ${e.message}. Plain comment.`);
      await postComment(body);
      return summarize({ inline: 0, posted_as: 'issue-comment' });
    }
  }

  try {
    const review = await postReview(body, inline);
    return summarize({ review_id: review });
  } catch (e1) {
    // The reviews API rejects the whole batch if one comment is unanchorable, and a stray
    // multi-line range is the usual culprit; retry with single-line comments before giving up.
    core.warning(`Inline review failed (${e1.status ?? '?'}): ${e1.message}. Retrying single-line.`);
    const singles = inline.map(({ start_line, start_side, ...c }) => c);
    try {
      const review = await postReview(body, singles);
      return summarize({ review_id: review, retried: 'single-line' });
    } catch (e2) {
      core.warning(`Single-line retry failed (${e2.status ?? '?'}): ${e2.message}. Body only.`);
      const later = moved
        ? ''
        : await github.rest.pulls.get({ owner, repo, pull_number: prNumber }).then((r) => String(r.data?.head?.sha ?? '')).catch(() => '');
      const replan = later && later !== commitId ? await plan(later) : null;
      const replanned = replan === null ? planned : replan.value;
      const reshadowed = replan !== null && replan.parity !== '' ? { render_parity: replan.parity } : {};
      const wholeBody =
        replanned.whole_body ??
        (later && later !== commitId ? `${planned.whole_body}\n\n${movedNote(commitId, later)}` : planned.whole_body);
      try {
        const review = await postReview(wholeBody);
        return summarize({ inline: 0, folded: planned.findings_total, review_id: review, retried: 'body-only', ...reshadowed });
      } catch (e3) {
        core.warning(`Body-only review failed (${e3.status ?? '?'}): ${e3.message}. Plain comment.`);
        await postComment(wholeBody);
        return summarize({ inline: 0, folded: planned.findings_total, posted_as: 'issue-comment', retried: 'body-only', ...reshadowed });
      }
    }
  }
};
