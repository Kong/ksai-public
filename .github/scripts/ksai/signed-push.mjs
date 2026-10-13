import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { CREATE_COMMIT, MAX_COMMIT_LINE, PLAIN_FILE, splitMessage, wrapped } from '../lib/signed-commit.mjs';
import { COMMIT_WAIT_LIMIT, fallsBack } from './cp-commit.mjs';

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
    const [oldMode, newMode, , newSha, status] = head.slice(1).split(' ');
    const file = fields[at + 1] ?? '';
    if (!file) continue;
    at += 1;
    out.push({ oldMode, newMode, newSha, status: String(status ?? '').slice(0, 1), path: file });
  }
  return out;
}

const GITLINK = '160000';

export function fileChangesFor({ from, to, git, modes = false, paths = null }) {
  const asked = ['diff', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', from, to];
  const diff = git(paths ? [...asked, '--', ...paths.map((one) => `:(top,literal)${one}`)] : asked);
  if (!diff?.ok) return { unreadable: 'git could not list what the commit changed' };

  const additions = [];
  const deletions = [];
  for (const entry of parseRawDiff(diff.stdout)) {
    if (entry.status === 'D' || entry.newMode === ABSENT) {
      deletions.push({ path: entry.path });
      continue;
    }
    if (entry.newMode !== PLAIN_FILE && !modes) {
      return { unrepresentable: `\`${safeEcho(entry.path)}\` is mode ${entry.newMode}` };
    }
    if (entry.newMode === GITLINK) {
      additions.push({ path: entry.path, contents: Buffer.from(String(entry.newSha)).toString('base64'), mode: GITLINK });
      continue;
    }
    const blob = git(['cat-file', 'blob', `${to}:${entry.path}`], { base64: true });
    if (!blob?.ok) return { unreadable: `\`${safeEcho(entry.path)}\` could not be read out of the commit` };
    additions.push(
      entry.newMode === PLAIN_FILE
        ? { path: entry.path, contents: String(blob.stdout) }
        : { path: entry.path, contents: String(blob.stdout), mode: entry.newMode },
    );
  }
  return { additions, deletions };
}

export function conflictedPaths({ git, head, parent, tip }) {
  const replayed = git(['merge-tree', '--write-tree', '--name-only', '-z', head, parent], { keepStdout: true });
  const [tree, ...listed] = String(replayed?.stdout ?? '').split('\0');
  if (!SHA_SHAPE.test(tree.trim()) || (replayed?.status !== 0 && replayed?.status !== 1)) return null;
  const end = listed.indexOf('');
  const decided = git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', tree.trim(), tip]);
  if (!decided?.ok) return null;
  return [...new Set([...(end === -1 ? listed : listed.slice(0, end)), ...String(decided.stdout).split('\0').filter(Boolean)])];
}

export function mergeChanges({ git, tip, parent }) {
  const conflicted = conflictedPaths({ git, head: `${tip}^1`, parent, tip });
  if (!conflicted) return { unreadable: 'git could not list what the merge changed' };
  if (!conflicted.length) return { additions: [], deletions: [], conflicted };
  return { ...fileChangesFor({ from: parent, to: tip, git, modes: true, paths: conflicted }), conflicted };
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

function within(text, room) {
  let kept = '';
  for (const char of text) {
    if (kept.length + char.length > room) break;
    kept += char;
  }
  return kept.trimEnd();
}

export function coAuthorTrailer(said) {
  const one = String(said ?? '').trim();
  if (!CO_AUTHOR.test(one)) return null;
  const at = one.indexOf(' <');
  const name = within(one.slice(0, at), MAX_COMMIT_LINE - 'Co-authored-by: '.length - (one.length - at));
  return `Co-authored-by: ${name || one.slice(0, at)}${one.slice(at)}`;
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

function shortened(subject) {
  return subject.length <= MAX_COMMIT_LINE ? subject : `${within(subject, MAX_COMMIT_LINE - 1)}…`;
}

function fit(line) {
  return TRAILER.test(line) || REFERENCE.test(line) ? [line] : wrapped(line);
}

function fitted(lines) {
  return [shortened(lines[0]), ...lines.slice(1).flatMap((line) => fit(line))];
}

function withoutClaims(raw) {
  return String(raw ?? '')
    .split('\n')
    .filter((line) => !claimsTheCommit(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

export function normaliseMessage(raw) {
  const lines = fitted(withoutClaims(raw).split('\n'));
  if (lines.length < 2 || lines[1].trim() === '') return lines.join('\n');
  return [lines[0], '', ...lines.slice(1)].join('\n');
}

const TRAILER =
  /^(?:(?:Acked|Co-authored|Co-developed|Helped|Mentored|Released|Reported|Reviewed|Signed-off|Suggested|Tested)-by|Close[sd]?|Fix(?:e[sd])?|Jira|Ksai-[\w-]+|Refs?|Resolve[sd]?|See-also): \S/i;
const REFERENCE = /^(?:Close[sd]?|Fix(?:e[sd])?|Refs?|Resolve[sd]?) (?:[\w.-]+\/[\w.-]+)?#\d+$/i;
const FLOW_TRAILER = /^Ksai-[\w-]+:/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: \S/;
const BREAKING_SUBJECT = /^\w+(?:\([^)]*\))?!: /;

function footerIn(paragraph) {
  const breaking = [];
  const trailers = [];
  let continues = false;
  for (const line of paragraph.split('\n')) {
    if (BREAKING_FOOTER.test(line)) {
      breaking.push(line);
      continues = true;
    } else if (TRAILER.test(line) || REFERENCE.test(line)) {
      if (!FLOW_TRAILER.test(line)) trailers.push(line);
      continues = false;
    } else if (continues) {
      breaking[breaking.length - 1] += `\n${line}`;
    } else {
      return null;
    }
  }
  return { breaking, trailers };
}

function foldedBody(messages) {
  const breaking = [];
  const trailers = new Set();
  const entries = messages.map((message) => {
    const paragraphs = String(message).trim().split(/\n{2,}/);
    const footers = [];
    for (let footer = null; paragraphs.length > 1 && (footer = footerIn(paragraphs.at(-1))) !== null; paragraphs.pop()) {
      footers.unshift(footer);
    }
    const said = footers.flatMap((footer) => footer.breaking);
    if (said.length === 0 && BREAKING_SUBJECT.test(paragraphs[0])) said.push(`BREAKING CHANGE: ${paragraphs[0].split('\n')[0]}`);
    breaking.push(...said);
    for (const trailer of footers.flatMap((footer) => footer.trailers)) trailers.add(trailer);
    return `* ${paragraphs.join('\n\n')}`;
  });
  const footer = [...breaking, ...trailers];
  return [...entries, ...(footer.length > 0 ? [footer.join('\n')] : [])].join('\n\n');
}

export function foldedMessage(subject, messages) {
  const body = foldedBody(messages);
  return body ? `${subject}\n\n${body}` : subject;
}

function foldedFor({ git, from, foldUnder }) {
  if (!foldUnder) return { message: null };
  const listed = git(['log', '--reverse', '--first-parent', '--format=%B%x00', `${from}..HEAD`]);
  if (!listed?.ok) return { unreadable: 'the messages of the commits this pass made could not be read' };
  const commits = String(listed.stdout).split('\0').slice(0, -1);
  if (commits.length < 2) return { message: null };
  const body = foldedBody(commits.map((one) => withoutClaims(one).trim()).filter(Boolean))
    .split('\n')
    .flatMap((line) => fit(line))
    .join('\n');
  return { message: body ? `${shortened(foldUnder)}\n\n${body}` : shortened(foldUnder) };
}

function foldsFrom({ git, from, foldUnder }) {
  if (!foldUnder || git(['rev-parse', '--verify', '--quiet', 'HEAD^2'])?.ok) return false;
  const counted = git(['rev-list', '--count', '--first-parent', `${from}..HEAD`]);
  return Boolean(counted?.ok) && Number(String(counted.stdout).trim()) > 1;
}

function rewriteMessage({ git, log, coAuthor, jiraKey, messageFile = defaultMessageFile(), folds = false }) {
  const read = git(['log', '-1', '--format=%B']);
  if (!read?.ok) return { error: 'the local commit message could not be read, so nothing was published' };
  const raw = String(read.stdout);
  const stripped = normaliseMessage(raw);
  const { headline } = splitMessage(stripped);
  if (headline === '') {
    if (folds) return { changed: false };
    return { error: 'the commit message is nothing but an attribution footer, so there is no subject to keep' };
  }
  if (!folds && !SUBJECT_SHAPE.test(headline)) {
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

function asksControlPlane(env, appAuthor) {
  return usingControlPlane(env) && coAuthorTrailer(appAuthor) !== null;
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
  if (!writeBody(personFile, input)) return { why: `the commit could not be written to ${personFile}` };
  const asked = run(process.execPath, [CP_COMMIT, personFile], { timeout: COMMIT_WAIT_LIMIT });
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
  const why = oneLine(said?.why);
  return { why: why || 'the control plane could not be asked', lost: !why };
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

function descends({ run, repo, sha, from }) {
  const read = run('gh', ['api', `repos/${repo}/compare/${from}...${sha}`, '--jq', '.status']);
  return read.ok && String(read.stdout).trim() === 'ahead';
}

function readBack({ run, repo, branch, remoteSha, parent, localTree }) {
  const head = run('gh', ['api', `repos/${repo}/git/refs/heads/${branch}`, '--jq', '.object.sha']);
  const moved = head.ok ? String(head.stdout).trim() : '';
  if (!moved || moved === remoteSha) return null;
  const landed = headOf({ run, repo, sha: moved });
  const ours =
    landed.tree === localTree &&
    (parent === ''
      ? landed.parent === remoteSha
      : descends({ run, repo, sha: moved, from: remoteSha }) && descends({ run, repo, sha: moved, from: parent }));
  if (!ours) return { error: 'GitHub did not answer and the branch has moved - see the workflow run' };
  return landed.verified
    ? { signed: true, sha: moved }
    : { signed: false, sha: moved, reason: 'the verified work landed while its answer was lost, and GitHub did not sign it' };
}

function putBack({ run, repo, branch, sha, remoteSha }) {
  const held = sha ? run('gh', ['api', `repos/${repo}/git/refs/heads/${branch}`, '--jq', '.object.sha']) : { ok: false, stdout: '' };
  if (!held.ok || String(held.stdout).trim() !== sha) return 'left as it is because it no longer holds that commit - see the workflow run';
  const back = run('gh', ['api', '--method', 'PATCH', `repos/${repo}/git/refs/heads/${branch}`, '-f', `sha=${remoteSha}`, '-F', 'force=true', '--silent']);
  return back.ok ? 'put back' : 'left as it is - see the workflow run';
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
  controlPlaneOnly = false,
  coAuthor = env.CO_AUTHOR,
  foldUnder = null,
}) {
  const asking = asksControlPlane(env, appAuthor);
  const second = git(['rev-parse', '--verify', '--quiet', 'HEAD^2']);
  const parent = second?.ok ? String(second.stdout ?? '').trim() : '';
  if (parent !== '' && !asking) {
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
  const tipSha = String(tip.stdout).trim();

  if (parent !== '') {
    const first = git(['rev-parse', 'HEAD^1']);
    if (!first?.ok || String(first.stdout).trim() !== remoteSha) {
      return { error: 'the merge was not made on the head of the branch, so nothing was published' };
    }
  }
  const changes = parent !== '' ? mergeChanges({ git, tip: tipSha, parent }) : fileChangesFor({ from: remoteSha, to: tipSha, git, modes: asking });
  if (changes.unrepresentable) {
    return {
      signed: false,
      reason:
        `${changes.unrepresentable}, which a signed commit cannot carry - GitHub writes every file it creates ` +
        'as a plain file, so signing this one would drop the mode',
    };
  }
  if (changes.unreadable) {
    return asking ? { error: `${changes.unreadable}, so nothing was published` } : { signed: false, reason: `${changes.unreadable}, so it is pushed as it is` };
  }

  const folded = parent === '' ? foldedFor({ git, from: remoteSha, foldUnder }) : { message: null };
  if (folded.unreadable) {
    return asking ? { error: `${folded.unreadable}, so nothing was published` } : { signed: false, reason: `${folded.unreadable}, so it is pushed as it is` };
  }
  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    expectedHeadOid: remoteSha,
    message: splitMessage(folded.message === null ? message.stdout : withTrailers(folded.message, { coAuthor, jiraKey })),
    fileChanges: { additions: changes.additions, deletions: changes.deletions },
  };
  const asked = {
    ...input,
    message: splitMessage(withTrailers(folded.message ?? normaliseMessage(message.stdout), { coAuthor: appAuthor, jiraKey })),
    ...(parent !== '' ? { merge: { parent, conflicted: changes.conflicted } } : {}),
    ...(controlPlaneOnly ? { controlPlaneOnly: true } : {}),
  };
  const plain = fallsBack(asked);
  if (plain && !writeBody(bodyFile, input)) {
    return asking
      ? { error: `the mutation could not be written to ${bodyFile}, so nothing was published` }
      : { signed: false, reason: `the mutation could not be written to ${bodyFile}, so it is pushed as it is` };
  }

  const person = asking ? asThePerson({ run, bodyFile, log, input: asked }) : null;

  let answer = person?.commit;
  if (!answer && person?.lost && !plain) {
    const landed = readBack({ run, repo, branch, remoteSha, parent, localTree });
    if (landed) return landed;
  }
  if (!answer && controlPlaneOnly) return { error: 'the control plane did not commit the work, and a linked run publishes it no other way' };
  if (!answer && !plain) {
    return {
      error:
        `the control plane did not commit ${parent !== '' ? 'the merge' : 'a change to a file mode'} as whoever asked, ` +
        `and nothing else can sign it: ${person?.why ?? 'it was not asked'}`,
    };
  }
  if (!answer && person?.why) log(`note: KSAI commits as itself, because the control plane couldn't commit as the person who asked: ${person.why}`);
  if (!answer) {
    const created = run('gh', ['api', 'graphql', '--input', bodyFile]);
    if (!created.ok) {
      return (
        readBack({ run, repo, branch, remoteSha, parent, localTree }) ?? {
          signed: false,
          reason: 'GitHub would not create the commit - see the workflow run',
        }
      );
    }
    try {
      answer = JSON.parse(created.stdout).data.createCommitOnBranch.commit;
    } catch {
      return { signed: false, reason: 'GitHub answered something this could not read, so nothing was created' };
    }
  }

  if (answer?.tree?.oid !== localTree) {
    return {
      error:
        `the commit GitHub created holds ${answer?.tree?.oid ?? 'an unreadable tree'} where the verified one holds ` +
        `${localTree}, so it was not the work that was checked. The branch was ` +
        `${putBack({ run, repo, branch, sha: answer?.oid ? String(answer.oid) : '', remoteSha })}.`,
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
  controlPlaneOnly = false,
  foldUnder = null,
}) {
  if (controlPlaneOnly && !asksControlPlane(env, appAuthorOf(env))) {
    return { ok: false, reason: 'this run cannot ask the control plane to commit its work, and a linked run publishes it no other way' };
  }
  const folds = usingControlPlane(env) && foldsFrom({ git, from: createBranchAt ?? remoteSha, foldUnder });
  const normalised = rewriteMessage({ git, log, coAuthor, jiraKey, messageFile, folds });
  if (normalised.error) return { ok: false, reason: normalised.error };
  const localSha = normalised.sha ?? verifiedSha;
  const lfs = uploadLfsObjects({
    git,
    from: createBranchAt ?? remoteSha,
    to: localSha,
    pushUrl: controlPlaneOnly ? '' : pushUrl,
    remoteRefs: remoteLfsRefs,
  });
  if (!lfs.ok) return { ok: false, reason: controlPlaneOnly ? `a linked run uploads no Git LFS objects: ${lfs.reason}` : lfs.reason };

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
      if (usingControlPlane(env)) {
        return { ok: false, reason: 'the branch could not be created through the API, and a v5 run pushes nothing unsigned' };
      }
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
    controlPlaneOnly,
    coAuthor,
    foldUnder,
  });
  if (attempt.error) return { ok: false, reason: attempt.error };
  if (attempt.signed) return { ok: true, sha: attempt.sha, signed: true };

  if (attempt.sha && usingControlPlane(env)) {
    const back = putBack({ run, repo, branch, sha: attempt.sha, remoteSha: createBranchAt ?? remoteSha });
    return { ok: false, reason: `${attempt.reason}, and a v5 run keeps nothing unsigned, so the branch was ${back}` };
  }
  if (attempt.sha) {
    log(`note: ${attempt.reason}. The commit is on the branch unsigned.`);
    return { ok: true, sha: attempt.sha, signed: false };
  }
  if (controlPlaneOnly) return { ok: false, reason: `${attempt.reason}, and a linked run publishes nothing but through the control plane` };
  if (usingControlPlane(env)) return { ok: false, reason: `${attempt.reason}, and a v5 run pushes nothing unsigned` };

  log(`note: ${attempt.reason}. The commit is pushed unsigned.`);
  const pushed = git(['push', pushUrl, `${branch}:refs/heads/${branch}`]);
  return pushed.ok ? { ok: true, sha: localSha, signed: false } : { ok: false, reason: 'the push failed' };
}
