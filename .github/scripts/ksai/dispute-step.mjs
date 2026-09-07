import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { classifierModel } = require('./classify.cjs');
const { counted, plural } = require('../lib/text.cjs');
const {
  DISAGREE,
  MAX_THREADS,
  UNCLEAR,
  disputeFromExecution,
  renderDisputePrompt,
} = require('./dispute.cjs');
const {
  AGREED_KIND,
  LOCK_KIND,
  UNCLEAR_KIND,
  UNLOCK_KIND,
  disputedThreads,
  latestResponseWasEdited,
  lockedThreads,
} = require('./threads.cjs');
const { marked, payloadFor } = require('./marker.cjs');
const { spendFromExecution } = require('./write-report.cjs');
const { scrub } = require('./plan.cjs');
const { asAlert } = require('../lib/select-arm.cjs');

const HELD =
  'A disagreement was detected in this thread, so it is held. Nothing will work on it until somebody says ' +
  'what they want done instead - reply here with the unlock command and your instruction.';

const RELEASED = 'This thread was unlocked, and the instruction left with the unlock is what the next pass works from.';

const SETTLED = Object.freeze(
  Object.assign(Object.create(null), {
    [AGREED_KIND]: 'Read as agreement, so this thread is settled and no later pass reopens it. Write again here if it is not.',
    [UNCLEAR_KIND]:
      'It could not be told from the words whether this was agreement, so nothing was decided and no later pass ' +
      'reopens it. Write again here if there is something left to do.',
  }),
);

const readLog = (path) => {
  try {
    return readFileSync(String(path ?? ''), 'utf-8');
  } catch {
    return '';
  }
};

const readThreadsFile = (path) => {
  try {
    const parsed = JSON.parse(readFileSync(String(path ?? ''), 'utf-8'));
    return Array.isArray(parsed) ? parsed : (parsed?.threads ?? []);
  } catch {
    return [];
  }
};

export function buildDispute(env = process.env) {
  const disputes = disputedThreads(readThreadsFile(env.THREADS_FILE), { botLogin: env.BOT_LOGIN });
  const rooted = disputes.filter((thread) => Number.isInteger(thread?.rootCommentId) && thread.rootCommentId > 0);
  const threads = rooted.filter((thread) => !latestResponseWasEdited(thread, env.BOT_LOGIN));
  const edited = rooted.length - threads.length;
  const scopedIndex = threads.findIndex((thread) => thread.rootCommentId === Number(env.THREAD_ROOT_ID));
  if (scopedIndex > 0) threads.unshift(...threads.splice(scopedIndex, 1));
  threads.splice(MAX_THREADS);
  const arm = classifierModel(env.CLASSIFIER_MODEL);
  if (threads.length === 0 || arm.error) {
    const why =
      arm.error ??
      (edited > 0 ? 'Edited replies are not evidence of agreement, so those threads remain disputed' : '');
    return { count: 0, file: '', roots: '', model: '', why };
  }
  const file = join(String(env.PROMPT_DIR ?? env.RUNNER_TEMP ?? '/tmp'), 'ksai-dispute-prompt.txt');
  writeFileSync(file, renderDisputePrompt(threads, { botLogin: env.BOT_LOGIN }));
  return {
    count: threads.length,
    file,
    roots: threads.map((thread) => thread?.rootCommentId).join(','),
    model: arm.model,
    why: '',
  };
}

export async function lockDisputed({ github, core, owner, repo, env = process.env }) {
  const roots = String(env.DISPUTE_ROOTS ?? '')
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  if (roots.length === 0) return { locked: 0, held: false, notices: [], spend: { paid: false } };
  const log = readLog(env.DISPUTE_LOG);
  const spend = spendFromExecution(log, true);
  if (String(env.DISPUTE_CALLED ?? 'success') !== 'success') {
    return {
      locked: 0,
      held: false,
      spend,
      notices: ['the dispute judge did not complete, so every thread it was asked about stays disputed.'],
    };
  }
  const verdicts = disputeFromExecution(log, roots.length);
  const notices = [];
  let locked = 0;
  let held = false;
  const scoped = Number(env.THREAD_ROOT_ID);
  for (const [index, root] of roots.entries()) {
    const verdict = verdicts[index];
    if (verdict === DISAGREE && root === scoped) held = true;
    const kind = verdict === DISAGREE ? LOCK_KIND : verdict === UNCLEAR ? UNCLEAR_KIND : AGREED_KIND;
    const fields = payloadFor(env, { kind });
    const body =
      verdict === DISAGREE
        ? marked(asAlert('IMPORTANT', scrub(HELD, { triggerPhrase: env.TRIGGER })), fields)
        : marked(scrub(SETTLED[kind], { triggerPhrase: env.TRIGGER }), fields);
    try {
      await github.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: Number(env.PR_NUMBER),
        comment_id: root,
        body,
      });
      if (verdict === DISAGREE) locked += 1;
    } catch (error) {
      notices.push(`thread ${root} could not have its dispute recorded: ${error?.message ?? error}`);
    }
  }
  core?.info?.(`${locked} of ${counted(roots.length, 'thread')} read as a disagreement and were held.`);
  return { locked, held, notices, spend };
}

export async function releaseThread({ github, core, owner, repo, env = process.env }) {
  const root = Number(env.THREAD_ROOT_ID);
  if (!Number.isInteger(root) || root <= 0) return { released: false, why: 'no thread was named' };
  const threads = readThreadsFile(env.THREADS_FILE);
  const held = lockedThreads(threads, { botLogin: env.BOT_LOGIN }).some((thread) => thread?.rootCommentId === root);
  if (!held) return { released: false, why: 'that thread is not held, so there is nothing to release' };
  const body = marked(
    scrub(RELEASED, { triggerPhrase: env.TRIGGER }),
    payloadFor(env, { kind: UNLOCK_KIND }),
  );
  await github.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: Number(env.PR_NUMBER),
    comment_id: root,
    body,
  });
  core?.info?.(`thread ${root} was released, so the next pass may work it.`);
  return { released: true, why: '' };
}

export function main(env = process.env) {
  let built = { count: 0, file: '', roots: '', model: '', why: '' };
  try {
    built = buildDispute(env);
  } catch (error) {
    built.why = `the disputed threads could not be read (${error?.message ?? error})`;
  }
  writeOutputs(env.GITHUB_OUTPUT, {
    count: built.count,
    file: built.file,
    roots: built.roots,
    model: built.model,
  });
  process.stdout.write(
    built.count === 0
      ? `${built.why || 'No review thread here was answered back in'}, so nothing is asked about.\n`
      : `${counted(built.count, 'thread')} ${plural(built.count, 'was', 'were')} answered back in, ` +
        'so one cheap run is asked whether that was pushback.\n',
  );
  return 0;
}

export { HELD };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
