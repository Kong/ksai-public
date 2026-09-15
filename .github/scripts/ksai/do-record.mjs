import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cap, MAX_PR_TITLE_CHARS, planDirOf, scrub, retargetPermalinks } = require('./plan.cjs');
const { safeEcho, verifyChunk, verifyMerge, gitVia, noChangeLeftBehind } = require('./verify-chunk.cjs');
const { readScope, writeScopeResult } = require('./change-scope.cjs');
const { renderDoMarker, unaskedRun, MAX_REPORT_CHARS } = require('./do.cjs');
import { blockerFor, field, readManifest, reasonOf, runCommand, shown } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { verificationOf, writeVerification } from './fix-verification.mjs';

export function renderReportFooter({ sha = null, triggerPhrase = null, merged = null } = {}) {
  const short = typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 12) : '';
  const into = String(merged ?? '').trim();
  if (short && into) {
    return scrub(
      `_Merged \`${into}\` as ${short} and pushed it. The merge is unsigned, and nothing here ran against it: ` +
        'this run has no network._',
      { triggerPhrase },
    );
  }
  return scrub(
    short ? `_Committed ${short} and pushed it to this branch._` : '_No code change was needed, so nothing was pushed._',
    { triggerPhrase },
  );
}

export function mergeSubject({ baseRef = null, conflicted = 0 } = {}) {
  const named = String(baseRef ?? '').trim() || 'the base branch';
  const count = Number.parseInt(String(conflicted ?? ''), 10);
  const said =
    Number.isInteger(count) && count > 0
      ? `chore(merge): resolve the conflicts with ${named}`
      : `chore(merge): bring the branch up to date with ${named}`;
  return cap(said, MAX_PR_TITLE_CHARS);
}

export function renderReport({
  summary = null,
  sha = null,
  commentId = null,
  trigger = null,
  triggerPhrase = null,
  repo = null,
  localSha = null,
  merged = null,
} = {}) {
  const marker = renderDoMarker(commentId);
  if (!marker && !unaskedRun({ trigger, commentId })) return '';
  const retargeted = retargetPermalinks(scrub(field(summary), { triggerPhrase }), { repo, from: localSha, to: sha });
  const said = cap(retargeted.trim(), MAX_REPORT_CHARS);
  const footer = renderReportFooter({ sha, triggerPhrase, merged });
  return [footer, ...(said ? ['', said] : []), ...(marker ? ['', marker] : [])].join('\n');
}

