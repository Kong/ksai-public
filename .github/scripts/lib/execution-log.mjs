import { readFileSync } from 'node:fs';
import { constants } from 'node:os';

export const SUCCESS = 'success';

export const TRUNCATED = 'error_max_turns';

export const FAILED = 'error_during_execution';

const SIGNAL_NAMES = Object.entries(constants.signals).reduce((names, [name, number]) => {
  if (!(number in names)) names[number] = name;
  return names;
}, Object.create(null));

/**
 * exitedOn answers a child's exit as one number, encoding the signal that ended it as `128 + n`.
 *
 * @param {number | null} status
 * @param {string | null} signal
 * @returns {number}
 */
export function exitedOn(status, signal) {
  if (status !== null && status !== undefined) return Number(status);
  const number = signal ? Number(constants.signals[signal]) : 0;
  return Number.isFinite(number) && number > 0 ? 128 + number : 1;
}

/**
 * stopReason answers why a run ended, where the exit code alone reads as something it was not.
 *
 * @param {number | string | undefined} exitCode
 * @returns {string}
 */
export function stopReason(exitCode) {
  const code = Number(exitCode);
  if (!Number.isFinite(code) || code === 0) return '';
  if (code <= 128) return `opencode exited ${code}`;
  const signal = SIGNAL_NAMES[code - 128];
  return `opencode was killed by ${signal ?? `signal ${code - 128}`} (exit ${code}), not stopped by a turn limit`;
}

export function resultRecord({
  text = null,
  usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  cost = null,
  turns = 0,
  durationMs = 0,
  denials = [],
  truncated = false,
  failed = false,
  reason = '',
} = {}) {
  const said = typeof text === 'string';
  const cut = Boolean(truncated);
  const missing = Boolean(failed) || !said || cut;
  const why = missing ? String(reason ?? '').trim() : '';
  return [
    {
      type: 'result',
      subtype: cut ? TRUNCATED : missing ? FAILED : SUCCESS,
      is_error: missing,
      result: cut || !said ? '' : String(text),
      ...(why ? { stop_reason: why } : {}),
      usage,
      total_cost_usd: cost,
      num_turns: Number(turns) || 0,
      duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      permission_denials: Array.isArray(denials) ? denials : [],
    },
  ];
}

export function conclusionOf(at, read = readFileSync) {
  try {
    const [result] = JSON.parse(String(read(at, 'utf8')));
    return result?.is_error === false ? 'success' : 'failure';
  } catch {
    return 'failure';
  }
}
