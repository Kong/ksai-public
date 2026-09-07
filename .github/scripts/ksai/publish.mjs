import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { payloadFor, marked } = require('./marker.cjs');
const {
  carryRecords,
  linked,
  oneLine,
  parsePlanDocument,
  planFilePathFor,
  pullUrl,
  renderBody,
  planDocMarker,
  renderPlanWaiting,
  renderShape,
  requesterOf,
  scrub,
  shortenedNote,
} = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');
const { gitVia, safeEcho, verifyChunk } = require('./verify-chunk.cjs');
const { stagePaths } = require('./stage.cjs');
import { blockerFor, field, readManifest, reasonOf, runCommand, shown, subjectFrom, TITLE_KEY_POSITIONS } from './run.mjs';
import { alignToBranch, publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function publishPlan({
  manifestPath = null,
  prNumber = null,
  issueNumber = null,
  requestedBy = null,
  triggerPhrase = null,
  repo = null,
  bodyFile = null,
  jira = null,
  titleKey = null,
  serverUrl = null,
  marker = null,
  cwd = null,
  branch = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  commitFile = null,
  noun = 'Planning',
  run = runCommand,
} = {}) {
  const block = blockerFor(manifestPath);

  const number = String(prNumber ?? '');
  if (!NUMBER_SHAPE.test(number)) {
    return block(`There is no pull request to write this plan into (got \`${safeEcho(number)}\`).`);
  }

  const read = readManifest(manifestPath, { noun, triggerPhrase });
  if (read.message) return block(read.message);
  const manifest = read.manifest;

  const status = field(manifest?.status);
  if (!status) {
    const raw = shown(manifest?.status);
    if (!raw) return block(`${noun} produced a manifest with no status.`);
    return block(`${noun} produced an unrecognized status: ${safeEcho(raw)}`);
  }
  if (status === 'blocked') {
    return block(`${noun} stopped without writing a plan: ${oneLine(reasonOf(manifest), { triggerPhrase })}`);
  }
  if (status !== 'ready') return block(`${noun} produced an unrecognized status: ${safeEcho(status)}`);

  const current = run('gh', ['pr', 'view', number, '--repo', repo, '--json', 'body', '--jq', '.body']);
  if (!current.ok) {
    return block('I could not read the pull request body, so nothing was published rather than overwrite what it records.');
  }
  const recorded = requesterOf(String(current.stdout));

  const planPath = planFilePathFor({ branch, dir: planDir });
  if (!planPath) {
    return block(`I could not name a plan document under \`${safeEcho(String(planDir ?? ''))}\`, so nothing was published.`);
  }

  const waiting = renderPlanWaiting({
    issueNumber: Number(issueNumber),
    requestedBy: recorded ?? requestedBy,
    summary: manifest?.summary,
    planPath,
    branch,
    repository: repo,
    triggerPhrase,
    jira,
  });
  if (waiting.error) return block(`The plan could not be published: ${waiting.error}`);

  let document;
  try {
    document = readFileSync(path.resolve(cwd ?? '', planPath), 'utf8');
  } catch {
    return block(`${noun} did not write \`${planPath}\`, so there is no plan document to publish.`);
  }
  const parsed = parsePlanDocument(document);
  if (parsed.error) return block(`${noun} wrote a document this flow cannot run: ${oneLine(parsed.error, { triggerPhrase })}.`);
  const runnable = renderBody({
    issueNumber: Number(issueNumber),
    requestedBy: recorded ?? requestedBy,
    phases: parsed.phases,
    summary: manifest?.summary,
    triggerPhrase,
    repository: repo,
    jira,
  });
  if (runnable.error) {
    return block(`${noun} wrote a document that cannot become a task list: ${oneLine(runnable.error, { triggerPhrase })}.`);
  }

  const where = String(titleKey ?? '').trim() || 'none';
  if (!TITLE_KEY_POSITIONS.includes(where)) {
    return block(
      `\`jira_title_key\` is \`${safeEcho(where)}\`, which is not one of ${TITLE_KEY_POSITIONS.join(', ')}. A typo ` +
        'folds to `none`, so every title would quietly lose the ticket key.',
    );
  }

  const subject = subjectFrom(manifest, { noun, triggerPhrase, key: jira?.key, where });
  if (subject.blocker) return block(subject.blocker);
  const { title } = subject;

  rmSync(manifestPath, { force: true });

  const git = gitVia(run, cwd);
  const aligned = alignToBranch({ git, pushUrl, branch });
  if (!aligned.ok) {
    return block(`The plan document could not be committed: ${aligned.reason}, so nothing was published.`);
  }
  const staged = stagePaths(git, [planPath]);
  if (!staged.ok) {
    return block(
      `\`${planPath}\` was written but ${staged.reason}, so nothing was published.`,
    );
  }
  const committed = git([
    'commit',
    '-m',
    `docs(plan): plan the work for ${jira?.key ? String(jira.key) : `#${String(issueNumber)}`}`,
    '-m',
    'A code owner reviews this document and approves it before any step runs.',
  ]);
  if (!committed.ok) {
    return block('The plan document could not be committed, so nothing was published.');
  }

  const verified = verifyChunk({ cwd, branch, remoteSha: aligned.sha, manifestPath, deniedPaths, onlyPath: planPath });
  if (!verified.ok) return block(`I did not push the plan document: ${verified.reason}`);

  const published = publishCommit({
    cwd,
    repo,
    branch,
    remoteSha: aligned.sha,
    pushUrl,
    verifiedSha: verified.sha,
    git,
    run,
    bodyFile: commitFile ?? undefined,
  });
  if (!published.ok) {
    return block(`The plan document did not reach the branch: ${published.reason} - see the workflow run.`);
  }

  writeFileSync(bodyFile, carryRecords(String(current.stdout), waiting.body));
  const edited = run('gh', ['pr', 'edit', number, '--repo', repo, '--title', title, '--body-file', bodyFile]);
  if (!edited.ok) {
    return block('The plan document is on the branch and the pull request would not take its body - see the workflow run.');
  }

  const shape = renderShape(runnable.checkpoints, requestedBy);
  if (!shape) {
    return block(`The plan holds ${String(runnable.checkpoints)} phase boundaries, which cannot be recorded.`);
  }
  const blob = git(['rev-parse', `${verified.sha}:${planPath}`]);
  const doc = blob.ok ? planDocMarker(String(blob.stdout).trim()) : null;
  if (!doc) {
    return block(`I could not name the content of \`${planPath}\` that was pushed, so the plan was not offered for approval.`);
  }
  const said = marked(
    scrub(
      'This comment records who asked for this work, how many phase boundaries the plan was written with, and ' +
        'the exact content of the plan document being offered. Approving the plan records the count it is ' +
        'released with beside it, and an approval is only honoured while the document still reads as it does now.',
      { triggerPhrase },
    ) + `\n\n${shape}\n${doc}`,
    { ...marker, kind: 'plan-published', triggerPhrase },
  );
  if (!run('gh', ['pr', 'comment', number, '--repo', repo, '--body', said]).ok) {
    return block('The plan document is on the branch and who asked for it could not be recorded - see the workflow run.');
  }

  const prUrl = pullUrl({ serverUrl, repository: repo, prNumber: number });
  return {
    status: 'planned',
    planFile: planPath,
    prUrl,
    message: linked(
      scrub(
        'The plan is [the plan document](LINK). Review it there and approve it, and it becomes the task list ' +
          'that drives the work - one commit per step. Nothing is implemented until then' +
          shortenedNote(runnable.shortened, runnable.summaryShortened),
        { triggerPhrase },
      ),
      prUrl === '' ? '' : `${prUrl}/files`,
    ),
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-message.txt');

  const result = publishPlan({
    manifestPath: env.MANIFEST,
    prNumber: env.PR_NUMBER,
    issueNumber: env.ISSUE_NUM,
    requestedBy: env.REQUESTER,
    triggerPhrase: env.TRIGGER,
    repo: env.REPO,
    bodyFile: path.join(tmp, 'ksai-pr-body.md'),
    commitFile: path.join(tmp, 'ksai-plan-commit.json'),
    jira: env.JIRA_KEY ? { key: env.JIRA_KEY, site: env.JIRA_SITE } : null,
    titleKey: env.JIRA_TITLE_KEY,
    serverUrl: env.GITHUB_SERVER_URL,
    marker: payloadFor(env, {}),
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: env.PLAN_DIR,
    noun: env.PLAN_GIVEN === 'true' ? 'The requester' : 'Planning',
    run,
  });

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    pr_url: result.prUrl,
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
