'use strict';

const PLAN_BEGIN = '<!-- ksai-plan-begin -->';
const PLAN_END = '<!-- ksai-plan-end -->';
const TITLE_MARKER = 'ksai-plan-title';
const SUMMARY_MARKER = 'ksai-plan-summary';

const MAX_PLAN_BYTES = 60 * 1024;
const MAX_PLAN_LINES = 5000;
const MAX_FIELD_CHARS = 500;
const MAX_FIELD_LINE = 1024;

const FIELD_SHAPE = (name) => new RegExp(`^<!--\\s*${name}:\\s*([^\\n]*?)\\s*-->$`);

const PLAN_SPAN = new RegExp(`${PLAN_BEGIN}[\\s\\S]*?${PLAN_END}`, 'g');

const PRUNED = '<!-- the handed-in plan, committed as this run\'s plan document -->';

const bare = (fields) => Object.freeze(Object.assign(Object.create(null), fields));

const NAMED = bare({
  [TITLE_MARKER]: 'title',
  [SUMMARY_MARKER]: 'summary',
});

function linesOf(text) {
  return String(text ?? '').split(/\r?\n/);
}

function markerLines(lines, marker) {
  const at = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === marker) at.push(index);
  }
  return at;
}

function fieldFrom(lines, name) {
  const shape = FIELD_SHAPE(name);
  const found = [];
  for (const line of lines) {
    const at = line.trim();
    if (at.length > MAX_FIELD_LINE) continue;
    const match = at.match(shape);
    if (match) found.push(match[1]);
  }
  const noun = NAMED[name] ?? name;
  if (found.length === 0) {
    return { error: `the comment carries no \`<!-- ${name}: ... -->\` line, so the plan has no ${noun}` };
  }
  if (found.length > 1) {
    return { error: `the comment carries ${found.length} \`<!-- ${name}: ... -->\` lines, so which ${noun} it means is not decided here` };
  }
  const value = found[0].trim();
  if (value === '') return { error: `the \`<!-- ${name}: ... -->\` line is empty, so the plan has no ${noun}` };
  if (value.length > MAX_FIELD_CHARS) {
    return { error: `the ${noun} runs to ${value.length} characters, over the limit of ${MAX_FIELD_CHARS}` };
  }
  return { value };
}

function extractGivenPlan(text) {
  const lines = linesOf(text);
  const opens = markerLines(lines, PLAN_BEGIN);
  const closes = markerLines(lines, PLAN_END);

  if (opens.length === 0) {
    return { error: `the comment carries no \`${PLAN_BEGIN}\` line, so there is no handed-in plan to read` };
  }
  if (opens.length > 1) {
    return { error: `the comment opens a handed-in plan ${opens.length} times, so where the plan starts is not decided here` };
  }
  if (closes.length === 0) {
    return { error: `the comment never closes the handed-in plan with \`${PLAN_END}\`, so where it ends is not decided here` };
  }
  if (closes.length > 1) {
    return { error: `the comment closes the handed-in plan ${closes.length} times, so where it ends is not decided here` };
  }
  if (closes[0] < opens[0]) {
    return { error: `the comment closes the handed-in plan above the line that opens it` };
  }

  const document = lines.slice(opens[0] + 1, closes[0]).join('\n');
  if (document.trim() === '') {
    return { error: 'the handed-in plan is empty between its markers, so there is no plan document to commit' };
  }
  const bytes = Buffer.byteLength(document, 'utf8');
  if (bytes > MAX_PLAN_BYTES) {
    return { error: `the handed-in plan is ${bytes} bytes, over the limit of ${MAX_PLAN_BYTES}` };
  }
  const held = document.split('\n').length;
  if (held > MAX_PLAN_LINES) {
    return { error: `the handed-in plan holds ${held} lines, over the limit of ${MAX_PLAN_LINES}` };
  }

  const outside = lines.slice(0, opens[0]).concat(lines.slice(closes[0] + 1));
  const title = fieldFrom(outside, TITLE_MARKER);
  if (title.error) return { error: title.error };
  const summary = fieldFrom(outside, SUMMARY_MARKER);
  if (summary.error) return { error: summary.error };

  return { document: `${document.replace(/\s+$/, '')}\n`, title: title.value, summary: summary.value };
}

function prunePlan(text) {
  return String(text ?? '').replace(PLAN_SPAN, PRUNED);
}

module.exports = {
  extractGivenPlan,
  prunePlan,
  MAX_FIELD_LINE,
  MAX_FIELD_CHARS,
  MAX_PLAN_BYTES,
  MAX_PLAN_LINES,
  PLAN_BEGIN,
  PLAN_END,
  SUMMARY_MARKER,
  TITLE_MARKER,
};
