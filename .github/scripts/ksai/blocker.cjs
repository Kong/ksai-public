'use strict';

const { readFileSync } = require('node:fs');
const { validateSchema } = require('../lib/json-schema.cjs');
const OUTCOME_SCHEMA = require('../lib/task-schemas/task-outcome-v1.json');

function textAt(file, read) {
  const at = String(file ?? '').trim();
  if (at === '') return '';
  try {
    return String(read(at)).trim();
  } catch {
    return '';
  }
}

function blockerOf(env, { read = (at) => readFileSync(at, 'utf8') } = {}) {
  if (String(env.BLOCKER_ASKED ?? '').trim() !== 'true') return '';
  const said = textAt(env.BLOCKER_FILE, read);
  return validateSchema(OUTCOME_SCHEMA.properties.blocker, said, 'blocker').length ? '' : said;
}

function stoppedOf(env, { read = (at) => readFileSync(at, 'utf8') } = {}) {
  return textAt(env.STOPPED_FILE, read).slice(0, OUTCOME_SCHEMA.properties.blocker.maxLength);
}

const MAX_SAID_CHARS = 8192;

function saidOf(env, { read = (at) => readFileSync(at, 'utf8') } = {}) {
  if (String(env.SAID_ASKED ?? '').trim() !== 'true') return '';
  const said = textAt(env.STOPPED_FILE, read).replace(/<!--[\s\S]*?-->/g, '').trim();
  return Array.from(said).slice(0, MAX_SAID_CHARS).join('');
}

module.exports = { blockerOf, saidOf, stoppedOf };
