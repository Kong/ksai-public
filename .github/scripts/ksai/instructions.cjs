const path = require('node:path');

const IMPORT = /(^|\s)@([A-Za-z0-9._][A-Za-z0-9._/-]*\.mdx?)(?=$|\s)/gim;

const MAX_FILES = 64;

const MAX_DEPTH = 8;

function resolveFrom(base, target) {
  const out = path.posix.join(String(base ?? ''), String(target));
  return out === '..' || out.startsWith('../') ? null : out || null;
}

function importsOf(text, base = '') {
  const found = [];
  for (const [, , target] of String(text ?? '').matchAll(IMPORT)) {
    const entry = resolveFrom(base, target);
    if (entry && !found.includes(entry)) found.push(entry);
  }
  return found;
}

function closureOf(read, roots) {
  const seen = new Set();
  const out = [];
  let frontier = [...roots];

  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= MAX_DEPTH) return { imported: out, truncated: true };
    const next = [];
    for (const at of frontier) {
      if (seen.has(at)) continue;
      seen.add(at);

      let text = null;
      try {
        text = read(at);
      } catch {
        text = null;
      }
      if (typeof text !== 'string') continue;

      const from = path.posix.dirname(at);
      for (const target of importsOf(text, from)) {
        if (seen.has(target) || out.includes(target)) continue;
        if (out.length >= MAX_FILES) return { imported: out, truncated: true };
        out.push(target);
        next.push(target);
      }
    }
    frontier = next;
  }

  return { imported: out, truncated: false };
}

function expandDenied(denied, read) {
  const roots = denied.filter((one) => /\.mdx?$/i.test(one));
  if (roots.length === 0) return { denied: [...denied], truncated: false };

  const { imported, truncated } = closureOf(read, roots);
  return { denied: [...new Set([...denied, ...imported])], truncated };
}

module.exports = {
  MAX_DEPTH,
  MAX_FILES,
  closureOf,
  expandDenied,
  importsOf,
};
