'use strict';

const { readFileSync } = require('node:fs');
const { validateSchema } = require('../lib/json-schema.cjs');
const OUTCOME_SCHEMA = require('../lib/work-session-schemas/outcome-v1.json');

function blockerOf(env, { read = (at) => readFileSync(at, 'utf8') } = {}) {
  const at = String(env.BLOCKER_FILE ?? '').trim();
  if (String(env.BLOCKER_ASKED ?? '').trim() !== 'true' || at === '') return '';
  let said;
  try {
    said = String(read(at)).trim();
  } catch {
    return '';
  }
  return validateSchema(OUTCOME_SCHEMA.properties.blocker, said, 'blocker').length ? '' : said;
}

module.exports = { blockerOf };
