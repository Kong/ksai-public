'use strict';

const { parseCodeowners } = require('./codeowners.cjs');

/**
 * Decides whether a GitHub login is authorized by the repository's CODEOWNERS.
 *
 * This is the security boundary behind the comment-triggered actions: its answer decides who
 * can spend a team's Anthropic budget, and for `ksai-implement` who can make the bot write to the
 * repo. It lives here rather than inline in `action.yml` so the API glue is unit-testable, not
 * just the parse - see `authorize.test.mjs`.
 *
 * Two failure modes are deliberately different. Not being an owner is a quiet `false`: the
 * common case is a stranger commenting. Being unable to *tell* fails loudly, because silently
 * rejecting a real CODEOWNER over a missing grant looks like the bot is broken and is impossible
 * to debug from the outside. A refusal names the grant to fix; a 5xx names GitHub instead, since a
 * token that just read CODEOWNERS is not why the next call died.
 */

/** Where GitHub itself looks for CODEOWNERS, in its own precedence order. */
const SEARCH_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

function unreadable(what, err, grant) {
  if (err.status === undefined) {
    return `${what}: ${err.message}. No HTTP status, so no token grant is missing.`;
  }
  if (err.status >= 500) {
    return `${what}: ${err.status} ${err.message}. GitHub failed rather than refused, so no token grant is missing and the request is worth retrying.`;
  }
  return `${what}; github-token needs ${grant}: ${err.status} ${err.message}`;
}

/**
 * Reads the repository's CODEOWNERS from the first of `SEARCH_PATHS` that has one.
 *
 * @returns {Promise<{ content: string, source: string } | null>} null where no owners were read:
 *   either the file could not be read, having already called `core.setFailed` with the reason, or
 *   there is no file at any path, having set the `owners` output and warned instead. Note that a
 *   found-but-empty file returns `content: ''`, an ownerless file rather than a missing one.
 */
async function readCodeowners({ github, core, owner, repo, cache }) {
  /*
   * An optional caller-owned cache, because one caller now asks this question repeatedly. The approval
   * gate in `ksai/gate.cjs` authorizes up to ten candidate approvers against one repository, and each
   * call otherwise re-reads CODEOWNERS from up to three paths - so ten candidates cost up to thirty
   * `getContent` calls for a file that cannot have changed between them, in a quota shared with the
   * reviewer running on the same repo.
   *
   * Keyed on owner/repo so a cache handed to two repositories cannot cross them, and holding the failure
   * too: `null` is a real answer here - it means the file was unreadable and `core.setFailed` has already
   * fired - and re-deriving it would repeat both the calls and the failure. Absent, nothing is cached and
   * the function behaves exactly as before, which is what keeps it callable from `action.yml` on its own.
   */
  const key = `${owner}/${repo}`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const answer = await readCodeownersUncached({ github, core, owner, repo });
  if (cache) cache[key] = answer;
  return answer;
}

async function readCodeownersUncached({ github, core, owner, repo }) {
  for (const path of SEARCH_PATHS) {
    let data;
    try {
      ({ data } = await github.rest.repos.getContent({ owner, repo, path }));
    } catch (err) {
      // 404 means this path has no CODEOWNERS, so try the next. A non-404 status (permission,
      // rate limit, server error) is not a missing file; surface it so maintainers fix the
      // credential or API, not the file.
      if (err.status === 404) continue;
      core.setFailed(unreadable(`Cannot read ${path} from ${owner}/${repo}`, err, 'contents:read'));
      return null;
    }
    // An array is a directory listing; a non-base64 encoding means the API declined to inline the
    // content (oversized file, symlink, submodule). Either way the owners went unread, so fail
    // instead of parsing '' and denying everyone.
    if (Array.isArray(data) || data.encoding !== 'base64') {
      core.setFailed(`${path} in ${owner}/${repo} is not an inline file payload, so its owners cannot be read`);
      return null;
    }
    return { content: Buffer.from(data.content, 'base64').toString('utf-8'), source: path };
  }
  core.setOutput?.('owners', 'absent');
  core.warning(
    `CODEOWNERS not found in ${owner}/${repo} at ${SEARCH_PATHS.join(', ')}, so it has no code owners and ` +
      'nobody is authorized by ownership. Add one to the default branch',
  );
  return null;
}

