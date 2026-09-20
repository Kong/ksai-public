import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import { boundedBytes } from '../lib/evidence.cjs';

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

const PROMPT_BYTES = 1024 * 1024;
const CONTROL_BYTES = 2 * 1024 * 1024;

export function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is not an object`);
  return value;
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function sameDigest(left, right) {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  return timingSafeEqual(Buffer.from(left.slice(7), 'hex'), Buffer.from(right.slice(7), 'hex'));
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export function regularFile(path, maximum) {
  if (!isAbsolute(path)) throw new Error(`expected an absolute path: ${path}`);
  try {
    return boundedBytes(path, path, maximum, { sole: true, refuse: () => `expected one regular file: ${path}` });
  } catch (error) {
    throw new Error(`expected one regular file: ${path}`, { cause: error });
  }
}

export function readArtifacts(root) {
  return {
    prompt: regularFile(join(root, 'prompt.md'), PROMPT_BYTES),
    render: regularFile(join(root, 'render.sigstore.json'), CONTROL_BYTES),
    lock: regularFile(join(root, 'catalog.lock.json'), CONTROL_BYTES),
    attestation: regularFile(join(root, 'catalog.sigstore.json'), CONTROL_BYTES),
    tool: (name) => regularFile(join(root, 'tools', `${name}.json`), CONTROL_BYTES),
    reminder: () => regularFile(join(root, 'max-steps.json'), CONTROL_BYTES),
  };
}
