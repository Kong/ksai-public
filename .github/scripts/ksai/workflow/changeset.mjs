import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import stage from '../stage.cjs';
import controlPlane from '../../lib/control-plane.cjs';
import { toolCalls } from '../../kreview/opencode-v2.mjs';
import { withEscaped } from '../../kreview/secrets.cjs';

const { answeredRetrying, held } = controlPlane;

export const CHANGESET_VERSION = 'ksai.konghq.com/stage-changeset/v1alpha1';
export const WRITE_PROFILE = 'workflow-write';
export const MOST_CALLS = 96;

const COMMIT = /^[0-9a-f]{40}$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STEP_PATH = /^(?!\.git(?:\/|$))(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,15}$/;
const LISTED = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/;
const HELD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t([^]*)$/;
const STAGED = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([^]*)$/;
const PRINTABLE = /^[ -~]+$/;
const PATH_MOST = 4096;
const TIMEOUT_MS = 60_000;
const MODES = new Set(['100644', '100755', '120000']);
const SUBMODULE = '160000';
const MERGE_CARRIED = new Set(['go.mod', 'go.sum']);
const COMMAND_REDACTED = '<command redacted>';
const ARGUMENTS_REDACTED = '<arguments redacted>';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>`\\]+)\s+/;
const EXECUTABLE = /^([A-Za-z0-9_./+-]{1,120})(?=$|[\s;&|()<>`])/;
const SAFE_EXECUTABLE = /^[A-Za-z0-9_.+-]{1,120}$/;
const HIGH_ENTROPY = /[A-Za-z0-9+_]{24,}={0,2}/g;

const byPathBytes = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const byBytes = (left, right) => byPathBytes(left.path, right.path);

function entropy(value) {
  const counts = new Map();
  for (const point of value) counts.set(point, (counts.get(point) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) total -= (count / value.length) * Math.log2(count / value.length);
  return total;
}

const opaque = (value) => [...value.matchAll(HIGH_ENTROPY)].some(([found]) => new Set(found).size >= 10 && entropy(found) >= 3.5);

export function identityOf(command, secrets = []) {
  let rest = String(command ?? '').trimStart();
  let prefixed = false;
  for (let assigned = ASSIGNMENT.exec(rest); assigned; assigned = ASSIGNMENT.exec(rest)) {
    prefixed = true;
    rest = rest.slice(assigned[0].length);
  }
  const named = EXECUTABLE.exec(rest);
  const executable = named ? named[1].replace(/^.*\//, '') : '';
  if (!SAFE_EXECUTABLE.test(executable) || opaque(executable) || secrets.some(([, value]) => value && executable.includes(value))) {
    return COMMAND_REDACTED;
  }
  return prefixed || rest.slice(named[1].length).trim() !== '' ? `${executable} ${ARGUMENTS_REDACTED}` : executable;
}

function streamOf(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { state: 'unavailable', events: [] };
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { state: 'incomplete', events };
    }
  }
  return { state: 'complete', events };
}

const timed = (call) => Number.isSafeInteger(call.started) && Number.isSafeInteger(call.ended) && call.started >= 0 && call.ended >= call.started;

export function commandsOf(file, secrets = []) {
  const read = streamOf(file);
  const ran = toolCalls(read.events).filter((call) => call.tool === 'shell' && (call.status === 'completed' || call.status === 'error'));
  const kept = ran.filter((call) => timed(call)).sort((one, other) => one.started - other.started);
  const recorded = kept.slice(0, MOST_CALLS);
  return {
    state: kept.length === ran.length ? read.state : 'incomplete',
    capped: kept.length > recorded.length,
    calls: recorded.map((call) => {
      const command = String(call.input?.command ?? '');
      const exit = call.metadata?.exit;
      return {
        identity: identityOf(command, secrets),
        command_sha256: createHash('sha256').update(command, 'utf8').digest('hex'),
        exit: Number.isSafeInteger(exit) && exit >= 0 ? exit : null,
        began_ms: call.started,
        ended_ms: call.ended,
      };
    }),
  };
}

function listed(git, base, tree, only = [], paths = []) {
  const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ...only, base, tree, ...paths]);
  if (!diff.ok) throw new Error('listing the change against the bound commit failed');
  const parts = String(diff.stdout ?? '').split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 2 !== 0) throw new Error('git change list has an unexpected format');
  const changed = [];
  for (let at = 0; at < parts.length; at += 2) {
    const line = LISTED.exec(parts[at]);
    if (!line) throw new Error('git change list has an unexpected format');
    changed.push({ path: parts[at + 1], mode: line[2], was: line[3], blob: line[4], status: line[5] });
  }
  return changed;
}

