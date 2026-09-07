import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { counted, plural } from '../lib/text.cjs';
import { elapsed, plain, read } from './progress.mjs';

const DELEGATING = new Set(['Agent', 'Task']);
const MAX_LABEL = 60;
const MAX_TOOLS = 16;
const ORCHESTRATOR = 'orchestrator';

const finite = (value) => (Number.isFinite(value) ? value : null);

function usageOf(entry) {
  const held = entry?.message?.usage;
  const take = (key) => {
    const value = held?.[key];
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return {
    input_tokens: take('input_tokens'),
    output_tokens: take('output_tokens'),
    cache_read_tokens: take('cache_read_input_tokens'),
    cache_creation_tokens: take('cache_creation_input_tokens'),
  };
}

function blocks(entry, type) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === type) : [];
}

/**
 * spanOf answers one transcript stream as a span, a token tally, a per-tool tally and the windows it
 * spent waiting on a subagent.
 *
 * A tool result carries its own timestamp in a real transcript and not in every fixture, so a window
 * that cannot read one closes at the last timestamp the stream had. A window that never closes at all
 * is a run that was killed mid-delegation, and it closes at the end of the stream instead.
 */
export function spanOf(source) {
  let start = null;
  let end = null;
  let last = null;
  let calls = 0;
  let failures = 0;
  const tokens = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const tools = new Map();
  const named = new Map();
  const open = new Map();
  const windows = [];

  for (const line of String(source ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry?.timestamp ?? '');
    if (Number.isFinite(at)) {
      if (start === null) start = at;
      end = at;
      last = at;
    }
    if (entry?.type === 'assistant') {
      const used = usageOf(entry);
      for (const key of Object.keys(tokens)) tokens[key] += used[key];
    }
    for (const block of blocks(entry, 'tool_use')) {
      const name = plain(block?.name, 40) || 'unknown';
      calls += 1;
      const seen = tools.get(name) ?? { name, calls: 0, failures: 0 };
      seen.calls += 1;
      tools.set(name, seen);
      if (typeof block?.id === 'string') named.set(block.id, seen);
      if (!DELEGATING.has(name) || typeof block?.id !== 'string') continue;
      const input = block?.input && typeof block.input === 'object' ? block.input : {};
      const label = plain(input.subagent_type || input.description || name, MAX_LABEL);
      open.set(block.id, { label, start: last });
    }
    for (const block of blocks(entry, 'tool_result')) {
      const id = block?.tool_use_id;
      const failed = block?.is_error === true || block?.is_error === 'true';
      const row = typeof id === 'string' ? named.get(id) : undefined;
      if (failed) failures += 1;
      if (failed && row) row.failures += 1;
      const window = typeof id === 'string' ? open.get(id) : undefined;
      if (!window) continue;
      open.delete(id);
      windows.push({ label: window.label, start: window.start, end: last });
    }
  }

  for (const window of open.values()) windows.push({ label: window.label, start: window.start, end, open: true });

  return {
    start: finite(start),
    end: finite(end),
    duration_ms: start !== null && end !== null ? Math.max(0, end - start) : 0,
    calls,
    failures,
    tokens,
    tools: [...tools.values()],
    windows: windows.filter(
      (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && (w.open === true ? w.end >= w.start : w.end > w.start),
    ),
  };
}

/** union answers the milliseconds covered by a set of spans, counting overlapping time once. */
export function union(spans) {
  const sorted = spans
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let from = null;
  let to = null;
  for (const span of sorted) {
    if (from === null || span.start > to) {
      if (from !== null) total += to - from;
      from = span.start;
      to = span.end;
      continue;
    }
    to = Math.max(to, span.end);
  }
  return from === null ? 0 : total + (to - from);
}

/*
 * A window is claimed once. One assistant message can open two `Agent` calls, which makes two windows
 * with the same start, and an unclaimed search hands both children the first label - so the second
 * subagent's name never prints, on exactly the fan-out `overlap_ms` exists to judge.
 */
function labelFor(span, windows, taken) {
  const inside = windows.find(
    (window) => !taken.has(window) && span.start >= window.start && span.start <= window.end,
  );
  if (inside) taken.add(inside);
  return inside ? inside.label : '';
}

function tally(rows) {
  const merged = new Map();
  for (const row of rows) {
    const held = merged.get(row.name) ?? { name: row.name, calls: 0, failures: 0 };
    held.calls += row.calls;
    held.failures += row.failures;
    merged.set(row.name, held);
  }
  return [...merged.values()]
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, MAX_TOOLS);
}

/**
 * measure answers what one run spent its wall clock on, as the record the job summary renders and the
 * eval corpus keeps.
 *
 * `own_ms` is the number this exists for: the orchestrator's span less every window it spent blocked
 * on a subagent. It is the only stage nothing else measures, and the review pipeline is serial, so it
 * is time no fan-out can hide. `overlap_ms` is the evidence for the other half of that: subagent time
 * that ran concurrently, which is zero on a pipeline that delegates one agent at a time.
 */
