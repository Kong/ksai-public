'use strict';

/**
 * Extracts the owner set from a CODEOWNERS file.
 *
 * This is a security boundary: the set it returns decides which GitHub logins may trigger a
 * federated run, and therefore who can spend a team's Anthropic budget and (for `ksai-implement`)
 * make the bot write to the repo. Widening what counts as an owner widens that gate, so the
 * rules below are deliberately conservative and the test suite is adversarial rather than
 * happy-path.
 *
 * Every rule line counts, not just the `*` default line. Repos routinely put teams only on
 * path rules - a real repo names three individuals on `*` and every team on paths like
 * `/apps/analytics/` - so reading `*` alone rejects most of a repo's actual owners.
 *
 * Path patterns are deliberately NOT matched against the PR's files. Doing so would mean
 * reimplementing glob semantics inside this boundary, where a subtle bug is either a false grant
 * or a false denial. Owning any path in the repo is the trust bar instead; `authorize.cjs`
 * confirms the login actually holds write access, which is what makes that bar meaningful.
 *
 * CODEOWNERS is NOT gitignore, and the difference is load-bearing here. GitHub documents that
 * escaping a leading `#` with `\`, negating with `!`, and character ranges with `[ ]` all "don't
 * work", and that a line with invalid syntax "will be skipped". Honouring any of those would
 * grant owners GitHub itself assigns to nobody - `/x/ @real \# @attacker` reads as a trailing
 * comment to a human and to GitHub, so `@attacker` must not count.
 */

/**
 * GitHub login charset and length, not its full signup rules. Rejecting garbage is the point;
 * being stricter than GitHub (no consecutive hyphens, no trailing hyphen) risks denying a real
 * owner, while accepting a login shape that cannot exist grants nobody anything.
 *
 * `ACTOR_PATTERN` in `.github/scripts/federation/cel.mjs` is the same rule for the same reason.
 * The copy exists because this directory ships standalone to consumer repos, which sparse-check
 * out `.github/actions/codeowners-authz` alone, so nothing under `.github/scripts/` is there to
 * import. An edit to this rule belongs in both, and a test compares them.
 */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** Team slugs allow dots and underscores that logins do not. `/` is excluded, so `@a/b/c` is rejected. */
const TEAM_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * A pattern GitHub rejects, making the whole line invalid syntax that it skips: a leading `!`
 * (negation) or any `[`/`]` (character range). Honouring such a line would grant its owners
 * while GitHub grants them nothing.
 */
const INVALID_PATTERN = /^!|[[\]]/;

/**
 * Truncates a line at its first `#`. Unconditionally: GitHub documents that escaping a leading
 * `#` with `\` does not work, so a `\#` starts a comment just like a bare one. Treating the
 * escape as gitignore does would make `/x/ @real \# @attacker` grant `@attacker`, which reads as
 * commented-out to every human reviewing the diff and to GitHub.
 */
const stripComment = (line) => {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
};

/**
 * @param {string} content raw CODEOWNERS text
 * @returns {{
 *   users: Set<string>,
 *   teams: Array<{ org: string, slug: string, raw: string }>,
 *   ignored: string[],
 *   skipped: string[],
 * }} `users` is lowercased for case-insensitive comparison. `teams` keeps its source casing
 *   (the GitHub API is case-insensitive on org and slug) and is deduplicated case-insensitively
 *   so a team named on twenty path rules costs one pair of API calls, not twenty. `ignored`
 *   holds owner tokens that failed validation and `skipped` holds whole lines GitHub would
 *   reject, so a typo in a repo's CODEOWNERS surfaces as a warning instead of an unexplained
 *   denial.
 */
function parseCodeowners(content) {
  const users = new Set();
  const teams = [];
  const seenTeams = new Set();
  const ignored = [];
  const skipped = [];

  const text = String(content ?? '').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    // Only spaces and tabs separate CODEOWNERS tokens. Splitting on JS `\s` instead would treat
    // a non-breaking space, an ideographic space or a stray BOM as a separator, so
    // `* @realuser\u00A0@attacker` would grant `@attacker` where GitHub sees one invalid owner
    // token and grants nobody - and U+00A0 and U+FEFF are invisible in a diff.
    const tokens = line.split(/[ \t]+/);

    // Token 0 is the path pattern, never an owner. Dropping it keeps a file literally named
    // `@something` from being read as a login, which would grant that login the gate.
    if (INVALID_PATTERN.test(tokens[0])) {
      skipped.push(line);
      continue;
    }

    for (const token of tokens.slice(1)) {
      if (!token.startsWith('@')) {
        // GitHub also accepts an email address that is on the account. This cannot resolve one to
        // a login, so report it rather than dropping it silently: a real owner denied with no
        // explanation is the failure mode this module exists to avoid.
        if (token.includes('@')) ignored.push(token);
        continue;
      }
      const entry = token.slice(1);

      const slash = entry.indexOf('/');
      if (slash === -1) {
        if (LOGIN.test(entry)) users.add(entry.toLowerCase());
        else ignored.push(token);
        continue;
      }

      const org = entry.slice(0, slash);
      const slug = entry.slice(slash + 1);
      if (!LOGIN.test(org) || !TEAM_SLUG.test(slug)) {
        ignored.push(token);
        continue;
      }

      const key = `${org.toLowerCase()}/${slug.toLowerCase()}`;
      if (seenTeams.has(key)) continue;
      seenTeams.add(key);
      teams.push({ org, slug, raw: token });
    }
  }

  return { users, teams, ignored, skipped };
}

module.exports = { parseCodeowners };
