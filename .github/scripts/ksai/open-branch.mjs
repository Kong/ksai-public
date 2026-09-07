import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { marked } = require('./marker.cjs');
const { gitVia } = require('./verify-chunk.cjs');
import { branchExists, nameBranch } from './open-draft.mjs';
import { runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function openBranch({ cwd = null, issueNumber = null, issueFile = null, repo = null, run = runCommand } = {}) {
  const { named, branch } = nameBranch({ issueNumber, issueFile });
  const block = (message) => ({ status: 'blocked', message });

  if (!branch) return block(`I could not name a branch for ${named}, so nothing was built.`);

  const standing = branchExists(run, repo, branch);
  if (standing === null) {
    return block(
      `I could not check whether a branch named \`${branch}\` already exists, so nothing was built rather than ` +
        'risk building over work that is already there. Ask again, and if it keeps failing the token this flow ' +
        'runs with is missing `contents: read`',
    );
  }
  if (standing) {
    return block(
      `A branch named \`${branch}\` already exists and no open pull request uses it, so nothing was built. ` +
        'Delete that branch, or reopen the pull request that used it',
    );
  }

  if (!gitVia(run, cwd)(['checkout', '-b', branch]).ok) {
    return { fatal: `could not create the branch \`${branch}\` locally.` };
  }
  return { status: 'branched', branch };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-open-branch.txt');

  const result = openBranch({
    cwd: env.GITHUB_WORKSPACE,
    issueNumber: env.ISSUE_NUM,
    issueFile: env.ISSUE_FILE,
    repo: env.REPO,
    run,
  });

  if (result.fatal) {
    process.stderr.write(`${result.fatal}\n`);
    return 1;
  }

  if (result.status === 'blocked') {
    writeFileSync(
      messageFile,
      marked(result.message, {
        kind: 'build-blocked',
        flow: 'implement',
        issue: env.ISSUE_NUM,
        run: env.RUN_ID,
        triggerPhrase: env.TRIGGER,
      }),
    );
    writeOutputs(env.GITHUB_OUTPUT, {
      status: result.status,
      message_file: messageFile,
    });
    process.stdout.write(`${result.message}\n`);
    return 0;
  }

  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    branch: result.branch,
  });
  process.stdout.write(`Building on \`${result.branch}\`.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
