'use strict';

const { counted, plural } = require('../lib/text.cjs');

const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const MAX_MATCHED_CHARS = 1000;
const MAX_NAMED_FILES = 8;
const SHA_SHAPE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const DIFF_ARGS = Object.freeze([
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--find-renames',
  '--unified=6',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]);

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__snapshots__']);

const TEST_BASENAMES = Object.freeze([
  /^test_.+\.py$/i,
  /_test\.(?:py|go|rb|exs|lua|rs|cc|cpp|c)$/i,
  /_spec\.(?:rb|lua)$/i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /(?:Test|Tests|IT)\.(?:java|kt|scala|cs|swift|php)$/,
  /\.(?:snap|golden)$/i,
]);

const SNAPSHOT = /(?:^|\/)__snapshots__\/|\.(?:snap|golden)$/i;

const EXPECTATION = new RegExp(
  [
    '\\b(?:assert|expect|verify)\\w*',
    '\\bshould\\b',
    '\\bto(?:Be|Equal|StrictEqual|Match|Throw|Contain|HaveBeenCalled)\\w*',
    '\\brequire\\.\\w+\\(',
    '\\bt\\.(?:Error|Errorf|Fatal|Fatalf)\\(',
    '\\b(?:pytest\\.)?raises\\(',
    '\\bmatch\\s*=',
    '\\b(?:want|wanted|expected)\\w*\\s*[:=]',
  ].join('|'),
  'i',
);

const squeeze = (line) => line.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');

const substantive = (line) => /[A-Za-z0-9'"`]/.test(line);

function isTestPath(file) {
  const at = String(file ?? '');
  if (at === '') return false;
  const segments = at.split('/');
  const base = segments.at(-1);
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment.toLowerCase()))) return true;
  return TEST_BASENAMES.some((shape) => shape.test(base));
}

function unquoted(raw) {
  const said = String(raw ?? '').replace(/\t$/, '');
  if (said.startsWith('"') && said.endsWith('"') && said.length >= 2) return said.slice(1, -1);
  return said;
}

