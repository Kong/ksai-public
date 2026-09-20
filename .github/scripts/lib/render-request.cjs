'use strict';

const { writeFileSync } = require('node:fs');

const CONTRACT_VERSION = 'v1';

const SINKS = Object.freeze({
  classifier: 'ksai-classifier',
  generic: 'ksai-generic',
  implement: 'ksai-implement',
  review: 'ksai-review',
  test: 'ksai-test',
});

const SINK_NAMES = Object.freeze(Object.values(SINKS));

function renderRequest({ promptId, sink, model, inputs }) {
  const named = String(promptId ?? '');
  if (!/^[a-z][a-z0-9.-]*$/.test(named)) throw new Error(`a render request names no prompt the catalog could hold: ${named || '(none)'}`);
  if (!SINK_NAMES.includes(sink)) throw new Error(`a render request names a sink no prompt is served for: ${String(sink ?? '(none)')}`);
  if (!Array.isArray(inputs)) throw new Error(`the inputs of ${named} are not a list the contract can carry`);
  return {
    contract_version: CONTRACT_VERSION,
    prompt_id: named,
    sink,
    model: String(model ?? ''),
    inputs,
  };
}

function writeRenderRequest(at, request, { exclusive = false } = {}) {
  writeFileSync(at, JSON.stringify(request), { mode: 0o600, ...(exclusive ? { flag: 'wx' } : {}) });
  return at;
}

module.exports = { CONTRACT_VERSION, SINKS, renderRequest, writeRenderRequest };
