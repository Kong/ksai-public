import { writeOutputs } from '../../lib/outputs.mjs';
import { runMain } from '../../lib/main.mjs';
import trustedGit from '../trusted-git.cjs';

const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const said = (value) => String(value ?? '').trim();
const splitZ = (stdout) => String(stdout ?? '').split('\0').filter(Boolean);

export function startMerge({ git, head, base, remote }) {
  if (!COMMIT.test(head) || !COMMIT.test(base)) throw new Error('the record names no whole commit to merge or to merge into');
  const at = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!at.ok || said(at.stdout) !== head) throw new Error('the checkout is not at the commit the stage was bound to');
  const shallow = said(git(['rev-parse', '--is-shallow-repository']).stdout) === 'true';
  const held = !shallow && git(['cat-file', '-e', `${base}^{commit}`]).ok;
  if (!held && !git(['fetch', '--quiet', '--no-tags', ...(shallow ? ['--unshallow'] : []), remote, base]).ok) {
    throw new Error(`the base ${base} could not be fetched`);
  }
  if (git(['merge-base', '--is-ancestor', base, 'HEAD']).ok) {
    throw new Error(`the branch already holds the base ${base}, so there is no merge to resolve`);
  }
  const merged = git(['merge', '--no-commit', '--no-ff', '--quiet', base]);
  const unmerged = git(['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z']);
  const conflicted = splitZ(unmerged.stdout);
  if (!unmerged.ok || (!merged.ok && conflicted.length === 0)) throw new Error(`git could not merge the base ${base} into the branch`);
  return { conflicted };
}

export function main(env = process.env, { git = null } = {}) {
  try {
    const repository = said(env.SOURCE_REPO);
    if (!REPO.test(repository)) throw new Error('the run names no repository to fetch the base from');
    const { conflicted } = startMerge({
      git: git ?? trustedGit.directGit(said(env.GITHUB_WORKSPACE)),
      head: said(env.BOUND_HEAD_SHA),
      base: said(env.MERGE_BASE),
      remote: `https://x-access-token:${said(env.GH_TOKEN)}@github.com/${repository}.git`,
    });
    writeOutputs(env.GITHUB_OUTPUT, { conflicted: String(conflicted.length) });
    return conflicted.length;
  } catch (error) {
    writeOutputs(env.GITHUB_OUTPUT, { error: error.message });
    throw error;
  }
}

await runMain(import.meta.url, async () => {
  console.log(`the base is merged into the checkout, uncommitted, with ${main()} conflicted paths for the stage to resolve`);
});
