import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { planFilePathFor } = require('./plan.cjs');
const { gitVia, safeEcho, verifyChunk } = require('./verify-chunk.cjs');

import { runCommand } from './run.mjs';
import { alignToBranch, publishCommit } from './signed-push.mjs';

export function retirePlan({
  repo = null,
  branch = null,
  cwd = null,
  planDir = null,
  issueNumber = null,
  jiraKey = null,
  pushUrl = null,
  deniedPaths = null,
  manifestPath = null,
  commitFile = null,
  run = runCommand,
} = {}) {
  const planPath = planFilePathFor({ branch, dir: planDir });
  if (!planPath) {
    return { removed: false, reason: `no plan document can be named under \`${safeEcho(String(planDir ?? ''))}\`` };
  }

  const git = gitVia(run, cwd);
  const aligned = alignToBranch({ git, pushUrl, branch });
  if (!aligned.ok) return { removed: false, planPath, reason: `${aligned.reason}, so nothing was removed` };
  const remoteSha = aligned.sha;

  const staged = git(['rm', '--quiet', '--', planPath]);
  if (!staged.ok) {
    if (!git(['ls-files', '--error-unmatch', '--', planPath]).ok) {
      return { removed: false, planPath, absent: true, reason: `\`${planPath}\` is not on the branch` };
    }
    if (!git(['rm', '--quiet', '--force', '--', planPath]).ok) {
      return { removed: false, planPath, reason: `\`${planPath}\` is on the branch and could not be staged for removal` };
    }
  }

  const subject = jiraKey ? String(jiraKey) : `#${String(issueNumber)}`;
  const committed = git([
    'commit',
    '-m',
    `docs(plan): remove the plan document for ${subject}`,
    '-m',
    'The plan is done, and this repository is configured not to keep it.',
  ]);
  if (!committed.ok) {
    return { removed: false, planPath, reason: 'the removal could not be committed, so nothing was removed' };
  }

  const verified = verifyChunk({ cwd, branch, remoteSha, deniedPaths, manifestPath });
  if (!verified.ok) return { removed: false, planPath, reason: `the removal was refused: ${verified.reason}` };

  const published = publishCommit({
    cwd,
    repo,
    branch,
    remoteSha,
    pushUrl,
    verifiedSha: verified.sha,
    git,
    run,
    bodyFile: commitFile ?? undefined,
  });
  if (!published.ok) {
    return { removed: false, planPath, reason: `the removal did not reach the branch: ${published.reason}` };
  }

  return { removed: true, planPath, sha: published.sha };
}

export function main(env = process.env, { run = runCommand, log = console.log } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const result = retirePlan({
    repo: env.REPO,
    branch: env.BRANCH,
    cwd: env.GITHUB_WORKSPACE,
    planDir: env.PLAN_DIR,
    issueNumber: env.ISSUE_NUM,
    jiraKey: env.JIRA_KEY,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    manifestPath: env.MANIFEST,
    commitFile: path.join(tmp, 'ksai-retire-commit.json'),
    run,
  });

  if (result.removed) log(`removed ${result.planPath} in ${result.sha}`);
  else if (result.absent) log(`nothing to remove: ${result.reason}`);
  else log(`::warning::the plan document was left on the branch: ${result.reason}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
