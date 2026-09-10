import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { payloadFor, marked } = require('./marker.cjs');
const {
  carryRecords,
  linked,
  motivationOf,
  planDocsIn,
  parsePlanDocument,
  planFileIn,
  planFilePathFor,
  pullUrl,
  renderBody,
  renderShape,
  requesterOf,
  scrub,
  shapesIn,
  stepDigest,
  shortenedNote,
} = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');
const { safeEcho } = require('./verify-chunk.cjs');
const { vouchedOwn } = require('./approval.cjs');
import { runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const MAX_DOC_BYTES = 256 * 1024;

function recordedBy({ repo, prNumber, botLogin, run }) {
  const login = String(botLogin ?? '').trim();
  if (login === '') return { requester: null, docs: [], readable: true };
  const listed = run('gh', [
    'api',
    `repos/${repo}/issues/${prNumber}/comments`,
    '--paginate',
    '--jq',
    '.[] | [.user.login, .created_at, .updated_at, (.body | @base64)] | @tsv',
  ]);
  if (!listed.ok) return { requester: null, docs: [], readable: false };
  let found = null;
  const docs = [];
  for (const row of String(listed.stdout).split('\n')) {
    const [who, created, updated, encoded] = row.split('\t');
    if (!vouchedOwn({ login: who, created_at: created, updated_at: updated }, login) || !encoded) continue;
    const said = Buffer.from(encoded, 'base64').toString('utf8');
    const shape = shapesIn(said).at(-1);
    if (shape?.requestedBy) found = shape.requestedBy;
    const offered = planDocsIn(said);
    if (offered.length) docs.splice(0, docs.length, ...offered);
  }
  return { requester: found, docs, readable: true };
}

export function releasePlan({
  prNumber = null,
  issueNumber = null,
  branch = null,
  repo = null,
  triggerPhrase = null,
  jira = null,
  requestedBy = null,
  botLogin = null,
  planDir = null,
  bodyFile = null,
  serverUrl = null,
  marker = null,
  run = runCommand,
} = {}) {
  const number = String(prNumber ?? '');
  const block = (message) => ({ status: 'blocked', message: scrub(message, { triggerPhrase }) });
  if (!NUMBER_SHAPE.test(number)) {
    return block(`There is no pull request to release a plan in (got \`${safeEcho(number)}\`).`);
  }

  const view = run('gh', ['pr', 'view', number, '--repo', repo, '--json', 'body', '--jq', '.body']);
  if (!view.ok) return block('I could not read the pull request body, so no plan was released.');
  const body = String(view.stdout);

  const planFile = planFileIn(body);
  if (!planFile) {
    return block('This pull request names no plan document, so there is nothing to release.');
  }
  const expected = planFilePathFor({ branch, dir: planDir });
  if (planFile !== expected) {
    return block(
      `This pull request names \`${planFile}\` as its plan document, and the plan this flow wrote is ` +
        `\`${expected === null ? 'nowhere' : expected}\`. Nothing was released.`,
    );
  }

  const read = run('gh', [
    'api',
    `repos/${repo}/contents/${planFile}?ref=${encodeURIComponent(String(branch ?? ''))}`,
    '--jq',
    '[.sha, (.content | gsub("\\n"; ""))] | @tsv',
  ]);
  if (!read.ok) {
    return block(`I could not read \`${planFile}\` on \`${safeEcho(String(branch ?? ''))}\`, so no plan was released.`);
  }
  const [blob, held] = String(read.stdout).trim().split('\t');
  const encoded = String(held ?? '').replace(/\s+/g, '');
  if (encoded === '' || encoded.length > MAX_DOC_BYTES) {
    return block(`\`${planFile}\` is empty or too large to read as a plan document, so no plan was released.`);
  }
  const document = Buffer.from(encoded, 'base64').toString('utf8');

  const parsed = parsePlanDocument(document);
  if (parsed.error) return block(`\`${planFile}\` is not a plan this flow can run: ${parsed.error}.`);

  const recorded = recordedBy({ repo, prNumber: number, botLogin, run });
  const offered = String(blob ?? '').trim().toLowerCase();
  if (!recorded.readable) {
    return block('I could not read this pull request\'s comments to find which plan document was approved, so no plan was released.');
  }
  if (recorded.docs.length === 0) {
    return block(
      String(botLogin ?? '').trim() === ''
        ? 'This flow was given no `bot_login`, so it cannot tell which of the comments here are its own and cannot ' +
          'find which plan document was offered for approval. No plan was released. Set `bot_login` on the action.'
        : 'No comment of this flow records which plan document was offered for approval, so there is nothing to check ' +
          `this approval against and no plan was released. Ask for the plan again to publish \`${planFile}\` afresh.`,
    );
  }
  if (!recorded.docs.includes(offered)) {
    return block(
      `\`${planFile}\` has changed since it was offered for approval, so the approval is for a document that is no ` +
        'longer on the branch and no plan was released. Ask for the plan again, and approve the version that is ' +
        'published in answer.',
    );
  }

  const asked = requesterOf(body) ?? requestedBy;
  const trusted = recorded.requester;
  const rendered = renderBody({
    issueNumber: Number(issueNumber),
    requestedBy: asked,
    phases: parsed.phases,
    summary: motivationOf(body),
    triggerPhrase,
    repository: repo,
    jira,
  });
  if (rendered.error) {
    return block(
      `The plan could not be turned into a task list: ${rendered.error}. The steps come from \`${planFile}\` ` +
        "and the summary from this pull request's own `## Motivation`.",
    );
  }

  const digest = stepDigest(rendered.body);
  const shape = renderShape(rendered.checkpoints, trusted, { sealedWith: digest });
  if (!shape || !digest) {
    return block(`The plan holds ${String(rendered.checkpoints)} phase boundaries, which cannot be recorded.`);
  }
  const said = marked(
    scrub(
      'The plan is approved. The tasks in this pull request body are the run state now, and each one lands ' +
        'as its own commit here. This comment seals what was approved, so rewording a task or changing a phase ' +
        'boundary stops the next run',
      { triggerPhrase },
    ) + `\n\n${shape}`,
    { ...marker, kind: 'plan-approved', triggerPhrase },
  );
  if (!run('gh', ['pr', 'comment', number, '--repo', repo, '--body', said]).ok) {
    return block('The plan could not have its phase count recorded, so nothing was released.');
  }

  writeFileSync(bodyFile, carryRecords(body, rendered.body));
  if (!run('gh', ['pr', 'edit', number, '--repo', repo, '--body-file', bodyFile]).ok) {
    return block('The phase count is recorded and the pull request would not take the task list - see the workflow run.');
  }

  const remaining = rendered.steps;
  const prUrl = pullUrl({ serverUrl, repository: repo, prNumber: number });
  return {
    status: 'released',
    planFile,
    remaining,
    message: linked(
      scrub(
        'Released the plan in [the plan document](LINK). The tasks in this body are the run state now, and ' +
          'each one lands as its own commit here' +
          shortenedNote(rendered.shortened, rendered.summaryShortened),
        { triggerPhrase },
      ),
      prUrl === '' ? '' : `${prUrl}/files`,
    ),
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-release-plan.txt');

  const result = releasePlan({
    prNumber: env.PR_NUMBER,
    issueNumber: env.ISSUE_NUM,
    branch: env.BRANCH,
    repo: env.REPO,
    triggerPhrase: env.TRIGGER,
    jira: env.JIRA_KEY ? { key: env.JIRA_KEY, site: env.JIRA_SITE } : null,
    requestedBy: env.REQUESTER,
    botLogin: env.BOT_LOGIN,
    planDir: env.PLAN_DIR,
    bodyFile: path.join(tmp, 'ksai-pr-body.md'),
    serverUrl: env.GITHUB_SERVER_URL,
    marker: payloadFor(env, {}),
    run,
  });

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    remaining: result.remaining ?? '',
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
