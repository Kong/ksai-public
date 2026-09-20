'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');

const READ_CHUNK = 1024 * 1024;

function opened(at, maximum, refuse, { sole = false } = {}) {
  const named = String(at ?? '');
  const descriptor = fs.openSync(named, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const found = fs.fstatSync(descriptor);
  if (!found.isFile() || found.size > maximum || (sole && found.nlink > 1)) {
    fs.closeSync(descriptor);
    throw new Error(refuse(named));
  }
  return { named, descriptor, size: found.size };
}

function within(descriptor, maximum, refuse, size = maximum) {
  const first = Buffer.allocUnsafe(Math.min(size, maximum) + 1);
  let offset = 0;
  while (offset < first.length) {
    const count = fs.readSync(descriptor, first, offset, first.length - offset, null);
    if (count === 0) return first.subarray(0, offset);
    offset += count;
  }
  const held = [Buffer.from(first)];
  let bytes = offset;
  if (bytes > maximum) throw new Error(refuse());
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  for (let count = fs.readSync(descriptor, chunk, 0, chunk.length, null); count > 0; count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) {
    bytes += count;
    if (bytes > maximum) throw new Error(refuse());
    held.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(held);
}

function boundedBytes(at, name, maximum, { optional = false, sole = false, refuse = null } = {}) {
  const said = refuse ?? (() => `${name} is not one regular file of at most ${maximum} bytes`);
  let held;
  try {
    held = opened(at, maximum, said, { sole });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
  try {
    return within(held.descriptor, maximum, said, held.size);
  } finally {
    fs.closeSync(held.descriptor);
  }
}

function evidence(at, name, maximum) {
  const refuse = (named) => `${name} is not one regular file of at most ${maximum} bytes: ${named}`;
  const { named, descriptor } = opened(at, maximum, refuse);
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let bytes = 0;
    for (let count = fs.readSync(descriptor, buffer, 0, buffer.length, null); count > 0; count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) {
      digest.update(buffer.subarray(0, count));
      bytes += count;
      if (bytes > maximum) throw new Error(refuse(named));
    }
    return { path: named, sha256: digest.digest('hex'), bytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

function bounded(at, name, maximum) {
  const refuse = () => `${name} is empty or larger than ${maximum} bytes`;
  const text = boundedBytes(at, name, maximum, { refuse }).toString('utf8');
  if (text.trim() === '') throw new Error(refuse());
  return text;
}

module.exports = { bounded, boundedBytes, evidence };