function listedAt(git, base, tree, paths) {
  const changed = new Map();
  for (let at = 0; at < paths.length; at += stage.PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + stage.PATH_BATCH_SIZE).map((path) => `:(literal)${path}`);
    for (const one of listed(git, base, tree, [], ['--', ...batch])) changed.set(one.path, one);
  }
  return [...changed.values()];
}

function entriesAt(git, tree, paths) {
  const entries = new Map();
  for (let at = 0; at < paths.length; at += stage.PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + stage.PATH_BATCH_SIZE).map((path) => `:(literal)${path}`);
    const read = git(['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...batch]);
    if (!read.ok) throw new Error('listing a tree of the merge in git failed');
    for (const line of String(read.stdout ?? '').split('\0').filter(Boolean)) {
      const entry = HELD.exec(line);
      if (!entry) throw new Error('git tree list has an unexpected format');
      entries.set(entry[4], { mode: entry[1], blob: entry[3] });
    }
  }
  return entries;
}

function heldIn(git, tree, paths) {
  const entries = entriesAt(git, tree, paths);
  return paths.map((path) => (entries.has(path) ? { path, ...entries.get(path), status: 'M' } : { path, status: 'D' }));
}

function checkedPath(path) {
  if (!PRINTABLE.test(path) || Buffer.byteLength(path, 'utf8') > PATH_MOST) {
    throw new Error(`the stage changed a path the control plane cannot commit: ${JSON.stringify(path.slice(0, 200))}`);
  }
  return path;
}

function checkedLink(path, target) {
  const text = target.toString('utf8');
  if (!text || Buffer.byteLength(text, 'utf8') > PATH_MOST || text.startsWith('/') || posix.normalize(posix.join(posix.dirname(path), text)).startsWith('..')) {
    throw new Error(`the stage left a symbolic link at ${path} that points outside the repository`);
  }
}

function heldSecret(contents, secrets) {
  return secrets.find(([, value]) => value && contents.includes(Buffer.from(value, 'utf8')))?.[0] ?? '';
}

function mergeOf(git, base, mergeBase, maxFiles) {
  if (mergeBase && !COMMIT.test(mergeBase)) throw new Error('merge base from the control plane is not a full commit sha');
  const merging = git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD^{commit}']);
  const parent = merging.ok ? String(merging.stdout ?? '').trim() : '';
  if (parent !== mergeBase) {
    if (!mergeBase) throw new Error('the checkout is merging a commit the control plane did not name');
    throw new Error(parent ? `the checkout is merging ${parent}, not the base ${mergeBase} the control plane named` : 'the checkout holds no merge of the base the control plane named');
  }
  if (!mergeBase) return null;
  const replayed = git(['merge-tree', '--write-tree', '-z', base, mergeBase]);
  const [tree, ...rest] = String(replayed.stdout ?? '').split('\0');
  if ((!replayed.ok && replayed.status !== 1) || !COMMIT.test(tree)) {
    throw new Error('replaying the merge in git failed');
  }
  const end = rest.indexOf('');
  const named = [];
  const ancestors = [];
  for (const line of end < 0 ? rest : rest.slice(0, end)) {
    const entry = STAGED.exec(line);
    if (!entry) throw new Error('git merge conflicts have an unexpected format');
    named.push(entry[4]);
    if (entry[3] === '1') ancestors.push({ path: entry[4], blob: entry[2] });
  }
  const messages = end < 0 ? [] : rest.slice(end + 1);
  for (let at = 0; at < messages.length && messages[at] !== ''; ) {
    const count = Number(messages[at]);
    const kind = messages[at + count + 1];
    if (!Number.isSafeInteger(count) || count < 1 || kind === undefined) throw new Error('git merge messages have an unexpected format');
    if (kind.startsWith('CONFLICT')) named.push(...messages.slice(at + 1, at + count + 1));
    at += count + 3;
  }
  named.push(...renamedFrom(git, base, mergeBase, ancestors, new Set(named)));
  const unique = new Set(named);
  const real = heldOn(git, [base, mergeBase], [...unique]);
  const under = filesUnder(git, base, [...unique]).filter((path) => !unique.has(path));
  return { parent, tree, named: [...unique].filter((path) => real.has(path)), under, maxFiles };
}

function conflictsOf(git, merge, stageTree) {
  const kept = heldOn(git, [merge.tree, stageTree], merge.under);
  const conflicted = [...merge.named, ...merge.under.filter((path) => kept.has(path))].map((path) => checkedPath(path)).sort(byPathBytes);
  if (conflicted.length > merge.maxFiles) {
    throw new Error(`merge conflicts in ${conflicted.length} files, over the control plane limit of ${merge.maxFiles}`);
  }
  return conflicted;
}

function renamedFrom(git, base, mergeBase, ancestors, named) {
  if (ancestors.length === 0) return [];
  const ancestor = git(['merge-base', base, mergeBase]);
  const from = String(ancestor.stdout ?? '').trim();
  if (!ancestor.ok || !COMMIT.test(from)) throw new Error('finding where the merge sides part in git failed');
  const parted = entriesAt(git, from, ancestors.map(({ path }) => path));
  const moved = new Set(ancestors.filter(({ path, blob }) => parted.get(path)?.blob !== blob).map(({ blob }) => blob));
  if (moved.size === 0) return [];
  const gone = [base, mergeBase].flatMap((side) => listed(git, from, side, ['--diff-filter=D']));
  const sources = new Map(gone.filter(({ path, was }) => moved.has(was) && !named.has(path)).map(({ path, was }) => [path, was]));
  if (sources.size === 0) return [];
  const [onBase, onMerged] = [entriesAt(git, base, [...sources.keys()]), entriesAt(git, mergeBase, [...sources.keys()])];
  return [...sources].filter(([path, was]) => {
    const [ours, theirs] = [onBase.get(path)?.blob, onMerged.get(path)?.blob];
    return ours !== was && theirs !== was;
  }).map(([path]) => path);
}

function filesUnder(git, tree, paths) {
  const files = [];
  for (let at = 0; at < paths.length; at += stage.PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + stage.PATH_BATCH_SIZE).map((path) => `:(literal)${path}`);
    const read = git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', tree, '--', ...batch]);
    if (!read.ok) throw new Error('listing the conflicted paths of the merge in git failed');
    files.push(...String(read.stdout ?? '').split('\0').filter(Boolean));
  }
  return files;
}

