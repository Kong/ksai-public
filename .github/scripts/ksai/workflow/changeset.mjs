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
const PRINTABLE = /^[ -~]+$/;
const PATH_MOST = 4096;
const TIMEOUT_MS = 60_000;
const MODES = new Set(['100644', '100755', '120000']);
const SUBMODULE = '160000';
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

function listed(git, base, tree) {
  const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, tree]);
  if (!diff.ok) throw new Error('the change could not be listed against the commit the stage was bound to');
  const parts = String(diff.stdout ?? '').split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 2 !== 0) throw new Error('git listed the change in a shape this runtime does not read');
  const changed = [];
  for (let at = 0; at < parts.length; at += 2) {
    const line = LISTED.exec(parts[at]);
    if (!line) throw new Error('git listed the change in a shape this runtime does not read');
    changed.push({ path: parts[at + 1], mode: line[2], blob: line[4], status: line[5] });
  }
  return changed;
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
  if (mergeBase && !COMMIT.test(mergeBase)) throw new Error('the control plane named a merge base that is not a whole commit');
  const merging = git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD^{commit}']);
  const parent = merging.ok ? String(merging.stdout ?? '').trim() : '';
  if (parent !== mergeBase) {
    if (!mergeBase) throw new Error('the checkout is merging a commit the control plane did not name');
    throw new Error(parent ? `the checkout is merging ${parent}, not the base ${mergeBase} the control plane named` : 'the checkout holds no merge of the base the control plane named');
  }
  if (!mergeBase) return null;
  const replayed = git(['merge-tree', '--write-tree', '--name-only', '-z', base, mergeBase]);
  const [tree, ...rest] = String(replayed.stdout ?? '').split('\0');
  if ((!replayed.ok && replayed.status !== 1) || !COMMIT.test(tree)) {
    throw new Error('git could not replay the merge, so what the stage resolved cannot be told apart from what the merge carried');
  }
  const end = rest.indexOf('');
  const conflicted = [...new Set(end < 0 ? rest : rest.slice(0, end))].map((path) => checkedPath(path)).sort(byPathBytes);
  if (conflicted.length > maxFiles) {
    throw new Error(`the merge conflicts in ${conflicted.length} files, and the control plane takes at most ${maxFiles}`);
  }
  return { parent, tree, conflicted };
}

function decidedIn(git, merge, tree, maxFiles) {
  const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', merge.tree, tree]);
  if (!diff.ok) throw new Error('git could not list what the stage decided in the merge');
  const decided = [...new Set([...merge.conflicted, ...String(diff.stdout ?? '').split('\0').filter(Boolean)])];
  if (decided.length > maxFiles) {
    throw new Error(`the stage decided ${decided.length} files in the merge, and the control plane takes at most ${maxFiles}`);
  }
  return decided.map((path) => checkedPath(path)).sort(byPathBytes);
}

export function stepOutputsOf(text, maxFiles) {
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the steps after the model attested what they wrote in no readable form');
  }
  if (!Array.isArray(parsed) || parsed.length > maxFiles) throw new Error('the steps after the model attested what they wrote in no bounded list');
  const outputs = parsed.map((one) => {
    const texts = one && typeof one === 'object' && Object.keys(one).length === 3
      && [one.step, one.path, one.sha256].every((value) => typeof value === 'string');
    if (!texts || !STEP_ID.test(one.step) || !STEP_PATH.test(one.path) || !SHA256.test(one.sha256)) {
      throw new Error('a step after the model attested an output with no step, no path in the tree or no sha256');
    }
    return { step: one.step, path: one.path, sha256: one.sha256 };
  });
  outputs.sort((left, right) => byBytes(left, right) || byPathBytes(left.step, right.step));
  if (outputs.some((one, at) => at > 0 && one.path === outputs[at - 1].path && one.step === outputs[at - 1].step)) {
    throw new Error('a step after the model attested one output twice');
  }
  return outputs;
}

export function captureChangeset({ git, base, mergeBase = '', index, stageAttempt, maxBytes, maxFiles, secrets = [], events = '', stepOutputs = [] }) {
  if (!COMMIT.test(base)) throw new Error('the stage names no commit it was bound to, so its change cannot be captured');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('the control plane named no bounds for the stage\'s change');
  }
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok || String(head.stdout ?? '').trim() !== base) {
    throw new Error('the checkout is no longer at the commit the stage was bound to');
  }
  const merge = mergeOf(git, base, mergeBase, maxFiles);
  const written = stage.workTree(git, base, index);
  if (!written.ok) throw new Error(written.reason);
  const changed = listed(git, base, written.tree);
  if (changed.length > maxFiles) {
    throw new Error(`the stage changed ${changed.length} files, and the control plane takes at most ${maxFiles}`);
  }
  const decided = merge ? decidedIn(git, merge, written.tree, maxFiles) : [];
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
    if (one.mode === SUBMODULE) throw new Error(`the stage changed the submodule at ${path}, and a change carries no submodule`);
    if (!MODES.has(one.mode)) throw new Error(`the stage left ${path} with mode ${one.mode}, which a change cannot carry`);
    const read = git(['cat-file', 'blob', one.blob], { base64: true });
    if (!read.ok) throw new Error(`the stage's change to ${path} could not be read`);
    const encoded = String(read.stdout ?? '').trim();
    size += encoded.length + path.length;
    if (size > maxBytes) throw new Error(`the stage's change is over the ${maxBytes} bytes the control plane takes`);
    const contents = Buffer.from(encoded, 'base64');
    if (one.mode === '120000') checkedLink(path, contents);
    const secret = heldSecret(contents, hidden);
    if (secret) throw new Error(`the stage's change to ${path} holds ${secret}, a secret this runner has, so nothing is sent`);
    additions.push({ path, mode: one.mode, contents: encoded });
  }
  additions.sort(byBytes);
  deletions.sort(byBytes);
  const body = JSON.stringify({
    apiVersion: CHANGESET_VERSION, ...stageAttempt, base, additions, deletions, commands: commandsOf(events, secrets),
    ...(merge ? { merge: { parent: merge.parent, conflicted: merge.conflicted, decided } } : {}),
    ...(stepOutputs.length > 0 ? { stepOutputs } : {}),
  });
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new Error(`the stage's change is over the ${maxBytes} bytes the control plane takes`);
  }
  return { body, files: additions.length + deletions.length };
}

export async function uploadChangeset({ fetch, base, token, body, pause = held }) {
  const sent = await answeredRetrying(fetch, `${base}/run/changeset`, { token, body, timeout: TIMEOUT_MS }, pause);
  if (sent.why) throw new Error(`the control plane did not take the stage's change: ${sent.why}`);
  const artifact = sent.answer?.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('the control plane took the stage\'s change and named no artifact for it');
  }
  return artifact;
}
