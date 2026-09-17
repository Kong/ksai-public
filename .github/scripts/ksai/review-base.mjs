import { pathToFileURL } from 'node:url';

import { runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const SHA_SHAPE = /^[0-9a-f]{40}$/;

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

const REPO_SHAPE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const NUMBER_SHAPE = /^[1-9][0-9]{0,9}$/;

const API_TIMEOUT_MS = 30_000;

const distance = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

/**
 * fetchReviewBase makes the base branch reachable from a review's shallow checkout.
 *
 * It fetches the base branch and the pull request head only as deep as their merge base, and fetches
 * full history when that merge base cannot be proven in the clone.
 */
export async function fetchReviewBase({
  repo = '',
  number = '',
  token = '',
  apiUrl = 'https://api.github.com',
  cwd = process.cwd(),
  remote = '',
  fetchImpl = fetch,
  run = runCommand,
  log = console.log,
} = {}) {
  if (!REPO_SHAPE.test(repo) || !NUMBER_SHAPE.test(String(number))) {
    throw new Error('the review names no pull request this step can read its base from');
  }
  const api = String(apiUrl).replace(/\/+$/, '');
  const pull = await getJson(fetchImpl, `${api}/repos/${repo}/pulls/${number}`, token);
  const ref = String(pull?.base?.ref ?? '');
  if (!REF_SHAPE.test(ref) || ref.includes('..')) throw new Error('the pull request names a base branch this step will not fetch');

  const git = (args) => run('git', args, { cwd, stderr: 'ignore' });
  const head = String(git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout ?? '').trim();
  if (!SHA_SHAPE.test(head)) return { ref, depth: '' };

  const url = remote || `https://x-access-token:${token}@github.com/${repo}.git`;
  const baseSpec = `+refs/heads/${ref}:refs/remotes/origin/${ref}`;
  const shallow = String(git(['rev-parse', '--is-shallow-repository']).stdout ?? '').trim() === 'true';
  if (!shallow) {
    git(['fetch', '--no-tags', url, baseSpec]);
    return { ref, depth: 'full' };
  }

  let compare = null;
  try {
    const segments = ref.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    compare = await getJson(fetchImpl, `${api}/repos/${repo}/compare/${segments}...${head}?per_page=1`, token);
  } catch (error) {
    log(`::notice::the merge base could not be read (${error.message}), so the review fetches full history`);
  }
  const behind = distance(compare?.behind_by);
  const ahead = distance(compare?.ahead_by);
  const mergeBase = String(compare?.merge_base_commit?.sha ?? '');
  if (behind !== null && ahead !== null && SHA_SHAPE.test(mergeBase)) {
    const reached = git(['fetch', '--no-tags', `--depth=${behind + 1}`, url, baseSpec]).ok
      && git(['fetch', '--no-tags', `--depth=${ahead + 1}`, url, head]).ok
      && String(git(['merge-base', `refs/remotes/origin/${ref}`, 'HEAD']).stdout ?? '').trim() === mergeBase;
    if (reached) {
      log(`The review fetched ${ahead} commits of the pull request and ${behind} of ${ref} back to their merge base`);
      return { ref, depth: 'merge-base' };
    }
    log('::notice::the shallow fetch did not reach the merge base, so the review fetches full history');
  }
  if (!git(['fetch', '--no-tags', '--unshallow', url, baseSpec]).ok) git(['fetch', '--no-tags', url, baseSpec]);
  return { ref, depth: 'full' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const answer = await fetchReviewBase({
      repo: process.env.SOURCE_REPO,
      number: process.env.ISSUE_NUM,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    writeOutputs(process.env.GITHUB_OUTPUT, {
      ref: answer.ref,
    });
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
