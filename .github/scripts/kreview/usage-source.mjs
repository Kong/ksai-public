import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { record } from '../governance/artifacts.mjs';
import { COUNTERS, savedSnapshot } from './usage-counter.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

const MODES = new Set(['unregistered', 'ambiguous', 'unavailable', 'legacy', 'cumulative']);

const SCOPE = Object.freeze(['link', 'job', 'flow']);

export const usageFileOf = (root, link) => join(root, 'ksai-usage', `${basename(String(link))}.json`);

function written(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  const file = openSync(staged, 'w', 0o600);
  try {
    writeSync(file, `${JSON.stringify(state)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(staged, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return state;
}

function heldState(path, scope) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const held = record(JSON.parse(text), 'the usage counter file');
  const named = ['v', ...SCOPE, 'intent', 'counters', 'source', 'mode', 'asking', 'snapshots'];
  if (Object.keys(held).length !== named.length || named.some((name) => !Object.hasOwn(held, name)) || held.v !== 1) throw new Error(`${path} is not a usage counter file`);
  if (SCOPE.some((name) => held[name] !== scope[name])) throw new Error(`${path} counts another run's usage`);
  if (!HEX64.test(held.intent) || held.counters !== COUNTERS || !MODES.has(held.mode) || typeof held.asking !== 'boolean') throw new Error(`${path} holds no usage registration it can go on with`);
  if ((held.source !== null && !HEX64.test(String(held.source))) || (held.mode === 'cumulative') !== (held.source !== null)) throw new Error(`${path} holds no usage source it can go on with`);
  if (!Array.isArray(held.snapshots)) throw new Error(`${path} holds no usage snapshots`);
  return { ...held, snapshots: held.snapshots.map((one) => savedSnapshot(one)) };
}

export function openUsage(path, scope, intent = () => randomBytes(32).toString('hex')) {
  const held = heldState(path, scope);
  if (!held) return written(path, { v: 1, ...Object.fromEntries(SCOPE.map((name) => [name, scope[name]])), intent: intent(), counters: COUNTERS, source: null, mode: 'unregistered', asking: false, snapshots: [] });
  return held.asking && held.mode !== 'cumulative' ? written(path, { ...held, mode: 'ambiguous', asking: false }) : held;
}

export const saved = (path, state) => written(path, state);

export function ending(state) {
  if (state.mode === 'cumulative') return { legacy: false, error: '' };
  if (state.mode === 'unavailable' || state.mode === 'legacy' || (state.mode === 'unregistered' && !state.asking)) return { legacy: true, error: '' };
  return { legacy: false, error: 'the usage source registration may have committed and was never confirmed, so this run reports no usage it could count twice' };
}