export function recordDo({
  manifestPath = null,
  cwd = null,
  branch = null,
  remoteSha = null,
  repo = null,
  prNumber = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  commentId = null,
  trigger = null,
  triggerPhrase = null,
  commitFile = null,
  mergedSha = null,
  mergedRef = null,
  conflicted = null,
  mergeMessageFile = null,
  checksPath = null,
  eventsPath = null,
  verificationPath = null,
  changeScopePath = null,
  recordScope = writeScopeResult,
  run = runCommand,
} = {}) {
  const block = blockerFor(manifestPath);
  const blocked = (message) => ({ ...block(message), pushed: false, commitSha: null });
  const merging = String(mergedSha ?? '').trim() !== '';
  const boundScope = readScope(changeScopePath, {
    repo,
    pr: String(prNumber ?? ''),
    phase: 'do',
    head: remoteSha,
  });
  if (!boundScope.ok) return blocked(`I did not run the push gate: ${boundScope.reason}. Nothing was pushed.`);
  const recordOutcome = (outcome) => recordScope(changeScopePath, boundScope.scope, outcome);

  const read = readManifest(manifestPath, { noun: 'The run', triggerPhrase });
  if (read.message) return blocked(read.message);
  const manifest = read.manifest;

  const status = field(manifest?.status);
  if (status === 'blocked') {
    return blocked(`Stopped without doing anything: ${scrub(reasonOf(manifest), { triggerPhrase }).trim()}`);
  }
  if (status !== 'done' && status !== 'answered') {
    return blocked(`The run reported an unrecognized status: ${safeEcho(shown(manifest?.status))}`);
  }

  if (!renderDoMarker(commentId) && !unaskedRun({ trigger, commentId })) {
    return blocked(
      `I could not record this request, because \`${safeEcho(shown(commentId))}\` is not a comment id. Nothing ` +
        'was pushed: without the record, every later request would do this work again.',
    );
  }

  const pushing = merging || status === 'done';
  const verification = pushing
    ? verificationOf({ manifest, checksPath, eventsPath, merging })
    : { status: 'not-applicable', target: '', command: '', exit_status: null, reason: 'no-change' };
  writeVerification(verificationPath, verification);
  if (verification.status === 'failed') {
    const said = verification.reason === 'command-after-commit'
      ? 'ran after the commit, so its ordering cannot be trusted'
      : `exited ${verification.exit_status === null ? 'without a status' : verification.exit_status}`;
    return blocked(
      `I did not push the work: verification command \`${safeEcho(verification.command)}\` ${said} for ` +
        `\`${safeEcho(verification.target)}\`.`,
    );
  }
  rmSync(manifestPath, { force: true });

  let sha = '';
  let localSha = '';
  if (pushing) {
    const noun = merging ? 'merge' : 'work';
    let verifiedSha = '';
    let verifiedTree = '';

    if (merging) {
      const verified = verifyMerge({
        cwd,
        branch,
        remoteSha,
        mergedSha,
        manifestPath,
        deniedPaths,
        planDir,
        changeScope: boundScope.scope,
      });
      if (!verified.ok) {
        const recorded = recordOutcome({ outcome: 'refused', reason: verified.reason });
        if (!recorded.ok) {
          return blocked(`I did not push the merge: ${verified.reason} The outcome record failed: ${recorded.reason}.`);
        }
        return blocked(`I did not push the merge: ${verified.reason}`);
      }
      verifiedTree = verified.tree;

      if (!mergeMessageFile) {
        return blocked('I did not push the merge: no path was given to write the commit message to.');
      }
      writeFileSync(
        mergeMessageFile,
        `${mergeSubject({ baseRef: mergedRef, conflicted })}\n\nMerged ${mergedSha} into \`${branch}\`.\n`,
      );
    } else {
      const verified = verifyChunk({
        cwd,
        branch,
        remoteSha,
        manifestPath,
        deniedPaths,
        planDir,
        branchGrammar: 'human-named',
        changeScope: boundScope.scope,
      });
      if (!verified.ok) {
        const recorded = recordOutcome({ outcome: 'refused', reason: verified.reason });
        if (!recorded.ok) {
          return blocked(`I did not push the work: ${verified.reason} The outcome record failed: ${recorded.reason}.`);
        }
        return blocked(`I did not push the work: ${verified.reason}`);
      }
      verifiedSha = verified.sha;
      verifiedTree = verified.tree;
    }

    const verifiedRecord = recordOutcome({ outcome: 'verified', tree: verifiedTree });
    if (!verifiedRecord.ok) return blocked(`I did not push the ${noun}: ${verifiedRecord.reason}.`);

    const git = gitVia(run, cwd);
    if (merging) {
      const committed = git(['commit', '--no-verify', '--cleanup=verbatim', '--file', mergeMessageFile]);
      if (!committed.ok) return blocked('I did not push the merge: the merge commit could not be created.');

      const tip = git(['rev-parse', 'HEAD']);
      const tree = git(['rev-parse', 'HEAD^{tree}']);
      verifiedSha = String(tip?.stdout ?? '').trim();
      if (!tip?.ok || !tree?.ok || String(tree.stdout).trim() !== verifiedTree) {
        return blocked('I did not push the merge: the commit does not carry the tree that was checked.');
      }

      const parents = git(['rev-parse', 'HEAD^@']);
      const landed = String(parents?.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (!parents?.ok || landed.length !== 2 || landed[0] !== remoteSha || landed[1] !== mergedSha) {
        return blocked(
          'I did not push the merge: the commit is a merge of something other than this branch and the base ' +
            'branch a trusted step merged into it.',
        );
      }
    }

    const published = publishCommit({
      cwd,
      repo,
      branch,
      remoteSha,
      pushUrl,
      verifiedSha,
      git,
      run,
      bodyFile: commitFile ?? undefined,
      remoteLfsRefs: merging ? [mergedSha] : [],
    });
    if (!published.ok) {
      const recorded = recordOutcome({ outcome: 'refused', tree: verifiedTree, reason: published.reason });
      if (!recorded.ok) {
        return blocked(
          `I did not put the ${noun} on the branch: ${published.reason}. The outcome record failed: ${recorded.reason}.`,
        );
      }
      return blocked(
        `I did not put the ${noun} on the branch: ${published.reason}. Nothing was recorded, so a later request ` +
          'retries it.',
      );
    }
    localSha = verifiedSha;
    sha = published.sha;
    const publishedRecord = recordOutcome({ outcome: 'published', tree: verifiedTree });
    if (!publishedRecord.ok) {
      return {
        ...block(`I pushed the ${noun}, but the outcome record failed: ${publishedRecord.reason}.`),
        pushed: true,
        commitSha: sha || null,
      };
    }
  } else {
    const left = noChangeLeftBehind({ from: remoteSha, git: gitVia(run, cwd) });
    if (!left.ok) {
      return blocked(
        left.unreadable
          ? `I could not check whether the run left work behind: ${left.reason}. Nothing was recorded.`
          : `The run reported that no code change was needed, but ${left.reason}. That is a report contradicting ` +
            'the tree, so nothing was pushed and nothing was recorded. Ask again and it will start from a clean ' +
            'checkout.',
      );
    }
    const git = gitVia(run, cwd);
    const tree = git(['rev-parse', `${remoteSha}^{tree}`]);
    const treeSha = tree.ok ? String(tree.stdout ?? '').trim() : '';
    const recorded = recordOutcome({ outcome: 'unchanged', tree: treeSha });
    if (!recorded.ok) return blocked(`I did not record the run result: ${recorded.reason}.`);
  }

  return {
    status: pushing ? 'changed' : 'unchanged',
    pushed: pushing,
    commitSha: sha || null,
    message: renderReport({
      summary: manifest?.summary,
      sha,
      commentId,
      trigger,
      triggerPhrase,
      repo,
      localSha,
      merged: merging ? mergedRef || mergedSha : '',
    }),
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const tmp = env.RUNNER_TEMP || '/tmp';
  const messageFile = path.join(tmp, 'ksai-message.txt');
  const verificationFile = env.VERIFICATION_FILE || path.join(tmp, 'ksai-fix-verification.json');

  const result = recordDo({
    manifestPath: env.MANIFEST,
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    remoteSha: env.REMOTE_SHA,
    repo: env.REPO,
    prNumber: env.PR_NUMBER,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    commentId: env.COMMENT_ID,
    trigger: env.SAW_TRIGGER,
    triggerPhrase: env.TRIGGER,
    commitFile: path.join(tmp, 'ksai-commit.json'),
    mergedSha: env.MERGED_SHA,
    mergedRef: env.MERGED_REF,
    conflicted: env.MERGE_CONFLICTED,
    mergeMessageFile: path.join(tmp, 'ksai-merge-message.txt'),
    checksPath: env.CHECKS_FILE,
    eventsPath: env.OPENCODE_EVENTS_FILE,
    verificationPath: verificationFile,
    changeScopePath: env.CHANGE_SCOPE_FILE,
    run,
  });

  process.stdout.write(`note: ${result.pushed ? 'a commit was pushed' : 'nothing was pushed'}.\n`);

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    message_file: messageFile,
    verification_file: verificationFile,
    commit_sha: result.commitSha ?? '',
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
