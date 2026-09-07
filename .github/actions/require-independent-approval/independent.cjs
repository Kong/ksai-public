const CO_AUTHOR_LINE = /^co-authored-by:\s*[^<]*<([^>]+)>\s*$/i;
const NOREPLY = /^(?:(\d+)\+)?([A-Za-z0-9-[\]]+)@users\.noreply\.github\.com$/i;
const BOT_LOGIN = /\[bot\]$/i;
const DECIDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const MAX_DESCRIPTION = 140;
const STATUS_CONTEXT = 'KSAI / independent approval';
const LEGACY_STATUS_CONTEXT = 'KSAI / hold';
const SHA = /^[0-9a-f]{40}$/i;

function coAuthorsOf(message) {
  const found = [];
  for (const line of String(message ?? '').split('\n')) {
    const trailer = CO_AUTHOR_LINE.exec(line.trim());
    if (!trailer) continue;
    const email = trailer[1].trim();
    const parts = NOREPLY.exec(email);
    found.push(
      parts
        ? { login: parts[2].toLowerCase(), id: parts[1] ? Number(parts[1]) : null, email }
        : { login: null, id: null, email },
    );
  }
  return found;
}

function publishedByApp(entry) {
  return (
    entry?.author?.type === 'Bot' &&
    entry?.committer?.type === 'Bot' &&
    entry?.commit?.verification?.verified === true
  );
}

function contributorsOf({ pull, commits }) {
  const logins = new Set();
  const ids = new Set();
  const unresolved = new Set();

  const add = (login, id) => {
    if (login) logins.add(String(login).toLowerCase());
    if (Number.isInteger(id)) ids.add(id);
  };

  add(pull?.user?.login, pull?.user?.id);

  for (const entry of commits ?? []) {
    if ((entry?.parents?.length ?? 1) > 1) continue;
    if (entry?.author?.login) add(entry.author.login, entry.author.id);
    else unresolved.add(String(entry?.commit?.author?.email ?? '(a commit author with no email)'));
    if (!publishedByApp(entry)) continue;
    for (const co of coAuthorsOf(entry?.commit?.message)) {
      if (co.login) add(co.login, co.id);
      else unresolved.add(co.email);
    }
  }

  const people = [...logins].filter((login) => !BOT_LOGIN.test(login)).sort();

  return { logins, ids, unresolved: [...unresolved].sort(), people };
}

function approvalsOf(reviews) {
  const latest = new Map();
  for (const review of reviews ?? []) {
    const login = review?.user?.login;
    const state = String(review?.state ?? '');
    if (!login || review.user?.type === 'Bot' || !DECIDING.has(state)) continue;
    latest.set(login.toLowerCase(), { login, id: review.user?.id ?? null, state, review: review.id });
  }
  return [...latest.values()].filter((entry) => entry.state === 'APPROVED');
}

function requiredCountOf(rules) {
  let required = 0;
  let declared = false;
  for (const rule of rules ?? []) {
    if (rule?.type !== 'pull_request') continue;
    declared = true;
    const count = Number(rule?.parameters?.required_approving_review_count);
    if (Number.isInteger(count) && count > required) required = count;
  }
  return { required, declared };
}

function statusContextsOf(rules) {
  const required = new Set();
  for (const rule of rules ?? []) {
    if (rule?.type !== 'required_status_checks') continue;
    const checks = rule?.parameters?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      required.add(String(check?.context ?? ''));
    }
  }
  if (required.has(STATUS_CONTEXT) && required.has(LEGACY_STATUS_CONTEXT)) {
    return [STATUS_CONTEXT, LEGACY_STATUS_CONTEXT];
  }
  if (required.has(LEGACY_STATUS_CONTEXT)) return [LEGACY_STATUS_CONTEXT];
  return [STATUS_CONTEXT];
}

function splitApprovals(approvals, contributors) {
  const own = [];
  const independent = [];
  for (const approval of approvals) {
    const named =
      contributors.logins.has(String(approval.login).toLowerCase()) ||
      (Number.isInteger(approval.id) && contributors.ids.has(approval.id));
    (named ? own : independent).push(approval);
  }
  return { own, independent };
}

function countOf(number) {
  return `${number} independent approval${number === 1 ? '' : 's'}`;
}

function blameOf({ own, people, unresolved }) {
  if (own.length) return `; ${own.map((entry) => entry.login).join(', ')} contributed to this pull request`;
  if (people.length || unresolved.length) return '';
  return "; every commit here is a bot's, so this is only waiting for a person to approve";
}

