const NO_OUTPUT = 'no-output';
const NOT_JSON = 'not-json';
const NO_FINDINGS = 'no-findings';
const REPAIRED = 'repaired';

const FENCE_OPENER = /```(?:json)?[^\S\n]*\r?\n/gi;
const MAX_FENCES = 64;
const AFTER_STRING = new Set([',', '}', ']', ':']);

function escapeControls(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString && char < ' ') {
      out += `${escaped ? '\\' : ''}${JSON.stringify(char).slice(1, -1)}`;
      escaped = false;
      continue;
    }
    if (escaped) escaped = false;
    else if (char === '\\') escaped = inString;
    else if (char === '"') inString = !inString;
    out += char;
  }
  return out;
}

function parsedObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const objectOf = (text) => parsedObject(escapeControls(text));

function topLevelObjects(text, read) {
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
        const parsed = read(text.slice(start, index + 1));
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
  }

  return out;
}

function candidateRegions(text) {
  const starts = [...text.matchAll(FENCE_OPENER)].map((opener) => opener.index + opener[0].length);
  return [...starts.slice(-MAX_FENCES).map((start) => text.slice(start)), text];
}

function findReview(regions, read) {
  let sawObject = false;
  for (const region of regions) {
    const objects = topLevelObjects(region, read);
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
  const strict = findReview(regions, parsedObject);
  if (strict.review) return { review: strict.review, reason: null };

  const escaped = findReview(regions, objectOf);
  if (escaped.review) return { review: escaped.review, reason: REPAIRED };

  let sawRepaired = escaped.sawObject;
  for (const region of regions) {
    const salvaged = findReview([escapeStrayQuotes(region)], objectOf);
    if (salvaged.review) return { review: salvaged.review, reason: REPAIRED };
    sawRepaired ||= salvaged.sawObject;
  }

  return { review: null, reason: strict.sawObject || sawRepaired ? NO_FINDINGS : NOT_JSON };
}

function extractReviewJson(raw) {
  return readReviewOutput(raw).review;
}

module.exports = { extractReviewJson, readReviewOutput, objectOf, NO_OUTPUT, NOT_JSON, NO_FINDINGS, REPAIRED };
