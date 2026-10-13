import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { annotation } from './text.cjs';

export const ACKNOWLEDGEMENT_LOG = 'ksai-link-acknowledgements.jsonl';

const tokensOf = (usage) => ['input', 'output', 'cache_read', 'cache_write'].reduce((total, name) => total + (Number(usage?.[name]) || 0), 0);

export function acknowledgedOf({ kind, body }) {
  if (kind === 'observation' && body?.withheld !== true && (body?.parts === undefined || body.part === body.parts - 1)) return [{ kind, id: body.id }];
  if (kind === 'receipt') return (Array.isArray(body?.deliveries) ? body.deliveries : []).map((one) => ({ kind, final_digest: one?.final_digest }));
  if (kind === 'usage' && tokensOf(body) > 0) return [{ kind, session: body.session }];
  return [];
}

export function acknowledging(runnerTemp, warn = (line) => console.log(line)) {
  const log = join(runnerTemp, ACKNOWLEDGEMENT_LOG);
  let warned = false;
  const written = (lines) => {
    try {
      appendFileSync(log, lines, { mode: 0o600 });
    } catch (error) {
      if (!warned) warn(annotation(`the acknowledgement log could not be written: ${error?.message ?? error}`, 'warning'));
      warned = true;
    }
  };
  written('');
  return (message) => {
    const lines = acknowledgedOf(message).map((one) => `${JSON.stringify(one)}\n`).join('');
    if (lines !== '') written(lines);
  };
}

export function acknowledgedIn(runnerTemp) {
  const log = join(runnerTemp, ACKNOWLEDGEMENT_LOG);
  if (!existsSync(log)) return null;
  const read = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const of = (kind, name) => [...new Set(read.filter((one) => one.kind === kind).map((one) => one[name]))];
  return { observations: of('observation', 'id'), receipts: of('receipt', 'final_digest'), spent: read.some((one) => one.kind === 'usage') };
}
