import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const {
  linked,
  oneLine,
  planDirOf,
  pullUrl,
  renderDirectBody,
  scrub,
  shortenedNote,
} = require('./plan.cjs');
const { MAX_DIRECT_COMMITS, gitVia, safeEcho, verifyChunk } = require('./verify-chunk.cjs');
import { blockerFor, createPull, field, readManifest, reasonOf, runCommand, shown, subjectFrom } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function publishDirect({
  manifestPath = null,
  issueNumber = null,
  requestedBy = null,
  triggerPhrase = null,
  repo = null,
  bodyFile = null,
  serverUrl = null,
  defaultBranch = null,
  cwd = null,
  branch = null,
  baseSha = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  commitFile = null,
  run = runCommand,
} = {}) {
  const block = blockerFor(manifestPath);

  const read = readManifest(manifestPath, { noun: 'The run', triggerPhrase });
  if (read.message) return block(read.message);
  const manifest = read.manifest;

  const status = field(manifest?.status);
  if (!status) {
    const raw = shown(manifest?.status);
    if (!raw) return block('The run produced a manifest with no status.');
    return block(`The run produced an unrecognized status: ${safeEcho(raw)}`);
  }
  if (status === 'blocked') {
    return block(`The work was not finished: ${oneLine(reasonOf(manifest), { triggerPhrase })}`);
  }
  if (status !== 'done') return block(`The run produced an unrecognized status: ${safeEcho(status)}`);

  const subject = subjectFrom(manifest, { noun: 'The run', triggerPhrase });
  if (subject.blocker) return block(subject.blocker);
  const { title } = subject;

  const rendered = renderDirectBody({
    issueNumber: Number(issueNumber),
    requestedBy,
    summary: manifest?.summary,
    repository: repo,
    triggerPhrase,
  });

  rmSync(manifestPath, { force: true });

  const git = gitVia(run, cwd);
  const verified = verifyChunk({
    cwd,
    branch,
    remoteSha: baseSha,
    manifestPath,
    deniedPaths,
    planDir,
    maxCommits: MAX_DIRECT_COMMITS,
  });
  if (!verified.ok) return block(`I did not push this work: ${verified.reason}`);

  const published = publishCommit({
    cwd,
    repo,
    branch,
    remoteSha: baseSha,
    createBranchAt: baseSha,
    pushUrl,
    verifiedSha: verified.sha,
    git,
    run,
    bodyFile: commitFile ?? undefined,
  });
  if (!published.ok) {
    return block(`The work did not reach the remote: ${published.reason} - see the workflow run.`);
  }

  writeFileSync(bodyFile, rendered.body);
  const created = createPull({ repo, base: defaultBranch, head: branch, title, bodyFile, run });
  if (created.refused) {
    return block(`The work is pushed to \`${branch}\` and opening its pull request failed - see the workflow run.`);
  }
  const { prUrl, prNumber } = created;
  if (!prNumber) {
    return block(`The pull request was opened but its number could not be read back from \`${safeEcho(prUrl)}\`.`);
  }

  const at = pullUrl({ serverUrl, repository: repo, prNumber });
  return {
    status: 'built',
    prUrl: at || prUrl,
    prNumber,
    message: linked(
      scrub(
        'This was small enough to build without a plan, so the whole change is in [one pull request](LINK), ' +
          `open for review${shortenedNote(null, rendered.shortened)}`,
        { triggerPhrase },
      ),
      at || prUrl,
    ),
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-message.txt');

  const result = publishDirect({
    manifestPath: env.MANIFEST,
    issueNumber: env.ISSUE_NUM,
    requestedBy: env.REQUESTER,
    triggerPhrase: env.TRIGGER,
    repo: env.REPO,
    bodyFile: path.join(tmp, 'ksai-pr-body.md'),
    commitFile: path.join(tmp, 'ksai-direct-commit.json'),
    serverUrl: env.GITHUB_SERVER_URL,
    defaultBranch: env.DEFAULT_BRANCH,
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    baseSha: env.BASE_SHA,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    run,
  });

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    pr_url: result.prUrl ?? '',
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
