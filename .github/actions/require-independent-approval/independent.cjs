const CO_AUTHOR_LINE = /^co-authored-by:\s*[^<]*<([^>]+)>\s*$/i;
const RELEASED_BY_LINE = /^released-by:\s*\S/i;
const RUN_LINE = /^ksai-run:\s*https:\/\/\S+$/i;
const NOREPLY = /^(?:(\d+)\+)?([A-Za-z0-9-[\]]+)@users\.noreply\.github\.com$/i;
const BOT_LOGIN = /\[bot\]$/i;
const DECIDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const MAX_DESCRIPTION = 140;
const STATUS_CONTEXT = 'KSAI / independent approval';
const LEGACY_STATUS_CONTEXT = 'KSAI / hold';
const SHA = /^[0-9a-f]{40}$/i;
const ACTIONS_LOGIN = 'github-actions';

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

function claimsRelease(message) {
  return String(message ?? '')
    .split('\n')
    .some((line) => RELEASED_BY_LINE.test(line.trim()));
}

function publishedByApp(entry) {
  return (
    entry?.author?.type === 'Bot' &&
    entry?.committer?.type === 'Bot' &&
    entry?.commit?.verification?.verified === true
  );
}

function appLogin(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(BOT_LOGIN, '');
}

function madeAsPerson(entry, ours) {
  const message = String(entry?.commit?.message ?? '');
  return (
    entry?.commit?.verification?.verified === true &&
    message.split('\n').some((line) => RUN_LINE.test(line.trim())) &&
    coAuthorsOf(message).some((co) => co.login && appLogin(co.login) === ours)
  );
}

function contributorsOf({ pull, commits, botLogin }) {
  const logins = new Set();
  const ids = new Set();
  const unresolved = new Set();
  let involved = false;

  const add = (login, id) => {
    if (login) logins.add(String(login).toLowerCase());
    if (Number.isInteger(id)) ids.add(id);
  };

  const ours = appLogin(botLogin);
  const published = new Set();

  add(pull?.user?.login, pull?.user?.id);

  for (const entry of commits ?? []) {
    if ((entry?.parents?.length ?? 1) > 1) continue;
    if (entry?.author?.login) add(entry.author.login, entry.author.id);
    else unresolved.add(String(entry?.commit?.author?.email ?? '(a commit author with no email)'));
    if (!publishedByApp(entry)) {
      if (ours && madeAsPerson(entry, ours)) involved = true;
      continue;
    }
    const trailers = coAuthorsOf(entry?.commit?.message);
    const credited = trailers.length > 0 || claimsRelease(entry?.commit?.message);
    const wrote = appLogin(entry.author?.login);
    if (wrote) published.add(wrote);
    if (ours && wrote === ours) involved = true;
    else if (credited && (!ours || wrote === ACTIONS_LOGIN)) involved = true;
    for (const co of trailers) {
      if (co.login) add(co.login, co.id);
      else unresolved.add(co.email);
    }
  }

  const people = [...logins].filter((login) => !BOT_LOGIN.test(login)).sort();

  return { logins, ids, unresolved: [...unresolved].sort(), people, involved, published, ours };
}

