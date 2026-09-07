// What a review should cost and cover, decided from the pull request's file list before any run.
//
// The tables live in `rules.json`, beside this file and not beside the action that
// calls it: the ksai checkout is sparse and the action stages `.github/scripts` alone, so a rules
// file anywhere else never reaches the runner. The require below would throw, the catch would swallow
// it, and every review would run with an empty ruleset that reports nothing. This file holds only
// the logic that applies those tables.
// A policy change is therefore a data edit that a reviewer can read at a glance, and the parts that
// must not be gettable wrong from a config file -- the downgrade-only clamp, the truncation guard,
// the routing share and the skill cap -- stay here in code with tests on them.
//
// This is a policy module, not a security boundary, and it is written so that it cannot become one
// by accident. It never emits a model id: it emits a *tier name* out of a three-word vocabulary
// (`haiku`, `sonnet`, `opus`) that `lib/select-arm.cjs` resolves, bounds and re-checks against
// MODEL_SHAPE before anything reaches `claude_args`. A policy that returned `claude-sonnet-5`
// directly would put a second author on the value that gets whitespace-split into CLI flags; a
// policy that returns `sonnet` cannot, whatever it computes and whatever the file list said.
//
// The same rule governs the other outputs. Skills come from the rules file but are checked against
// the plugin directory by the wiring test, so a path in the diff can never name the skill that
// reviews it. `apiSurface` is a boolean, and each `why` string is authored in the rules file itself.
//
// Every decision is a *downgrade* or a no-op. The caller's configured arm is the ceiling and this
// module only ever proposes something at or below it, because a saving needs no trust while a cost
// increase does. `selectArm` enforces that bound independently rather than relying on this file to
// be right, so the two would have to be wrong together before a repo is billed for an arm that it
// never configured for itself.
//
// It fails open, always. A truncated file list, an unrecognized language, an empty diff, an
// unreadable rules file and a thrown error all resolve to "no opinion", which runs exactly the
// review the repo gets today. The alternative -- guessing from partial facts -- downgrades a large
// risky diff to a cheap arm on the strength of the first hundred filenames.

'use strict';

const { ALLOWED_EFFORTS, MODEL_TIERS } = require('../lib/select-arm.cjs');

/*
 * A language claims a skill once it accounts for this much of the reviewable diff. Below it the
 * language is real but incidental -- a single generated stub beside a large Go change -- and naming
 * its skill would spend a second reviewer pass on it.
 *
 * In code rather than in the rules file: it is a property of how the routing arithmetic behaves,
 * not a policy about a language, and a wrong value here fans a review out rather than costing a
 * single line of the diff its reviewer.
 */
const ROUTING_SHARE = 0.2;

/* At most this many skills, so a polyglot diff cannot fan out into every reviewer at once. */
const MAX_SKILLS = 2;

/*
 * The flag allowlist for a rule pattern, which admits `i` and nothing else. A `g` flag makes a
 * RegExp stateful across `.test()` calls through `lastIndex`, so the same path would match on one
 * file and miss on the next depending on what ran before it -- a bug that shows up as a rule
 * working intermittently, which is the hardest kind to catch in a review.
 */
const ALLOWED_FLAGS = /^i?$/;

/* The ruleset that changes nothing, and what any unusable rules file resolves to. */
const EMPTY_RULES = Object.freeze({
  bands: Object.freeze([]),
  riskFloorTier: null,
  risk: Object.freeze([]),
  apiSurface: Object.freeze([]),
  skillsByExtension: Object.freeze([]),
  skillsByPath: Object.freeze([]),
  skipAuthors: Object.freeze([]),
  nonReviewableExtensions: Object.freeze([]),
  nonReviewableBasenames: Object.freeze([]),
  dependencyManifests: Object.freeze([]),
  skipReason: '',
  skipAuthorReason: '',
  manifestSkipReason: '',
});

const isPlainString = (value) => typeof value === 'string' && value.length > 0;

/*
 * Turns one `{ match, flags }` entry into a RegExp, or null if it cannot.
 *
 * A rule that will not compile is dropped rather than thrown on. The rules file ships in this
 * repository and a test validates it, so a bad pattern is caught in CI where it is loud; at runtime
 * the same bad pattern must not take every consumer's review down with it.
 */
