import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { CREATE_COMMIT, PLAIN_FILE, splitMessage } from '../lib/signed-commit.mjs';

export { splitMessage };

const require = createRequire(import.meta.url);
const { COMMIT_TYPES, safeEcho } = require('./verify-chunk.cjs');
const { trustedIdentity, uploadLfsObjects } = require('./trusted-git.cjs');
const { SUBJECT_SHAPE } = require('./plan.cjs');
const { JIRA_KEY_SHAPE } = require('../lib/select-arm.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');

export const CP_COMMIT = fileURLToPath(new URL('./cp-commit.mjs', import.meta.url));

const defaultBodyFile = () => path.join(process.env.RUNNER_TEMP || tmpdir(), 'ksai-commit.json');

const defaultMessageFile = () => path.join(process.env.RUNNER_TEMP || tmpdir(), 'ksai-commit-message.txt');

const ABSENT = '000000';

export function parseRawDiff(stdout) {
  const fields = String(stdout ?? '').split('\0');
  const out = [];
  for (let at = 0; at < fields.length; at += 1) {
    const head = fields[at];
    if (!head.startsWith(':')) continue;
    const [oldMode, newMode, , , status] = head.slice(1).split(' ');
    const file = fields[at + 1] ?? '';
    if (!file) continue;
    at += 1;
    out.push({ oldMode, newMode, status: String(status ?? '').slice(0, 1), path: file });
  }
  return out;
}

export function fileChangesFor({ from, to, git }) {
  const diff = git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', from, to]);
  if (!diff?.ok) return { unreadable: 'git could not list what the commit changed' };

  const additions = [];
  const deletions = [];
  for (const entry of parseRawDiff(diff.stdout)) {
    if (entry.status === 'D' || entry.newMode === ABSENT) {
      deletions.push({ path: entry.path });
      continue;
    }
    if (entry.newMode !== PLAIN_FILE) {
      return { unrepresentable: `\`${safeEcho(entry.path)}\` is mode ${entry.newMode}` };
    }
    const blob = git(['cat-file', 'blob', `${to}:${entry.path}`], { base64: true });
    if (!blob?.ok) return { unreadable: `\`${safeEcho(entry.path)}\` could not be read out of the commit` };
    additions.push({ path: entry.path, contents: String(blob.stdout) });
  }
  return { additions, deletions };
}