function verdictOf({ required, declared, own, independent, unresolved, people }) {
  const note = unresolved.length ? ` (${unresolved.length} contributors GitHub resolved to no account)` : '';
  if (required === 0) {
    return {
      state: 'success',
      description: declared
        ? `the base branch ruleset requires no approvals, so there is nothing to hold${note}`
        : `no ruleset on the base branch declares an approval count, so this checked nothing${note}`,
      dismissable: own,
    };
  }
  if (independent.length >= required) {
    return {
      state: 'success',
      description: `has ${countOf(independent.length)}, needs ${required}${note}`,
      dismissable: own,
    };
  }
  const said = `needs ${countOf(required)}, has ${independent.length}`;
  return { state: 'pending', description: said + blameOf({ own, people, unresolved }) + note, dismissable: own };
}

function unreadable(error, prNumber) {
  const status = Number(error?.status);
  if (!Number.isInteger(status)) return `this gate could not read #${prNumber}: ${error.message}`;
  if (status >= 500) return `GitHub answered ${status} reading #${prNumber}, so this is worth re-running`;
  return `this gate reads #${prNumber} with contents:read, pull-requests:write and statuses:write, and GitHub answered ${status}: ${error.message}`;
}

async function run({ github, core, owner, repo, prNumber, headSha, targetUrl }) {
  let sha = String(headSha ?? '');
  let statusContexts = [STATUS_CONTEXT, LEGACY_STATUS_CONTEXT];
  if (!SHA.test(sha) || !Number.isInteger(prNumber) || prNumber < 1) {
    core.setFailed(
      `this gate was called with pr-number ${JSON.stringify(prNumber)} and head-sha ${JSON.stringify(sha)}. Both are required, and an empty input overrides a default rather than falling back to one, so nothing was read and no status was written`,
    );
    return { state: 'failure' };
  }

  const report = async (state, description) => {
    for (const context of statusContexts) {
      await github.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        context,
        description: description.slice(0, MAX_DESCRIPTION),
        target_url: targetUrl,
      });
    }
  };

  let verdict;
  try {
    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    sha = pull.head.sha;
    const rules = await github.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner,
      repo,
      branch: pull.base.ref,
      per_page: 100,
    });
    statusContexts = statusContextsOf(rules);
    if (statusContexts.length > 1) {
      core.warning(`the base branch requires both ${STATUS_CONTEXT} and ${LEGACY_STATUS_CONTEXT}, so this run must report both until that ruleset is migrated`);
    }
    const [commits, reviews] = await Promise.all([
      github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: prNumber, per_page: 100 }),
      github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
    ]);

    const claimed = Number(pull.commits);
    if (Number.isInteger(claimed) && commits.length !== claimed) {
      throw new Error(
        `#${prNumber} has ${claimed} commits and the list endpoint answered with ${commits.length}, so a contributor could be missing from a set this gate decides an approval on`,
      );
    }

    const contributors = contributorsOf({ pull, commits });
    const { required, declared } = requiredCountOf(rules);
    const split = splitApprovals(approvalsOf(reviews), contributors);
    verdict = verdictOf({
      required,
      declared,
      own: split.own,
      independent: split.independent,
      unresolved: contributors.unresolved,
      people: contributors.people,
    });
    for (const email of contributors.unresolved) {
      core.warning(`<${email}> contributed to #${prNumber} and GitHub resolves it to no account, so it is held against no reviewer. require_last_push_approval is what covers a contributor this gate cannot name`);
    }
    if (!declared) {
      core.warning(`no ruleset on ${pull.base.ref} declares an approval count, so this gate holds nothing. Classic branch protection is invisible to the rules endpoint, and a repository using it gets a green status that checked nothing`);
    }
  } catch (error) {
    await report('failure', unreadable(error, prNumber));
    core.setFailed(`the independent-approval gate could not resolve #${prNumber}: ${unreadable(error, prNumber)}`);
    return { state: 'failure' };
  }

  let refused = null;
  for (const approval of verdict.dismissable ?? []) {
    try {
      await github.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: approval.review,
        message: `Dismissed because ${approval.login} contributed to this pull request, as its author, a commit author or a co-author trailer. The approvals this branch requires have to come from somebody else.`,
      });
      core.notice(`dismissed the approval from ${approval.login}, who contributed to #${prNumber}`);
    } catch (error) {
      refused = `${approval.login}'s own approval could not be dismissed: ${error.message}`;
      core.warning(`${refused}. A code owner rule can still be satisfied by whoever asked for the work, so this reports failure`);
    }
  }

  if (refused) verdict = { state: 'failure', description: refused };

  await report(verdict.state, verdict.description);
  core.info(`#${prNumber} at ${sha}: ${verdict.state} - ${verdict.description}`);
  return verdict;
}

module.exports = {
  STATUS_CONTEXT,
  LEGACY_STATUS_CONTEXT,
  DECIDING,
  coAuthorsOf,
  contributorsOf,
  approvalsOf,
  requiredCountOf,
  statusContextsOf,
  splitApprovals,
  verdictOf,
  run,
};
