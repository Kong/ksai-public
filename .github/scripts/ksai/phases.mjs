import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { elapsed, plain } from './progress.mjs';

const MAX_PHASES = 64;
const WIDTHS = [7, 8, 6];
const row = (...cells) => cells.map((cell, index) => cell.padStart(WIDTHS[index])).join('  ');
const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-');
const brief = (ms) => (Number.isFinite(ms) && ms < 1000 ? `${Math.round(ms)}ms` : elapsed(ms));

/**
 * stamps answers the phase file as ordered marks, dropping what it cannot read.
 *
 * A mark is `<epoch ms>\t<name>`, appended by a step of the action. The file is written inside the
 * job and read back in it, so a line that is not two fields is a step that was interrupted
 * mid-append rather than an input worth refusing over.
 */
export function stamps(source) {
  const marks = [];
  let dropped = 0;
  for (const line of String(source ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [at, ...rest] = line.split('\t');
    const ms = Number(at);
    const name = plain(rest.join('\t'), 40);
    if (!Number.isFinite(ms) || ms <= 0 || !name) {
      dropped += 1;
      continue;
    }
    marks.push({ at: ms, name });
  }
  marks.sort((left, right) => left.at - right.at);
  return { marks: marks.slice(0, MAX_PHASES), dropped: dropped + Math.max(0, marks.length - MAX_PHASES) };
}

/**
 * measure turns the marks into one phase per interval, closed by `endedAt`.
 *
 * A mark names the phase that *starts* at it, so the last one is closed by the reporter's own clock.
 * Two marks at the same millisecond yield a zero, which is a step that did nothing on this flow -
 * the honest answer for an action whose steps are shared by every flow it serves.
 */
export function measure(marks, endedAt) {
  if (!marks.length) return null;
  const began = marks[0].at;
  const ended = Number.isFinite(endedAt) && endedAt > began ? endedAt : marks.at(-1).at;
  const phases = marks.map((mark, index) => {
    const next = index + 1 < marks.length ? marks[index + 1].at : ended;
    return {
      name: mark.name,
      offset_ms: mark.at - began,
      duration_ms: Math.max(0, next - mark.at),
    };
  });
  return { total_ms: ended - began, phases };
}

/** format renders a measurement as the block the job log carries. */
export function format(record) {
  if (!record) return 'No phase marks were recorded, so this run reported no step timings.';
  const lines = [`  ${brief(record.total_ms)} from the first step to the last`];
  if (record.dropped) lines.push(`  ${record.dropped} mark(s) could not be read`);
  lines.push('', `  ${row('start', 'elapsed', 'share')}  phase`);
  for (const phase of record.phases) {
    lines.push(
      `  ${row(brief(phase.offset_ms), brief(phase.duration_ms), share(phase.duration_ms, record.total_ms))}  ${phase.name}`,
    );
  }
  return lines.join('\n');
}

/** summary renders a measurement as the markdown the job summary carries. */
export function summary(record) {
  if (!record) return '';
  const worst = [...record.phases].sort((left, right) => right.duration_ms - left.duration_ms)[0];
  const headline = worst
    ? `${brief(record.total_ms)} across ${record.phases.length} phases, longest ${worst.name} at ${brief(worst.duration_ms)}`
    : `${brief(record.total_ms)} across no phases`;
  return `${[
    '## Where the action spent its time',
    '',
    `<details><summary>${headline}</summary>`,
    '',
    '````text',
    format(record).replaceAll('`', "'"),
    '````',
    '',
    '</details>',
    '',
  ].join('\n')}\n`;
}

/**
 * main reports the action's own phase timings, from the marks its steps appended.
 *
 * `recordOnly` is the invocation the eval record reads. That record is written before the publishing
 * tail finishes, so a single run of this at the end of the action would be too late for it and a
 * single run before it would cut the tail out of the table a reader sees. Two invocations, each
 * honest about the moment it measured.
 *
 * Every write fails open. This measures a run that has already happened, so nothing it cannot do is
 * worth failing the step for.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function main(env = process.env, { recordOnly = false } = {}) {
  let source = '';
  try {
    source = readFileSync(env.PHASES_FILE ?? '', 'utf8');
  } catch {
    process.stdout.write('No phase file was written, so this run reported no step timings.\n');
    return 0;
  }
  const { marks, dropped } = stamps(source);
  const measured = measure(marks, Date.now());
  const record = measured ? { ...measured, dropped } : null;
  if (!recordOnly) process.stdout.write(`${format(record)}\n`);
  try {
    writeOutputs(env.GITHUB_OUTPUT, {
      phases: record ? JSON.stringify(record) : undefined,
    });
  } catch (error) {
    process.stdout.write(`The phase record could not be published: ${plain(error?.message)}\n`);
  }
  const digest = recordOnly ? '' : summary(record);
  if (env.GITHUB_STEP_SUMMARY && digest) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, digest);
    } catch (error) {
      process.stdout.write(`The job summary could not be written: ${plain(error?.message)}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.env, { recordOnly: process.argv.includes('--record') }));
}
