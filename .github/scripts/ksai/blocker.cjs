'use strict';

const { readFileSync } = require('node:fs');
const OUTCOME_SCHEMA = require('../lib/work-session-schemas/outcome-v1.json');

const BLOCKER_MOST = OUTCOME_SCHEMA.properties.blocker.maxLength;

function blockerOf(env, { read = (at) => readFileSync(at, 'utf8') } = {}) {
  const at = String(env.BLOCKER_FILE ?? '').trim();
  if (String(env.BLOCKER_ASKED ?? '').trim() !== 'true' || at === '') return '';
  let said;
  try {
    said = String(read(at)).trim();
  } catch {
    return '';
  }
  if (said.length <= BLOCKER_MOST) return said;
  return Array.from(said.slice(0, 2 * BLOCKER_MOST + 1)).length > BLOCKER_MOST ? '' : said;
}

module.exports = { BLOCKER_MOST, blockerOf };
