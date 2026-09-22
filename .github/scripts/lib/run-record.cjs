'use strict';

const { escapeForRegExp } = require('./text.cjs');
const { runSettingsArmOf } = require('./run-settings-migration.cjs');

const PREFIX = '<!-- ksai-run-state:';

const SHAPE = new RegExp(`${escapeForRegExp(PREFIX)}(\\{[^]*?\\}) -->`);

// `stopped_by` names what ended a run that did not end itself. The watchdog knows - `publish.cjs`
// has written the sentence "the review watchdog stopped it" into the posted comment since it
// existed - but nothing machine-readable carried it, so the corpus recorded a terminated review as
// `head_moved` or `error_during_execution` and every findings rate counted it as a review that
// looked and found nothing. 84 of them over 2026-09-13..09-18, 19% of one arm's runs.
const FIELDS = Object.freeze([
  'conclusion',
  'stopped_by',
  'reviewed_commit',
  'model',
  'effort',
  'selected_by',
  'run_settings_arm',
  'triage',
  'engine',
  'review_protocol',
  'repo_rules',
  'channel_notes',
  'status_updates',
  'status_model',
  'status_cost_usd',
  'prompt',
  'duration_s',
  'num_turns',
  'input_tokens',
  'output_tokens',
  'uncached_input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'permission_denials',
  'cost_usd',
]);

const DETAIL = Object.freeze([
  'requester',
  'triage_why',
  'rules_path',
  'rules_sha',
  'rules_bytes',
  'rules_packs',
]);

const VERSION = 1;

const markerJson = (value) => JSON.stringify(value).replace(/--/g, '-\\u002d');

const only = (names, source) => Object.fromEntries(names.map((name) => [name, source?.[name] ?? null]));

const shaped = (source) => ({ ...only(FIELDS, source), run_settings_arm: runSettingsArmOf(source) });

const runDetail = (source) => only(DETAIL, source);

const FLOWS = Object.freeze(['review', 'test']);

const flowOf = (value) => value ?? FLOWS[0];

function runStateMarker(fields) {
  const marker = { v: VERSION, flow: flowOf(fields?.flow), ...shaped(fields), detail: runDetail(fields?.detail) };
  return `${PREFIX}${markerJson(marker)} -->`;
}

function runStateIn(body) {
  const text = String(body ?? '');
  if (text.split(PREFIX).length > 2) return null;
  const found = text.match(SHAPE);
  if (!found) return null;
  let parsed;
  try {
    parsed = JSON.parse(found[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.v !== VERSION) return null;
  if (parsed.flow !== undefined && !FLOWS.includes(parsed.flow)) return null;
  return { flow: flowOf(parsed.flow), ...shaped(parsed), detail: runDetail(parsed.detail) };
}

module.exports = { DETAIL, FIELDS, FLOWS, PREFIX, flowOf, markerJson, runDetail, runStateIn, runStateMarker };
