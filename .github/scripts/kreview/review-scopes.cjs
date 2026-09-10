const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const SCOPE_LIMITS = Object.freeze({ count: 8, files: 8, bytes: 49_152, lines: 600, inputBytes: 16_777_216, inventoryBytes: 1_048_576, units: 4096 });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const header = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\n]*(?:\n|$)/gm;

function inventoryOf(raw) {
  if (raw === '') return [];
  if (!raw.endsWith('\0')) throw new Error('review inventory lacks its final NUL');
  const fields = raw.slice(0, -1).split('\0');
  const files = [];
  const seen = new Set();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^(?:[ADMT]|[RC]\d{1,3})$/.test(status)) throw new Error('unsupported review inventory status');
    const previous = /^[RC]/.test(status) ? fields[i++] : '';
    const path = fields[i++];
    if (!path || seen.has(path) || (/^[RC]/.test(status) && !previous)) throw new Error('invalid or duplicate review inventory path');
    seen.add(path);
    files.push({ path, previous, status });
  }
  return files;
}

function changedLines(patch) {
  let active = false;
  let count = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) active = true;
    else if (active && /^[+-]/.test(line)) count += 1;
  }
  return count;
}

const fits = (patch) => Buffer.byteLength(patch) <= SCOPE_LIMITS.bytes && changedLines(patch) <= SCOPE_LIMITS.lines;
const supported = (path) => path.length <= 512 && !/^(?:\/|[A-Za-z]:)/.test(path) && !path.split(/[\\/]/).some((part) => ['', '.', '..'].includes(part)) && !/[\p{C}]/u.test(path);

function scopePlan(patch, inventory) {
  if (Buffer.byteLength(patch) > SCOPE_LIMITS.inputBytes || Buffer.byteLength(inventory) > SCOPE_LIMITS.inventoryBytes) throw new Error('review scope input exceeds its bound');
  const files = inventoryOf(inventory);
  if (files.length > SCOPE_LIMITS.units) throw new Error('review has too many files');
  const blocks = patch === '' ? [] : patch.split(/(?=^diff --git )/m);
  if (blocks.some((block) => !block.startsWith('diff --git '))) throw new Error('review patch has an unsupported preamble');
  const units = [];
  const omitted = [];
  let next = 0;
  for (const [index, file] of files.entries()) {
    const count = file.status === 'T' ? 2 : 1;
    const parts = blocks.slice(next, next + count);
    next += count;
    if (parts.length !== count) throw new Error('review patch and inventory disagree');
    if (count === 2 && (parts[0].split('\n')[0] !== parts[1].split('\n')[0] || !/^deleted file mode \d+$/m.test(parts[0]) || !/^new file mode \d+$/m.test(parts[1]))) throw new Error('review type change lacks its paired patches');
    for (const [part, block] of parts.entries()) {
      const id = `file-${index + 1}-${part + 1}`;
      if (!supported(file.path) || (file.previous && !supported(file.previous))) {
        omitted.push({ id, path: file.path, reason: 'unsupported-path' });
        continue;
      }
      const hunks = [...block.matchAll(header)];
      const pieces = fits(block) ? [block] : hunks.length ? hunks.map((hunk, i) => block.slice(0, hunks[0].index) + block.slice(hunk.index, hunks[i + 1]?.index ?? block.length)) : [block];
      for (const [piece, value] of pieces.entries()) {
        const unit = { id: `${id}-${piece + 1}`, path: file.path, patch: value, lines: changedLines(value), bytes: Buffer.byteLength(value) };
        if (!fits(value)) omitted.push({ id: unit.id, path: file.path, reason: 'oversized-hunk-or-header' });
        else units.push(unit);
        if (units.length + omitted.length > SCOPE_LIMITS.units) throw new Error('review has too many scope units');
      }
    }
  }
  if (next !== blocks.length) throw new Error('review patch and inventory disagree');
  const scopes = [];
  units.sort((a, b) => Math.max(b.bytes / SCOPE_LIMITS.bytes, b.lines / SCOPE_LIMITS.lines) - Math.max(a.bytes / SCOPE_LIMITS.bytes, a.lines / SCOPE_LIMITS.lines) || a.id.localeCompare(b.id));
  for (const unit of units) {
    let scope = scopes.find((entry) => entry.bytes + unit.bytes <= SCOPE_LIMITS.bytes && entry.lines + unit.lines <= SCOPE_LIMITS.lines && (entry.files.includes(unit.path) || entry.files.length < SCOPE_LIMITS.files));
    if (!scope && scopes.length < SCOPE_LIMITS.count) {
      scope = { id: `scope-${scopes.length + 1}`, files: [], units: [], patch: '', bytes: 0, lines: 0 };
      scopes.push(scope);
    }
    if (!scope) {
      omitted.push({ id: unit.id, path: unit.path, reason: 'scope-limit' });
      continue;
    }
    if (!scope.files.includes(unit.path)) scope.files.push(unit.path);
    scope.units.push(unit.id);
    scope.patch += unit.patch;
    scope.bytes += unit.bytes;
    scope.lines += unit.lines;
  }
  return { version: 1, digest: hash(patch + '\0' + inventory), total_files: files.length, total_units: units.length + omitted.filter((unit) => unit.reason !== 'scope-limit').length, scopes, omitted };
}

function readBounded(path, limit) {
  if (statSync(path).size > limit) throw new Error('review scope input exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

function materializeScopes(patchPath, inventoryPath) {
  const plan = scopePlan(readBounded(patchPath, SCOPE_LIMITS.inputBytes), readBounded(inventoryPath, SCOPE_LIMITS.inventoryBytes));
  const dir = join(dirname(patchPath), 'scopes');
  mkdirSync(dir, { recursive: true });
  plan.scopes = plan.scopes.map(({ patch, ...scope }) => {
    const diffPath = join(dir, `${scope.id}.patch`);
    const changedFilesPath = join(dir, `${scope.id}.txt`);
    writeFileSync(diffPath, patch);
    writeFileSync(changedFilesPath, scope.files.map((path) => JSON.stringify(path)).join('\n') + '\n');
    return { ...scope, patch_sha256: hash(patch), diffPath, changedFilesPath };
  });
  return plan;
}

module.exports = { SCOPE_LIMITS, scopePlan, materializeScopes };