function heldOn(git, trees, paths) {
  const asked = new Set(paths);
  const present = new Set();
  for (const tree of trees) {
    for (let at = 0; at < paths.length; at += stage.PATH_BATCH_SIZE) {
      const batch = paths.slice(at, at + stage.PATH_BATCH_SIZE).map((path) => `:(literal)${path}`);
      const read = git(['ls-tree', '-r', '-t', '-z', '--name-only', '--full-tree', tree, '--', ...batch]);
      if (!read.ok) throw new Error('listing the paths of the merge in git failed');
      for (const path of String(read.stdout ?? '').split('\0').filter(Boolean)) {
        if (asked.has(path)) present.add(path);
      }
    }
  }
  return present;
}

function decidedIn(git, merge, base, tree, maxFiles) {
  const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', merge.tree, tree]);
  if (!diff.ok) throw new Error('listing the stage merge resolution in git failed');
  const changed = String(diff.stdout ?? '').split('\0').filter(Boolean);
  const real = heldOn(git, [base, merge.parent, tree], changed);
  const decided = [...new Set([...merge.conflicted, ...changed.filter((path) => real.has(path))])];
  if (decided.length > maxFiles) {
    throw new Error(`stage resolved ${decided.length} files in the merge, over the control plane limit of ${maxFiles}`);
  }
  return decided.map((path) => checkedPath(path)).sort(byPathBytes);
}