function toPattern(entry) {
  if (!entry || !isPlainString(entry.match)) return null;
  const flags = entry.flags ?? '';
  if (typeof flags !== 'string' || !ALLOWED_FLAGS.test(flags)) return null;
  try {
    return new RegExp(entry.match, flags);
  } catch {
    return null;
  }
}

const compilePatterns = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => ({
      re: toPattern(entry),
      why: isPlainString(entry?.why) ? entry.why : '',
      floor: entry?.floor,
      skill: entry?.skill,
    }))
    .filter((rule) => rule.re !== null);

/**
 * Reads the raw rules file into the shape the policy runs on.
 *
 * Exported so a test can compile a hostile or malformed ruleset without writing one to disk. Every
 * malformed part is dropped on its own, so one bad rule costs its own rule and never the file.
 */
function compileRules(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_RULES;

  return {
    bands: (Array.isArray(raw.bands) ? raw.bands : [])
      .filter((band) => MODEL_TIERS.includes(band?.tier)
        && Number.isFinite(band.maxLines) && Number.isFinite(band.maxFiles))
      .map((band) => ({
        tier: band.tier,
        maxLines: band.maxLines,
        maxFiles: band.maxFiles,
        why: isPlainString(band.why) ? band.why : '',
      })),
    riskFloorTier: MODEL_TIERS.includes(raw.riskFloorTier) ? raw.riskFloorTier : null,
    risk: compilePatterns(raw.risk).map((rule) => ({
      re: rule.re,
      why: rule.why,
      floor: MODEL_TIERS.includes(rule.floor) ? rule.floor : null,
    })),
    apiSurface: compilePatterns(raw.apiSurface),
    skillsByExtension: (Array.isArray(raw.skillsByExtension) ? raw.skillsByExtension : [])
      .filter((rule) => isPlainString(rule?.ext) && isPlainString(rule?.skill))
      .map((rule) => ({ ext: rule.ext.toLowerCase(), skill: rule.skill })),
    skillsByPath: compilePatterns(raw.skillsByPath).filter((rule) => isPlainString(rule.skill)),
    skipAuthors: (Array.isArray(raw.skipAuthors) ? raw.skipAuthors : [])
      .filter((rule) => isPlainString(rule?.login))
      .map((rule) => rule.login.toLowerCase()),
    skipAuthorReason: isPlainString(raw.skipAuthorReason) ? raw.skipAuthorReason : '',
    nonReviewableExtensions: (Array.isArray(raw.nonReviewable?.extensions) ? raw.nonReviewable.extensions : [])
      .filter((value) => isPlainString(value)).map((value) => value.toLowerCase()),
    nonReviewableBasenames: (Array.isArray(raw.nonReviewable?.basenames) ? raw.nonReviewable.basenames : [])
      .filter((value) => isPlainString(value)).map((value) => value.toLowerCase()),
    dependencyManifests: (Array.isArray(raw.dependencyManifests) ? raw.dependencyManifests : [])
      .filter((rule) => isPlainString(rule?.manifest) && Array.isArray(rule.lockfiles))
      .map((rule) => ({
        manifest: rule.manifest.toLowerCase(),
        lockfiles: rule.lockfiles.filter((name) => isPlainString(name)).map((name) => name.toLowerCase()),
      }))
      .filter((rule) => rule.lockfiles.length > 0),
    skipReason: isPlainString(raw.skipReason) ? raw.skipReason : '',
    manifestSkipReason: isPlainString(raw.manifestSkipReason) ? raw.manifestSkipReason : '',
  };
}

/*
 * The shipped ruleset, compiled once at module load.
 *
 * `require` parses the JSON with no parser of our own, which is what keeps this dependency-free in
 * an action that installs nothing. It is wrapped because a require that throws at load would fail
 * the triage step outright, and a broken rules file must cost the reviewer its opinion, not its run.
 */
let DEFAULT_RULES = EMPTY_RULES;
try {
  DEFAULT_RULES = compileRules(require('./rules.json'));
} catch {
  DEFAULT_RULES = EMPTY_RULES;
}

/*
 * Every skill the shipped rules can route to, which the wiring test compares against
 * `plugins/kreview/skills/`. Derived rather than listed, so a rules file naming a skill the plugin
 * does not ship fails the suite instead of routing a review to nothing at all.
 *
 * `default-code-review` is in it unconditionally because `route` adds it for uncovered lines, not
 * because a rule names it.
 */