function privilegedContributorsOf({ pull, commits, botLogin }) {
  const contributors = contributorsOf({ pull, commits, botLogin });
  for (const entry of commits ?? []) {
    for (const [identity, email, label] of [
      [entry?.author, entry?.commit?.author?.email, 'author'],
      [entry?.committer, entry?.commit?.committer?.email, 'committer'],
    ]) {
      if (identity?.login) {
        contributors.logins.add(String(identity.login).toLowerCase());
        if (Number.isInteger(identity.id)) contributors.ids.add(identity.id);
      } else {
        contributors.unresolved.push(String(email ?? `(a commit ${label} with no email)`));
      }
    }
    for (const coAuthor of coAuthorsOf(entry?.commit?.message)) {
      if (coAuthor.login) {
        contributors.logins.add(coAuthor.login);
        if (Number.isInteger(coAuthor.id)) contributors.ids.add(coAuthor.id);
      } else {
        contributors.unresolved.push(coAuthor.email);
      }
    }
  }
  contributors.unresolved = [...new Set(contributors.unresolved)].sort();
  contributors.people = [...contributors.logins].filter((login) => !BOT_LOGIN.test(login)).sort();
  return contributors;
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

function currentApprovalsOf(reviews, pull, contributors) {
  const latest = new Map();
  const ordered = [...(reviews ?? [])].sort((left, right) => {
    const byTime = Date.parse(left?.submitted_at ?? '') - Date.parse(right?.submitted_at ?? '');
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return Number(left?.id ?? 0) - Number(right?.id ?? 0);
  });
  for (const review of ordered) {
    const login = String(review?.user?.login ?? '').trim();
    const state = String(review?.state ?? '').toUpperCase();
    if (!login || !DECIDING.has(state)) continue;
    latest.set(login.toLowerCase(), review);
  }

  const head = String(pull?.head?.sha ?? '').toLowerCase();
  return [...latest.values()].filter((review) => {
    const login = String(review?.user?.login ?? '').toLowerCase();
    const id = review?.user?.id;
    const contributed =
      contributors.logins.has(login) || (Number.isInteger(id) && contributors.ids.has(id));
    return (
      String(review?.state ?? '').toUpperCase() === 'APPROVED' &&
      review?.user?.type !== 'Bot' &&
      String(review?.commit_id ?? '').toLowerCase() === head &&
      !contributed
    );
  });
}

function hasWriteAccess(data) {
  const granular = data?.user?.permissions;
  if (granular) return granular.push === true;
  return ['write', 'maintain', 'admin', 'push'].includes(String(data?.permission ?? '').toLowerCase());
}

async function writeApprovalsOf({ github, owner, repo, approvals }) {
  const checked = await Promise.all(
    approvals.map(async (review) => {
      const username = review.user.login;
      try {
        const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
        return hasWriteAccess(data) ? review : null;
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw new Error(`GitHub could not verify ${username}'s repository permission: ${error.message}`, {
          cause: error,
        });
      }
    }),
  );
  return checked.filter(Boolean);
}

function publisherClaimsOf(commits, botLogin) {
  const ours = appLogin(botLogin);
  return (commits ?? []).filter((entry) => {
    if ((entry?.parents?.length ?? 1) > 1 || entry?.author?.type !== 'Bot') return false;
    const wrote = appLogin(entry?.author?.login);
    const attributed = coAuthorsOf(entry?.commit?.message).length > 0 || claimsRelease(entry?.commit?.message);
    return ours ? wrote === ours || (wrote === ACTIONS_LOGIN && attributed) : attributed;
  });
}

async function publisherProvenanceOf({ github, owner, repo, commits, botLogin }) {
  const claims = publisherClaimsOf(commits, botLogin);
  const checked = await Promise.all(
    claims.map(async (entry) => {
      if (entry?.commit?.verification?.verified !== true || !SHA.test(String(entry?.sha ?? ''))) return false;
      const login = String(entry.author.login);
      const actorId = entry.author.id;
      const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
        owner,
        repo,
        actor: login,
        head_sha: entry.sha,
        per_page: 100,
      });
      return runs.some(
        (workflowRun) =>
          workflowRun?.event === 'pull_request' &&
          workflowRun?.actor?.type === 'Bot' &&
          appLogin(workflowRun?.actor?.login) === appLogin(login) &&
          (!Number.isInteger(actorId) || workflowRun?.actor?.id === actorId) &&
          workflowRun?.triggering_actor?.type === 'Bot' &&
          appLogin(workflowRun?.triggering_actor?.login) === appLogin(login) &&
          (!Number.isInteger(actorId) || workflowRun?.triggering_actor?.id === actorId) &&
          String(workflowRun?.head_sha ?? '').toLowerCase() === String(entry.sha).toLowerCase() &&
          String(workflowRun?.head_repository?.full_name ?? '').toLowerCase() === `${owner}/${repo}`.toLowerCase(),
      );
    }),
  );
  return {
    claims,
    trusted: claims.filter((_, index) => checked[index]),
    untrusted: claims.filter((_, index) => !checked[index]),
  };
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