export function measure(streams, { stampedAt = null, dropped = 0 } = {}) {
  const parsed = streams.map(({ name, source }) => ({ name: plain(name, MAX_LABEL), span: spanOf(source) }));
  const parent = parsed[0]?.span;
  if (!parent || parent.start === null) return null;
  const children = parsed.slice(1);
  const spans = children.map(({ span }) => span);
  const ended = parent.end ?? parent.start;
  const killed = parent.windows.some((window) => window.open === true);
  const reached = killed
    ? spans.reduce((far, span) => (span.end === null ? far : Math.max(far, span.end)), ended)
    : ended;
  const windows = parent.windows.map((window) =>
    window.open === true ? { ...window, end: Math.max(window.end, reached) } : window,
  );
  const delegated = union(windows);
  const covered = union(spans);
  const served = spans.reduce((sum, span) => sum + span.duration_ms, 0);
  const wall = Math.max(parent.duration_ms, reached - parent.start);
  const taken = new Set();

  return {
    wall_ms: wall,
    setup_ms: Number.isFinite(stampedAt) && stampedAt > 0 ? Math.max(0, parent.start - stampedAt) : null,
    own_ms: Math.max(0, wall - delegated),
    delegated_ms: delegated,
    overlap_ms: Math.max(0, served - covered),
    subagents: children.length,
    unmeasured_subagents: Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0,
    stages: parsed.map(({ name, span }, index) => ({
      name,
      label: index === 0 ? ORCHESTRATOR : labelFor(span, windows, taken) || name || 'subagent',
      offset_ms: span.start === null ? null : Math.max(0, span.start - parent.start),
      duration_ms: span.duration_ms,
      calls: span.calls,
      failures: span.failures,
      ...span.tokens,
    })),
    tools: tally(parsed.flatMap(({ span }) => span.tools)),
  };
}

const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-');

/*
 * An `M` step, because a cache-read tally reaches eight figures and `12000k` is two characters wider
 * than the column that holds it.
 */
const thousands = (value) => {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
};

/*
 * Two spaces between every cell, because a value wider than its column would otherwise run into its
 * neighbour and read as one number. `new in` excludes cache reads on purpose: usage is reported per
 * assistant message, so the cached prefix is counted again on every turn and the sum reads as
 * millions of tokens for a stage that was handed one diff.
 */
const WIDTHS = [7, 8, 6, 5, 7, 7];

const row = (...cells) => cells.map((cell, index) => cell.padStart(WIDTHS[index])).join('  ');

/** format renders a measurement as the block the job log carries. */
export function format(record) {
  if (!record) return 'No session transcript was found, so this run recorded no stage timings.';
  const lines = [
    `  wall ${elapsed(record.wall_ms)}, orchestrator ${elapsed(record.own_ms)} (${share(record.own_ms, record.wall_ms)}), delegated ${elapsed(record.delegated_ms)} (${share(record.delegated_ms, record.wall_ms)})`,
  ];
  if (record.setup_ms !== null) lines.push(`  ${elapsed(record.setup_ms)} passed before the model started`);
  if (record.subagents > 1) {
    lines.push(`  ${record.subagents} subagents, ${elapsed(record.overlap_ms)} of their time ran concurrently`);
  }
  if (record.unmeasured_subagents) {
    lines.push(
      `  ${counted(record.unmeasured_subagents, 'further subagent')} ` +
        `${plural(record.unmeasured_subagents, 'was', 'were')} not measured, so this run is a partial view`,
    );
  }
  lines.push('', `  ${row('start', 'elapsed', 'calls', 'fail', 'new in', 'out')}  stage`);
  for (const stage of record.stages) {
    const fresh = thousands(stage.input_tokens + stage.cache_creation_tokens);
    const written = thousands(stage.output_tokens);
    const at = stage.offset_ms === null ? '-' : elapsed(stage.offset_ms);
    const took = elapsed(stage.duration_ms);
    lines.push(
      `  ${row(at, took, String(stage.calls), String(stage.failures), fresh, written)}  ${stage.label}`,
    );
  }
  if (record.tools.length) {
    const named = record.tools.map((t) => `${t.name} ${t.calls}${t.failures ? `/${t.failures} failed` : ''}`);
    lines.push('', `  tool calls: ${named.join(', ')}`);
  }
  return lines.join('\n');
}

/** summary renders a measurement as the markdown the job summary carries. */
export function summary(record) {
  if (!record) return '';
  const headline = `wall ${elapsed(record.wall_ms)}, ${share(record.own_ms, record.wall_ms)} of it orchestrator`;
  return [
    '## Where the run spent its time',
    '',
    `<details><summary>${headline}</summary>`,
    '',
    '````text',
    format(record).replaceAll('`', "'"),
    '````',
    '',
    '</details>',
    '',
  ].join('\n') + '\n';
}

function publish(env, record) {
  writeOutputs(env.GITHUB_OUTPUT, {
    stages: record ? JSON.stringify(record) : undefined,
  });
}

/**
 * main runs the CLI surface: the stage block on stdout, the job summary, and the step output.
 *
 * Every write fails open. This is a measurement of a review that has already run, so nothing it
 * cannot do is worth failing the step for.
 */
/**
 * main measures a run's stages, from the streams it is given or the transcript it can find.
 *
 * The source is a parameter because a second engine reaches these numbers with no transcript to
 * discover: `kreview/opencode-progress.mjs` renders its event stream into the same shape and hands
 * it in, so the measurement is one implementation rather than two.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{streams: Array<{name: string, source: string}>, why?: string, dropped?: number} | null} [source]
 */
export function main(env = process.env, source = null) {
  const { streams, why, dropped } = source ?? read();
  if (why) {
    process.stdout.write(`${why}, so this run recorded no stage timings.\n`);
    return 0;
  }
  const record = measure(streams, { stampedAt: Number(env.STARTED_AT_MS), dropped });
  process.stdout.write(`${format(record)}\n`);
  try {
    publish(env, record);
  } catch (error) {
    process.stdout.write(`The stage record could not be published: ${plain(error?.message)}\n`);
  }
  const digest = summary(record);
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
  process.exit(main());
}
