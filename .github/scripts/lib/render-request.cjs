'use strict';

const { writeFileSync } = require('node:fs');

const CONTRACTS = Object.assign(Object.create(null), require('./prompt-schemas/contracts.json').inputs);
const DIGESTS = Object.assign(Object.create(null), require('./prompt-schemas/manifest.json').schemas);
const PROMPT_DIGESTS = Object.assign(Object.create(null), require('./prompt-schemas/manifest.json').prompts);
const { validateSchema } = require('./json-schema.cjs');

const SCHEMAS = Object.assign(Object.create(null), {
  'claude-generic': require('./prompt-schemas/claude-generic.schema.json'),
  'command-classifier': require('./prompt-schemas/command-classifier.schema.json'),
  'dispute': require('./prompt-schemas/dispute.schema.json'),
  'implement': require('./prompt-schemas/implement.schema.json'),
  'implement-adversarial': require('./prompt-schemas/implement-adversarial.schema.json'),
  'implement-repair': require('./prompt-schemas/implement-repair.schema.json'),
  'pr-test': require('./prompt-schemas/pr-test.schema.json'),
  'pr-test-criteria': require('./prompt-schemas/pr-test-criteria.schema.json'),
  'pr-test-environment': require('./prompt-schemas/pr-test-environment.schema.json'),
  'review': require('./prompt-schemas/review.schema.json'),
  'review-audit': require('./prompt-schemas/review-audit.schema.json'),
  'review-discovery': require('./prompt-schemas/review-discovery.schema.json'),
  'review-findings-audit': require('./prompt-schemas/review-findings-audit.schema.json'),
  'review-resolution': require('./prompt-schemas/review-resolution.schema.json'),
  'review-stage-correction': require('./prompt-schemas/review-stage-correction.schema.json'),
  'task-continue': require('./prompt-schemas/task-continue.schema.json'),
  'task-followup': require('./prompt-schemas/task-followup.schema.json'),
  'task-start': require('./prompt-schemas/task-start.schema.json'),
  'workflow-stage': require('./prompt-schemas/workflow-stage.schema.json'),
  'write-triage-risk': require('./prompt-schemas/write-triage-risk.schema.json'),
  'write-triage-sizing': require('./prompt-schemas/write-triage-sizing.schema.json'),
});
Object.freeze(SCHEMAS);

const SUPPLIED = Object.freeze(Object.assign(Object.create(null), {
  'runtime.task-continue': Object.freeze(['followup']),
  'runtime.workflow-stage': Object.freeze(['instructions', 'known_findings', 'stage']),
}));

function schemaNameFor(promptId) {
  const named = String(promptId ?? '');
  if (!named.startsWith('runtime.')) return '';
  const held = named.slice('runtime.'.length).replaceAll('.', '-');
  if (Object.hasOwn(SCHEMAS, held)) return held;
  return held.startsWith('implement-') && Object.hasOwn(CONTRACTS, named) ? 'implement' : '';
}

const schemaFor = (promptId) => SCHEMAS[schemaNameFor(promptId)] ?? null;

function checkRenderRequest(request, { schemaDigest = '' } = {}) {
  const promptId = String(request?.prompt_id ?? '');
  const sent = (request?.inputs ?? []).map((one) => one.name);
  const seen = new Set();
  const twice = new Set();
  for (const name of sent) (seen.has(name) ? twice : seen).add(name);
  const out = [...twice].sort().map((name) => `${promptId} sends ${name} more than once, and the control plane reads one of them`);
  const supplied = SUPPLIED[promptId] ?? [];
  const declared = CONTRACTS[promptId]?.filter((name) => !supplied.includes(name));
  if (declared) {
    for (const name of declared) if (!seen.has(name)) out.push(`${promptId} declares ${name}, and the request leaves it out`);
    for (const name of [...seen].sort()) if (!declared.includes(name)) out.push(`${promptId} does not declare ${name}, and the request sends it`);
  }
  const schema = schemaFor(promptId);
  if (schemaDigest && schemaDigest !== schemaDigestFor(promptId)) out.push(`${promptId} names a schema digest this release does not carry: ${schemaDigest}`);
  if (!declared) out.push(`${promptId} names no contract this release carries`);
  if (!schema) return out;
  const inputs = Object.fromEntries((request.inputs ?? []).map((one) => [one.name, one.value]));
  const sendable = supplied.length ? { ...schema, required: (schema.required ?? []).filter((name) => !supplied.includes(name)) } : schema;
  out.push(...validateSchema(sendable, inputs, promptId));
  return out;
}

const schemaNames = () => Object.keys(SCHEMAS).sort();



const CONTRACT_VERSION = 'v1';

const SINKS = Object.freeze({
  classifier: 'ksai-classifier',
  generic: 'ksai-generic',
  implement: 'ksai-implement',
  review: 'ksai-review',
  test: 'ksai-test',
  workflowRead: 'ksai-workflow-read',
});

const SINK_NAMES = Object.freeze(Object.values(SINKS));

function renderRequest({ promptId, sink, model, inputs, metadata = null }) {
  const named = String(promptId ?? '');
  if (!/^[a-z][a-z0-9.-]*$/.test(named)) throw new Error(`a render request names no prompt the catalog could hold: ${named || '(none)'}`);
  if (!SINK_NAMES.includes(sink)) throw new Error(`a render request names a sink no prompt is served for: ${String(sink ?? '(none)')}`);
  if (!Array.isArray(inputs)) throw new Error(`the inputs of ${named} are not a list the contract can carry`);
  const request = {
    contract_version: CONTRACT_VERSION,
    prompt_id: named,
    schema_digest: schemaDigestFor(named),
    sink,
    model: String(model ?? ''),
    ...(metadata && { metadata }),
    inputs,
  };
  const refused = checkRenderRequest(request);
  if (refused.length) {
    throw new Error(`${named} does not match the contract the control plane serves: ${refused.join('; ')}`);
  }
  return request;
}

function writeRenderRequest(at, request, { exclusive = false } = {}) {
  writeFileSync(at, JSON.stringify(request), { mode: 0o600, ...(exclusive ? { flag: 'wx' } : {}) });
  return at;
}

const schemaDigestFor = (promptId) => {
  const named = String(promptId ?? '');
  if (Object.hasOwn(PROMPT_DIGESTS, named)) return PROMPT_DIGESTS[named];
  const file = schemaNameFor(named);
  return file ? (DIGESTS[`prompts/schemas/${file}.schema.json`] ?? '') : '';
};

const schemaFileDigestFor = (promptId) => {
  const file = schemaNameFor(promptId);
  return file ? (DIGESTS[`prompts/schemas/${file}.schema.json`] ?? '') : '';
};

module.exports = { CONTRACT_VERSION, schemaDigestFor, schemaFileDigestFor, SINKS, checkRenderRequest, renderRequest, schemaFor, schemaNames, writeRenderRequest };