const SKILLS = Object.freeze(
  [...new Set([
    'default-code-review',
    ...DEFAULT_RULES.skillsByExtension.map((rule) => rule.skill),
    ...DEFAULT_RULES.skillsByPath.map((rule) => rule.skill),
  ])].sort(),
);

const basename = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

const extension = (path) => {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
};

/*
 * Whether a reviewer has anything to say about this file's content.
 *
 * No extension carrying words is skippable, which is why the answer is this short. Markdown is
 * documentation in most repositories and behaviour in this one -- `AGENTS.md` becomes
 * `repo_conventions` for every later review, a `SKILL.md` is a spawn protocol, an agent file sets
 * the model its subagent runs on -- and prose is worth reviewing everywhere else. What is left is
 * binary assets and generated dependency pins, so a skip means a pin-only bump in practice.
 */
function isReviewable(path, rules = DEFAULT_RULES) {
  if (rules.nonReviewableBasenames.includes(basename(path))) return false;
  return !rules.nonReviewableExtensions.includes(extension(path));
}

/*
 * Which kreview skill reviews this file, or null when no rule claims it.
 *
 * Path rules run first so a role-named NestJS file, or a Vue/Nuxt composable or store matched by
 * its directory, is not taken by a plain `.ts` extension rule that happens to be listed beside it.
 * They match the full repo-relative path, lowercased the same way `extension`/`isReviewable`
 * already lowercase through `basename`, which is what lets a rule key on a directory
 * (`composables/`, `stores/`) rather than only a filename suffix, without also requiring every
 * rule to carry its own `i` flag.
 */
function skillFor(path, rules = DEFAULT_RULES) {
  const lowerPath = path.toLowerCase();
  const byPath = rules.skillsByPath.find((rule) => rule.re.test(lowerPath));
  if (byPath) return byPath.skill;
  const ext = extension(path);
  return rules.skillsByExtension.find((rule) => rule.ext === ext)?.skill ?? null;
}

/**
 * Reads the changed-file list into the facts the policy runs on.
 *
 * `files` entries come straight from the GitHub API, so nothing about their shape is assumed: a
 * missing path, a non-numeric line count and a null entry are all tolerated rather than thrown on,
 * because a single odd record must not cost the run its whole review.
 */
function summarize(files, rules = DEFAULT_RULES) {
  const facts = {
    reviewableFiles: 0,
    reviewableLines: 0,
    manifestFiles: 0,
    manifests: new Set(),
    locks: new Set(),
    risk: false,
    riskFloor: null,
    apiSurface: false,
    byLanguage: Object.create(null),
    uncoveredLines: 0,
    reasons: [],
  };

  const note = (why) => {
    if (why && !facts.reasons.includes(why)) facts.reasons.push(why);
  };

  const raise = (floor) => {
    if (!floor) return;
    const current = facts.riskFloor;
    if (!current || MODEL_TIERS.indexOf(floor) > MODEL_TIERS.indexOf(current)) facts.riskFloor = floor;
  };

  for (const entry of files) {
    const path = typeof entry?.path === 'string' ? entry.path : '';
    if (!path) continue;

    const added = Number.isFinite(entry.additions) ? Math.max(0, entry.additions) : 0;
    const removed = Number.isFinite(entry.deletions) ? Math.max(0, entry.deletions) : 0;
    const lines = added + removed;

    // Both flags come from every changed path, reviewable or not. A workflow file is risk-bearing
    // whatever its line count, and excluding documentation here would mean a docs-and-proto diff
    // got read as if the proto were never in it at all.
    for (const rule of rules.risk) {
      if (!rule.re.test(path)) continue;
      facts.risk = true;
      note(rule.why);
      raise(rule.floor ?? rules.riskFloorTier);
    }
    if (rules.apiSurface.some((rule) => rule.re.test(path))) facts.apiSurface = true;

    if (rules.nonReviewableBasenames.includes(basename(path))) facts.locks.add(basename(path));

    if (!isReviewable(path, rules)) continue;

    facts.reviewableFiles += 1;
    facts.reviewableLines += lines;
    if (rules.dependencyManifests.some((rule) => rule.manifest === basename(path))) {
      facts.manifestFiles += 1;
      facts.manifests.add(basename(path));
    }

    const skill = skillFor(path, rules);
    if (skill) facts.byLanguage[skill] = (facts.byLanguage[skill] ?? 0) + lines;
    else facts.uncoveredLines += lines;
  }

  return facts;
}

