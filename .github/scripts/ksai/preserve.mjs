import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommand } from './run.mjs';
import { publishCommit } from './signed-push.mjs';
import { stopHeld } from './channel.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { MAX_DIRECT_COMMITS, deniedFor, gitVia, grammarFor, safeEcho, soleWritable, verifyChunk } =
  require('./verify-chunk.cjs');
const { planFilePathFor } = require('./plan.cjs');
const { stageAll } = require('./stage.cjs');

const MAX_SUBJECT_CHARS = 72;

export function wipSubject(phase) {
  const said = String(phase ?? '')
    .replaceAll(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const named = said === '' ? 'a run' : said;
  return `chore(stop): keep the work from ${named}`.slice(0, MAX_SUBJECT_CHARS);
}

export function decidePreserve({ preserve = '', mode = '', stopped = false, hard = false } = {}) {
  if (stopped !== true) return { keep: false, why: 'this run was not asked to stop' };
  if (hard === true || String(mode) === 'hard') return { keep: false, why: 'a hard stop preserves nothing by design' };
  if (String(preserve) !== 'auto') return { keep: false, why: 'stop_preserve is off' };
  return { keep: true, why: '' };
}

export function stopRecord(text) {
  const held = stopHeld(text);
  return { stopped: held.text.trim() !== '', hard: held.hard, hold: held.hold };
}

export function main(env = process.env, run = runCommand, read = readFileSync) {
  const outputs = { preserved: '', reason: '', tree: '' };
  let held = stopRecord('');
  try {
    held = stopRecord(read(String(env.STOP_FILE ?? ''), 'utf-8'));
  } catch {}
  const decided = decidePreserve({
    preserve: env.STOP_PRESERVE,
    mode: env.STOP_MODE,
    stopped: held.stopped,
    hard: held.hard,
  });
  if (!decided.keep) {
    outputs.reason = decided.why;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }

  const cwd = String(env.WORKSPACE ?? '');
  const branch = String(env.BRANCH ?? '');
  const git = gitVia(run, cwd);
  if (git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok) {
    outputs.reason =
      'the run was stopped inside a merge, and committing that here would land a second parent and whatever ' +
      'conflict markers are still in the tree, so only the artifact holds it';
    outputs.tree = cwd;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }
  const manifestPath = String(env.MANIFEST ?? '');
  const manifestRel = manifestPath === '' ? '' : path.relative(cwd, manifestPath);
  const staged = stageAll(git, manifestRel === '' ? [] : [manifestRel]);
  if (!staged.ok) {
    outputs.reason = `${staged.reason}, so only the artifact holds the remaining work`;
    outputs.tree = cwd;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }
  const nothingStaged = git(['diff', '--no-ext-diff', '--cached', '--quiet']).ok;
  if (!nothingStaged && !git(['commit', '--no-verify', '-m', wipSubject(env.PHASE)]).ok) {
    outputs.reason = 'the remaining work could not be committed, so only the artifact holds it';
    outputs.tree = cwd;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }

  const named = String(env.PLAN_FILE ?? '').trim() || planFilePathFor({ branch, dir: env.PLAN_DIR }) || '';
  const onlyPath = soleWritable(env.PHASE, named);
  const denied = deniedFor({
    deniedPaths: env.DENIED_PATHS,
    planDir: env.PLAN_DIR,
    workdir: cwd,
    baseSha: env.BASE_SHA,
    onlyPath,
  });
  const verified = verifyChunk({
    cwd,
    branch,
    remoteSha: env.BASE_SHA,
    manifestPath,
    deniedPaths: denied.denied,
    onlyPath,
    branchGrammar: grammarFor(env.PHASE),
    maxCommits: MAX_DIRECT_COMMITS,
  });
  if (!verified.ok) {
    outputs.reason = `the remaining work touches a path this flow may not push (${verified.reason}), so only the artifact holds it`;
    outputs.tree = cwd;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }

  const published = publishCommit({
    cwd,
    repo: env.REPO,
    branch,
    remoteSha: env.BASE_SHA,
    pushUrl: env.PUSH_URL,
    verifiedSha: verified.sha,
    bodyFile: path.join(path.dirname(manifestPath || cwd), 'ksai-preserve-commit.json'),
    git,
    run,
  });
  outputs.preserved = published.ok ? (nothingStaged ? 'committed' : 'pushed') : '';
  outputs.reason = published.ok ? '' : `the remaining work did not reach the branch: ${safeEcho(published.reason)}`;
  outputs.tree = cwd;
  writeOutputs(env.GITHUB_OUTPUT, outputs);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
