import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { runMain } from '../../lib/main.mjs';
import trustedGit from '../trusted-git.cjs';
import { BASE_SHA_FIELD, FAILURES, PLAN_FIELD, readHarnessInput, stateDirOf, validatePlan, writeHarnessResult } from './contract.mjs';
import { checkDeadline, checkedPath, writeRefusal } from './files.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const inside = (root, target) => target === root || target.startsWith(`${root}${sep}`);

function repositoryURL(env) {
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('invalid harness repository');
  const url = new URL(`https://github.com/${env.GITHUB_REPOSITORY}.git`);
  if (env.GH_TOKEN) {
    url.username = 'x-access-token';
    url.password = env.GH_TOKEN;
  }
  return url.href;
}

function safeLinks(path, root, check) {
  check();
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(path);
    if (isAbsolute(link) || !inside(root, resolve(dirname(path), link))) {
      rmSync(path);
      return;
    }
    try {
      if (!inside(root, realpathSync.native(path))) rmSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ELOOP') throw error;
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) safeLinks(join(path, name), root, check);
  }
}

function runGit(args, options) {
  const { cwd, timeout } = options;
  const child = spawnSync('git', trustedGit.gitArgs(cwd, args), {
    env: trustedGit.gitEnv(), timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL',
  });
  return { ok: child.status === 0, stdout: child.stdout ?? '' };
}

export function restoreBase({ record, plan, workspace, setup_deadline_at: deadlineAt }, {
  env = process.env, now = Date.now, run = runGit, remote = '',
} = {}) {
  const check = () => checkDeadline(deadlineAt, now);
  check();
  const base = record?.[BASE_SHA_FIELD];
  if (typeof base !== 'string' || !SHA.test(base)) throw new Error('invalid harness base commit');
  const { restore } = validatePlan(plan ?? record[PLAN_FIELD], env);
  const cwd = realpathSync(workspace ?? env.GITHUB_WORKSPACE);
  const git = (args) => {
    const started = now();
    checkDeadline(deadlineAt, () => started);
    const result = run(['--literal-pathspecs', ...args], { cwd, timeout: deadlineAt - started });
    check();
    return result;
  };
  const commits = [...new Set([base, ...restore.commits])];
  const missing = commits.filter((commit) => !git(['cat-file', '-e', `${commit}^{commit}`]).ok);
  if (missing.length && !git([
    'fetch', '--no-write-fetch-head', '--no-tags', '--depth=1', remote || repositoryURL(env), ...missing,
  ]).ok) return { ok: false, failure: FAILURES.baseUnavailable };
  if (missing.some((commit) => !git(['cat-file', '-e', `${commit}^{commit}`]).ok)) {
    return { ok: false, failure: FAILURES.baseUnavailable };
  }

  for (const name of restore.paths) {
    const path = checkedPath(cwd, name);
    const object = git(['ls-tree', '-z', '--format=%(objecttype)', base, '--', name]);
    if (!object.ok) throw new Error('cannot read the harness base tree');
    rmSync(path, { recursive: true, force: true });
    if (object.stdout === '') continue;
    if (!git(['restore', `--source=${base}`, '--worktree', '--', name]).ok) throw new Error('cannot restore the harness base tree');
    safeLinks(path, path, check);
  }
  check();
  return { ok: true };
}

await runMain(import.meta.url, async () => {
  const stateDir = stateDirOf(process.env.RUNNER_TEMP);
  try {
    const restored = restoreBase(readHarnessInput());
    if (restored.ok) writeHarnessResult(restored);
    else writeRefusal(stateDir, restored.failure, undefined);
  } catch (error) {
    writeRefusal(stateDir, FAILURES.restoreRefused, error);
  }
});