/*
 * The skills to name in the prompt, or an empty list to leave detection to the model.
 *
 * An empty list is a real answer rather than a failure: where no rule covers a meaningful share of
 * the diff, the action's existing prompt already routes to `default-code-review`, and repeating
 * that decision here would add a way to get it wrong without adding any way to get it right.
 */
function route(facts) {
  if (facts.reviewableLines <= 0) return [];

  const claimed = Object.entries(facts.byLanguage)
    .filter(([, lines]) => lines / facts.reviewableLines >= ROUTING_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([skill]) => skill);

  if (!claimed.length) return [];

  const skills = claimed.slice(0, MAX_SKILLS);
  // Lines no rule covers get the default reviewer beside the language one, but only when there are
  // enough of them to be worth a pass. Without this a Go change that also rewrites the CI workflow
  // would be reviewed as if the workflow were not in the diff.
  if (facts.uncoveredLines / facts.reviewableLines >= ROUTING_SHARE && skills.length < MAX_SKILLS) {
    skills.push('default-code-review');
  }
  return skills;
}

/*
 * Whether this diff is a resolved dependency update and nothing else.
 *
 * The lockfile is the load-bearing condition rather than decoration. A package manager rewrites its
 * lockfile when the resolved dependency set moves and leaves it alone when only a script, an
 * `engines` field or an export map changes, so a manifest edit arriving without one is a behaviour
 * change wearing a dependency file's name and stays reviewable.
 *
 * The pairing is per ecosystem, and that is the whole rule. Counting lockfiles across the diff let a
 * hand-edited `package.json` ride into a skip on a `go.sum` that a real Go bump had changed, which
 * is a crafted bypass of the only automated review pass a repository gets. It is deliberately not
 * per directory: npm workspaces keep one `package-lock.json` at the root while every
 * `packages/*&#47;package.json` changes beneath it, so pairing by directory would refuse the
 * monorepos this rule exists for.
 *
 * The risk term is the third condition because a manifest can sit on a risk path -- a `go.mod` under
 * a vendored auth module, a `package.json` beside a Dockerfile -- and a rule that holds the arm on a
 * path has already said that path is worth a reviewer's attention.
 */
function manifestOnly(facts, rules) {
  if (facts.reviewableFiles === 0 || facts.manifestFiles !== facts.reviewableFiles || facts.risk) return false;
  return [...facts.manifests].every((name) => {
    const rule = rules.dependencyManifests.find((entry) => entry.manifest === name);
    return rule ? rule.lockfiles.some((lock) => facts.locks.has(lock)) : false;
  });
}

/**
 * Whether a listed automation account wrote every commit on the head.
 *
 * `commitAuthors` is the resolved login per commit, an empty string where GitHub resolved none, and
 * null from a caller that did not look. `commitCount` is the pull request's own count. An unresolved
 * author, a list shorter than that count and an empty list all answer false.
 */
function automationWroteAll(commitAuthors, commitCount, rules) {
  if (!Array.isArray(commitAuthors)) return true;
  const total = Number.isFinite(commitCount) ? commitCount : commitAuthors.length;
  if (commitAuthors.length < total) return false;
  return commitAuthors.every((login) => rules.skipAuthors.includes(String(login ?? '').toLowerCase()));
}

/**
 * Whether the author rule has anything to say about this login at all.
 *
 * Exported so a caller can price the commit lookup above without a second copy of the list.
 */
function skipsAuthor(author, rules = DEFAULT_RULES) {
  const login = String(author ?? '').toLowerCase();
  return Boolean(login) && rules.skipAuthors.includes(login);
}

/**
 * The tier for this diff, the band that produced it, and whether the risk floor overrode that band.
 *
 * The band, because the resolved tier is not enough to find it again. Where the risk floor raises a
 * cheap band's tier, looking the band up by tier afterwards answers with a *different* band - so the
 * report would print that band's reason for a diff which never matched it.
 *
 * `raised`, because a band whose tier the floor overrode did not decide this diff's arm, and the
 * report must not read as though it had. The shipped floor is the top tier, so every risk path takes
 * this path: printing "a diff of this size reads fine on sonnet" beside a review deliberately kept
 * on the configured arm states the opposite of what happened.
 */
function tierFor(facts, rules = DEFAULT_RULES) {
  const band = rules.bands.find((b) => facts.reviewableLines <= b.maxLines && facts.reviewableFiles <= b.maxFiles);
  if (!band) return { tier: null, band: null, raised: false };
  const floor = facts.riskFloor;
  const raised = Boolean(floor) && MODEL_TIERS.indexOf(band.tier) < MODEL_TIERS.indexOf(floor);
  return { tier: raised ? floor : band.tier, band, raised };
}

