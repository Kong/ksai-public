'use strict';

const { markdownTable } = require('./markdown-table.cjs');

/*
 * The wire shape carries no escaped newline, and trusted code puts every line break back.
 *
 * `zai-org/GLM-5.3` reached `submit_review_result` with every backslash gone from the argument, so
 * each `\n` the model encoded arrived as the letter `n`: on 2026-09-18 that failed seven reviews
 * outright, each spending its three attempts resubmitting byte-identical text it could not fix,
 * while the same turn's assistant text carried its newlines intact. The corruption is upstream of
 * the relay, which is a byte copy, so nothing here can repair it and nothing here can tell the
 * letter from the escape afterwards.
 *
 * So the wire stops asking for one. A body is an array of lines and the verdict table is its four
 * cells; `fromWire` joins and renders them, and everything downstream - the publisher, the match
 * ID, the eval corpus - still reads the single string it always read. A dropped backslash now has
 * nothing to corrupt, whatever the engine or the model.
 *
 * `body` stays the identity `match-id.cjs` hashes, which is why the join happens here rather than
 * the fence moving to a field of its own: the canonical input is a wire contract, and changing it
 * would silently un-suppress every committed rule.
 */
const VERDICT_LABELS = Object.freeze([['scope', 'Scope'], ['mandate', 'Mandate'], ['findings', 'Findings'], ['findings_audit', 'Findings audit']]);
const CELL_LIMIT = 400;
const LINE_LIMIT = 400;
const BODY_CHARS = 4000;
const ASSESSMENT_LIMIT = 4;
/*
 * Bounded so the schema composes with the joined caps it cannot express.
 *
 * JSON Schema bounds each element and never their join, so an array that every element bound
 * admits can still exceed the length the joined value is held to - and the refusal then names the
 * joined field, which reads as though the model omitted it. The four cells and their labels come
 * to under 1,800 characters, so four paragraphs of this size leave the rendered summary inside the
 * 4,000 a final summary is capped at. `wireProblem` states the body's joined bound in its own
 * words, because no element bound can.
 */
const ASSESSMENT_CHARS = 500;

const exactKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

const cell = (value) => typeof value === 'string' && value.length <= CELL_LIMIT && !/[\n\r]/.test(value);
const lineList = (value, limit = LINE_LIMIT) => Array.isArray(value) && value.length > 0 && value.length <= limit && value.every((line) => typeof line === 'string' && !/[\n\r]/.test(line));
const joinLines = (value) => (lineList(value) ? value.join('\n') : value);

/** renderVerdict writes the verdict table, so a malformed one cannot be submitted at all. */
function renderVerdict(verdict) {
  return markdownTable(['Check', 'Result'], VERDICT_LABELS.map(([key, label]) => [label, verdict[key]]));
}

function verdictProblem(verdict, assessment) {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return 'verdict is not an object';
  if (!exactKeys(verdict, VERDICT_LABELS.map(([key]) => key))) return 'unexpected verdict field';
  if (!VERDICT_LABELS.every(([key]) => cell(verdict[key]) && verdict[key].trim() !== '')) return `every verdict cell is one nonempty line of at most ${CELL_LIMIT} characters, with no line break in it`;
  if (!lineList(assessment, 4)) return 'assessment is one to four paragraphs, each a string with no line break in it';
  return '';
}

const withBody = (finding) => (finding && typeof finding === 'object' && !Array.isArray(finding) ? { ...finding, body: joinLines(finding.body) } : finding);

/** wireProblem answers the shape the model submits, before `fromWire` renders it. */
function wireProblem(kind, submission) {
  if (typeof submission === 'string') return 'submission arrived as text that does not parse as a JSON object; pass the object itself';
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return 'submission is not an object';
  const findings = Array.isArray(submission.findings) ? submission.findings : [];
  if (findings.some((finding) => finding && typeof finding === 'object' && !Array.isArray(finding) && !lineList(finding.body))) return 'every finding body is an array of lines, each a string with no line break in it';
  const decisions = Array.isArray(submission.decisions) ? submission.decisions : [];
  if (decisions.some((decision) => decision?.finding && !lineList(decision.finding.body))) return 'every audit decision finding body is an array of lines, each a string with no line break in it';
  const bodies = [...findings, ...decisions.map((decision) => decision?.finding)].filter(Boolean).map((finding) => joinLines(finding.body));
  if (bodies.some((body) => typeof body === 'string' && body.length > BODY_CHARS)) return `a finding body joins to more than ${BODY_CHARS} characters; shorten it`;
  if (kind !== 'final') return '';
  if (!exactKeys(submission, ['verdict', 'assessment', 'findings'])) return 'unexpected submission field';
  return verdictProblem(submission.verdict, submission.assessment);
}

/** fromWire renders the submitted shape into the review every later reader already expects. */
function fromWire(kind, submission) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return submission;
  const rendered = { ...submission };
  if (Array.isArray(submission.findings)) rendered.findings = submission.findings.map((finding) => withBody(finding));
  if (Array.isArray(submission.decisions)) rendered.decisions = submission.decisions.map((decision) => (decision && typeof decision === 'object' && !Array.isArray(decision) ? { ...decision, finding: withBody(decision.finding) } : decision));
  if (kind !== 'final') return rendered;
  if (verdictProblem(submission.verdict, submission.assessment)) return rendered;
  const { verdict, assessment, findings } = rendered;
  return { summary: [renderVerdict(verdict), ...assessment].join('\n\n'), findings };
}

const rendered = (review) => fromWire(Array.isArray(review.decisions) || review.coverage !== undefined ? 'stage' : 'final', review);

module.exports = { VERDICT_LABELS, CELL_LIMIT, LINE_LIMIT, BODY_CHARS, ASSESSMENT_LIMIT, ASSESSMENT_CHARS, renderVerdict, wireProblem, fromWire, rendered };
