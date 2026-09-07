const NO_OUTPUT = 'no-output';
const NOT_JSON = 'not-json';
const NO_FINDINGS = 'no-findings';
const REPAIRED = 'repaired';

const FENCE_OPENER = /```(?:json)?[^\S\n]*\r?\n/gi;
const AFTER_STRING = new Set([',', '}', ']', ':']);

function objectAt(text, start, end) {
  try {
    const parsed = JSON.parse(text.slice(start, end));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function topLevelObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (depth === 0) {
      if (char !== '{') continue;
      start = index;
      depth = 1;
      inString = false;
      escaped = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = objectAt(text, start, index + 1);
        if (parsed) found.push(parsed);
      }
    }
  }
  return found;
}

function escapeStrayQuotes(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      out += char;
      continue;
    }
    if (char !== '"') {
      out += char;
      continue;
    }
    let ahead = index + 1;
    while (ahead < text.length && /\s/.test(text[ahead])) ahead += 1;
    if (ahead >= text.length || AFTER_STRING.has(text[ahead])) {
      inString = false;
      out += char;
      continue;
    }
    out += '\\"';
    changed = true;
  }

  return { text: out, changed };
}

function candidateRegions(text) {
  const regions = [];
  for (const opener of text.matchAll(FENCE_OPENER)) regions.push(text.slice(opener.index + opener[0].length));
  regions.push(text);
  return regions;
}

function findReview(regions) {
  let sawObject = false;
  for (const region of regions) {
    const objects = topLevelObjects(region);
    sawObject ||= objects.length > 0;
    const review = objects.find((candidate) => Array.isArray(candidate.findings));
    if (review) return { review, sawObject: true };
  }
  return { review: null, sawObject };
}

function readReviewOutput(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return { review: null, reason: NO_OUTPUT };

  const regions = candidateRegions(text);
  const strict = findReview(regions);
  if (strict.review) return { review: strict.review, reason: null };

  const repairs = regions.map((region) => escapeStrayQuotes(region)).filter((repair) => repair.changed);
  const salvaged = findReview(repairs.map((repair) => repair.text));
  if (salvaged.review) return { review: salvaged.review, reason: REPAIRED };

  return { review: null, reason: strict.sawObject || salvaged.sawObject ? NO_FINDINGS : NOT_JSON };
}

function extractReviewJson(raw) {
  return readReviewOutput(raw).review;
}

module.exports = { extractReviewJson, readReviewOutput, NO_OUTPUT, NOT_JSON, NO_FINDINGS, REPAIRED };
