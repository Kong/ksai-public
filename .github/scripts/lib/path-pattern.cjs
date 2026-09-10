'use strict';

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

module.exports = { ALLOWED_FLAGS, toPattern, claimsAny };
