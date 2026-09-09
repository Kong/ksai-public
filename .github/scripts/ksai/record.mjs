
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { checkStep, oneLine, planDirOf, scrub, storedTitle } = require('./plan.cjs');
const { readCount } = require('./continue.cjs');
const { counted, plural } = require('../lib/text.cjs');
const { safeEcho, verifyChunk, gitVia, noChangeLeftBehind } = require('./verify-chunk.cjs');
import { blockerFor, field, readManifest, reasonOf, runCommand, shown } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function recordStep({
  manifestPath = null,
  cwd = null,
  branch = null,
  remoteSha = null,
  stepTitle = null,
  remaining = null,
  remainingSteps = null,
  prNumber = null,
  repo = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  triggerPhrase = null,
  bodyFile = null,
  commitFile = null,
  run = runCommand,
} = {}) {
  const block = blockerFor(manifestPath);

  const quoted = oneLine(stepTitle, { triggerPhrase });

  const read = readManifest(manifestPath, { noun: 'The step', triggerPhrase });
  if (read.message) return block(read.message);
  const manifest = read.manifest;

  const claimed = storedTitle(field(manifest?.step), { triggerPhrase });
  if (claimed && claimed !== quoted) {
    return block(
      `The step reported work on "${claimed}", but this run was given "${quoted}". Nothing was pushed and no ` +
        'box was ticked, because a report naming another step is not a report of this one.',
    );
  }

  const status = field(manifest?.status);
  let pushed;

  if (status === 'blocked') {
    return block(`Stopped on "${quoted}": ${scrub(reasonOf(manifest), { triggerPhrase }).trim()}`);
  }

  rmSync(manifestPath, { force: true });

  if (status === 'skipped') {
    const left = noChangeLeftBehind({ from: remoteSha, git: gitVia(run, cwd) });
    if (!left.ok) {
      return block(
        left.unreadable
          ? `I could not check whether "${quoted}" left work behind: ${left.reason}.`
          : `"${quoted}" reported that no change was needed, but ${left.reason}. That is a report contradicting ` +
            'the tree, so nothing was pushed and the box is left unticked. Re-request and it will start from a ' +
            'clean checkout.',
      );
    }
    pushed = false;
  } else if (status === 'done') {
    const verified = verifyChunk({ cwd, branch, remoteSha, manifestPath, deniedPaths, planDir });
    if (!verified.ok) return block(`I did not push "${quoted}": ${verified.reason}`);

    const published = publishCommit({
      cwd,
      repo,
      branch,
      remoteSha,
      pushUrl,
      verifiedSha: verified.sha,
      git: gitVia(run, cwd),
      run,
      bodyFile: commitFile ?? undefined,
    });
    if (!published.ok) {
      return block(
        `I did not put "${quoted}" on the branch: ${published.reason}. The box is left unticked, so a later run ` +
          'retries it.',
      );
    }
    pushed = true;
  } else {
    return block(`The step reported an unrecognized status: ${safeEcho(shown(manifest?.status))}`);
  }

  const view = run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body', '-q', '.body']);
  if (!view.ok) {
    return { fatal: 'could not read the pull request body, so no box was ticked.', pushed };
  }

  const flipped = checkStep(view.stdout, stepTitle, { triggerPhrase });
  if (flipped.error) {
    return block(
      `I pushed "${quoted}" but could not tick its box: ${flipped.error}. The commit is on the branch; a later run would try this step again.`,
    );
  }
  if (flipped.changed === false) {
    process.stderr.write(
      `Note: "${quoted}" was already ticked, so this step reported done twice. Carrying on to the next box.\n`,
    );
  }
  writeFileSync(bodyFile, flipped.body);

  if (!run('gh', ['pr', 'edit', String(prNumber), '--repo', repo, '--body-file', bodyFile]).ok) {
    return block(`I pushed "${quoted}" but could not update the plan. The commit is on the branch.`);
  }

  const before = readCount(remaining);
  if (!Number.isInteger(before)) {
    return { fatal: `the unticked-box count \`${safeEcho(remaining)}\` is not a number.`, pushed };
  }
  const remainingAfter = before - 1;
  const stepsBefore = readCount(remainingSteps);
  const stepsLeft = stepsBefore === null ? null : stepsBefore - 1;

  return {
    status: 'stepped',
    pushed,
    remaining: remainingAfter,
    boundary: stepsLeft === 0 && remainingAfter > 0,
    message: finishedMessage({ quoted, remainingAfter, stepsLeft }),
  };
}

function finishedMessage({ quoted, remainingAfter, stepsLeft }) {
  if (remainingAfter === 0) return `Finished the last step: "${quoted}". Every box in the plan is ticked.`;
  if (!Number.isInteger(stepsLeft)) {
    return `Finished "${quoted}". ${counted(remainingAfter, 'box', 'boxes')} ${plural(remainingAfter, 'remains', 'remain')}.`;
  }
  if (stepsLeft === 0) {
    return `Finished "${quoted}", the last step in this phase. The checkpoint below is next, and an approver releases it.`;
  }
  return `Finished "${quoted}". ${counted(stepsLeft, 'step')} ${plural(stepsLeft, 'remains', 'remain')}.`;
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-message.txt');

  const result = recordStep({
    manifestPath: env.MANIFEST,
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    remoteSha: env.REMOTE_SHA,
    stepTitle: env.STEP_TITLE,
    remaining: env.REMAINING,
    remainingSteps: env.REMAINING_STEPS,
    prNumber: env.PR_NUMBER,
    repo: env.REPO,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    triggerPhrase: env.TRIGGER,
    bodyFile: path.join(tmp, 'ksai-pr-body.md'),
    commitFile: path.join(tmp, 'ksai-commit.json'),
    run,
  });

  process.stdout.write(`pushed=${result.pushed ? 'true' : 'false'}\n`);

  if (result.fatal) {
    process.stderr.write(`${result.fatal}\n`);
    return 1;
  }

  const speaks = result.status !== 'stepped' || result.boundary === true;
  if (speaks) writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    remaining: result.remaining,
    message_file: speaks ? messageFile : '',
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
