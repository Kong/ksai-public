// The two stable identities a suppression list is keyed on. Both are hashes, so the same
// finding text yields the same match ID on every repo and every run — that is what lets a
// maintainer key a suppression entry off one posted comment and have it hold on later PRs.
//
// The canonical input and its key order are a wire contract. Change either and every committed
// suppression key stops matching, which un-suppresses findings silently rather than failing, so
// bump MATCH_VERSION in the same change: the version is part of the ID, so old and new keys can
// never be confused for each other.

const { createHash } = require('node:crypto');

const MATCH_VERSION = 1;
// 128 bits of sha256. A suppression list holds tens of entries, not billions, so this is far
// past the point where a collision is a real concern, and it stays short enough to copy by hand.
const DIGEST_CHARS = 32;

const digest = (fields) => createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, DIGEST_CHARS);

/*
 * The model writes the body; the publisher adds the severity label, the tag and the markers
 * around it. Only the model's text is identity — otherwise every change to how a comment is
 * rendered would invalidate the whole list.
 */
const canonicalBody = (body) =>
  String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();

/*
 * Identity of a finding's content: reviewer, tag, body, and deliberately nothing else.
 *
 * Severity, path, line, side, PR and commit are all excluded, so the same concern raised in
 * another file still matches an existing key while a reworded one does not — v1 suppresses exact
 * recurrences only. The tag is lowercased because the tag gate is case-insensitive too; letting
 * `Nit` and `nit` hash differently would leave a rule that looks active but never fires.
 *
 * Returns null when a required part is missing. A finding with no ID cannot be suppressed and
 * cannot become evidence, so the caller must post it.
 */
function matchId({ reviewerId, tag, body }) {
  const reviewer_id = String(reviewerId ?? '').trim();
  const canonical_tag = String(tag ?? '')
    .trim()
    .toLowerCase();
  const canonical_body = canonicalBody(body);
  if (!reviewer_id || !canonical_tag || !canonical_body) return null;

  return `m${MATCH_VERSION}-${digest({
    match_version: MATCH_VERSION,
    reviewer_id,
    tag: canonical_tag,
    canonical_body,
  })}`;
}

/*
 * Identity of one finding in one review — per occurrence, unlike the match ID, so two identical
 * concerns on different lines stay two records. Derived from the run rather than assigned, so
 * reprocessing the same review's record re-derives the same ID and a replay cannot inflate the
 * fire count for a rule.
 *
 * Returns null without a run ID: a record that cannot be tied to its run is not worth writing.
 */
function findingId({ runId, index, matchId: match, path, line, side }) {
  const run_id = String(runId ?? '').trim();
  if (!run_id) return null;

  return `f${MATCH_VERSION}-${digest({
    match_version: MATCH_VERSION,
    run_id,
    index: Number.isInteger(index) ? index : null,
    match_id: match ?? null,
    path: String(path ?? ''),
    line: Number.isFinite(Number(line)) ? Number(line) : null,
    side: String(side ?? '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
  })}`;
}

/*
 * Identity of one suppression event. The same rule and finding always produce the same ID, so a
 * reprocessed review contributes the same event rather than a second one.
 */
function eventId({ ruleId, findingId: finding }) {
  return `e${MATCH_VERSION}-${digest({
    match_version: MATCH_VERSION,
    rule_id: String(ruleId ?? ''),
    finding_id: String(finding ?? ''),
  })}`;
}

module.exports = { MATCH_VERSION, DIGEST_CHARS, canonicalBody, matchId, findingId, eventId };
