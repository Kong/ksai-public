'use strict';

const { matchesGlob } = require('node:path');

/*
 * The flag allowlist for a rule pattern, which admits `i` and nothing else. A `g` flag makes a
 * RegExp stateful across `.test()` calls through `lastIndex`, so the same path would match on one
 * file and miss on the next depending on what ran before it -- a bug that shows up as a rule
 * working intermittently, which is the hardest kind to catch in a review.
 */
const ALLOWED_FLAGS = /^i?$/;

const isPlainString = (value) => typeof value === 'string' && value.length > 0;

/* Turns one `{ match, flags }` entry into a RegExp, or null if it cannot. */
function toPattern(entry) {
  if (!entry || !isPlainString(entry.match)) return null;
  const flags = entry.flags ?? '';
  if (typeof flags !== 'string' || !ALLOWED_FLAGS.test(flags)) return null;
  try {
    return new RegExp(entry.match, flags);
  } catch {
    return null;
  }
}

function claimsAny(re, paths) {
  if (!re) return false;
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path === '') continue;
    if (re.test(path) || re.test(path.toLowerCase())) return true;
  }
  return false;
}

function splitGlobs(value) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const character of String(value)) {
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

function globFault(glob) {
  if (glob.startsWith('/')) return `\`${glob}\` starts at the filesystem root; write it relative to the repository`;
  if (glob.split('/').includes('..')) return `\`${glob}\` climbs past the repository root`;
  let braces = 0;
  let brackets = 0;
  for (const character of glob) {
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    if (braces < 0 || brackets < 0) return `\`${glob}\` closes a \`{\` or \`[\` it never opened`;
  }
  if (braces !== 0 || brackets !== 0) return `\`${glob}\` opens a \`{\` or \`[\` it never closes`;
  return null;
}

function toGlobs(value) {
  const raw = [];
  if (typeof value === 'string') raw.push(...splitGlobs(value));
  else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') return { error: 'every entry is a glob written as a string' };
      const one = entry.trim();
      if (one !== '') raw.push(one);
    }
  } else return { error: 'it is a glob, a comma-separated list of globs, or a list of them' };

  if (raw.length === 0) return { error: 'it names no glob' };

  const include = [];
  const exclude = [];
  for (const item of raw) {
    const negated = item.startsWith('!');
    const glob = negated ? item.slice(1).trim() : item;
    if (glob === '') return { error: '`!` is written with the glob it excludes' };
    if (/['"]/.test(glob)) {
      return { error: `\`${glob}\` still carries a quote; quote every entry or none of them` };
    }
    const fault = globFault(glob);
    if (fault) return { error: fault };
    (negated ? exclude : include).push(glob);
  }
  if (include.length === 0) return { error: 'it excludes paths without claiming any' };
  return { globs: { include, exclude } };
}

const undot = (value) =>
  value
    .split('/')
    .map((segment) => segment.replace(/^\.+/, ''))
    .join('/');

const globMatches = (glob, path) =>
  matchesGlob(path, glob) || matchesGlob(path.toLowerCase(), glob.toLowerCase());

const globClaims = (glob, path) =>
  globMatches(glob, path) || matchesGlob(undot(path.toLowerCase()), undot(glob.toLowerCase()));

function claimsAnyGlob(globs, paths) {
  if (!globs || !Array.isArray(globs.include) || globs.include.length === 0) return false;
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path === '') continue;
    if (!globs.include.some((glob) => globClaims(glob, path))) continue;
    if (globs.exclude.some((glob) => globMatches(glob, path))) continue;
    return true;
  }
  return false;
}

module.exports = { ALLOWED_FLAGS, toPattern, claimsAny, toGlobs, claimsAnyGlob };