async function writeAccessLevel({ github, owner, repo, username, cache }) {
  const key = `write:${owner}/${repo}->${username}`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const answer = await writeAccessLevelUncached({ github, owner, repo, username });
  if (cache) cache[key] = answer;
  return answer;
}

async function writeAccessLevelUncached({ github, owner, repo, username }) {
  let data;
  try {
    ({ data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username }));
  } catch (err) {
    if (err.status === 404) return Object.freeze({ access: 'no-write', collaborator: false });
    return Object.freeze({ access: 'unknown', error: err });
  }

  // `user.permissions.push` is the authority whenever it is present: true for write, maintain and
  // admin alike, and the only signal that survives a custom org role. The top-level `permission`
  // string is the legacy vocabulary - `admin`/`write`/`read`/`none` - so it never says "push" and
  // collapses maintain into write. Testing it for "push" authorized admins only, which is the bug
  // this replaces.
  //
  // Deciding on presence rather than on truthiness is deliberate: falling through on an explicit
  // `push: false` would let the legacy string grant what the booleans just denied, and a security
  // boundary has to resolve a disagreement between two signals by denying.
  const granular = data.user?.permissions;
  const permitted = granular
    ? granular.push === true
    // The REST schema documents `user` as nullable, so the legacy string is the only signal left
    // when it is absent. It accepts both vocabularies so no rename can silently deny every code
    // owner at once.
    : ['write', 'maintain', 'admin', 'push'].includes(data.permission);
  return Object.freeze({ access: permitted ? 'write' : 'no-write', collaborator: true, permission: data.permission });
}

/**
 * Confirms a CODEOWNERS match actually holds write access on the repository.
 *
 * Being named in CODEOWNERS is not the same as owning code. GitHub requires code owners to have
 * write permission and assigns a rule naming someone without it to nobody, but it does not remove
 * the line - so a departed employee, or a read-only collaborator added to a path rule, stays in
 * the file indefinitely. Without this check that stale name authorizes a `ksai-implement` run, which
 * pushes a branch and opens a PR with a contents:write token: read-only access laundered into
 * bot-mediated write.
 *
 * The bar is *effective* write, which stays deliberately wider than GitHub's own ownership rule in
 * one respect: GitHub requires "explicit write access to the repository", so write inherited from an
 * organization base permission counts here where GitHub would credit no ownership. That is left wide
 * on purpose - anyone with effective write can already push to the repo directly, so denying them a
 * bot-mediated write adds friction without removing a capability. Team-level write, by contrast, is
 * verified: see `teamHasWriteAccess`.
 *
 * @returns {Promise<boolean>} false unless the login is confirmed to hold write access, with
 *   `core.setFailed` already called when the answer could not be determined.
 */
async function hasWriteAccess({ github, core, owner, repo, username, rawUsername, cache }) {
  const { access, collaborator, permission, error } = await writeAccessLevel({ github, owner, repo, username, cache });
  if (access === 'write') return true;
  if (access === 'unknown') {
    core.setFailed(unreadable(`Cannot read ${rawUsername}'s permission on ${owner}/${repo}`, error, 'metadata:read'));
    return false;
  }
  core.warning(
    collaborator
      ? `${rawUsername} is named in CODEOWNERS but has '${permission}' access on ${owner}/${repo}, not write, so GitHub assigns them no ownership`
      : `${rawUsername} is named in CODEOWNERS but is not a collaborator on ${owner}/${repo}`,
  );
  return false;
}

