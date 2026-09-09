'use strict';

const { COMMANDS, MODEL_CORE, MODEL_SHAPE } = require('./select-arm.cjs');
const { markerJson } = require('./run-record.cjs');
const { escapeForRegExp } = require('./text.cjs');

const VERSION = 1;
const IDENTITY_PREFIX = '<!-- ksai-write-report:';
const PREFIX = '<!-- ksai-write-state:';
const SHAPE = new RegExp(`${escapeForRegExp(PREFIX)}(\\{[^]*?\\}) -->`);
const SHAPE_ALL = new RegExp(SHAPE, 'g');
const IDENTITY_SHAPE = new RegExp(`${escapeForRegExp(IDENTITY_PREFIX)}(\\{[^]*?\\}) -->`);

const MAX_ATTEMPTS = 60;
const MAX_PAID_RUNS = 204;
const MAX_ARM_KINDS = 12;

const ATTEMPT_ID_SHAPE = /^\d{1,20}:\d{1,10}:[A-Za-z0-9_.~-]{1,40}:\d{1,10}$/;

const REASON_SHAPE = /^[a-z][a-z0-9-]{0,39}$/;

const UNCLASSIFIED_REASON = 'unclassified';
const ARMS = Object.freeze(['classifier', 'triage', 'dispute', 'main', 'status']);
const ARM_MODEL_SHAPE = new RegExp(`^(?:${MODEL_CORE})?$`);
const ARM_EFFORT_SHAPE = /^[a-z]{0,16}$/;
const ROUTE_SOURCES = Object.freeze(['explicit', 'classifier', 'context', 'continuation']);
const ROUTE_SURFACES = Object.freeze(['issue', 'pull', 'thread', 'review']);
const SELECTION_SOURCES = Object.freeze(['input', 'comment', 'triage']);

const ROUTE_FIELDS = Object.freeze(['route_command', 'route_surface', 'route_source']);

const ATTEMPT_FIELDS = Object.freeze([
  'id',
  'phase',
  'outcome',
  'model',
  'effort',
  'model_source',
  'effort_source',
  'selection',
  'paid_runs',
  'duration_s',
  'turns',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'arms',
  'route_command',
  'route_surface',
  'route_source',
  'at',
  'reason',
]);

function armFields(arm) {
  if (!Array.isArray(arm)) return null;
  if (arm.length === 5) return { name: arm[0], model: arm[1], effort: arm[2], runs: arm[3], cost: arm[4] };
  if (arm.length === 4) return { name: arm[0], model: arm[1], effort: '', runs: arm[2], cost: arm[3] };
  return null;
}

function validNullableNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validNullableInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validArm(arm) {
  const held = armFields(arm);
  if (held === null) return false;
  const { name, model, effort, runs, cost } = held;
  if (!ARMS.includes(name)) return false;
  if (typeof model !== 'string' || !ARM_MODEL_SHAPE.test(model)) return false;
  if (typeof effort !== 'string' || !ARM_EFFORT_SHAPE.test(effort)) return false;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_PAID_RUNS) return false;
  return validNullableNumber(cost) && Number(cost ?? 0) <= 1_000_000_000;
}

function validArms(arms) {
  if (!Array.isArray(arms) || arms.length > ARMS.length) return false;
  const named = arms.map((arm) => (Array.isArray(arm) ? arm[0] : arm));
  return new Set(named).size === named.length && arms.every((arm) => validArm(arm));
}

const shaped = (value, shape) => typeof value === 'string' && shape.test(value);

function validAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return false;
  if (!shaped(attempt.id, ATTEMPT_ID_SHAPE)) return false;
  if (!shaped(attempt.phase, /^[A-Za-z0-9._/-]{1,24}$/)) return false;
  if (!shaped(attempt.outcome, /^[A-Za-z0-9._/-]{1,24}$/)) return false;
  if (!shaped(attempt.model, MODEL_SHAPE)) return false;
  if (!shaped(attempt.effort, /^[a-z]{1,16}$/)) return false;
  if (!SELECTION_SOURCES.includes(attempt.model_source)) return false;
  if (!SELECTION_SOURCES.includes(attempt.effort_source)) return false;
  if (!Number.isSafeInteger(attempt.paid_runs) || attempt.paid_runs < 0 || attempt.paid_runs > MAX_PAID_RUNS) {
    return false;
  }
  for (const key of ['duration_s', 'turns', 'input_tokens', 'output_tokens']) {
    if (!validNullableInteger(attempt[key])) return false;
  }
  if (!validNullableNumber(attempt.cost_usd) || Number(attempt.cost_usd) > 1_000_000_000) return false;
  if (!validArms(attempt.arms)) return false;
  if (attempt.route_command !== '' && !COMMANDS.includes(attempt.route_command)) return false;
  if (attempt.route_surface !== '' && !ROUTE_SURFACES.includes(attempt.route_surface)) return false;
  if (attempt.route_source !== '' && !ROUTE_SOURCES.includes(attempt.route_source)) return false;
  if (attempt.at !== null && !(Number.isSafeInteger(attempt.at) && attempt.at > 0)) return false;
  if (attempt.reason !== null && !shaped(attempt.reason, REASON_SHAPE)) return false;
  return typeof attempt.selection === 'string' && attempt.selection.length <= 80;
}

