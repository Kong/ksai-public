'use strict';

const { NUMBER_SHAPE } = require('./context.cjs');
const { heldBy } = require('./plan.cjs');
const { matchesBranchGrammar } = require('./verify-chunk.cjs');

const DEFAULT_NOUN = 'branch to work on';

const MERGEABLE_TRIES = 6;

const MERGEABLE_WAIT_MS = 3000;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function resolvePullTarget({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  noun: wanted = null,
  awaitMergeable = false,
  sleep = wait,
} = {}) {
  const noun = (typeof wanted === 'string' ? wanted.trim() : '') || DEFAULT_NOUN;
  if (!github?.rest) return { error: 'no authenticated GitHub client was passed' };
  const number = String(prNumber ?? '');
  if (!NUMBER_SHAPE.test(number)) return { error: `\`${number}\` is not a pull request number` };

  let pull;
  for (let attempt = 0; attempt < (awaitMergeable === true ? MERGEABLE_TRIES : 1); attempt += 1) {
    if (attempt > 0) await sleep(MERGEABLE_WAIT_MS);
    try {
      ({ data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: Number(number) }));
    } catch (error) {
      const status = error?.status ?? 0;
      return {
        error:
          status === 404
            ? `${owner}/${repo}#${number} is not a pull request, so it has no ${noun}`
            : `could not read ${owner}/${repo}#${number}: ${error.message}`,
      };
    }
    if (pull?.mergeable === true || pull?.mergeable === false) break;
  }
  if (awaitMergeable === true && pull?.mergeable !== true && pull?.mergeable !== false) {
    core?.warning?.(
      `#${number} reports no merge state after ${MERGEABLE_TRIES} reads, so this run treats it as an ordinary ` +
        'branch. GitHub computes that in the background and a later request will see it.',
    );
  }

  if (pull?.state !== 'open') {
    return { error: `${owner}/${repo}#${number} is ${pull?.merged ? 'merged' : String(pull?.state ?? 'unreadable')}, so nothing is pushed to it` };
  }

  const headRepo = pull?.head?.repo?.full_name ?? null;
  const baseRepo = pull?.base?.repo?.full_name ?? `${owner}/${repo}`;
  if (headRepo === null || headRepo.toLowerCase() !== String(baseRepo).toLowerCase()) {
    return {
      error:
        `#${number} is from ${headRepo === null ? 'a fork that no longer exists' : `\`${headRepo}\``}, and this ` +
        `runs with an installation token on \`${baseRepo}\` alone, so it cannot push to the branch. A ` +
        'maintainer can push the branch into this repository and re-request there.',
    };
  }

  const ref = String(pull?.head?.ref ?? '');
  if (!ref) return { error: `#${number} reports no head branch, so there is nothing to check out` };
  const candidateBase = String(pull?.base?.ref ?? '');
  const baseRef = matchesBranchGrammar(candidateBase, 'human-named') ? candidateBase : '';
  if (candidateBase && !baseRef) {
    core?.warning?.(
      `#${number} reports a base branch this flow will not put in a command line, so the prompt will not name ` +
        'a diff base. The run continues without one.',
    );
  }

  return {
    ref,
    baseRef,
    prNumber: Number(number),
    reportedHeadSha: String(pull?.head?.sha ?? ''),
    held: heldBy(pull?.body) ?? '',
    mergeable: pull?.mergeable === true || pull?.mergeable === false ? pull.mergeable : null,
  };
}

module.exports = {
  DEFAULT_NOUN,
  MERGEABLE_TRIES,
  MERGEABLE_WAIT_MS,
  resolvePullTarget,
};
