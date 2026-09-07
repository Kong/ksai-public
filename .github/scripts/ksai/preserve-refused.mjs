import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommand } from './run.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { planDirOf } = require('./plan.cjs');
const { ANY_DEPTH_FLOOR, DENIED_PREFIX_FLOOR, deniedFor, gitVia } = require('./verify-chunk.cjs');
const { stageAllowed } = require('./stage.cjs');
const { lfsObjectsFromIndex, validLfsObject } = require('./trusted-git.cjs');

const SHA_SHAPE = /^[0-9a-f]{40}$/;

const PATCH_FILE = 'refused.diff';

const EXCLUDED_FILE = 'excluded.txt';

const RECOVERY_FILE = 'RECOVER.md';

const RECOVERY_METADATA = 'recovery.json';

const MAX_ATTRIBUTES_BYTES = 16 * 1024 * 1024;

const lfsArtifactPath = (oid) => path.posix.join('lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);

function baseAttributeState(git, base, file) {
  const listed = git(['ls-tree', '-z', base, '--', `:(top,literal)${file}`]);
  if (!listed?.ok) return { ok: false };
  const records = String(listed.stdout ?? '').split('\0').filter(Boolean);
  if (records.length === 0) return { ok: true, kind: 'absent', body: null };
  if (records.length !== 1) return { ok: false };
  const tab = records[0].indexOf('\t');
  if (tab === -1 || records[0].slice(tab + 1) !== file) return { ok: false };
  const [mode, type, oid] = records[0].slice(0, tab).split(' ');
  if (!mode || !type || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return { ok: false };
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
    return { ok: true, kind: 'other', body: null };
  }
  const read = git(['cat-file', 'blob', oid], { base64: true });
  return read?.ok
    ? { ok: true, kind: 'regular', body: Buffer.from(String(read.stdout ?? ''), 'base64') }
    : { ok: false };
}

function indexAttributeState(git, file) {
  const listed = git(['ls-files', '--stage', '-z', '--', `:(top,literal)${file}`]);
  if (!listed?.ok) return { ok: false };
  const records = String(listed.stdout ?? '').split('\0').filter(Boolean);
  if (records.length === 0) return { ok: true, kind: 'absent', body: null };
  if (records.length !== 1) return { ok: false };
  const tab = records[0].indexOf('\t');
  if (tab === -1 || records[0].slice(tab + 1) !== file) return { ok: false };
  const [mode, oid, stage] = records[0].slice(0, tab).split(' ');
  if (stage !== '0' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return { ok: false };
  if (mode !== '100644' && mode !== '100755') return { ok: true, kind: 'other', body: null };
  const read = git(['cat-file', 'blob', oid], { base64: true });
  return read?.ok
    ? { ok: true, kind: 'regular', body: Buffer.from(String(read.stdout ?? ''), 'base64') }
    : { ok: false };
}

function worktreeAttributeState(workdir, file) {
  const root = path.resolve(workdir);
  const target = path.resolve(root, ...file.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false };
  try {
    const entry = lstatSync(target);
    if (!entry.isFile()) return { ok: true, kind: 'other', body: null };
    if (entry.size > MAX_ATTRIBUTES_BYTES) return { ok: false };
    return { ok: true, kind: 'regular', body: readFileSync(target) };
  } catch (error) {
    return error?.code === 'ENOENT' ? { ok: true, kind: 'absent', body: null } : { ok: false };
  }
}

function sameAttributeState(left, right) {
  if (left.kind !== right.kind) return false;
  return left.kind !== 'regular' || left.body.equals(right.body);
}

function excludedAttributesChanged({ git, workdir, base, paths }) {
  const attributes = [...new Set(paths.map((file) => String(file ?? '').split(path.sep).join('/')))].filter(
    (file) => path.posix.basename(file) === '.gitattributes',
  );
  for (const file of attributes) {
    const prior = baseAttributeState(git, base, file);
    const staged = indexAttributeState(git, file);
    const current = worktreeAttributeState(workdir, file);
    if (!prior.ok || !staged.ok || !current.ok) return { ok: false, file: '' };
    if (!sameAttributeState(prior, staged) || !sameAttributeState(prior, current)) return { ok: true, file };
  }
  return { ok: true, file: '' };
}

function recoveryGuide(hasLfs, hasRemoteLfs) {
  const lines = [
    '# Recover refused KSAI work',
    '',
    '1. Check out the base commit named in `recovery.json`.',
    '2. Run `git apply refused.diff` from the repository root.',
  ];
  let step = 3;
  if (hasLfs) {
    lines.push(`${step}. Copy each Git LFS object listed in \`recovery.json\` from its artifact path to the same relative path under the repository Git directory.`);
    step += 1;
  }
  if (hasRemoteLfs) {
    lines.push(`${step}. Run \`git lfs pull\` to fetch the base-resident objects listed in \`recovery.json\`.`);
    step += 1;
  }
  if (hasLfs || hasRemoteLfs) lines.push(`${step}. Run \`git lfs checkout\` to replace the pointers with their payloads.`);
  lines.push('', 'Paths listed in `excluded.txt` were deliberately not preserved.', '');
  return lines.join('\n');
}

export function exclusionsFor(denied) {
  return [
    ...denied.flatMap((entry) => [
      `:(exclude,top)${entry}`,
      ...(ANY_DEPTH_FLOOR.includes(entry) ? [`:(exclude,top,glob)**/${entry}`] : []),
    ]),
    ...DENIED_PREFIX_FLOOR.flatMap((prefix) => [
      `:(exclude,top,glob)${prefix}*`,
      `:(exclude,top,glob)**/${prefix}*`,
    ]),
  ];
}

export function withKeptLine(message, said) {
  const body = String(message ?? '').replace(/\s+$/, '');
  const lines = body.split('\n');
  const at = lines.findLastIndex((line) => line.trim() !== '');
  if (at === -1) return said;
  if (/^<!--\s*ksai-/.test(lines[at].trim())) {
    return [...lines.slice(0, at), said, '', lines[at]].join('\n');
  }
  return [...lines, '', said].join('\n');
}

export function preserveRefused({
  cwd = null,
  remoteSha = null,
  outDir = null,
  manifestPath = null,
  deniedPaths = null,
  planDir = null,
  mergedSha = null,
  run = runCommand,
  write = writeFileSync,
  makeDir = mkdirSync,
  copy = copyFileSync,
} = {}) {
  const empty = { tree: '', kept: '', excluded: '' };
  const workdir = String(cwd ?? '');
  const base = String(remoteSha ?? '').trim();
  const at = String(outDir ?? '').trim();
  if (!workdir || !at || !SHA_SHAPE.test(base)) return { ...empty, reason: 'there was nothing to measure against' };

  const git = gitVia(run, workdir);
  if (!git.policy.ok) return { ...empty, reason: git.policy.reason };
  const expanded = deniedFor({
    workdir,
    baseSha: base,
    deniedPaths,
    planDir,
    onlyPath: null,
  });
  if (expanded.unreadable || expanded.truncated) {
    return { ...empty, reason: 'the paths this flow may not publish are not known in full' };
  }

  const manifestRel = manifestPath ? path.relative(workdir, manifestPath) : '';
  const attributes = excludedAttributesChanged({
    git,
    workdir,
    base,
    paths: [...expanded.denied, manifestRel],
  });
  if (!attributes.ok) return { ...empty, reason: 'the excluded Git attributes could not be compared safely' };
  if (attributes.file) {
    return {
      ...empty,
      reason: 'an excluded .gitattributes change could alter the files staged for recovery',
    };
  }
  const exclusions = [
    ...exclusionsFor(expanded.denied),
    ...(manifestRel && !manifestRel.startsWith('..') ? [`:(exclude,top,literal)${manifestRel}`] : []),
  ];

  const staged = stageAllowed(git, exclusions);
  if (!staged.ok) return { ...empty, reason: staged.reason };
  const diff = git(['diff', '--cached', '--binary', '--no-ext-diff', base, '--', ...exclusions]);
  if (!diff.ok) return { ...empty, reason: 'the refused work could not be read back' };
  const patch = String(diff.stdout ?? '');
  if (patch.trim() === '') return { ...empty, reason: 'the run left nothing behind to keep' };
  const lfs = lfsObjectsFromIndex({ git, from: base, pathspec: exclusions });
  if (!lfs.ok) return { ...empty, reason: lfs.reason };
  const objects = lfs.objects.map(({ oid, size, source }) => ({
    oid,
    size,
    source,
    artifact: lfsArtifactPath(oid),
  }));

  try {
    makeDir(at, { recursive: true });
    for (const object of objects) {
      const target = path.join(at, ...object.artifact.split('/'));
      makeDir(path.dirname(target), { recursive: true });
      copy(object.source, target, constants.COPYFILE_EXCL);
      if (!validLfsObject(target, object, at)) throw new Error('copied Git LFS object did not match its pointer');
    }
    write(path.join(at, PATCH_FILE), patch);
    write(path.join(at, EXCLUDED_FILE), `${expanded.stated.join('\n')}\n`);
    write(path.join(at, RECOVERY_FILE), recoveryGuide(objects.length > 0, lfs.remoteObjects.length > 0));
    write(
      path.join(at, RECOVERY_METADATA),
      `${JSON.stringify(
        {
          version: 1,
          base,
          patch: PATCH_FILE,
          lfsObjects: objects.map(({ oid, size, artifact }) => ({ oid, size, artifact })),
          lfsRemoteObjects: lfs.remoteObjects,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    return { ...empty, reason: 'the refused work could not be written out' };
  }

  return {
    tree: at,
    kept: PATCH_FILE,
    guide: RECOVERY_FILE,
    excluded: expanded.stated.join(', '),
    merging: SHA_SHAPE.test(String(mergedSha ?? '').trim()),
    reason: '',
  };
}

export function main(env = process.env, { run = runCommand } = {}) {
  const outputs = {
    tree: '',
  };
  const out = preserveRefused({
    cwd: env.WORKSPACE,
    remoteSha: env.REMOTE_SHA,
    outDir: env.OUT_DIR,
    manifestPath: env.MANIFEST,
    deniedPaths: env.DENIED_PATHS,
    planDir: planDirOf(env.PLAN_DIR),
    mergedSha: env.MERGED_SHA,
    run,
  });

  if (out.tree === '') {
    process.stdout.write(`note: nothing was preserved: ${out.reason}.\n`);
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    return 0;
  }

  const said = out.merging
    ? `_The work I did not push is kept in this run's artifacts; follow \`${out.guide}\` to recover it. It is the whole merge, not ` +
      'just the resolution, so applying it gives you the merged content on one parent rather than a merge ' +
      'commit. Paths this flow may not publish are left out of it._'
    : `_The work I did not push is kept in this run's artifacts; follow \`${out.guide}\` to recover it. Paths ` +
      'this flow may not publish are left out of it._';
  const messageFile = String(env.MESSAGE_FILE ?? '').trim();
  if (messageFile) {
    try {
      writeFileSync(messageFile, `${withKeptLine(readFileSync(messageFile, 'utf8'), said)}\n`);
    } catch {
      process.stdout.write('note: the refusal could not be told that the work was kept.\n');
    }
  }

  process.stdout.write(`note: kept the refused work at ${out.tree}.\n`);
  writeOutputs(env.GITHUB_OUTPUT, { ...outputs, tree: out.tree });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
