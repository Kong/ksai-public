const fs = require('node:fs');

const { LIMITS, auditProblem, findingProblem } = require('./review-pipeline.cjs');

const TOOL_NAME = 'submit_review_result';
const ATTEMPTS = 3;
const KINDS = Object.freeze(['candidate', 'audit', 'final']);
const AGENTS = new Set(['ksai-review-stage', 'ksai-review-finish', 'ksai-review-submit']);
const ENV_KEYS = Object.freeze([
  'KSAI_REVIEW_RESULT_FILE',
  'KSAI_REVIEW_RESULT_KIND',
  'KSAI_REVIEW_CANDIDATE_IDS',
]);

const text = (value, limit = 4000) => typeof value === 'string' && value.trim() !== '' && value.length <= limit;
const pathOf = (value) => text(value, 512) && !/^(?:\/|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '') && !/[\p{C}]/u.test(value);
const canonical = (value) => JSON.stringify(value) ?? '';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));

function evidenceProblem(evidence) {
  if (!exact(evidence, ['trigger', 'expected', 'observed', 'causal_path', 'premises'])) return 'unexpected evidence field';
  for (const location of evidence.causal_path ?? []) if (!exact(location, ['path', 'line', 'reason'])) return 'unexpected causal-path field';
  for (const premise of evidence.premises ?? []) if (!exact(premise, ['claim', 'source', 'version', 'status'])) return 'unexpected premise field';
  return '';
}

function finalFindingProblem(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'finding is not an object';
  if (!exact(finding, ['path', 'line', 'start_line', 'side', 'severity', 'tag', 'body'])) return 'unexpected final finding field';
  if (!pathOf(finding.path) || !Number.isInteger(finding.line) || finding.line < 1) return 'invalid code location';
  if (finding.start_line !== undefined && (!Number.isInteger(finding.start_line) || finding.start_line < 1 || finding.start_line > finding.line)) return 'invalid start line';
  if (!['LEFT', 'RIGHT'].includes(finding.side) || !['Critical', 'High', 'Medium', 'Low'].includes(finding.severity)) return 'invalid side or severity';
  if (!text(finding.body) || !text(finding.tag, 32)) return 'missing finding body or tag';
  return '';
}

/**
 * single answers a finding's own shape once `start_line` names the line it starts on.
 *
 * GitHub takes `start_line` only for a range, and only below `line`; a one-line comment carries no
 * `start_line` at all. A model handed both fields fills both in, which is how every single-line
 * finding arrived as `start_line === line` and was refused for a rule nothing had told it. The
 * equal pair means the line itself, so it is dropped rather than rejected - and dropped in the one
 * place both the plugin and `submitted` read through, or the held bytes stop matching the call's.
 */
function single(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding) || finding.start_line !== finding.line) return finding;
  const { start_line: _dropped, ...rest } = finding;
  return rest;
}

/** normalized answers the submission as it is held and published, with each finding's own shape settled. */
function normalized(kind, submission) {
  if (kind !== 'final' || !submission || typeof submission !== 'object' || Array.isArray(submission) || !Array.isArray(submission.findings)) return submission;
  return { ...submission, findings: submission.findings.map(single) };
}

function submissionProblem(kind, submission, candidateIds = []) {
  if (!KINDS.includes(kind)) return 'unknown result kind';
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return 'submission is not an object';
  const allowed = kind === 'final' ? ['summary', 'findings'] : kind === 'audit' ? ['summary', 'findings', 'coverage', 'decisions'] : ['summary', 'findings', 'coverage'];
  if (!exact(submission, allowed)) return 'unexpected submission field';
  if (!text(submission.summary, 20_000) || !Array.isArray(submission.findings)) return 'summary and findings are required';
  if (kind === 'final') return submission.findings.map(finalFindingProblem).find(Boolean) ?? '';
  if (!['complete', 'incomplete'].includes(submission.coverage)) return 'coverage must be complete or incomplete';
  if (kind === 'candidate') {
    if (submission.findings.length > LIMITS.candidates) return 'candidate limit exceeded';
    return submission.findings.map((finding) => findingProblem(finding, false) || evidenceProblem(finding.evidence)).find(Boolean) ?? '';
  }
  if (submission.summary !== 'audit' || submission.findings.length !== 0) return 'audit summary must be audit and findings must be empty';
  if (!candidateIds.length || candidateIds.length > LIMITS.batch) return 'audit needs its bounded candidate IDs';
  if (!Array.isArray(submission.decisions)) return 'audit decisions must be an array';
  const decisionProblem = submission.decisions?.find((decision) => !exact(decision, ['id', 'verdict', 'reason', 'finding']) || decision.finding && evidenceProblem(decision.finding.evidence));
  return decisionProblem ? 'unexpected audit decision field' : auditProblem(submission, candidateIds);
}

const locationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'reason'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 512 },
    line: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 4000 },
  },
};

const premiseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'source', 'version', 'status'],
  properties: {
    claim: { type: 'string', minLength: 1, maxLength: 4000 },
    source: { type: 'string', minLength: 1, maxLength: 4000 },
    version: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['verified', 'unverified'] },
  },
};

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'expected', 'observed', 'causal_path', 'premises'],
  properties: {
    trigger: { type: 'string', minLength: 1, maxLength: 4000 },
    expected: { type: 'string', minLength: 1, maxLength: 4000 },
    observed: { type: 'string', minLength: 1, maxLength: 4000 },
    causal_path: { type: 'array', minItems: 1, maxItems: 12, items: locationSchema },
    premises: { type: 'array', maxItems: 12, items: premiseSchema },
  },
};

const candidateSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['path', 'line', 'side', 'severity', 'tag', 'body', 'root_cause', 'evidence'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 512 },
    line: { type: 'integer', minimum: 1 },
    side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
    tag: { type: 'string', minLength: 1, maxLength: 32 },
    body: { type: 'string', minLength: 1, maxLength: 4000 },
    root_cause: { type: 'string', minLength: 1, maxLength: 400 },
    evidence: evidenceSchema,
    verification_hypothesis: { type: 'string', maxLength: 4000 },
  },
};

const finalFindingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'side', 'severity', 'tag', 'body'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 512 },
    line: { type: 'integer', minimum: 1 },
    start_line: { type: 'integer', minimum: 1 },
    side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
    tag: { type: 'string', minLength: 1, maxLength: 32 },
    body: { type: 'string', minLength: 1, maxLength: 4000 },
  },
};

function schemaFor(kind, candidateIds = []) {
  const common = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings'],
    properties: {
      summary: kind === 'audit' ? { const: 'audit' } : { type: 'string', minLength: 1, maxLength: 20_000 },
      findings: { type: 'array', items: kind === 'final' ? finalFindingSchema : candidateSchema },
    },
  };
  if (kind === 'final') return common;
  common.required.push('coverage');
  common.properties.coverage = { type: 'string', enum: ['complete', 'incomplete'] };
  if (kind === 'candidate') {
    common.properties.findings.maxItems = LIMITS.candidates;
    return common;
  }
  common.properties.findings.maxItems = 0;
  common.required.push('decisions');
  common.properties.decisions = {
    type: 'array',
    minItems: candidateIds.length,
    maxItems: candidateIds.length,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'verdict', 'reason'],
      properties: {
        id: { type: 'string', enum: candidateIds },
        verdict: { type: 'string', enum: ['keep', 'remove', 'insufficient_evidence'] },
        reason: { type: 'string', minLength: 1, maxLength: 4000 },
        finding: candidateSchema,
      },
      oneOf: [
        { properties: { verdict: { const: 'keep' } }, required: ['finding'] },
        { properties: { verdict: { enum: ['remove', 'insufficient_evidence'] } } },
      ],
    },
  };
  return common;
}