/**
 * Confirms a code owner team holds write access on the repository itself.
 *
 * GitHub is explicit that team membership alone does not make a team's rule apply: "When the code
 * owner is a team, that team must be visible and it must have write permissions, even if all the
 * individual members of the team already have write permissions directly, through organization
 * membership, or through another team membership." So a read-only team named on a path rule owns
 * nothing, and honouring it credits ownership GitHub does not recognise.
 *
 * Denials are warnings, not info: on a CODEOWNERS naming only teams, losing a team's grant turns
 * every `/ksai` into a green no-op, and an unannotated log line inside a collapsed step is not a
 * trace anyone finds. The individual path warns for the same class of misconfiguration.
 *
 * @returns {Promise<{ access: 'write'|'no-write'|'unknown', reason?: string }>} `unknown` when the
 *   level could not be read, carrying the reason so the caller reports it rather than guessing.
 */
async function teamHasWriteAccess({ github, core, org, slug, owner, repo, raw, cache }) {
  /*
   * Cached on the same caller-owned object as the CODEOWNERS read, and for the same reason one step
   * further on. That cache stopped one call short: the content is read once per approval loop now, but the
   * team verdict is not, so ten approving comments re-asked GitHub up to ten times whether the same team
   * holds write on the same repository - and each of those is a second call after the membership check.
   *
   * Keyed on org/slug/owner/repo, all four, because the answer is about one team's access to one
   * repository. Namespaced apart from the content keys so the two cannot collide on a repo named like a
   * team. The failure verdict is cached too: an `unknown` is a permission the token does not hold, which
   * re-asking cannot change within a run.
   */
  const key = `team:${org}/${slug}->${owner}/${repo}`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const answer = await teamHasWriteAccessUncached({ github, core, org, slug, owner, repo, raw });
  if (cache) cache[key] = answer;
  return answer;
}

async function teamHasWriteAccessUncached({ github, core, org, slug, owner, repo, raw }) {
  let data;
  try {
    ({ data } = await github.rest.teams.checkPermissionsForRepoInOrg({
      org,
      team_slug: slug,
      owner,
      repo,
      // Required: without this media type the endpoint answers 204 with an empty body when the team
      // has access, so the level reads as unknown and every team-based owner is reported unresolved.
      headers: { accept: 'application/vnd.github.v3.repository+json' },
    }));
  } catch (err) {
    // 404 here is documented as "team does not have permission". The repo is known to be visible -
    // its CODEOWNERS was just read with this same client - and an installation token missing a
    // permission returns 403, which falls through to `unknown` rather than being read as a denial.
    if (err.status === 404) {
      core.warning(`${raw} has no access to ${owner}/${repo}, so its CODEOWNERS rules own nothing`);
      return Object.freeze({ access: 'no-write' });
    }
    return Object.freeze({ access: 'unknown', reason: err.status ? `${err.status} ${err.message}` : err.message });
  }
  const push = data?.permissions?.push;
  if (push === true) return Object.freeze({ access: 'write' });
  // A 204, or any body without the permissions object, leaves the level genuinely unread. Guessing
  // write would credit ownership GitHub may not grant; guessing read-only would deny a real owner.
  if (push === undefined) {
    return Object.freeze({ access: 'unknown', reason: 'no permissions object in the response' });
  }
  core.warning(`${raw} has read-only access to ${owner}/${repo}, so its CODEOWNERS rules own nothing`);
  return Object.freeze({ access: 'no-write' });
}

/**
 * authorize answers whether `username` is authorized by CODEOWNERS on `owner`/`repo`. `github`
 * needs contents:read and, for team entries, org Members:read. Callers must still surface
 * `core.setFailed` - a `false` from an undecidable check is not the same as a denial.
 */
