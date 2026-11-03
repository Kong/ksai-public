import { createHash } from 'node:crypto';

import json from '../lib/json.cjs';
import schema from '../link/json-schema.cjs';
import profileSchema from './prepare-contract/runtime-preparation.schema.json' with { type: 'json' };
import taskSchema from './prepare-contract/prepare-task.schema.json' with { type: 'json' };
import resultSchema from './prepare-contract/prepare-result.schema.json' with { type: 'json' };

const { parseIJson } = json;
const { validateSchema, validateSchemaDefinition } = schema;

export const PREPARATION_PROFILE_BYTES = 16 * 1024;
export const PREPARE_TASK_BYTES = 16 * 1024;
export const PREPARE_RESULT_BYTES = 8 * 1024;

const TASK_ID = new RegExp(resultSchema.properties.task_id.pattern, 'u');
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{0,8}[1-9]))?Z$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

for (const contract of [profileSchema, taskSchema, resultSchema]) validateSchemaDefinition(contract);

function immutable(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function parseBytes(raw, contract, limit, where) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) throw new Error(`${where} requires UTF-8 bytes or text`);
  if (typeof raw === 'string' && LONE_SURROGATE.test(raw)) throw new Error(`${where} contains a lone Unicode surrogate`);
  const bytes = Buffer.from(raw);
  if (bytes.length >= limit) throw new Error(`${where} reaches its ${limit}-byte limit`);
  const value = parseIJson(bytes, where);
  const problems = validateSchema(contract, value, where);
  if (problems.length) throw new Error(problems.join('; '));
  return Object.freeze({
    value: immutable(value),
    text: bytes.toString('utf8'),
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
}

function deadlineNanoseconds(text) {
  const matched = UTC.exec(text);
  if (!matched) throw new Error('the preparation deadline is not canonical UTC');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = matched;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) {
    throw new Error('the preparation deadline names an invalid calendar instant');
  }
  const milliseconds = Date.parse(`${text.slice(0, 19)}Z`);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('the preparation deadline names an invalid calendar instant');
  return BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND + BigInt(fraction.padEnd(9, '0'));
}

export function parsePreparationProfile(rawProfile) {
  return parseBytes(rawProfile, profileSchema, PREPARATION_PROFILE_BYTES, 'the preparation profile');
}

export function parsePrepareTask(taskId, rawArgument) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Error('the preparation task names no valid Link message id');
  const parsed = parseBytes(rawArgument, taskSchema, PREPARE_TASK_BYTES, 'the preparation task');
  return Object.freeze({ ...parsed, taskId, deadlineNanoseconds: deadlineNanoseconds(parsed.value.deadline_at) });
}

export function parsePrepareResult(rawOutput) {
  return parseBytes(rawOutput, resultSchema, PREPARE_RESULT_BYTES, 'the preparation result');
}

export function assertSamePrepareTask(retainedTask, receivedTask) {
  if (retainedTask.taskId !== receivedTask.taskId || retainedTask.digest !== receivedTask.digest) {
    throw new Error('the preparation task differs from its retained identity');
  }
  return receivedTask;
}

export function assertPrepareExecution(retainedTask, receivedTask, nowNanoseconds) {
  assertSamePrepareTask(retainedTask, receivedTask);
  if (typeof nowNanoseconds !== 'bigint') throw new Error('the preparation guard requires an integer nanosecond clock');
  if (nowNanoseconds >= receivedTask.deadlineNanoseconds) throw new Error('the preparation deadline expired');
  return receivedTask;
}

export function assertPrepareResultIdentity(parsedResult, task) {
  const result = parsedResult.value;
  if (result.task_id !== task.taskId || result.body_digest !== task.digest
    || result.binding_digest !== task.value.binding_digest || result.runtime_commit !== task.value.runtime_commit
    || result.profile_digest !== task.value.profile_digest) {
    throw new Error('the preparation result differs from its task identity');
  }
  return parsedResult;
}

export function prepareDeadlineMilliseconds(task) {
  const nanoseconds = task.deadlineNanoseconds;
  const truncated = nanoseconds / NANOSECONDS_PER_MILLISECOND;
  return Number(truncated - (nanoseconds < 0n && nanoseconds % NANOSECONDS_PER_MILLISECOND !== 0n ? 1n : 0n));
}
