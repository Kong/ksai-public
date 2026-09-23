import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { payloadFor, marked } = require('./marker.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');
const { writerFor } = require('../lib/cp-effects.cjs');
const {
  carryRecords,
  motivationOf,
  parseBody,
  parsePlanDocument,
  planFileIn,
  planFilePathFor,
  releaseOf,
  renderBody,
  renderShape,
  requesterOf,
  scrub,
  stepDigest,
  withRelease,
} = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');
const { safeEcho } = require('./verify-chunk.cjs');
const { FOREIGN, ownState, planRecords, withLastEdits } = require('./approval.cjs');
import { editPullBody, filesLinked, readPullBody, runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const MAX_DOC_BYTES = 256 * 1024;
const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const graphqlOver = (run) => async (query, variables) => {
  const asked = run('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }), stderr: 'ignore' });
  if (!asked.ok) throw new Error('the GraphQL API could not be reached');
  const answer = JSON.parse(String(asked.stdout));
  if (answer?.errors?.length) throw new Error(`the GraphQL API answered ${answer.errors.length} errors`);
  return answer?.data;
};

async function recordedBy({ repo, prNumber, botLogin, run }) {
  const login = String(botLogin ?? '').trim();
  if (login === '') return { requester: null, docs: [], readable: true };
  const list = (space) =>
    run('gh', [
      'api',
      `repos/${repo}/${space}/${prNumber}/comments`,
      '--paginate',
      '--jq',
      '.[] | [.user.login, .created_at, .updated_at, .node_id, (.body | @base64)] | @tsv',
    ]);
  const listed = [list('issues'), list('pulls')];
  if (listed.some((one) => !one.ok)) return { requester: null, docs: [], readable: false };
  const comments = listed
    .flatMap((one) => String(one.stdout).split('\n'))
    .filter((row) => row !== '')
    .map((row) => {
      const [who, created, updated, nodeId, encoded] = row.split('\t');
      const body = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
      return { login: who, created_at: created, updated_at: updated, node_id: nodeId, body };
    })
    .filter((comment) => ownState(comment, login) !== FOREIGN && comment.body !== '')
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  const read = await withLastEdits(comments, { graphql: graphqlOver(run) }).catch(() => comments);
  const seen = planRecords(read, { botLogin: login });
  return { requester: seen.requester, docs: seen.offeredDocs, offeredAt: seen.offeredAt, readable: true };
}

export async function releasePlan({
  prNumber = null,
  issueNumber = null,
  branch = null,
  approvedAt = null,
  approvedHead = null,
  releasedBy = null,
  approvalUrl = null,
  repo = null,
  triggerPhrase = null,
  jira = null,
  requestedBy = null,
  botLogin = null,
  planDir = null,
  bodyFile = null,
  serverUrl = null,
  marker = null,
  throughControlPlane = false,
  releaseThroughControlPlane = null,
  run = runCommand,
} = {}) {
  const number = String(prNumber ?? '');
  const block = (message, refusal) => {
    if (!refusal?.code) throw new Error('a blocked release needs a refusal code');
    return { status: 'blocked', message: scrub(message, { triggerPhrase }), refusal };
  };
  if (!NUMBER_SHAPE.test(number)) {
    return block(`There is no pull request to release a plan in (got \`${safeEcho(number)}\`).`,
      { code: 'missing_pull', number: safeEcho(number) });
  }
  const approved = Date.parse(String(approvedAt ?? ''));
  const head = String(approvedHead ?? '').trim();
  if (!Number.isFinite(approved) || !COMMIT_SHAPE.test(head)) {
    return block(
      'The approval gate did not say when this plan was approved or which commit it read, so there is nothing ' +
        'to check the document against and no plan was released. Approve again to release it.',
      { code: 'missing_approval' },
    );
  }

  const body = readPullBody({ repo, number, run });
  if (body === null) return block('I could not read the pull request body, so no plan was released.', { code: 'body_unreadable' });

  const planFile = planFileIn(body);
  if (!planFile) {
    return block('This pull request names no plan document, so there is nothing to release.', { code: 'no_document' });
  }
  const expected = planFilePathFor({ branch, dir: planDir });
  if (planFile !== expected) {
    return block(
      `This pull request names \`${planFile}\` as its plan document, and the plan this flow wrote is ` +
        `\`${expected === null ? 'nowhere' : expected}\`. Nothing was released.`,
      { code: 'document_mismatch', path: planFile, expected: expected ?? 'nowhere' },
    );
  }

  const read = run('gh', [
    'api',
    `repos/${repo}/contents/${planFile}?ref=${head}`,
    '--jq',
    '[.sha, (.content | gsub("\\n"; ""))] | @tsv',
  ]);
  if (!read.ok) {
    return block(`I could not read \`${planFile}\` at \`${head}\`, the commit the approval gate read, so no plan was released.`,
      { code: 'document_unreadable', path: planFile, head });
  }
  const [blob, held] = String(read.stdout).trim().split('\t');
  const encoded = String(held ?? '').replace(/\s+/g, '');
  if (encoded === '' || encoded.length > MAX_DOC_BYTES) {
    return block(`\`${planFile}\` is empty or too large to read as a plan document, so no plan was released.`,
      { code: 'document_size', path: planFile });
  }
  const document = Buffer.from(encoded, 'base64').toString('utf8');

  const parsed = parsePlanDocument(document);
  if (parsed.error) return block(`\`${planFile}\` is not a plan this flow can run: ${parsed.error}.`,
    { code: 'document_invalid', path: planFile, error: parsed.error });

  const recorded = await recordedBy({ repo, prNumber: number, botLogin, run });
  const offered = String(blob ?? '').trim().toLowerCase();
  if (!recorded.readable) {
    return block('I could not read this pull request\'s comments to find which plan document was approved, so no plan was released.',
      { code: 'comments_unreadable' });
  }
  if (recorded.docs.length === 0) {
    return block(
      String(botLogin ?? '').trim() === ''
        ? 'This flow was given no `bot_login`, so it cannot tell which of the comments here are its own and cannot ' +
          'find which plan document was offered for approval. No plan was released. Set `bot_login` on the action.'
        : 'No comment of this flow records which plan document was offered for approval, so there is nothing to check ' +
          `this approval against and no plan was released. Ask for the plan again to publish \`${planFile}\` afresh.`,
      String(botLogin ?? '').trim() === '' ? { code: 'bot_login_missing' } : { code: 'offer_missing', path: planFile },
    );
  }
  if (!recorded.docs.includes(offered)) {
    return block(
      `\`${planFile}\` has changed since it was offered for approval, so the approval is for a document that is no ` +
        'longer on the branch and no plan was released. Ask for the plan again, and approve the version that is ' +
        'published in answer.',
      { code: 'document_changed', path: planFile },
    );
  }
  const offeredAt = Date.parse(String(recorded.offeredAt ?? ''));
  if (!Number.isFinite(offeredAt)) {
    return block(`I could not tell when \`${planFile}\` was last offered for approval, so no plan was released.`,
      { code: 'offer_time_unreadable', path: planFile });
  }
  if (offeredAt >= approved) {
    return block(
      `\`${planFile}\` was offered for approval again after the approval this run found, so that approval is for ` +
        'the document it replaced and no plan was released. Read the plan again, and approve the version that is ' +
        'published now.',
      { code: 'offered_after_approval', path: planFile },
    );
  }
  const tip = run('gh', ['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha']);
  if (!tip.ok) {
    return block('I could not read which commit this pull request is at, so no plan was released.', { code: 'head_unreadable' });
  }
  if (String(tip.stdout).trim() !== head) {
    return block(
      'This pull request moved to another commit after the approval gate read it, so the approval may be for a ' +
        'document that is no longer on the branch and no plan was released. Approve again to release the plan as ' +
        'it is now.',
      { code: 'head_changed' },
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
      { code: 'task_list_invalid', path: planFile, error: rendered.error },
    );
  }

  if (throughControlPlane) {
    const facts = {
      path: planFile, head_sha: head, blob_sha: offered,
      phases: parsed.phases.map((phase) => phase.steps),
      issue: Number(issueNumber), requester: asked, trusted_requester: trusted,
      ref: releasedBy, approval_url: approvalUrl,
      trigger: triggerPhrase, jira_key: jira?.key ?? '', jira_site: jira?.site ?? '',
      command: marker?.command ?? '', run: String(marker?.run ?? ''), ask: marker?.ask ?? '',
    };
    try {
      const released = await releaseThroughControlPlane({ number: Number(number), facts });
      const { message } = filesLinked(
        'Released the plan in [the plan document](LINK). The tasks in this body are the run state now, and ' +
          'each one lands as its own commit here',
        rendered, { serverUrl, repo, number, triggerPhrase },
      );
      return { status: 'released', planFile, remaining: released.remaining, message };
    } catch {
      return block('The control plane could not record the approval and publish the task list - see the workflow run.',
        { code: 'cp_publish_failed' });
    }
  }

  const digest = stepDigest(parseBody(rendered.body));
  const shape = renderShape(rendered.checkpoints, trusted, { sealedWith: digest });
  if (!shape || !digest) {
    return block(`The plan holds ${String(rendered.checkpoints)} phase boundaries, which cannot be recorded.`,
      { code: 'phase_count_invalid', count: rendered.checkpoints });
  }
  const unreleased = body.split('\n').filter((line) => releaseOf(line) === null).join('\n');
  const next = withRelease(carryRecords(unreleased, rendered.body), releasedBy, { url: approvalUrl });
  if (next === null) {
    return block('The approval gate named no approver this release can record, so no plan was released.',
      { code: 'approver_missing' });
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
    return block('The plan could not have its phase count recorded, so nothing was released.',
      { code: 'phase_record_failed' });
  }

  if (!editPullBody({ repo, number, bodyFile, body: next.body, run })) {
    return block('The phase count is recorded and the pull request would not take the task list - see the workflow run.',
      { code: 'body_edit_failed' });
  }

  const { message } = filesLinked(
    'Released the plan in [the plan document](LINK). The tasks in this body are the run state now, and ' +
      'each one lands as its own commit here',
    rendered,
    { serverUrl, repo, number, triggerPhrase },
  );
  return { status: 'released', planFile, remaining: rendered.steps, message };
}

export async function main(env = process.env, { run = runCommand,
  releaseThroughControlPlane = (facts) => writerFor({ env }).releasePlan(facts) } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-release-plan.txt');
  const refusalFile = path.join(tmp, 'ksai-release-refusal.json');

  const result = await releasePlan({
    prNumber: env.PR_NUMBER,
    issueNumber: env.ISSUE_NUM,
    branch: env.BRANCH,
    approvedAt: env.APPROVED_AT,
    approvedHead: env.APPROVED_HEAD,
    releasedBy: env.RELEASE_REF,
    approvalUrl: env.APPROVAL_URL,
    repo: env.REPO,
    triggerPhrase: env.TRIGGER,
    jira: env.JIRA_KEY ? { key: env.JIRA_KEY, site: env.JIRA_SITE } : null,
    requestedBy: env.REQUESTER,
    botLogin: env.BOT_LOGIN,
    planDir: env.PLAN_DIR,
    bodyFile: path.join(tmp, 'ksai-pr-body.md'),
    serverUrl: env.GITHUB_SERVER_URL,
    marker: payloadFor(env, {}),
    throughControlPlane: usingControlPlane(env),
    releaseThroughControlPlane,
    run,
  });

  writeFileSync(messageFile, `${result.message}\n`);
  if (result.status === 'blocked') writeFileSync(refusalFile, JSON.stringify(result.refusal));
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    remaining: result.remaining ?? '',
    message_file: messageFile,
    refusal_file: result.status === 'blocked' ? refusalFile : '',
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
