import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { MAX_ERRORS } from './channel.mjs';
import { runDir } from '../lib/channel-hook.mjs';
import { plain } from './progress.mjs';
import { counted } from '../lib/text.cjs';

/** digest answers what a run's delivery log holds: how many notes went out, and of which kinds. */
export function digest(text) {
  const counts = Object.create(null);
  let notes = 0;
  let deliveries = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const kinds = Array.isArray(record?.kinds) ? record.kinds : [];
    deliveries += 1;
    notes += kinds.length;
    for (const kind of kinds) counts[String(kind)] = (counts[String(kind)] ?? 0) + 1;
  }
  return { notes, deliveries, counts };
}

/** format renders the delivery log for the job log, naming the silence when there was one. */
export function format(record, errors = []) {
  const lines = [];
  if (record.notes === 0) {
    lines.push(
      'No notes were delivered. Either the run was shorter than its first reminder, or the hook was never registered.',
    );
  } else {
    const kinds = Object.entries(record.counts)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ');
    lines.push(
      `${counted(record.notes, 'note')} delivered across ${counted(record.deliveries, 'injection')}: ${kinds}.`,
    );
  }
  for (const line of errors.slice(0, MAX_ERRORS)) lines.push(`Dropped: ${plain(line)}`);
  return `${lines.join('\n')}\n`;
}

const readOr = (path, fallback) => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return fallback;
  }
};

/**
 * main reports the run channel after the run, and publishes the count the record keeps.
 *
 * The inbox is what a hook drains, so a run holding none armed no channel however much of a state
 * directory it has. The count is withheld there rather than published as 0: `off` and `none
 * delivered` are different facts, and the arm record keeps them apart.
 */
export function main(env = process.env) {
  const dir = String(env.CHANNEL_DIR ?? '');
  if (dir === '' || !existsSync(join(dir, 'inbox'))) {
    process.stdout.write('This run armed no channel.\n');
    return 0;
  }
  const record = digest(readOr(join(runDir(dir), 'delivered.jsonl'), ''));
  const errors = readOr(join(runDir(dir), 'errors.log'), '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  process.stdout.write(format(record, errors));
  try {
    writeOutputs(env.GITHUB_OUTPUT, {
      notes: record.notes,
    });
  } catch (error) {
    process.stdout.write(`The note count could not be published: ${plain(error?.message)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
