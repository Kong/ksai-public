import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { planDirOf } = require('./plan.cjs');
const { counted } = require('../lib/text.cjs');
const { deniedFor, deniedMatch, gitVia, safeEcho } = require('./verify-chunk.cjs');

const SHA_SHAPE = /^[0-9a-f]{40}$/;

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function mergeBaseRef({
  cwd = null,
  baseRef = null,
  baseBranch = null,
  remoteSha = null,
  deniedPaths = null,
  planDir = null,
  run = runCommand,
} = {}) {
  const outputs = {
    merged_sha: '',
    merged_ref: '',
    conflicted: '',
    error: '',
  };
  const refused = (error) => ({ ...outputs, error });

  const workdir = String(cwd ?? '');
  if (!workdir) return refused('this run had no workspace to merge the base branch into');

  const named = String(baseBranch ?? '').trim();
  const ref = String(baseRef ?? '').trim();
  if (!ref || !REF_SHAPE.test(ref) || ref.includes('..')) {
    return refused(
      'this pull request conflicts with its base branch, and that branch is not in this clone, so the conflict ' +
        'could not be merged in',
    );
  }

  const git = gitVia(run, workdir);
  const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const mergedSha = String(resolved?.stdout ?? '').trim();
  if (!resolved?.ok || !SHA_SHAPE.test(mergedSha)) {
    return refused(
      `\`${safeEcho(ref)}\` does not resolve to a commit in this clone, so the conflict with the base branch ` +
        'could not be merged in',
    );
  }

  const contained = git(['merge-base', '--is-ancestor', mergedSha, 'HEAD']);
  if (contained?.ok) {
    return refused(
      `this branch already contains \`${safeEcho(named || ref)}\`, so there is no merge to make here even though ` +
        'GitHub reports a conflict. Ask again in a few minutes, or resolve it on the branch',
    );
  }

  const tip = String(remoteSha ?? '').trim();
  if (!SHA_SHAPE.test(tip)) {
    return refused(
      'this run does not know which commit it checked out, so the paths it may not touch cannot be worked out ' +
        'and the conflict was left alone',
    );
  }

  const expanded = deniedFor({ workdir, baseSha: tip, deniedPaths, planDir, onlyPath: null });
  if (expanded.unreadable || expanded.truncated) {
    return refused(
      'the instruction files this run may not touch could not be worked out, so the conflict was left alone ' +
        'rather than merged into a tree nothing could check',
    );
  }

  const merged = git(['merge', '--no-commit', '--no-ff', mergedSha]);
  const unmerged = git(['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z']);
  const conflicted = String(unmerged?.stdout ?? '').split('\0').filter(Boolean);
  const abort = () => git(['merge', '--abort']);

  if (!merged?.ok && conflicted.length === 0) {
    abort();
    return refused(`git could not merge \`${safeEcho(named || ref)}\` into this branch at all - see the workflow run`);
  }

  for (const file of conflicted) {
    if (deniedMatch(file, expanded.denied)) {
      abort();
      return refused(
        `resolving this conflict means changing \`${safeEcho(file)}\`, which this flow may not touch. Resolve it ` +
          'on the branch yourself',
      );
    }
  }

  return { ...outputs, merged_sha: mergedSha, merged_ref: named || ref, conflicted: String(conflicted.length) };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const out = mergeBaseRef({
    cwd: env.WORKSPACE,
    baseRef: env.BASE_REF,
    baseBranch: env.BASE_BRANCH,
    remoteSha: env.REMOTE_SHA,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    run,
  });
  process.stdout.write(
    out.error
      ? `note: the base branch was not merged: ${out.error}\n`
      : `note: merged ${out.merged_sha} into the branch, with ${counted(Number(out.conflicted), 'conflicted path')} to resolve.\n`,
  );
  writeOutputs(env.GITHUB_OUTPUT, out);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
