
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { marked } = require('./marker.cjs');
const { cap, planDirOf, planDocMarker, planFilePathFor, scrub, retargetPermalinks, POSITIVE_ID_SHAPE } =
  require('./plan.cjs');
const { safeEcho, soleWritable, verifyChunk, gitVia, noChangeLeftBehind } = require('./verify-chunk.cjs');
const { MAX_ANSWERABLE: MAX_REPLIES, MAX_REPLY_CHARS } = require('./threads.cjs');
const { counted } = require('../lib/text.cjs');
import { blockerFor, field, readManifest, reasonOf, runCommand, shown } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const COMMENT_ID_SHAPE = POSITIVE_ID_SHAPE;

const PASS = Object.freeze(
  Object.assign(Object.create(null), {
    fix: Object.freeze({ kind: 'fix-answered', noun: 'The review pass', work: 'the review fixes', carries: false }),
    revise: Object.freeze({
      kind: 'revise-answered',
      noun: 'The plan rework',
      work: 'the reworked plan',
      carries: true,
    }),
  }),
);

const SESSION_RESUMED = 'It resumed the planning session.';

const SESSION_COLD = 'The planning session was not carried, so it re-read the repository.';

const MAX_PASS_SUMMARY_CHARS = 1500;

export function parseReplies(manifest, { pending = null, triggerPhrase = null } = {}) {
  const rows = manifest?.threads;
  if (!Array.isArray(rows)) {
    return { message: `The pass reported no thread list: ${safeEcho(shown(rows))}` };
  }
  if (rows.length === 0) {
    return { message: 'The pass reported an empty thread list, so there is nothing to answer.' };
  }
  if (rows.length > MAX_REPLIES) {
    return { message: `The pass reported ${rows.length} threads, over the limit of ${MAX_REPLIES}.` };
  }

  const offered = new Map();
  for (const thread of pending ?? []) {
    if (thread?.id) offered.set(String(thread.id), thread);
  }

  const replies = [];
  const seen = new Set();
  for (const row of rows) {
    const threadId = field(row?.id).trim();
    if (!threadId) return { message: `The pass reported a thread with no id: ${safeEcho(shown(row?.id))}` };
    const thread = offered.get(threadId);
    if (!thread) {
      return { message: `The pass named a review thread that was not open for it: ${safeEcho(threadId)}` };
    }
    if (seen.has(threadId)) {
      return { message: `The pass named one review thread twice: ${safeEcho(threadId)}` };
    }
    seen.add(threadId);

    const commentId = String(thread.rootCommentId ?? '');
    if (!COMMENT_ID_SHAPE.test(commentId)) {
      return { message: `A review thread on \`${safeEcho(thread.path)}\` has no comment to reply to.` };
    }

    const body = scrub(field(row?.reply), { triggerPhrase }).trim();
    if (!body) return { message: `The pass reported no reply for the thread on \`${safeEcho(thread.path)}\`.` };
    if (body.length > MAX_REPLY_CHARS) {
      return { message: `A reply for \`${safeEcho(thread.path)}\` is ${body.length} characters, over the limit of ${MAX_REPLY_CHARS}.` };
    }

    replies.push({ threadId, commentId, body, path: thread.path });
  }

  return { replies };
}

export function renderFooter({ sha = null, triggerPhrase = null } = {}) {
  const short = typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 12) : '';
  return scrub(
    short ? `_This pass pushed ${short} to this branch._` : '_This pass pushed no commit._',
    { triggerPhrase },
  );
}

