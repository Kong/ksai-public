import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { marked } = require('./marker.cjs');
const { isThreadless, branchFor, provisionalTitle, renderPlaceholder } = require('./plan.cjs');
const { FLOW_BRANCH_SHAPE, safeEcho, gitVia } = require('./verify-chunk.cjs');
import { createPull, runCommand } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

function titleFrom(issueFile) {
  try {
    const parsed = JSON.parse(readFileSync(issueFile, 'utf8'));
    return typeof parsed?.title === 'string' ? parsed.title : '';
  } catch {
    return '';
  }
}

export function branchExists(run, repo, branch) {
  const standing = run('gh', ['api', `repos/${repo}/git/matching-refs/heads/${branch}`, '--jq', '.[].ref']);
  if (!standing.ok) return null;
  return String(standing.stdout)
    .split('\n')
    .map((line) => line.trim())
    .includes(`refs/heads/${branch}`);
}

export function nameBranch({ issueNumber = null, issueFile = null, jiraKey = null, jiraFile = null } = {}) {
  const { key, threadless } = isThreadless({ issueNumber, jiraKey });
  const title = titleFrom(threadless ? jiraFile : issueFile);
  const named = threadless ? key : `issue ${safeEcho(String(issueNumber))}`;
  const branch = branchFor({ issueNumber, title, jiraKey: key });
  if (!branch || !FLOW_BRANCH_SHAPE.test(branch)) return { key, threadless, title, named, branch: null };
  return { key, threadless, title, named, branch };
}

export function openDraft({
  cwd = null,
  issueNumber = null,
  issueFile = null,
  jiraKey = null,
  jiraSite = null,
  jiraFile = null,
  requestedBy = null,
  defaultBranch = null,
  triggerPhrase = null,
  repo = null,
  pushUrl = null,
  bodyFile = null,
  commitFile = null,
  run = runCommand,
} = {}) {
  const { key, threadless, title, named, branch } = nameBranch({ issueNumber, issueFile, jiraKey, jiraFile });
  const jira = key && jiraSite ? { key, site: jiraSite } : null;
  const block = (message) => ({ status: 'blocked', message });

  if (!branch) return block(`I could not name a branch for ${named}, so nothing was opened.`);

  const subject = provisionalTitle({ issueNumber, title, triggerPhrase, jiraKey: key });
  if (!subject) {
    return block(`I could not name a pull request for ${named}, so nothing was opened.`);
  }

  const rendered = renderPlaceholder({
    issueNumber: threadless ? null : Number(issueNumber),
    requestedBy,
    triggerPhrase,
    repository: repo,
    jira,
  });
  writeFileSync(bodyFile, rendered.body);

  const runGit = gitVia(run, cwd);
  const git = (...args) => runGit(args);

  const standing = branchExists(run, repo, branch);
  if (standing === null) {
    return block(
      `I could not check whether a branch named \`${branch}\` already exists, so nothing was opened rather ` +
        'than risk a second pull request for work that is already under way. Ask again, and if it keeps ' +
        'failing the token this flow runs with is missing `contents: read`',
    );
  }
  if (standing) {
    return openOn({ branch, repo, defaultBranch, subject, bodyFile, run, block, pushed: false });
  }

  if (!git('checkout', '-b', branch).ok) {
    return { fatal: `could not create the branch \`${branch}\` locally.` };
  }
  const commit = git(
    'commit',
    '--allow-empty',
    '-m',
    `chore(plan): start work on ${threadless ? key : `#${issueNumber}`}`,
    '-m',
    'The plan is written to a document on this branch. Each later commit completes one step.',
  );
  if (!commit.ok) return { fatal: 'could not create the first commit on the plan branch.' };

  const base = git('rev-parse', `origin/${defaultBranch}`);
  const tip = git('rev-parse', 'HEAD');
  if (!base.ok || !tip.ok) return { fatal: 'could not read the plan branch after committing on it.' };

  const published = publishCommit({
    cwd,
    repo,
    branch,
    remoteSha: String(base.stdout).trim(),
    createBranchAt: String(base.stdout).trim(),
    pushUrl,
    verifiedSha: String(tip.stdout).trim(),
    git: runGit,
    run,
    bodyFile: commitFile,
  });
  if (!published.ok) {
    return block(`The plan branch did not reach the remote: ${published.reason} - see the workflow run.`);
  }

  return openOn({ branch, repo, defaultBranch, subject, bodyFile, run, block });
}

function openOn({ branch, repo, defaultBranch, subject, bodyFile, run, block, pushed = true }) {
  const created = createPull({
    repo,
    base: defaultBranch,
    head: branch,
    title: subject,
    bodyFile,
    draft: true,
    run,
  });
  if (created.refused) {
    return block(
      pushed
        ? 'Opening the draft pull request failed (branch pushed, no pull request opened).'
        : `Opening the draft pull request failed on \`${branch}\`, which was already standing from an earlier run.`,
    );
  }
  const { prUrl, prNumber } = created;
  if (!prNumber) {
    return block(`The draft pull request was opened but its number could not be read back from \`${safeEcho(prUrl)}\`.`);
  }

  return {
    status: 'opened',
    branch,
    prUrl,
    prNumber,
    message: `Working on this in ${prUrl}. The plan is written to a document on that branch for a code owner to review, and every later update lands on that pull request.`,
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-open-draft.txt');

  const result = openDraft({
    cwd: env.GITHUB_WORKSPACE,
    issueNumber: env.ISSUE_NUM,
    issueFile: env.ISSUE_FILE,
    jiraKey: env.JIRA_KEY,
    jiraSite: env.JIRA_SITE,
    jiraFile: env.JIRA_FILE,
    requestedBy: env.REQUESTER,
    defaultBranch: env.DEFAULT_BRANCH,
    triggerPhrase: env.TRIGGER,
    repo: env.REPO,
    pushUrl: env.PUSH_URL,
    bodyFile: path.join(tmp, 'ksai-placeholder-body.md'),
    commitFile: path.join(tmp, 'ksai-open-commit.json'),
    run,
  });

  if (result.fatal) {
    process.stderr.write(`${result.fatal}\n`);
    return 1;
  }

  writeFileSync(
    messageFile,
    marked(result.message, {
      kind: result.status === 'opened' ? 'pr-opened' : 'plan-blocked',
      flow: 'implement',
      issue: env.ISSUE_NUM,
      pr: result.prNumber,
      run: env.RUN_ID,
      triggerPhrase: env.TRIGGER,
    }),
  );
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    branch: result.branch,
    pr_url: result.prUrl,
    pr_number: result.prNumber,
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