/**
 * Decides the arm, the routing and the skip verdict for one review.
 *
 * `files` is the pull request's changed-file list (`path`, `additions`, `deletions`) and
 * `changedFiles` is GitHub's own count of it. `rules` defaults to the shipped tables and exists so
 * a test can drive the engine with a ruleset of its own. Returns
 * `{ tier, effort, skills, skip, apiSurface, facts }`, where a null `tier` or `effort` means "no
 * opinion, use what the repo configured" and `skip` is `{ reason }` or null.
 *
 * `changedFiles` is not decoration. The list endpoint caps at 3000 files, so a large pull request
 * arrives silently short, and every number below it would then describe a fraction of the diff --
 * the file count, the line count, the language shares and the risk flag alike. A short list is the
 * one input that cannot be partially trusted, so it returns no opinion at all.
 */
function triage({
  files = null,
  changedFiles = null,
  author = null,
  commitAuthors = null,
  commitCount = null,
  rules = DEFAULT_RULES,
} = {}) {
  const inert = { tier: null, effort: null, skills: [], skip: null, apiSurface: false, facts: null };

  /*
   * The author check runs before the file list is looked at, and before the truncation guard, because
   * it does not depend on either: a four-thousand-file dependency bump is still a dependency bump.
   *
   * The rule pays for itself where reviews are requested automatically, which a caller can now wire
   * up: every opened pull request gets one, so a bot's output is reviewed on repeat until something
   * stops it. That is why the list holds automation accounts only, and why the reason names the
   * account class rather than echoing a login -- nothing a pull request controls reaches the notice.
   *
   * It is bounded by who wrote the head rather than by who opened it, so a person pushing onto a
   * Renovate branch is not refused a review of their own commit. A caller that passes no commit list
   * gets the rule as it was.
   */
  if (skipsAuthor(author, rules) && automationWroteAll(commitAuthors, commitCount, rules) && rules.skipAuthorReason) {
    return { ...inert, skip: { reason: rules.skipAuthorReason, by: 'author' } };
  }

  if (!Array.isArray(files) || files.length === 0) return inert;

  const total = Number.isFinite(changedFiles) ? changedFiles : files.length;
  if (files.length < total) return inert;

  const facts = summarize(files, rules);

  // Nothing in the diff a reviewer can read. Skipping is where the saving is: today this spends a
  // full run to report that a documentation change is a documentation change. A ruleset naming no
  // skip reason cannot skip at all, so an unusable rules file reviews rather than withholds.
  if (facts.reviewableFiles === 0 && rules.skipReason) {
    return { ...inert, apiSurface: facts.apiSurface, skip: { reason: rules.skipReason, by: 'content' }, facts };
  }

  if (manifestOnly(facts, rules) && rules.manifestSkipReason) {
    return { ...inert, apiSurface: facts.apiSurface, skip: { reason: rules.manifestSkipReason, by: 'manifest' }, facts };
  }

  const { tier, band, raised } = tierFor(facts, rules);
  if (band?.why && !raised) facts.reasons.unshift(band.why);

  return {
    tier,
    /*
     * Never moved, on purpose, and the axis exists because `selectArm` takes a complete arm.
     *
     * Effort is not a cost lever. Measured on this reviewer, haiku at `medium` cost $1.79 where the
     * same review at `high` cost $0.32, because a shallower run makes more and less-consolidated
     * tool calls and the loop thrashes. Spend is not monotonic in effort, so lowering it here would
     * buy an unmeasured change in depth for an unmeasured change in cost. The model is the lever
     * and the band is where the whole of the saving comes from.
     */
    effort: null,
    skills: route(facts),
    skip: null,
    apiSurface: facts.apiSurface,
    facts,
  };
}

module.exports = {
  SKILLS,
  DEFAULT_RULES,
  EMPTY_RULES,
  ROUTING_SHARE,
  MAX_SKILLS,
  ALLOWED_EFFORTS,
  compileRules,
  triage,
  skipsAuthor,
  // Exported for the tests, which pin the classification rules directly rather than inferring them
  // from a whole-diff verdict.
  isReviewable,
  skillFor,
  summarize,
  route,
  tierFor,
};
