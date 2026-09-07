import { readFileSync } from 'node:fs';

export const SUCCESS = 'success';

export const TRUNCATED = 'error_max_turns';

export const FAILED = 'error_during_execution';

export function resultRecord({
  text = null,
  usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  cost = null,
  turns = 0,
  durationMs = 0,
  denials = [],
  truncated = false,
  failed = false,
} = {}) {
  const said = typeof text === 'string';
  const cut = Boolean(truncated);
  const missing = Boolean(failed) || !said || cut;
  return [
    {
      type: 'result',
      subtype: cut ? TRUNCATED : missing ? FAILED : SUCCESS,
      is_error: missing,
      result: cut || !said ? '' : String(text),
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