export function stepOutputsOf(attested, maxFiles) {
  const parsed = [];
  for (const text of [attested].flat().filter(Boolean)) {
    let one;
    try {
      one = JSON.parse(text);
    } catch {
      throw new Error('step outputs attested by a step are not readable');
    }
    if (!Array.isArray(one)) throw new Error('step outputs attested by a step are not a list within the size limit');
    parsed.push(...one);
  }
  if (!Array.isArray(parsed) || parsed.length > maxFiles) throw new Error('step outputs attested by a step are not a list within the size limit');
  const outputs = parsed.map((one) => {
    const texts = one && typeof one === 'object' && Object.keys(one).length === 3
      && [one.step, one.path, one.sha256].every((value) => typeof value === 'string');
    if (!texts || !STEP_ID.test(one.step) || !STEP_PATH.test(one.path) || !SHA256.test(one.sha256)) {
      throw new Error('an attested step output has no step, tree path or sha256');
    }
    return { step: one.step, path: one.path, sha256: one.sha256 };
  });
  outputs.sort((left, right) => byBytes(left, right) || byPathBytes(left.step, right.step));
  if (outputs.some((one, at) => at > 0 && one.path === outputs[at - 1].path && one.step === outputs[at - 1].step)) {
    throw new Error('a step output was attested twice');
  }
  return outputs;
}

export function captureChangeset({ git, base, mergeBase = '', index, stageAttempt, maxBytes, maxFiles, secrets = [], events = '', stepOutputs = [] }) {
  if (!COMMIT.test(base)) throw new Error('stage has no bound commit, cannot capture its change');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('control plane sent no limits for the stage change');
  }
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok || String(head.stdout ?? '').trim() !== base) {
    throw new Error('checkout moved off the bound commit');
  }
  const replayed = mergeOf(git, base, mergeBase, maxFiles);
  const written = stage.workTree(git, replayed?.tree ?? base, index);
  if (!written.ok) throw new Error(written.reason);
  const merge = replayed && { parent: replayed.parent, tree: replayed.tree, conflicted: conflictsOf(git, replayed, written.tree) };
  const decided = merge ? decidedIn(git, merge, base, written.tree, maxFiles) : [];
  const sent = new Set([...decided, ...MERGE_CARRIED]);
  const changed = merge ? listedAt(git, base, written.tree, [...sent]).filter(({ path }) => sent.has(path)) : listed(git, base, written.tree);
  const listedPaths = new Set(changed.map(({ path }) => path));
  changed.push(...heldIn(git, written.tree, decided.filter((path) => !listedPaths.has(path))).filter(({ mode }) => mode !== SUBMODULE));
  if (changed.length > maxFiles) {
    throw new Error(`stage changed ${changed.length} files, over the control plane limit of ${maxFiles}`);
  }
  const hidden = withEscaped(secrets);
  const additions = [];
  const deletions = [];
  let size = 0;
  for (const one of changed) {
    const path = checkedPath(one.path);
    if (one.status === 'D') {
      deletions.push({ path });
      size += path.length;
      continue;
    }
    if (one.mode === SUBMODULE) throw new Error(`stage changed the submodule at ${path}, which a change cannot carry`);
    if (!MODES.has(one.mode)) throw new Error(`the stage left ${path} with mode ${one.mode}, which a change cannot carry`);
    const read = git(['cat-file', 'blob', one.blob], { base64: true });
    if (!read.ok) throw new Error(`reading the stage change to ${path} failed`);
    const encoded = String(read.stdout ?? '').trim();
    size += encoded.length + path.length;
    if (size > maxBytes) throw new Error(`stage change is over the control plane limit of ${maxBytes} bytes`);
    const contents = Buffer.from(encoded, 'base64');
    if (one.mode === '120000') checkedLink(path, contents);
    const secret = heldSecret(contents, hidden);
    if (secret) throw new Error(`stage change to ${path} contains ${secret}, a runner secret, so nothing is sent`);
    additions.push({ path, mode: one.mode, contents: encoded });
  }
  additions.sort(byBytes);
  deletions.sort(byBytes);
  const body = JSON.stringify({
    apiVersion: CHANGESET_VERSION, ...stageAttempt, base, additions, deletions, commands: commandsOf(events, secrets),
    ...(merge ? { merge: { parent: merge.parent, conflicted: merge.conflicted, decided, tree: written.tree } } : {}),
    ...(stepOutputs.length > 0 ? { stepOutputs } : {}),
  });
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new Error(`stage change is over the control plane limit of ${maxBytes} bytes`);
  }
  return { body, files: additions.length + deletions.length };
}

export async function uploadChangeset({ fetch, base, token, body, pause = held }) {
  const sent = await answeredRetrying(fetch, `${base}/run/changeset`, { token, body, timeout: TIMEOUT_MS }, pause);
  if (sent.why) throw new Error(`control plane did not accept the stage change: ${sent.why}`);
  const artifact = sent.answer?.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('control plane accepted the stage change but returned no artifact');
  }
  return artifact;
}
