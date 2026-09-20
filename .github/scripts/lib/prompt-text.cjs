const text = (value) => String(value ?? '');

/*
 * The constraint block's own delimiters, neutralised in anything a review comment says.
 *
 * The trust levels of the fix prompt's two untrusted inputs were inverted. `scope` is refused outright for
 * containing `<` or `>`, and it comes from the CODEOWNER who triggered the run. Review comment bodies were
 * interpolated verbatim, and they come from anyone with read access to the pull request - so one could carry a
 * complete `<system-instructions>…</system-instructions>` block of its own and read as system text to a model
 * with Edit and unqualified Bash. The blast radius is bounded (no token in the process, `gh` and `git push`
 * disallowed, `verifyChunk` enforcing one commit and the denied-path floor), but the weaker treatment sat on
 * the weaker-trusted input.
 *
 * **Escaping is the wrong tool here, which is why the treatment differs at all rather than being unified.** A
 * review comment quotes code: HTML-escaping it turns `if (a < b)` into `if (a &lt; b)`, and a model answering a
 * review about mangled code is worse than one answering a review about real code. So only the two structural
 * tokens go, the way `scrub` removes a reserved comment and leaves the prose around it.
 *
 * Marked rather than deleted, because a comment that really did discuss this flow's own prompt should still
 * read as having said something.
 *
 * **Deliberately loose, because the parser that matters is a model rather than a strict one.** The first
 * version was `/<\/?system-instructions>/gi`, and six variants walked straight past it: `</ system-instructions>`,
 * `< /system-instructions>`, a newline inside the name, `</system_instructions>`, `</system instructions>`, and
 * `</system-instructions foo=1>`. None of those is valid XML and every one of them is something a model could
 * read as the constraint block closing early. So this tolerates whitespace anywhere a tag could carry it, an
 * underscore or a space where the hyphen goes, and any attribute run up to the `>`.
 *
 * The first test of this was blind and worth remembering: it counted tag-like sequences with the same pattern
 * the scrubber used, so it could only ever agree with itself. Counting with a looser pattern than the scrubber
 * is what exposed all six.
 *
 * Over-matching is the safe direction here, but only within one line - and the two ways of arranging that are
 * not equivalent, which cost a round to learn. With `[-_\s]*` and `[^>]*` unbounded the pattern crossed
 * newlines, and a reviewer writing
 *
 *     if (n < system_instructions_len(ctx)) {
 *       return ctx->len > 0;
 *
 * had the match run from that `<` to the `>` on the NEXT line, so their actual point - which value the guard
 * compares - was replaced by the marker. That is the failure two paragraphs up rules out.
 *
 * **The fix for that was a character count on every span, and a counted bound is one an attacker counts past.**
 * `{0,4}` and `{0,64}` meant five spaces, five separators or a 65-character attribute run walked through
 * untouched - so `</     system-instructions>` and `</system-----instructions>` reached the prompt whole, from
 * anyone with read access to the pull request. Reproduced against all four shapes, and invisible to the tests
 * of the time: every probe they carried used exactly one space and one separator, so neither the bound nor its
 * absence changed a result.
 *
 * **What has to be excluded is the newline, not the fifth character.** So every span here is unbounded and
 * newline-free, and exactly one newline is admitted in the one place a recorded variant needs it - inside the
 * name, where `</system\ninstructions>` breaks across a line. A match therefore spans at most one newline per
 * separator - two lines for a two-word name, three for `repo-review-rules` - which is tighter than the counted
 * version allowed (`\s{0,4}` admitted four newlines, so five lines) while having nothing left to count past.
 */
/*
 * **What separates the words of a tag is what renders as nothing, and that is a list Unicode keeps
 * rather than one written here.** The set above was spelled out code point by code point and missed
 * the ones that do not look like blanks: `U+2028`, which is a line separator; `U+034F`, a combining
 * mark; `U+3164` and `U+115F`, which are letters; `U+2065`, unassigned; the variation selectors.
 * Reproduced end to end - a workflow file named `</system<U+034F>instructions>.yml` reached a run's
 * prompt whole and read to a model as the block closing early, while this pattern matched the same
 * tag written with a hyphen and the same tag written with nothing between the words at all.
 *
 * There are on the order of nine hundred thousand such code points and they belong to no one
 * category, so `Default_Ignorable_Code_Point` does the naming: it is Unicode's own list of what a
 * renderer is to show nothing for, and it grows when Unicode grows. `Mn` covers the combining marks
 * beside it, `Zs`/`Zl`/`Zp` every space and line separator, and `U+2800` the one blank that is a
 * printing character rather than an ignorable one.
 */
const BLANK = '[\\t\\p{Zs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\p{Mn}\\u2800]';
const TAG_SEPARATOR = `[-_]*${BLANK}*\\n?${BLANK}*[-_]*`;
const tagPattern = (...segments) => new RegExp(`<${BLANK}*\\/?${BLANK}*${segments.join(TAG_SEPARATOR)}[^>\\n]*>`, 'giu');