const claimsTheCommit = (line) => {
  const said = line.trim().toLowerCase();
  return (
    said.startsWith('co-authored-by:') ||
    said.startsWith('released-by:') ||
    said.startsWith('jira:') ||
    said.includes('noreply@anthropic.com') ||
    /generated (?:with|by) \[?claude/.test(said)
  );
};

const CO_AUTHOR = /^[^\n<>]+ <[^\s<>@]+@[^\s<>@]+>$/;

export function coAuthorTrailer(said) {
  const one = String(said ?? '').trim();
  return CO_AUTHOR.test(one) ? `Co-authored-by: ${one}` : null;
}

export function jiraTrailer(said) {
  const one = String(said ?? '')
    .trim()
    .toUpperCase();
  return JIRA_KEY_SHAPE.test(one) ? `Jira: ${one}` : null;
}

export function withTrailers(message, { coAuthor = null, jiraKey = null } = {}) {
  const trailers = [coAuthorTrailer(coAuthor), jiraTrailer(jiraKey)].filter(Boolean);
  if (!trailers.length) return String(message ?? '');
  const body = String(message ?? '').replace(/\s+$/, '');
  const block = trailers.join('\n');
  return body ? `${body}\n\n${block}` : block;
}

export function normaliseMessage(raw) {
  const kept = String(raw ?? '')
    .split('\n')
    .filter((line) => !claimsTheCommit(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  const lines = kept.split('\n');
  if (lines.length < 2 || lines[1].trim() === '') return kept;
  return [lines[0], '', ...lines.slice(1)].join('\n');
}

function rewriteMessage({ git, log, coAuthor, jiraKey, messageFile = defaultMessageFile() }) {
  const read = git(['log', '-1', '--format=%B']);
  if (!read?.ok) return { error: 'the local commit message could not be read, so nothing was published' };
  const raw = String(read.stdout);
  const stripped = normaliseMessage(raw);
  const { headline } = splitMessage(stripped);
  if (headline === '') {
    return { error: 'the commit message is nothing but an attribution footer, so there is no subject to keep' };
  }
  if (!SUBJECT_SHAPE.test(headline)) {
    return {
      error:
        `the commit subject is not a Conventional Commit subject with a scope: ${safeEcho(headline)}. It must ` +
        `read \`<type>(<scope>): <description>\`, with a type from ${COMMIT_TYPES.join(', ')}.`,
    };
  }
  const cleaned = withTrailers(stripped, { coAuthor, jiraKey });
  if (cleaned === raw.replace(/\s+$/, '')) return { changed: false };

  const treeBefore = git(['rev-parse', 'HEAD^{tree}']);
  const parentsBefore = git(['rev-parse', 'HEAD^@']);
  if (!treeBefore?.ok || !parentsBefore?.ok) {
    return { error: 'the local commit could not be read, so nothing was published' };
  }

  writeFileSync(messageFile, `${cleaned}\n`);
  const amended = git(['commit', '--amend', '--allow-empty', '--no-verify', '--cleanup=verbatim', '--file', messageFile]);
  if (!amended?.ok) return { error: 'the commit message could not be rewritten, so nothing was published' };

  const treeAfter = git(['rev-parse', 'HEAD^{tree}']);
  const parentsAfter = git(['rev-parse', 'HEAD^@']);
  const moved = git(['rev-parse', 'HEAD']);
  if (!treeAfter?.ok || !parentsAfter?.ok || !moved?.ok) {
    return { error: 'the rewritten commit could not be read, so nothing was published' };
  }
  if (
    String(treeAfter.stdout).trim() !== String(treeBefore.stdout).trim() ||
    String(parentsAfter.stdout).trim() !== String(parentsBefore.stdout).trim()
  ) {
    return { error: 'rewriting the commit message changed the commit itself, so nothing was published' };
  }

  log('note: rewrote the commit message into the one that lands - see normaliseMessage.');
  return { sha: String(moved.stdout).trim() };
}

export function appAuthorOf(env = process.env) {
  const identity = trustedIdentity(env);
  return identity.ok && env.KSAI_GIT_AUTHOR_NAME ? `${identity.name} <${identity.email}>` : null;
}

function writeBody(file, input) {
  try {
    writeFileSync(file, `${JSON.stringify({ query: CREATE_COMMIT, variables: { input } })}\n`);
    return true;
  } catch {
    return false;
  }
}

const oneLine = (said) => String(said ?? '').replace(/\p{Cc}+/gu, ' ').trim().slice(0, 300);

function asThePerson({ run, input, bodyFile, log }) {
  const personFile = bodyFile.replace(/(\.json)?$/, '-person.json');
  if (!writeBody(personFile, input)) {
    log(`note: the commit could not be written to ${personFile}, so this App makes it.`);
    return null;
  }
  const asked = run(process.execPath, [CP_COMMIT, personFile]);
  let said = null;
  try {
    said = JSON.parse(String(asked.stdout ?? '').trim().split('\n').at(-1));
  } catch {
    said = null;
  }
  if (asked.ok && said?.commit) {
    log(`note: the control plane made this commit as ${oneLine(said.author)}, who asked for it.`);
    return said;
  }
  const why = oneLine(said?.why) || 'the control plane could not be asked';
  log(`note: the control plane did not commit as whoever asked, so this App does: ${why}`);
  return null;
}

function headOf({ run, repo, sha }) {
  const read = run('gh', ['api', `repos/${repo}/git/commits/${sha}`]);
  let held;
  try {
    held = read.ok ? JSON.parse(read.stdout) : null;
  } catch {
    held = null;
  }
  const parents = Array.isArray(held?.parents) ? held.parents : [];
  return {
    tree: String(held?.tree?.sha ?? ''),
    parent: parents.length === 1 ? String(parents[0]?.sha ?? '') : '',
    verified: held?.verification?.verified === true,
  };
}

export function pushSigned({
  cwd: _cwd,
  repo,
  branch,
  remoteSha,
  git,
  run,
  bodyFile = defaultBodyFile(),
  env = process.env,
  appAuthor = appAuthorOf(env),
  jiraKey = env.JIRA_KEY,
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  const second = git(['rev-parse', '--verify', '--quiet', 'HEAD^2']);
  if (second?.ok && String(second.stdout ?? '').trim() !== '') {
    return {
      signed: false,
      reason:
        'this is a merge commit and `createCommitOnBranch` parents every commit it makes on the branch tip ' +
        'alone, so signing it would drop the side it merged in and land a commit that carries the content ' +
      'without the merge',
    };
  }
  const tip = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const message = git(['log', '-1', '--format=%B']);
  if (!tip?.ok || !tree?.ok || !message?.ok) {
    return { signed: false, reason: 'the local commit could not be read, so it is pushed as it is' };
  }
  const localTree = String(tree.stdout).trim();

  const changes = fileChangesFor({ from: remoteSha, to: String(tip.stdout).trim(), git });
  if (changes.unrepresentable) {
    return {
      signed: false,
      reason:
        `${changes.unrepresentable}, which a signed commit cannot carry - GitHub writes every file it creates ` +
        'as a plain file, so signing this one would drop the mode',
    };
  }
  if (changes.unreadable) return { signed: false, reason: `${changes.unreadable}, so it is pushed as it is` };

  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    expectedHeadOid: remoteSha,
    message: splitMessage(message.stdout),
    fileChanges: { additions: changes.additions, deletions: changes.deletions },
  };
  if (!writeBody(bodyFile, input)) {
    return { signed: false, reason: `the mutation could not be written to ${bodyFile}, so it is pushed as it is` };
  }

  const person = usingControlPlane(env) && coAuthorTrailer(appAuthor)
    ? asThePerson({
        run,
        bodyFile,
        log,
        input: { ...input, message: splitMessage(withTrailers(normaliseMessage(message.stdout), { coAuthor: appAuthor, jiraKey })) },
      })
    : null;

  let answer = person?.commit;
  if (!answer) {
    const created = run('gh', ['api', 'graphql', '--input', bodyFile]);
    if (!created.ok) {
      const head = run('gh', ['api', `repos/${repo}/git/refs/heads/${branch}`, '--jq', '.object.sha']);
      const moved = head.ok ? String(head.stdout).trim() : '';
      if (moved && moved !== remoteSha) {
        const landed = headOf({ run, repo, sha: moved });
        if (landed.tree !== localTree || landed.parent !== remoteSha) {
          return { error: 'GitHub did not answer and the branch has moved - see the workflow run' };
        }
        return landed.verified
          ? { signed: true, sha: moved }
          : { signed: false, sha: moved, reason: 'the verified work landed while its answer was lost, and GitHub did not sign it' };
      }
      return { signed: false, reason: 'GitHub would not create the commit - see the workflow run' };
    }
    try {
      answer = JSON.parse(created.stdout).data.createCommitOnBranch.commit;
    } catch {
      return { signed: false, reason: 'GitHub answered something this could not read, so nothing was created' };
    }
  }

  if (answer?.tree?.oid !== localTree) {
    const held = answer?.oid
      ? run('gh', ['api', `repos/${repo}/git/refs/heads/${branch}`, '--jq', '.object.sha'])
      : { ok: false, stdout: '' };
    const stillOurs = held.ok && String(held.stdout).trim() === String(answer.oid);
    const back = stillOurs
      ? run('gh', [
          'api',
          '--method',
          'PATCH',
          `repos/${repo}/git/refs/heads/${branch}`,
          '-f',
          `sha=${remoteSha}`,
          '-F',
          'force=true',
          '--silent',
        ])
      : { ok: false };
    return {
      error:
        `the commit GitHub created holds ${answer?.tree?.oid ?? 'an unreadable tree'} where the verified one holds ` +
        `${localTree}, so it was not the work that was checked. The branch was ` +
        `${back.ok ? 'put back' : `left as it is${stillOurs ? '' : ' because it no longer holds that commit'} - see the workflow run`}.`,
    };
  }

  if (answer?.signature?.state !== 'VALID') {
    return {
      signed: false,
      sha: answer?.oid ? String(answer.oid) : '',
      reason: `GitHub created the commit but did not sign it (${answer?.signature?.state})`,
    };
  }
  return { signed: true, sha: String(answer.oid) };
}

const SHA_SHAPE = /^[0-9a-f]{40}$/;

export function alignToBranch({ git, pushUrl, branch }) {
  const fetched = git(['fetch', '--depth', '2', pushUrl, `+${branch}:refs/ksai/aligned`]);
  if (!fetched?.ok) return { ok: false, reason: `\`${branch}\` could not be fetched` };
  const reset = git(['reset', '--mixed', 'refs/ksai/aligned']);
  const tip = git(['rev-parse', 'HEAD']);
  const sha = String(tip?.stdout ?? '').trim();
  if (!reset?.ok || !tip?.ok || !SHA_SHAPE.test(sha)) {
    return { ok: false, reason: `the tip of \`${branch}\` could not be read back` };
  }
  return { ok: true, sha };
}

export function publishCommit({
  cwd,
  repo,
  branch,
  remoteSha,
  pushUrl,
  verifiedSha,
  git,
  run,
  bodyFile = defaultBodyFile(),
  messageFile = defaultMessageFile(),
  createBranchAt = null,
  env = process.env,
  coAuthor = env.CO_AUTHOR,
  remoteLfsRefs = [],
  jiraKey = env.JIRA_KEY,
  log = (message) => process.stdout.write(`${message}\n`),
}) {
  const normalised = rewriteMessage({ git, log, coAuthor, jiraKey, messageFile });
  if (normalised.error) return { ok: false, reason: normalised.error };
  const localSha = normalised.sha ?? verifiedSha;
  const lfs = uploadLfsObjects({
    git,
    from: createBranchAt ?? remoteSha,
    to: localSha,
    pushUrl,
    remoteRefs: remoteLfsRefs,
  });
  if (!lfs.ok) return { ok: false, reason: lfs.reason };

  if (createBranchAt) {
    const made = run('gh', [
      'api',
      '--method',
      'POST',
      `repos/${repo}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${createBranchAt}`,
      '--silent',
    ]);
    if (!made.ok) {
      log(`note: the branch could not be created through the API, so this commit is pushed unsigned.`);
      const pushed = git(['push', pushUrl, `${branch}:refs/heads/${branch}`]);
      return pushed.ok ? { ok: true, sha: localSha, signed: false } : { ok: false, reason: 'the push failed' };
    }
  }

  const attempt = pushSigned({
    cwd,
    repo,
    branch,
    remoteSha: createBranchAt ?? remoteSha,
    git,
    run,
    bodyFile,
    env,
    jiraKey,
    log,
  });
  if (attempt.error) return { ok: false, reason: attempt.error };
  if (attempt.signed) return { ok: true, sha: attempt.sha, signed: true };

  if (attempt.sha) {
    log(`note: ${attempt.reason}. The commit is on the branch unsigned.`);
    return { ok: true, sha: attempt.sha, signed: false };
  }

  log(`note: ${attempt.reason}. The commit is pushed unsigned.`);
  const pushed = git(['push', pushUrl, `${branch}:refs/heads/${branch}`]);
  return pushed.ok ? { ok: true, sha: localSha, signed: false } : { ok: false, reason: 'the push failed' };
}
