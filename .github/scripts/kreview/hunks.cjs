// Walks a unified diff patch once and returns three views of it.
//
// Shared by two callers with different questions. kreview/post-review.cjs asks "can a comment
// anchor here", which needs `left`/`right` and the hunk index (a multi-line comment spanning
// two hunks makes the whole review 422). The eval extractor asks "was this old line modified",
// which needs `removed` specifically — `left` cannot answer it, because it holds context lines
// (unchanged, present on both sides) alongside deleted ones. Presence in `left` means the line
// was *shown*, not that it changed.

// A comment can anchor to any line shown in a hunk, so context lines count for both sides.
// Values are the hunk index, so a multi-line comment can be checked to stay within one hunk.
// `removed` is a bare set of old-side line numbers that the patch deletes or rewrites.
function parseHunks(patch) {
  const right = new Map();
  const left = new Map();
  const removed = new Set();
  if (!patch) return { right, left, removed };
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[2], 10);
      hunk += 1;
      continue;
    }
    if (line.startsWith('+')) {
      right.set(newLine, hunk);
      newLine += 1;
    } else if (line.startsWith('-')) {
      left.set(oldLine, hunk);
      removed.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — not a real line
    } else {
      right.set(newLine, hunk);
      left.set(oldLine, hunk);
      newLine += 1;
      oldLine += 1;
    }
  }
  return { right, left, removed };
}

module.exports = { parseHunks };