module.exports = async function authorize({ github, core, owner, repo, username: rawUsername, cache }) {
  if (!rawUsername) {
    core.setFailed('username input is required and must not be empty');
    return false;
  }
  // GitHub logins are case-insensitive but not stored in a fixed case, so a CODEOWNERS entry
  // and the actor's login can differ only in case and still be the same account.
  const username = rawUsername.toLowerCase();

  const found = await readCodeowners({ github, core, owner, repo, cache });
  if (!found) return false;
  const { content, source } = found;

  const { users, teams, ignored, skipped } = parseCodeowners(content);
  core.info(`Parsed ${source}: ${users.size} @user entries, ${teams.length} @org/team entries`);
  for (const token of ignored) {
    core.warning(`Ignoring ${token} in ${source}: not a valid @user or @org/team`);
  }
  for (const line of skipped) {
    core.warning(`Skipping invalid CODEOWNERS line in ${source}, as GitHub does: ${line}`);
  }

  if (users.has(username)) {
    core.info(`${rawUsername} is named directly in ${source}`);
    return hasWriteAccess({ github, core, owner, repo, username, rawUsername, cache });
  }

  // An unreadable team does not abort the loop - every rule's teams are in scope, so one stale
  // entry must not stop the remaining teams from authorizing a real owner.
  const unresolved = [];
  const repoOrg = owner.toLowerCase();
  for (const { org, slug, raw } of teams) {
    // GitHub only honours teams in the repository's own org, so a foreign-org entry owns
    // nothing here. Skipping it quietly keeps a broken CODEOWNERS line from turning every
    // unauthorized comment into a red workflow.
    if (org.toLowerCase() !== repoOrg) {
      core.info(`Skipping ${raw}: not a team in ${owner}`);
      continue;
    }
    try {
      const { data } = await github.rest.teams.getMembershipForUserInOrg({ org, team_slug: slug, username });
      if (data.state === 'active') {
        core.info(`${rawUsername} is an active member of ${raw}`);
        // Membership is only half of it - the team must hold write on the repo for its rules to
        // apply. Checked here rather than up front so it costs a call only on a path that would
        // otherwise authorize, and a team that owns nothing does not stop a later one from
        // authorizing a real owner.
        const { access, reason } = await teamHasWriteAccess({ github, core, org, slug, owner, repo, raw, cache });
        if (access === 'write') {
          return hasWriteAccess({ github, core, owner, repo, username, rawUsername, cache });
        }
        if (access === 'unknown') {
          // Membership is confirmed, so Members:read is demonstrably present - carry the status
          // through rather than leaving the summary to point at a grant that is not the problem.
          unresolved.push(`${raw} (membership confirmed, repo permission unreadable: ${reason})`);
        }
        continue;
      }
      // A reply at all proves the team is visible, so this is a real non-membership.
      core.info(`${rawUsername} membership in ${raw} is '${data.state}', not active`);
      continue;
    } catch (err) {
      if (err.status !== 404) {
        unresolved.push(`${raw} (membership check failed: ${err.status} ${err.message})`);
        continue;
      }
    }
    // Only a 404 is ambiguous: the user is not a member, or the token cannot see the team at all
    // (e.g. no org Members:read). Asking for the team second, rather than first, disambiguates
    // it just as well while costing an authorized member one request instead of two.
    try {
      await github.rest.teams.getByName({ org, team_slug: slug });
      core.info(`${rawUsername} is not a member of ${raw}`);
    } catch (err) {
      unresolved.push(`${raw} (team unreadable: ${err.status} ${err.message})`);
    }
  }

  if (unresolved.length) {
    // Deliberately does not assert one cause: a 404 on both lookups is equally a team that does
    // not exist (a CODEOWNERS typo) and one the token cannot see, and a non-404 is neither.
    core.setFailed(`Ownership through these teams is undetermined, so ${rawUsername} was neither authorized nor cleanly denied: ${unresolved.join('; ')}. A 404 means the team does not exist or github-token lacks org Members:read; any other status is an API or scope failure.`);
  }
  return false;
};

module.exports.writeAccess = async function writeAccess({ github, core, owner, repo, username: rawUsername, cache }) {
  if (!rawUsername) return '';
  const { access, error } = await writeAccessLevel({
    github,
    owner,
    repo,
    username: rawUsername.toLowerCase(),
    cache,
  });
  if (access === 'write') return 'true';
  if (access === 'no-write') return 'false';
  core.warning(unreadable(`Cannot read ${rawUsername}'s write access on ${owner}/${repo}`, error, 'metadata:read'));
  return '';
};
