import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import trust from './trust.json' with { type: 'json' };

const GITHUB_FULCIO = 'fulcio.githubapp.com';
const STOP_GRACE_MS = 10_000;
const OUTPUT_BYTES = 1024 * 1024;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY/i;

function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function groupExists(child) {
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function timeLeft(signal, deadlineAt, now) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('the governance preparation was cancelled');
  if (deadlineAt === null) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new Error('the governance preparation deadline must be an absolute safe timestamp');
  const left = deadlineAt - now();
  if (left <= 0) throw new Error('the governance preparation deadline expired');
  return left;
}

function diagnostic(said, env = process.env) {
  let text = String(said ?? '');
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value !== '')
    .sort((left, right) => right[1].length - left[1].length);
  for (const [name, value] of secrets) text = text.replaceAll(value, `***redacted ${name}***`);
  return text.trim();
}

async function trustedRootChild({
  signal = new AbortController().signal, deadlineAt = null, env = process.env,
  launch = spawn, now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
  kill = killGroup, groupAlive = groupExists,
} = {}) {
  const started = now();
  const due = started + Math.min(60_000, timeLeft(signal, deadlineAt, () => started));
  const child = launch('gh', ['attestation', 'trusted-root'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const result = { status: null, stdout: '', stderr: '', error: null };
  let failure = null;
  await new Promise((resolve) => {
    let timer = null;
    let grace = null;
    let settled = false;
    let closed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finish = () => {
      if (settled || !closed || (failure && grace !== null && groupAlive(child))) return;
      settled = true;
      if (timer !== null) unschedule(timer);
      if (grace !== null) unschedule(grace);
      signal.removeEventListener('abort', abort);
      resolve(undefined);
    };
    const stop = (error) => {
      if (settled || failure) return;
      failure = error;
      grace = schedule(() => {
        kill(child, 'SIGKILL');
        grace = null;
        finish();
      }, STOP_GRACE_MS);
      kill(child, 'SIGTERM');
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('the governance preparation was cancelled'));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > OUTPUT_BYTES) stop(new Error('gh exceeded the governance preparation output limit'));
      else result.stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > OUTPUT_BYTES) stop(new Error('gh exceeded the governance preparation output limit'));
      else result.stderr += chunk;
    });
    child.once('error', (error) => { result.error = error; });
    child.once('close', (status) => {
      result.status = status;
      closed = true;
      finish();
    });
    signal.addEventListener('abort', abort, { once: true });
    timer = schedule(() => stop(new Error('gh exceeded the governance preparation deadline')), Math.max(0, due - now()));
    if (signal.aborted) abort();
  });
  if (failure) throw failure;
  return result;
}

export function rendererFor(endpoint, pinned = trust) {
  const origin = new URL(endpoint).origin;
  const renderer = pinned.renderers?.[origin];
  if (!renderer) throw new Error(`this KSAI release pins no render key for ${origin}, so nothing it renders can be verified`);
  return renderer;
}

export function githubTrustedRoot(said) {
  const roots = String(said ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((root) => (root.certificateAuthorities ?? []).some((authority) => authority.uri === GITHUB_FULCIO));
  if (roots.length !== 1) throw new Error(`gh answered ${roots.length} trust roots for GitHub's own Sigstore instance`);
  return roots[0];
}

function rootFrom(answered, env) {
  if (answered.status !== 0) throw new Error(`gh could not read GitHub's attestation trust root: ${diagnostic(answered.stderr || answered.error, env)}`);
  return githubTrustedRoot(answered.stdout);
}

function saveTrustedRoot(path, root) {
  writeFileSync(path, `${JSON.stringify(root)}\n`, { mode: 0o600 });
  return path;
}

export async function writeTrustedRoot(path, {
  signal = new AbortController().signal, deadlineAt = null, env = process.env, now = Date.now, ...children
} = {}) {
  const answered = await trustedRootChild({ ...children, signal, deadlineAt, env, now });
  timeLeft(signal, deadlineAt, now);
  return saveTrustedRoot(path, rootFrom(answered, env));
}

export const governedRoot = (env) => join(String(env.RUNNER_TEMP ?? ''), 'ksai-governed');

export const deliveriesAt = (root) => join(root, 'deliveries.jsonl');

export const trustedRootAt = (root) => join(root, 'trusted-root.json');

export function recordGovernance(env, answered) {
  const trusted = rootFrom(answered, env);
  const root = governedRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  saveTrustedRoot(trustedRootAt(root), trusted);
  writeFileSync(deliveriesAt(root), '', { mode: 0o600, flag: 'a' });
  return root;
}

export async function prepareGovernance(env, {
  signal = new AbortController().signal, deadlineAt = null, now = Date.now, ...children
} = {}) {
  const answered = await trustedRootChild({ ...children, signal, deadlineAt, now, env });
  timeLeft(signal, deadlineAt, now);
  return recordGovernance(env, answered);
}