function pathOf(header) {
  const said = unquoted(header);
  if (said === '/dev/null') return null;
  return said.replace(/^[ab]\//, '');
}

function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { from: null, to: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (hunk === null && line.startsWith('--- ')) {
      file.from = pathOf(line.slice(4));
      continue;
    }
    if (hunk === null && line.startsWith('+++ ')) {
      file.to = pathOf(line.slice(4));
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = { lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    const mark = line[0];
    if (mark === ' ' || mark === '-' || mark === '+') hunk.lines.push({ mark, text: line.slice(1) });
  }
  return files;
}

function balance(line) {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

const JOINS = /(?:\\|\+|,|&&|\|\||=|\(|\[|\{)\s*$/;

const BLOCK_OPENER = /(?:\)|=>|\belse|\bdo|\btry)\s*\{\s*$/;

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function codeOf(line) {
  return line.replace(STRING_LITERAL, '""');
}

function expectationLines(hunk, { snapshot = false } = {}) {
  const removed = [];
  let depth = 0;
  let open = false;
  for (const { mark, text } of hunk.lines) {
    if (mark === '+') continue;
    const probe = text.length > MAX_MATCHED_CHARS ? text.slice(0, MAX_MATCHED_CHARS) : text;
    if (probe.trim() === '') {
      depth = 0;
      open = false;
      continue;
    }
    const code = codeOf(probe);
    const matches = EXPECTATION.test(code);
    if (mark === '-' && substantive(probe) && (snapshot || matches || open)) removed.push(text);
    if (!matches && !open) {
      depth = 0;
      open = false;
      continue;
    }
    const block = BLOCK_OPENER.test(code);
    depth = (open ? depth : 0) + balance(code) - (block ? 1 : 0);
    open = depth > 0 || (!block && JOINS.test(code));
  }
  return removed;
}

function sameTokens(lines) {
  const removed = squeeze(lines.filter((line) => line.mark === '-').map((line) => line.text).join(''));
  const added = squeeze(lines.filter((line) => line.mark === '+').map((line) => line.text).join(''));
  return removed === added;
}

function withoutReformats(hunk) {
  if (sameTokens(hunk.lines)) return { lines: hunk.lines.filter((line) => line.mark === ' ') };
  const lines = [];
  let block = [];
  const flush = () => {
    lines.push(...(sameTokens(block) ? block.filter((line) => line.mark === '+') : block));
    block = [];
  };
  for (const line of hunk.lines) {
    if (line.mark === ' ') {
      flush();
      lines.push(line);
    } else {
      block.push(line);
    }
  }
  flush();
  return { lines };
}

function findExpectationEdits(diffText) {
  const text = String(diffText ?? '');
  if (text.length > MAX_DIFF_CHARS) {
    return { ok: false, reason: `the diff is over ${MAX_DIFF_CHARS} characters` };
  }
  const files = parseDiff(text);
  const added = new Map();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.mark !== '+') continue;
        const key = squeeze(line.text);
        if (key !== '') added.set(key, (added.get(key) ?? 0) + 1);
      }
    }
  }

  const perFile = new Map();
  for (const file of files) {
    const at = file.from ?? file.to;
    if (!isTestPath(file.from) && !isTestPath(file.to)) continue;
    const snapshot = SNAPSHOT.test(at);
    for (const hunk of file.hunks) {
      for (const line of expectationLines(withoutReformats(hunk), { snapshot })) {
        const key = squeeze(line);
        const moved = added.get(key) ?? 0;
        if (moved > 0) {
          added.set(key, moved - 1);
          continue;
        }
        perFile.set(at, (perFile.get(at) ?? 0) + 1);
      }
    }
  }

  const edited = [...perFile.entries()]
    .map(([path, lines]) => ({ path, lines }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    ok: true,
    edited,
    lines: edited.reduce((sum, entry) => sum + entry.lines, 0),
  };
}

function readExpectationEdits({ git = null, from = null, to = null } = {}) {
  try {
    if (typeof git !== 'function') return { ok: false, reason: 'no git runner was given' };
    if (!SHA_SHAPE.test(String(from ?? '')) || !SHA_SHAPE.test(String(to ?? ''))) {
      return { ok: false, reason: 'the commits to compare are not full shas' };
    }
    const read = git([...DIFF_ARGS, String(from), String(to), '--']);
    if (!read?.ok) return { ok: false, reason: 'the diff could not be read' };
    return findExpectationEdits(read.stdout);
  } catch {
    return { ok: false, reason: 'the diff could not be read' };
  }
}

function shownPath(value) {
  const scrubbed = String(value ?? '').replace(/[^A-Za-z0-9._/-]/g, '?');
  return scrubbed.length > 80 ? `…${scrubbed.slice(-79)}` : scrubbed;
}

function renderExpectationNote(found, { noun = 'This step' } = {}) {
  if (!found?.ok || !Array.isArray(found.edited) || found.edited.length === 0) return '';
  const named = found.edited.slice(0, MAX_NAMED_FILES).map((entry) => `\`${shownPath(entry.path)}\` (${entry.lines})`);
  const rest = found.edited.length - named.length;
  const where = rest > 0 ? `${named.join(', ')} and ${counted(rest, 'more file')}` : named.join(', ');
  return (
    `⚠️ ${noun} changed or removed ${counted(found.lines, 'existing test expectation line')} rather than only ` +
    `adding tests, in ${where}. A test edited to match new output can hide a behaviour change the request never ` +
    `asked for, so check that the request asks for ${plural(found.lines, 'that change', 'those changes')} before ` +
    'approving. This is a warning from a line-based diff scan, not a refusal'
  );
}

function expectationWarning({ readEdits = readExpectationEdits, git = null, from = null, to = null, noun = 'This step', log = (line) => process.stderr.write(line) } = {}) {
  let found;
  try {
    found = readEdits({ git, from, to });
  } catch {
    found = { ok: false, reason: 'the scan threw' };
  }
  if (!found?.ok) {
    log(`Note: the existing test expectation scan did not run: ${found?.reason ?? 'no answer'}.\n`);
    return '';
  }
  return renderExpectationNote(found, { noun });
}

module.exports = {
  DIFF_ARGS,
  MAX_DIFF_CHARS,
  MAX_NAMED_FILES,
  expectationWarning,
  findExpectationEdits,
  isTestPath,
  readExpectationEdits,
  renderExpectationNote,
};
