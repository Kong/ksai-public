import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cap, MAX_PR_TITLE_CHARS, planDirOf, scrub, retargetPermalinks } = require('./plan.cjs');
const { safeEcho, verifyChunk, verifyMerge, gitVia, noChangeLeftBehind } = require('./verify-chunk.cjs');
const { renderDoMarker, MAX_REPORT_CHARS } = require('./do.cjs');
import { blockerFor, field, readManifest, reasonOf, runCommand, shown } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

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
  triggerPhrase = null,
  repo = null,
  localSha = null,
  merged = null,
} = {}) {
  const marker = renderDoMarker(commentId);
  if (!marker) return '';
  const retargeted = retargetPermalinks(scrub(field(summary), { triggerPhrase }), { repo, from: localSha, to: sha });
  const said = cap(retargeted.trim(), MAX_REPORT_CHARS);
  const footer = renderReportFooter({ sha, triggerPhrase, merged });
  return [footer, ...(said ? ['', said] : []), '', marker].join('\n');
}

export function recordDo({
  manifestPath = null,
  cwd = null,
  branch = null,
  remoteSha = null,
  repo = null,
  pushUrl = null,
  deniedPaths = null,
  planDir = null,
  commentId = null,
  triggerPhrase = null,
  commitFile = null,
  mergedSha = null,
  mergedRef = null,
  conflicted = null,
  mergeMessageFile = null,
  run = runCommand,
} = {}) {
  const block = blockerFor(manifestPath);
  const blocked = (message) => ({ ...block(message), pushed: false });
  const merging = String(mergedSha ?? '').trim() !== '';

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

  if (!renderDoMarker(commentId)) {
    return blocked(
      `I could not record this request, because \`${safeEcho(shown(commentId))}\` is not a comment id. Nothing ` +
        'was pushed: without the record, every later request would do this work again.',
    );
  }

  const pushing = merging || status === 'done';
  rmSync(manifestPath, { force: true });

  let sha = '';
  let localSha = '';
  if (pushing) {
    const noun = merging ? 'merge' : 'work';
    let verifiedSha = '';
    let verifiedTree = '';

    if (merging) {
      const verified = verifyMerge({ cwd, branch, remoteSha, mergedSha, manifestPath, deniedPaths, planDir });
      if (!verified.ok) return blocked(`I did not push the merge: ${verified.reason}`);
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
      });
      if (!verified.ok) return blocked(`I did not push the work: ${verified.reason}`);
      verifiedSha = verified.sha;
    }

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
      return blocked(
        `I did not put the ${noun} on the branch: ${published.reason}. Nothing was recorded, so a later request ` +
          'retries it.',
      );
    }
    localSha = verifiedSha;
    sha = published.sha;
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
  }

  return {
    status: pushing ? 'changed' : 'unchanged',
    pushed: pushing,
    message: renderReport({
      summary: manifest?.summary,
      sha,
      commentId,
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

  const result = recordDo({
    manifestPath: env.MANIFEST,
    cwd: env.GITHUB_WORKSPACE,
    branch: env.BRANCH,
    remoteSha: env.REMOTE_SHA,
    repo: env.REPO,
    pushUrl: env.PUSH_URL,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    commentId: env.COMMENT_ID,
    triggerPhrase: env.TRIGGER,
    commitFile: path.join(tmp, 'ksai-commit.json'),
    mergedSha: env.MERGED_SHA,
    mergedRef: env.MERGED_REF,
    conflicted: env.MERGE_CONFLICTED,
    mergeMessageFile: path.join(tmp, 'ksai-merge-message.txt'),
    run,
  });

  process.stdout.write(`note: ${result.pushed ? 'a commit was pushed' : 'nothing was pushed'}.\n`);

  writeFileSync(messageFile, `${result.message}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    status: result.status,
    message_file: messageFile,
  });
  process.stdout.write(`${result.message}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
