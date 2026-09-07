// The suppression gate: which findings a repo's committed suppression list withholds from a PR.
//
// Enforcement is deliberately dumb. A finding is withheld only when its match ID appears
// verbatim in a rule's keys AND its tag is on the global low-risk list AND its severity is
// Medium or Low. No model takes part in the decision, the three checks are independent, and a
// rule can narrow them but never widen them. Every other outcome — no rule, an unparseable rule,
// a missing tag or severity, a finding whose match ID could not be derived — posts the finding.
//
// A rule that does not validate is dropped, not repaired, so a hand-edit typo can only ever
// cause a finding to post. the suppression store gates the same file with a stricter validator that
// rejects the whole file, so an invalid line should never reach a review in the first place;
// this is the backstop for when it does.

const { canonicalBody, matchId, findingId, eventId } = require('./match-id.cjs');

// The global low-risk tag list, mirroring plugins/kreview/resources/format-policy.md. `bug` and
// `risk` are absent on purpose: a real-defect tag is never suppressible, whatever a rule claims.
const LOW_RISK_TAGS = Object.freeze(['nit', 'shrink', 'spelling', 'yagni', 'q', 'delete', 'stdlib', 'native']);

// Rank by risk, most severe first. A missing or unrecognized severity has no rank, so it can
// never clear the Medium floor — unknown reads as dangerous, not as low.
//
// Null-prototype, because Object.freeze does not detach the prototype: a plain object answers
// `constructor` with a function and `__proto__` with an object, neither of which is undefined. A
// rule carrying `"severity_cap": "constructor"` would then validate with a cap that compares as
// NaN forever, so it could never fire — accepted with no warning and silently inert, which is
// exactly what the validation here exists to prevent.
const SEVERITY_RANK = Object.freeze(Object.assign(Object.create(null), { critical: 0, high: 1, medium: 2, low: 3 }));
const SUPPRESSIBLE_FLOOR = SEVERITY_RANK.medium;

// Shape of an ID from kreview/match-id.cjs. A key that does not look like one is a typo or a
// paste of the wrong field, never something a finding can match.
const KEY_SHAPE = /^m\d+-[0-9a-f]{32}$/;

const lower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const rank = (severity) => SEVERITY_RANK[lower(severity)];

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/*
 * Validates one rule and returns it in the shape the gate uses, or a `problem` string naming the
 * first thing wrong with it. Optional fields are validated when present: `tags` and
 * `severity_cap` exist only to narrow a rule, so a malformed one has to invalidate the rule
 * rather than be ignored, or a rule meant to cover just `nit` would quietly cover all eight tags.
 */
function normalizeRule(record, { scope }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { problem: 'not a JSON object' };
  if (!isNonEmptyString(record.id)) return { problem: 'missing id' };
  if (!isNonEmptyString(record.scope)) return { problem: 'missing scope' };

  // Defence in depth: the file path already implies the scope, so a mismatch means the loader
  // fetched the wrong path or the entry was copied between repos without being re-scoped.
  if (record.scope !== scope) {
    const hint = record.scope === '_org' ? 'org-wide rules are not supported yet' : `scope is ${record.scope}`;
    return { problem: `${hint}, expected ${scope}` };
  }

  if (!Array.isArray(record.keys) || record.keys.length === 0) return { problem: 'keys must be a non-empty array' };
  const keys = [...new Set(record.keys)];
  const badKey = keys.find((key) => !isNonEmptyString(key) || !KEY_SHAPE.test(key));
  if (badKey !== undefined) return { problem: `key ${JSON.stringify(badKey)} is not a match ID` };

  let tags = null;
  if (record.tags !== undefined && record.tags !== null) {
    if (!Array.isArray(record.tags) || record.tags.length === 0) return { problem: 'tags must be a non-empty array' };
    tags = record.tags.map(lower);
    const badTag = tags.find((tag) => !LOW_RISK_TAGS.includes(tag));
    if (badTag !== undefined) return { problem: `tag ${JSON.stringify(badTag)} is not a low-risk tag` };
  }

  let cap = SUPPRESSIBLE_FLOOR;
  if (record.severity_cap !== undefined && record.severity_cap !== null) {
    const capRank = rank(record.severity_cap);
    if (capRank === undefined || capRank < SUPPRESSIBLE_FLOOR) {
      return { problem: `severity_cap ${JSON.stringify(record.severity_cap)} must be medium or low` };
    }
    cap = capRank;
  }

  return { rule: Object.freeze({ id: record.id, scope: record.scope, keys: Object.freeze(keys), tags, cap }) };
}

