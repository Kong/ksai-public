'use strict';

const { escapeForRegExp } = require('./text.cjs');

const PREFIX = '<!-- ksai-run-state:';

const SHAPE = new RegExp(`${escapeForRegExp(PREFIX)}(\\{[^]*?\\}) -->`);

const FIELDS = Object.freeze([
  'conclusion',
  'reviewed_commit',
  'model',
  'effort',
  'selected_by',
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
]);

const VERSION = 1;

const markerJson = (value) => JSON.stringify(value).replace(/--/g, '-\\u002d');

const only = (names, source) => Object.fromEntries(names.map((name) => [name, source?.[name] ?? null]));

const shaped = (source) => only(FIELDS, source);

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