export function recordFix({
  manifestPath = null,
  cwd = null,
  branch = null,
  remoteSha = null,
  prNumber = null,
  issueNumber = null,
  runId = null,
  repo = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  onlyPath = null,
  phase = 'fix',
  resumed = null,
  pending = null,
  deferred = null,
  triggerPhrase = null,
  bodyFile = null,
  commitFile = null,
  run = runCommand,
} = {}) {
  const pass = PASS[String(phase ?? '')];
  if (!pass) {
    return { status: 'blocked', message: `\`${safeEcho(shown(phase))}\` is not a phase this write path records` };
  }
  const block = blockerFor(manifestPath);

  const read = readManifest(manifestPath, { noun: pass.noun, triggerPhrase });
  if (read.message) return block(read.message);
  const manifest = read.manifest;

  const status = field(manifest?.status);
  if (status === 'blocked') {
    return block(`Stopped without answering anything: ${scrub(reasonOf(manifest), { triggerPhrase }).trim()}`);
  }
  if (status !== 'done' && status !== 'answered') {
    return block(`${pass.noun} reported an unrecognized status: ${safeEcho(shown(manifest?.status))}`);
  }

  const parsed = parseReplies(manifest, { pending, triggerPhrase });
  if (parsed.message) return block(parsed.message);
  const { replies } = parsed;

  const pushing = status === 'done';
  const marker = { flow: 'implement', command: phase, issue: issueNumber, pr: prNumber, run: runId, triggerPhrase };
  rmSync(manifestPath, { force: true });

  let sha = '';
  let localSha = '';
  if (pushing) {
    const verified = verifyChunk({
      cwd,
      branch,
      remoteSha,
      manifestPath,
      deniedPaths,
      planDir,
      onlyPath,
      branchGrammar: 'human-named',
    });
    if (!verified.ok) return block(`I did not push ${pass.work}: ${verified.reason}`);

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
        `I did not put ${pass.work} on the branch: ${published.reason}. No thread was answered, so a later ` +
          'run retries them.',
      );
    }
    localSha = verified.sha;
    sha = published.sha;

    if (onlyPath) {
      const blob = gitVia(run, cwd)(['rev-parse', `${verified.sha}:${onlyPath}`]);
      const doc = blob.ok ? planDocMarker(String(blob.stdout).trim()) : null;
      if (!doc) {
        return block(`I could not name the content of \`${onlyPath}\` that was pushed, so it was not offered for approval.`);
      }
      const offer = marked(
        scrub(
          'This comment records the exact content of the plan document now being offered. An approval is only ' +
            'honoured while the document still reads as it does here.',
          { triggerPhrase },
        ) + `\n\n${doc}`,
        { ...marker, kind: 'plan-published' },
      );
      if (!run('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', offer]).ok) {
        return block(
          `\`${onlyPath}\` is on the branch and which content was offered could not be recorded, so an approval ` +
            'would have nothing to check against - see the workflow run. Re-request and I will offer it again.',
        );
      }
    }
  } else {
    const left = noChangeLeftBehind({ from: remoteSha, git: gitVia(run, cwd) });
    if (!left.ok) {
      return block(
        left.unreadable
          ? `I could not check whether the pass left work behind: ${left.reason}. Nothing was answered.`
          : `The pass reported that no code change was needed, but ${left.reason}. That is a report ` +
            'contradicting the tree, so nothing was pushed and no thread was answered. Re-request and it will ' +
            'start from a clean checkout.',
      );
    }
  }

  const footer = renderFooter({ sha, triggerPhrase });
  const answered = [];
  let failure = null;
  for (const reply of replies) {
    const answer = marked(`${reply.body}\n\n${footer}`, { ...marker, kind: pass.kind });
    writeFileSync(bodyFile, `${JSON.stringify({ body: answer })}\n`);
    const posted = run('gh', [
      'api',
      '--method',
      'POST',
      `repos/${repo}/pulls/${String(prNumber)}/comments/${reply.commentId}/replies`,
      '--input',
      bodyFile,
      '--silent',
    ]);
    if (!posted.ok) {
      failure = reply.path;
      break;
    }
    answered.push(reply);
  }

  const held = Number.isInteger(deferred) && deferred > 0 ? deferred : 0;
  const offered = (pending ?? []).length;
  const remaining = Math.max(0, offered - answered.length) + held;
  const pushedNote = pushing ? `Pushed ${sha.slice(0, 12)}.` : 'No code change was needed.';
  const retargeted = retargetPermalinks(scrub(field(manifest?.summary), { triggerPhrase }), { repo, from: localSha, to: sha });
  const summary = cap(retargeted.trim(), MAX_PASS_SUMMARY_CHARS);

  if (failure) {
    return {
      ...block(
        `${pushedNote} I answered ${answered.length} of ${counted(replies.length, 'thread')} and then could not post a ` +
          `reply on \`${safeEcho(failure)}\` - see the workflow run. Re-request and I will pick up the rest.`,
      ),
      pushed: pushing,
      answered: answered.length,
    };
  }

  const heldNote = held ? ` ${held} of those were not offered to this pass; ask again to pick them up.` : '';
  const sessionNote = pass.carries ? ` ${resumed === true ? SESSION_RESUMED : SESSION_COLD}` : '';
  const headline =
    remaining === 0
      ? `Answered all ${counted(answered.length, 'open review thread')}. ${pushedNote}${sessionNote}`
      : `Answered ${counted(answered.length, 'review thread')}; ${remaining} still open. ` +
        `${pushedNote}${heldNote}${sessionNote}`;

  return {
    status: pushing ? 'fixed' : 'answered',
    pushed: pushing,
    answered: answered.length,
    remaining,
    message: summary ? `${headline}\n\n${summary}` : headline,
  };
}

export function expectedPlanFile(env) {
  const named = String(env.PLAN_FILE ?? '').trim();
  const expected = planFilePathFor({ branch: env.BRANCH, dir: env.PLAN_DIR });
  return named !== '' && named === expected ? named : '';
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-message.txt');

  let pending;
  {
    let parsedPending;
    try {
      parsedPending = JSON.parse(readFileSync(env.PENDING_FILE, 'utf8'));
    } catch {
      process.stderr.write(
        `the review threads at ${env.PENDING_FILE ?? '(no path given)'} could not be read, so no reply is attempted.\n`,
      );
      return 1;
    }
    if (!Array.isArray(parsedPending)) {
      process.stderr.write(`the review threads at ${env.PENDING_FILE} are not a list.\n`);
      return 1;
    }
    pending = parsedPending;
  }

  const result = recordFix({
    manifestPath: env.MANIFEST,
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    remoteSha: env.REMOTE_SHA,
    prNumber: env.PR_NUMBER,
    issueNumber: env.ISSUE_NUM,
    runId: env.RUN_ID,
    repo: env.REPO,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    onlyPath: soleWritable(env.PHASE, expectedPlanFile(env)),
    phase: env.PHASE,
    resumed: env.RESUMED_SESSION === 'true',
    pending,
    deferred: Number.parseInt(env.DEFERRED ?? '', 10),
    triggerPhrase: env.TRIGGER,
    bodyFile: path.join(tmp, 'ksai-reply.json'),
    commitFile: path.join(tmp, 'ksai-commit.json'),
    run,
  });

  process.stdout.write(
    `note: ${result.pushed ? 'a commit was pushed' : 'nothing was pushed'}; ` +
      `${counted(result.answered ?? 0, 'thread')} answered.\n`,
  );

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    remaining: result.remaining,
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