/*
 * Parses the committed list. One JSON object per line, as written in
 * `suppressions/<owner>/<repo>/learnings.jsonl`. Blank lines are skipped; anything else that does
 * not validate is dropped with a warning naming the line, so a bad entry is visible in the run
 * log rather than silently inert.
 */
function parseRules(text, { scope = null, warn = (_message) => {} } = {}) {
  const rules = [];
  const seen = new Set();

  String(text ?? '')
    .split('\n')
    .forEach((raw, offset) => {
      const line = raw.trim();
      if (!line) return;
      const at = `suppression rule on line ${offset + 1}`;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        warn(`${at}: not valid JSON; ignoring it`);
        return;
      }

      const { rule, problem } = normalizeRule(record, { scope });
      if (problem) {
        warn(`${at}: ${problem}; ignoring it`);
        return;
      }
      // Two rules under one id make "which rule suppressed this" unanswerable, and the fire
      // events for both would collapse onto the same key.
      if (seen.has(rule.id)) {
        warn(`${at}: duplicate id ${JSON.stringify(rule.id)}; ignoring it`);
        return;
      }

      seen.add(rule.id);
      rules.push(rule);
    });

  return rules;
}

/*
 * The rule that withholds this finding, or null to post it.
 *
 * Order matters for readability only — all three conditions must hold, and each is checked
 * against the global list rather than anything the rule supplied.
 */
function decide(finding, { rules, scope }) {
  const tag = lower(finding.tag);
  const severity = rank(finding.severity);
  const match = finding.match_id;

  if (!match) return null;
  if (!LOW_RISK_TAGS.includes(tag)) return null;
  if (severity === undefined || severity < SUPPRESSIBLE_FLOOR) return null;

  return (
    rules.find(
      (rule) =>
        rule.scope === scope &&
        rule.keys.includes(match) &&
        (rule.tags === null || rule.tags.includes(tag)) &&
        severity >= rule.cap,
    ) ?? null
  );
}

/*
 * Splits a review's findings into the ones that still post and the ones a rule withholds, and
 * returns the records that make the drop auditable afterwards.
 *
 * `kept` carries each finding's IDs so the publisher can print the match ID in the comment
 * marker — that is where a maintainer copies it from when adding an entry by hand. `records`
 * covers every finding, posted or not, because the ID of a suppressed finding appears nowhere
 * else. `fires` is the usage record: one event per drop, keyed so a replay cannot double-count.
 */
function applySuppression({
  findings,
  rules = [],
  scope,
  reviewerId,
  runId,
  prNumber,
  reviewedHead,
  firedAt,
}) {
  const kept = [];
  const fires = [];
  const records = [];

  findings.forEach((finding, index) => {
    const match = matchId({ reviewerId, tag: finding.tag, body: finding.body });
    const id = findingId({ runId, index, matchId: match, path: finding.path, line: finding.line, side: finding.side });
    const carried = { ...finding, match_id: match, finding_id: id };
    const rule = rules.length ? decide(carried, { rules, scope }) : null;

    records.push({
      finding_id: id,
      match_id: match,
      repo: scope ?? null,
      pr: prNumber ?? null,
      reviewed_head: reviewedHead ?? null,
      path: finding.path ?? null,
      line: finding.line ?? null,
      side: String(finding.side ?? '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
      tag: finding.tag ?? null,
      severity: finding.severity ?? null,
      // The exact string the match ID hashes, so a maintainer can check an entry by hand.
      text: canonicalBody(finding.body),
      posted: rule === null,
      suppressed_by: rule?.id ?? null,
    });

    if (rule === null) {
      kept.push(carried);
      return;
    }

    fires.push({
      event_id: eventId({ ruleId: rule.id, findingId: id }),
      rule_id: rule.id,
      finding_id: id,
      pr: prNumber ?? null,
      reviewed_head: reviewedHead ?? null,
      fired_at: firedAt ?? null,
    });
  });

  return { kept, fires, records };
}

module.exports = { LOW_RISK_TAGS, SEVERITY_RANK, KEY_SHAPE, parseRules, decide, applySuppression };