function plugin(env = process.env) {
  const file = String(env.KSAI_REVIEW_RESULT_FILE ?? '');
  const kind = String(env.KSAI_REVIEW_RESULT_KIND ?? '');
  let candidateIds = [];
  try {
    candidateIds = JSON.parse(env.KSAI_REVIEW_CANDIDATE_IDS || '[]');
    if (!Array.isArray(candidateIds)) candidateIds = [];
  } catch {
    candidateIds = [];
  }
  if (candidateIds.some((id) => !text(id, 200)) || new Set(candidateIds).size !== candidateIds.length) candidateIds = [];
  let used = 0;
  let accepted = false;
  let invalid = false;
  let held = null;
  /*
   * A refusal ends the attempt, never the session. The count was of calls rather than acceptances,
   * so one rejected submission latched every later call - and because `tool.execute.before` reads
   * the same count, the refusal reached *every* tool, not just this one. A reviewer told to fix its
   * own submission could not call anything again, and a finished review with its findings written
   * was thrown away on a corrigible mistake.
   */
  const reject = (why) => {
    held = null;
    const left = ATTEMPTS - used;
    if (left < 1) throw new Error(`${why}; no attempts remain, so this review result is refused`);
    throw new Error(`${why}; correct it and submit again, ${left} ${left === 1 ? 'attempt' : 'attempts'} left`);
  };
  return {
    tool: {
      [TOOL_NAME]: {
        description: `Submit the completed ${kind} review result. Call it once with a submission that validates, correct and call again if it is refused, then end the turn without repeating an accepted result.`,
        args: { submission: schemaFor(kind, candidateIds) },
        async execute(args, context) {
          if (accepted) {
            invalid = true;
            held = null;
            throw new Error('duplicate review result submission');
          }
          used += 1;
          /*
           * The budget is spent here, not in `reject`. Counted only where a refusal is worded, it
           * decorated the message and bounded nothing: after three refusals a fourth call that
           * happened to validate was accepted, by a plugin whose own last error said no attempts
           * remained.
           */
          if (used > ATTEMPTS) {
            held = null;
            throw new Error('no attempts remain, so this review result is refused');
          }
          const problem = !AGENTS.has(context?.agent) ? 'this agent cannot submit review results' : !/^ses_[a-zA-Z0-9]+$/.test(context?.sessionID ?? '') ? 'review result has no valid session' : submissionProblem(kind, args?.submission, candidateIds);
          const bytes = canonical(args?.submission);
          if (problem || !bytes || Buffer.byteLength(bytes) > LIMITS.outputBytes) {
            return reject(problem || 'review result exceeds its byte bound');
          }
          const candidate = { version: 1, kind, session_id: context.sessionID, submission: normalized(kind, args.submission) };
          if (Buffer.byteLength(canonical(candidate)) > LIMITS.outputBytes) return reject('review result exceeds its byte bound');
          accepted = true;
          held = candidate;
          return 'Review result accepted. End this turn without repeating it.';
        },
      },
    },
    'shell.env': async (_input, output) => {
      for (const key of ENV_KEYS) output.env[key] = '';
    },
    'tool.execute.before': async () => {
      if (!accepted) return;
      invalid = true;
      held = null;
      throw new Error('review result was already submitted');
    },
    dispose: async () => {
      if (invalid || !accepted || !held || !file) return;
      let descriptor;
      try {
        descriptor = fs.openSync(file, 'wx', 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, `${canonical(held)}\n`);
      } catch {
        try { fs.unlinkSync(file); } catch {}
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    },
  };
}

function submitted({ file, events, kind, candidateIds = [] }) {
  const calls = events.filter((event) => event?.type === 'tool_use' && event.part?.tool === TOOL_NAME);
  if (calls.length === 0) return { status: 'missing', text: null };
  /*
   * A refused call is an attempt, not a submission. Counting every call read the corrected retry the
   * plugin now invites as a duplicate, which would have refused the very result it accepted. The
   * plugin holds one acceptance at most, so more than one completed call is still the old duplicate.
   */
  const done = calls.filter((call) => call.part?.state?.status === 'completed');
  if (done.length === 0) return { status: 'invalid', text: null };
  if (done.length !== 1) return { status: 'duplicate', text: null };
  const [call] = done;
  const input = call.part?.state?.input?.submission;
  if (!/^ses_[a-zA-Z0-9]+$/.test(call.sessionID ?? '')) return { status: 'invalid', text: null };
  const encoded = canonical(normalized(kind, input));
  if (!encoded) return { status: 'invalid', text: null };
  if (Buffer.byteLength(encoded) > LIMITS.outputBytes) return { status: 'oversized', text: null };
  if (submissionProblem(kind, input, candidateIds)) return { status: 'invalid', text: null };
  let held;
  let stat;
  try {
    stat = fs.statSync(file);
    held = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { status: 'missing', text: null };
  }
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > LIMITS.outputBytes) return { status: 'invalid', text: null };
  if (held?.version !== 1 || held.kind !== kind || held.session_id !== call.sessionID || canonical(held.submission) !== encoded) return { status: 'invalid', text: null };
  if (submissionProblem(kind, held.submission, candidateIds)) return { status: 'invalid', text: null };
  return { status: 'accepted', text: encoded };
}

module.exports = { TOOL_NAME, KINDS, ENV_KEYS, schemaFor, submissionProblem, finalFindingProblem, plugin, submitted };