/**
 * COLLAPSED_TAGS match what folding whitespace can assemble that the patterns above could not see.
 *
 * `neutralCut` makes untrusted text one line, and a run of whitespace it folds to a single space can
 * finish a tag the newline bound had kept apart: `</system` and `instructions>` on separate lines are
 * two lines to the pattern and one working tag afterwards. So the folded text is read again - but by
 * a pattern with no arbitrary tail, because on one line `[^>\n]*>` reaches the next `>` anywhere in
 * the text, and a reviewer writing `if (n < system_instructions_len(ctx))` about that very guard
 * would lose the rest of their comment to it.
 *
 * Every span here is a run rather than one character. A fold turns any amount of whitespace into one
 * space, but the hyphens and underscores around it survive it: `</system<NL><NL>-instructions>` folds
 * to `</system -instructions>`, which a single-character separator cannot span - and `</system -  * instructions>` needs no newline at all. Counting characters here is the same mistake the bound
 * above this one records, one pattern further down.
 */
const COLLAPSED_TAGS = Object.freeze([
  ['system', 'instructions'],
  ['user', 'request'],
  ['prior', 'findings'],
  ['repo', 'review', 'rules'],
  ['reviewer', 'mandate'],
].map((segments) => new RegExp(`< *\\/? *${segments.join('[-_ ]*')} *>`, 'gi')));

const CONSTRAINT_TAG = tagPattern('system', 'instructions');

/**
 * Untrusted text with the constraint block's own delimiters neutralised.
 *
 * **Here rather than at one call site, because every untrusted input crosses into the block at the same
 * place.** It was applied to review comment bodies only, in `renderThread`'s inner loop - so the issue
 * payload, which every one of the three prompts ends with, went through verbatim. Reproduced: a step prompt
 * built with a clean payload carries two delimiters, its own; the same prompt with an issue body containing
 * `</system-instructions>` carries four. That is the step model, which is the one holding `Edit` and Bash -
 * exactly the configuration the paragraph above names as the reason any of this exists - and the reporter
 * needs nothing but the ability to open an issue.
 *
 * **It does not parse the payload, which is the objection `renderPlanPrompt` records against touching it.**
 * That objection is about re-serialising a document and thereby deciding what the model sees; this replaces
 * two structural tokens and leaves every byte around them, the same treatment the comment bodies get. The
 * payload also stays valid JSON, because the marker carries no quote and no backslash. And the premise had
 * already lapsed: `stripOwnComments` parses and re-serialises that exact payload before any renderer sees it.
 */
const neutralize = (value) => text(value).replace(CONSTRAINT_TAG, '(constraint-tag)');

const SECTION_TAGS = Object.freeze([
  tagPattern('user', 'request'),
  tagPattern('prior', 'findings'),
  tagPattern('repo', 'review', 'rules'),
  tagPattern('reviewer', 'mandate'),
]);

/** neutralizeSections answers `value` with the review prompt's own section delimiters marked as well. */
function neutralizeSections(value) {
  return SECTION_TAGS.reduce((carried, tag) => carried.replace(tag, '(section-tag)'), neutralize(value));
}

const CHANNEL_MARKER = 'ksai run channel';

const CHANNEL_NONCE_SHAPE = /^[0-9a-f]{8,64}$/;

/** channelHeader answers the line a run-channel note opens with. */
function channelHeader(nonce) {
  return `[${CHANNEL_MARKER} ${nonce}]`;
}

/** usableNonce answers whether a run drew a token a note may be published under. */
function usableNonce(nonce) {
  return CHANNEL_NONCE_SHAPE.test(String(nonce ?? ''));
}

/** neutralCut answers untrusted text as one neutralized line, cut to a bound by code point. */
const CLOCK_COMMAND = 'date -u +%s';

function neutralCut(value, max) {
  const folded = neutralize(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  const line = COLLAPSED_TAGS.reduce((carried, tag) => carried.replace(tag, '(constraint-tag)'), folded);
  const kept = [...line];
  return kept.length > max ? `${kept.slice(0, max - 1).join('')}…` : line;
}

/** withinBytes cuts to a byte bound without splitting the character it lands in. */
function withinBytes(value, limit) {
  const said = String(value ?? '');
  if (Buffer.byteLength(said, 'utf8') <= limit) return said;
  const held = Buffer.from(said, 'utf8').subarray(0, limit).toString('utf8');

  return held.endsWith('\uFFFD') ? held.slice(0, -1) : held;
}

module.exports = {
  CLOCK_COMMAND,
  CONSTRAINT_TAG,
  SECTION_TAGS,
  channelHeader,
  neutralCut,
  neutralize,
  neutralizeSections,
  usableNonce,
  withinBytes,
};
