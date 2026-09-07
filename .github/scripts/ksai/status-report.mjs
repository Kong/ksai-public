import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { counted } from '../lib/text.cjs';
import { estimate } from './prices.mjs';
import { addTally, elapsed, emptyTally, plain } from './progress.mjs';
import { armed, compact } from './status.mjs';

const require = createRequire(import.meta.url);
const { appendHistory, stageOf, visibleHistory } = require('../lib/run-progress.cjs');

const MAX_ROWS = 200;

/** digest answers what a run's status log holds: its rows, and what the summariser spent writing them. */
export function digest(text, startedAtMs = 0) {
  const rows = [];
  const usage = emptyTally();
  let model = '';
  let posted = 0;
  let summaryRequests = 0;
  let summaryAnswers = 0;
  let summaryUsages = 0;
  let history = [];
  let stage = 'working';
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.posted === true) posted += 1;
    if (entry?.summary_requested === true) summaryRequests += 1;
    if (entry?.summary_answered === true) summaryAnswers += 1;
    if (entry?.usage) {
      summaryUsages += 1;
      addTally(usage, entry.usage);
    }
    if (entry?.model) model = String(entry.model);
    stage = stageOf(entry?.stage);
    history = appendHistory(history, { at: entry?.at, stage, said: plain(entry?.said, 240) });
    if (rows.length >= MAX_ROWS) continue;
    const at = Number(entry?.at);
    rows.push({
      elapsed: Number.isFinite(at) && startedAtMs > 0 ? elapsed(at - startedAtMs) : '',
      left: Number.isFinite(entry?.left) ? `${entry.left}m` : '',
      calls: Number(entry?.calls) || 0,
      tokens: entry?.tokens ?? {},
      said: plain(entry?.said, 160),
      doing: plain(entry?.doing, 80),
    });
  }
  return {
    rows,
    history,
    stage,
    usage,
    model,
    posted,
    summaryRequests,
    summaryAnswers,
    summaryUsages,
    updates: rows.length,
  };
}

/** format renders the status log for the job summary, naming the silence when there was one. */
export function format(record) {
  if (record.updates === 0) {
    return '## What the run was doing\n\nNo status was published. Either the run was shorter than one interval, or status updates were off.\n';
  }
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', "'");
  const lines = [
    '## What the run was doing',
    '',
    '| Elapsed | Left | Tokens | Calls | What it was doing |',
    '| ---: | ---: | ---: | ---: | :--- |',
  ];
  for (const row of record.rows) {
    const seen =
      Number(row.tokens?.input_tokens ?? 0) +
      Number(row.tokens?.cache_read_tokens ?? 0) +
      Number(row.tokens?.cache_creation_tokens ?? 0);
    const tokens = `${compact(seen)} in / ${compact(row.tokens?.output_tokens)} out`;
    const what = row.said || row.doing || '-';
    lines.push(
      `| \`${cell(row.elapsed || '-')}\` | \`${cell(row.left || '-')}\` | \`${cell(tokens)}\` | \`${row.calls}\` | ${cell(what)} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const readOr = (path, fallback) => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return fallback;
  }
};

/** main reports the status log after the run, and publishes what the record and the report row carry. */
export function main(env = process.env) {
  const dir = String(env.CHANNEL_DIR ?? '');
  if (dir === '' || !armed(env)) {
    process.stdout.write('This run was not watched, so it published no status.\n');
    return 0;
  }
  const record = digest(readOr(join(dir, 'status.jsonl'), ''), Number(env.STARTED_AT_MS));
  const cost = estimate(record.usage, record.model);
  process.stdout.write(
    `${counted(record.updates, 'status update')}, ${record.posted} posted, ` +
      `${record.summaryAnswers} of ${counted(record.summaryRequests, 'summary call')} answered.\n`,
  );
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, format(record));
    } catch (error) {
      process.stdout.write(`The status summary could not be written: ${plain(error?.message)}\n`);
    }
  }
  const line = JSON.stringify({
    updates: record.updates,
    posted: record.posted,
    model: record.model,
    summary_requests: record.summaryRequests,
    summary_answers: record.summaryAnswers,
    usage_complete: record.summaryUsages === record.summaryRequests,
    input_tokens:
      record.usage.input_tokens + record.usage.cache_read_tokens + record.usage.cache_creation_tokens,
    output_tokens: record.usage.output_tokens,
    cost_usd: cost,
    stage: record.stage,
    history: visibleHistory(record.history, env.STATUS_HISTORY),
  });
  try {
    writeOutputs(env.GITHUB_OUTPUT, {
      record: line,
    });
  } catch (error) {
    process.stdout.write(`The status counts could not be published: ${plain(error?.message)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
