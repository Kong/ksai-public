const { rendered } = require('./review-wire.cjs');

const NO_OUTPUT = 'no-output';
const NOT_JSON = 'not-json';
const NO_FINDINGS = 'no-findings';
const REPAIRED = 'repaired';

const FENCE_OPENER = /```(?:json)?[^\S\n]*\r?\n/gi;
const MAX_FENCES = 64;
const AFTER_STRING = new Set([',', '}', ']', ':']);
const CLOSER_AHEAD = /\s*[}\]]/y;
const BEFORE_NO_VALUE = new Set(['', '{', '[', ',']);

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

function dropTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let last = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === ',' && !BEFORE_NO_VALUE.has(last)) {
      CLOSER_AHEAD.lastIndex = index + 1;
      if (CLOSER_AHEAD.test(text)) continue;
    }
    out += char;
    if (char > ' ') last = char;
  }
  return out;
}

const objectOf = (text) => parsedObject(dropTrailingCommas(escapeControls(text)));

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
  return [text, ...starts.slice(-MAX_FENCES).map((start) => text.slice(start))];
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isFinding = (entry) => Boolean(entry) && typeof entry === 'object';

const holdsFinding = (list) => Array.isArray(list) && list.some((entry) => isFinding(entry));

const LISTED = [(candidate) => Array.isArray(candidate.findings), (candidate) => isObject(candidate.verdict) && holdsFinding(candidate.verdict.findings)];

const assesses = (value) => Array.isArray(value) || typeof value === 'string';

const SHAPES = [...LISTED, (candidate) => isObject(candidate.verdict) && (Array.isArray(candidate.verdict.findings) || assesses(candidate.verdict.assessment) || assesses(candidate.assessment))];

function once(build) {
  let built;
  return () => (built ??= build());
}

function bestReview(text) {
  const regions = candidateRegions(text);
  const passes = [
    { reason: null, objects: once(() => regions.flatMap((region) => topLevelObjects(region, parsedObject))) },
    { reason: REPAIRED, objects: once(() => regions.flatMap((region) => topLevelObjects(region, objectOf))) },
    { reason: REPAIRED, objects: once(() => regions.flatMap((region) => topLevelObjects(escapeStrayQuotes(region), objectOf))) },
  ];
  for (const [shape, holds] of SHAPES.entries()) {
    for (const { reason, objects } of passes) {
      const review = objects().findLast((candidate) => holds(candidate));
      if (review) return { review, reason, shape };
    }
  }
  return { review: null, reason: passes.some(({ objects }) => objects().length > 0) ? NO_FINDINGS : NOT_JSON, shape: SHAPES.length };
}

const SEVERITIES = [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];

function severityCounts(findings) {
  const counted = new Map();
  for (const finding of findings.filter((entry) => isFinding(entry))) {
    const said = String(finding?.severity || '').trim();
    const severity = said.toLowerCase();
    const tally = counted.get(severity) ?? { label: said || 'Note', count: 0 };
    tally.count += 1;
    counted.set(severity, tally);
  }
  const named = SEVERITIES.filter(([severity]) => counted.has(severity)).map(([severity, label]) => ({ label, count: counted.get(severity).count }));
  const rest = [...counted].filter(([severity]) => !SEVERITIES.some(([known]) => known === severity)).map(([, tally]) => tally);
  const parts = [...named, ...rest].map(({ label, count }) => `${count} ${label}`);
  return parts.length ? parts.join(', ') : 'None';
}

const blank = (value) => (Array.isArray(value) ? value.length === 0 : typeof value !== 'string' || !value.trim());

function liftedOutOfVerdict(review) {
  const { verdict } = review;
  if (!isObject(verdict)) return null;
  const lifted = { ...review, verdict: { ...verdict } };
  let moved = false;
  if (Array.isArray(verdict.findings) || !Array.isArray(review.findings)) {
    if (!holdsFinding(review.findings)) lifted.findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    lifted.verdict.findings = severityCounts(lifted.findings);
    moved = true;
  }
  if (Object.hasOwn(verdict, 'assessment')) {
    if (!blank(verdict.assessment) && blank(review.assessment)) lifted.assessment = verdict.assessment;
    delete lifted.verdict.assessment;
    moved = true;
  }
  return moved ? lifted : null;
}

function reviewOf(review, reason) {
  const lifted = liftedOutOfVerdict(review);
  return { review: rendered(lifted ?? review), reason: lifted ? REPAIRED : reason };
}

function readReviewOutput(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return { review: null, reason: NO_OUTPUT };
  const { review, reason } = bestReview(text);
  return review ? reviewOf(review, reason) : { review: null, reason };
}

function extractReviewJson(raw) {
  return readReviewOutput(raw).review;
}

const shapeOf = (raw) => (String(raw ?? '').trim() ? bestReview(String(raw)).shape : SHAPES.length);

function carriesWhole(last, whole) {
  if (whole === null || last === null) return false;
  const kept = shapeOf(last);
  return kept >= LISTED.length && shapeOf(whole) < kept;
}

const reviewAnswerOf = (last, whole) => (carriesWhole(last, whole) ? whole : last);

module.exports = { carriesWhole, extractReviewJson, readReviewOutput, reviewAnswerOf, objectOf, NO_OUTPUT, NOT_JSON, NO_FINDINGS, REPAIRED };