function verdictOf({ required, declared, own, independent, unresolved, people, involved }) {
  if (typeof involved !== 'boolean') {
    throw new TypeError(
      'verdictOf was handed no `involved`, and an absent one reads as a pull request this flow never wrote, which is the verdict that holds nothing',
    );
  }
  if (!involved) {
    return {
      state: 'success',
      description: "KSAI wrote no commit here, so it holds nobody and the base branch's own approval rules decide alone",
      dismissable: [],
    };
  }
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

async function run({ github, core, owner, repo, prNumber, headSha, targetUrl, botLogin }) {
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

    const contributors = contributorsOf({ pull, commits, botLogin });
    const { required, declared } = requiredCountOf(rules);
    const split = splitApprovals(approvalsOf(reviews), contributors);
    verdict = verdictOf({
      required,
      declared,
      own: split.own,
      independent: split.independent,
      unresolved: contributors.unresolved,
      people: contributors.people,
      involved: contributors.involved,
    });
    if (contributors.ours && contributors.published.size && !contributors.published.has(contributors.ours)) {
      core.warning(
        `bot-login names ${contributors.ours} and every App-published commit on #${prNumber} is by ` +
          `${[...contributors.published].sort().join(', ')}. A login naming no App on this pull request ` +
          'holds nothing here, so check it against the App this repository runs KSAI as',
      );
    }
    for (const email of contributors.involved ? contributors.unresolved : []) {
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

async function runPrivileged({ github, core, owner, repo, prNumber, headSha, botLogin }) {
  const requestedSha = String(headSha ?? '').toLowerCase();
  let hasGeneratedCommit = false;
  const setOutputs = ({ generated = false, privileged = false, head = requestedSha, approvedBy = [] } = {}) => {
    core.setOutput('generated', String(generated));
    core.setOutput('privileged', String(privileged));
    core.setOutput('head-sha', head);
    core.setOutput('approved-by', approvedBy.join(','));
  };
  setOutputs();

  if (!SHA.test(requestedSha) || !Number.isInteger(prNumber) || prNumber < 1) {
    core.setFailed(
      `the privileged-CI gate was called with pr-number ${JSON.stringify(prNumber)} and head-sha ${JSON.stringify(headSha)}; both are required`,
    );
    return { state: 'failure', generated: false, privileged: false };
  }

  try {
    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const liveSha = String(pull?.head?.sha ?? '').toLowerCase();
    if (!SHA.test(liveSha)) throw new Error('GitHub returned an unreadable pull request head sha');
    if (liveSha !== requestedSha) throw new Error(`#${prNumber} is now at ${liveSha}, not the event head ${requestedSha}`);
    if (String(pull?.head?.repo?.full_name ?? '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new Error(`#${prNumber} comes from another repository, so privileged CI is unavailable`);
    }

    const [commits, reviews] = await Promise.all([
      github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: prNumber, per_page: 100 }),
      github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
    ]);
    const claimed = Number(pull.commits);
    if (Number.isInteger(claimed) && commits.length !== claimed) {
      throw new Error(`#${prNumber} has ${claimed} commits and the list endpoint returned ${commits.length}`);
    }

    const { data: confirmed } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const confirmedSha = String(confirmed?.head?.sha ?? '').toLowerCase();
    if (confirmedSha !== requestedSha) throw new Error(`#${prNumber} moved to ${confirmedSha || '(unreadable)'} while the gate read it`);
    if (String(confirmed?.base?.ref ?? '') !== String(pull?.base?.ref ?? '')) {
      throw new Error(`#${prNumber} changed its base branch while the gate read it`);
    }
    if (String(confirmed?.head?.repo?.full_name ?? '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new Error(`#${prNumber} no longer comes from this repository`);
    }

    const provenance = await publisherProvenanceOf({ github, owner, repo, commits, botLogin });
    hasGeneratedCommit = provenance.trusted.length > 0;
    setOutputs({ generated: hasGeneratedCommit, head: requestedSha });
    if (provenance.untrusted.length) {
      throw new Error(
        `${provenance.untrusted.length} commit${provenance.untrusted.length === 1 ? '' : 's'} claim KSAI publisher identity without verified App and run provenance`,
      );
    }
    const contributors = privilegedContributorsOf({ pull: confirmed, commits, botLogin });
    if (contributors.unresolved.length) {
      throw new Error(
        `${contributors.unresolved.length} contributor${contributors.unresolved.length === 1 ? '' : 's'} cannot be resolved to a GitHub account`,
      );
    }

    const candidates = currentApprovalsOf(reviews, confirmed, contributors);
    const approvals = await writeApprovalsOf({ github, owner, repo, approvals: candidates });
    if (!approvals.length) {
      const kind = hasGeneratedCommit ? 'KSAI-generated' : 'candidate';
      throw new Error(`${kind} head ${requestedSha} needs a current trusted approval from a non-contributor`);
    }

    const approvedBy = approvals.map((review) => review.user.login);
    setOutputs({ generated: hasGeneratedCommit, privileged: true, head: requestedSha, approvedBy });
    core.info(`#${prNumber} at ${requestedSha} may start privileged CI; approved by ${approvedBy.join(', ')}`);
    return { state: 'success', generated: hasGeneratedCommit, privileged: true, headSha: requestedSha, approvedBy };
  } catch (error) {
    core.setFailed(`privileged CI remains held: ${error.message}`);
    return { state: 'failure', generated: hasGeneratedCommit, privileged: false };
  }
}

module.exports = {
  STATUS_CONTEXT,
  LEGACY_STATUS_CONTEXT,
  DECIDING,
  coAuthorsOf,
  contributorsOf,
  privilegedContributorsOf,
  approvalsOf,
  currentApprovalsOf,
  hasWriteAccess,
  writeApprovalsOf,
  publisherClaimsOf,
  publisherProvenanceOf,
  requiredCountOf,
  statusContextsOf,
  splitApprovals,
  verdictOf,
  run,
  runPrivileged,
};
