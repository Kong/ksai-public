'use strict';

const MARKER = '<!-- kreview-finding -->';
const FOLDED_HEADING = '### Additional findings (not anchored to the diff)';
const BULLET_END = '<!-- kreview-finding-end -->';
const ID_MARKER = /<!--\s*kreview-ids\s+match=(\S+?)(?:\s+finding=(\S+?))?\s*-->/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

const withoutIdMarkers = (text) =>
  String(text).replace(HTML_COMMENT, (comment) => (comment.includes('kreview-ids') ? '' : comment));

const idsFrom = (text) => {
  const last = [...String(text).matchAll(ID_MARKER)].at(-1);
  return { match_id: last?.[1] ?? null, posted_finding_id: last?.[2] ?? null };
};

function normalizeSeverity(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return SEVERITIES.has(value) ? value : null;
}

function parseFoldedFindings(reviewBody) {
  const text = String(reviewBody || '');
  const start = text.indexOf(FOLDED_HEADING);
  if (start === -1) return [];

  const section = text.slice(start + FOLDED_HEADING.length);
  const blocks = section.includes(BULLET_END)
    ? section
        .split(BULLET_END)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.startsWith('- '))
    : section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '));

  const out = [];
  for (const block of blocks) {
    const newlineIndex = block.indexOf('\n');
    const head0 = newlineIndex === -1 ? block : block.slice(0, newlineIndex);
    const sepIndex = head0.indexOf('` — ');
    if (sepIndex === -1) continue;

    const head = head0.slice(2, sepIndex + 1);
    const severityMatch = head.match(/\*\*([^*]+)\*\*/);
    const ticked = [...head.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const location = ticked.at(-1);
    if (!severityMatch || !location) continue;

    const separator = location.lastIndexOf(':');
    const path = separator === -1 ? location : location.slice(0, separator);
    const lineNumber = separator === -1 ? null : Number(location.slice(separator + 1));
    const body = block.slice(sepIndex + 4);

    out.push({
      severity: normalizeSeverity(severityMatch[1]),
      severity_raw: severityMatch[1].trim(),
      tag: ticked.length > 1 ? ticked.at(-2) : null,
      path: path === '?' ? null : path,
      line: Number.isInteger(lineNumber) ? lineNumber : null,
      body: withoutIdMarkers(body).trim(),
      ...idsFrom(block),
    });
  }
  return out;
}

module.exports = {
  BULLET_END,
  FOLDED_HEADING,
  MARKER,
  idsFrom,
  normalizeSeverity,
  parseFoldedFindings,
  withoutIdMarkers,
};