function armKinds(attempts) {
  const kinds = [];
  const at = new Map();
  for (const attempt of attempts) {
    for (const arm of attempt.arms ?? []) {
      const held = armFields(arm);
      if (held === null) continue;
      const key = `${held.model} ${held.effort}`;
      if (at.has(key) || kinds.length >= MAX_ARM_KINDS) continue;
      at.set(key, kinds.length);
      kinds.push([held.model, held.effort]);
    }
  }
  return { kinds, at };
}

function packArms(arms, at) {
  const packed = [];
  for (const arm of arms ?? []) {
    const held = armFields(arm);
    if (held === null) continue;
    const index = ARMS.indexOf(held.name);
    if (index === -1) continue;
    packed.push([index, at.get(`${held.model} ${held.effort}`) ?? -1, held.runs, held.cost]);
  }
  return packed;
}

function unpackArm(arm, kinds) {
  if (!Array.isArray(arm) || arm.length !== 4) return arm;
  if (typeof arm[0] !== 'number') return arm;
  const name = ARMS[arm[0]];
  const kind = Number.isInteger(arm[1]) && arm[1] >= 0 ? kinds[arm[1]] : null;
  return [name === undefined ? '' : name, kind?.[0] ?? '', kind?.[1] ?? '', arm[2], arm[3]];
}

function unpackArms(stored, kinds) {
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored)) return stored;
  return stored.map((arm) => unpackArm(arm, kinds));
}

const trimmed = (row) => {
  const held = [...row];
  while (held.length > 0 && (held.at(-1) === undefined || held.at(-1) === null)) held.pop();
  return held;
};

function packAttempts(attempts) {
  const { kinds, at } = armKinds(attempts);
  return {
    kinds,
    rows: attempts.map((attempt) =>
      trimmed(ATTEMPT_FIELDS.map((name) => (name === 'arms' ? packArms(attempt.arms, at) : attempt[name]))),
    ),
  };
}

function unpackAttempt(row, kinds) {
  const held = {};
  ATTEMPT_FIELDS.forEach((name, index) => {
    const value = name === 'arms' ? unpackArms(row?.[index], kinds) : row?.[index];
    held[name] = value ?? (ROUTE_FIELDS.includes(name) ? '' : null);
  });
  return held;
}

const IDENTITY_KINDS = Object.freeze(['implement', 'fix', 'do', 'unlock']);

const positiveOrAbsent = (value) =>
  value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER);

function validIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  if (identity.v !== VERSION || !IDENTITY_KINDS.includes(identity.kind)) return false;
  if (identity.source !== undefined && !/^(?:github|jira)\/[A-Za-z0-9_-]{1,64}$/.test(String(identity.source))) {
    return false;
  }
  return positiveOrAbsent(identity.pr) && positiveOrAbsent(identity.request);
}

function writeIdentityIn(body) {
  const text = String(body ?? '');
  if (text.split(IDENTITY_PREFIX).length > 2) return null;
  const found = text.match(IDENTITY_SHAPE);
  if (!found) return null;
  let parsed;
  try {
    parsed = JSON.parse(found[1]);
  } catch {
    return null;
  }
  return validIdentity(parsed) ? parsed : null;
}

function writeStateIn(body) {
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
  if (parsed.v !== VERSION || !Array.isArray(parsed.a)) return null;
  if (!validIdentity(parsed.identity)) return null;
  if (!/^https:\/\/[^\s]{1,240}$/.test(String(parsed.run_base ?? ''))) return null;

  const kinds = Array.isArray(parsed.k) ? parsed.k : [];
  const attempts = parsed.a.map((row) => unpackAttempt(row, kinds));
  if (attempts.length > MAX_ATTEMPTS || !attempts.every((attempt) => validAttempt(attempt))) return null;
  const ids = attempts.map((attempt) => attempt.id);
  if (new Set(ids).size !== ids.length) return null;

  const history = (Array.isArray(parsed.h) ? parsed.h : [])
    .filter((entry) => Array.isArray(entry) && Number.isSafeInteger(entry[0]) && typeof entry[1] === 'string')
    .map((entry) => ({ at: entry[0], said: entry[1] }));

  return { v: parsed.v, identity: parsed.identity, run_base: parsed.run_base, history, attempts };
}

function writeStateMarker({ v = VERSION, identity, run_base: runBase, history = [], attempts = [] }) {
  const { kinds, rows } = packAttempts(attempts);
  const stored = {
    v,
    identity,
    run_base: runBase,
    ...(history.length === 0 ? {} : { h: history.map((entry) => [entry.at, entry.said]) }),
    k: kinds,
    a: rows,
  };
  return `${PREFIX}${markerJson(stored)} -->`;
}

module.exports = {
  ARMS,
  ARM_EFFORT_SHAPE,
  ARM_MODEL_SHAPE,
  ATTEMPT_FIELDS,
  ATTEMPT_ID_SHAPE,
  REASON_SHAPE,
  UNCLASSIFIED_REASON,
  IDENTITY_PREFIX,
  MAX_ATTEMPTS,
  MAX_PAID_RUNS,
  PREFIX,
  SHAPE,
  SHAPE_ALL,
  VERSION,
  armFields,
  unpackArms,
  unpackAttempt,
  validAttempt,
  writeIdentityIn,
  writeStateIn,
  writeStateMarker,
};
