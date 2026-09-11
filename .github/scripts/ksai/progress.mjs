import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { counted } from '../lib/text.cjs';

const MAX_DETAIL_CHARS = 100;
const MAX_SAID_CHARS = 300;
const MAX_ROWS = 500;
const MAX_SUBAGENT_ROWS = 100;
const MAX_STREAMS = 20;
const MAX_EXCERPT_ROWS = 60;
const MAX_EXCERPT_CHARS = 12_000;
const NAME_COLUMN = 16;

const C0_END = 0x20;
const C1_START = 0x7F;
const C1_END = 0x9F;

const DETAIL_OF = Object.assign(Object.create(null), {
  Agent: (input) => input.description,
  Bash: (input) => input.description,
  BashOutput: (input) => input.bash_id,
  Edit: (input) => input.file_path,
  Glob: (input) => input.pattern,
  Grep: (input) => input.pattern,
  NotebookEdit: (input) => input.notebook_path,
  Read: (input) => input.file_path,
  Skill: (input) => input.skill,
  Task: (input) => input.description,
  WebFetch: (input) => input.url,
  WebSearch: (input) => input.query,
  Write: (input) => input.file_path,
});

const FORMAT_CHARS = /\p{Cf}/u;

const inert = (ch) => {
  const code = ch.codePointAt(0);
  if (code < C0_END || (code >= C1_START && code <= C1_END)) return false;
  return !FORMAT_CHARS.test(ch);
};

/**
 * plain answers a value as one line of inert log text, capped, with anything that could move a cursor
 * or reorder what follows it removed.
 *
 * The cut is by code point rather than by `.length`, or it splits a surrogate pair and the row ends in
 * a replacement character. Format characters go with the control characters: U+202E reverses the rest
 * of the line it lands on, and the detail is the last field on a row, so the reversal runs to the end.
 */
export function plain(value, max = MAX_DETAIL_CHARS) {
  const text = typeof value === 'string' ? value : '';
  const kept = [...text].map((ch) => (inert(ch) ? ch : ' '));
  const flat = [...kept.join('').replace(/\s+/g, ' ').trim()];
  return flat.length > max ? `${flat.slice(0, max - 1).join('')}…` : flat.join('');
}

/** elapsed renders a millisecond span as `m:ss`, growing to `h:mm:ss` only once it has to. */
export function elapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function shorten(value, prefix) {
  const text = typeof value === 'string' ? value : '';
  const cut = prefix && text.startsWith(`${prefix}/`) ? text.slice(prefix.length + 1) : text;
  return plain(cut);
}

function toolResults(entry) {
  if (entry?.type !== 'user') return [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_result');
}

const errored = (result) => result?.is_error === true || result?.is_error === 'true';

/**
 * ordered answers a stable fingerprint of a tool input, or null when it cannot take one.
 *
 * The sorting replacer allocates at every level and overflows the stack far sooner than the writer
 * that produced the line, so a deeply nested input is a transcript this can read and cannot fingerprint.
 * Unguarded that threw out of `--check`, which the loop reads as no trip and then repeats every poll
 * with its output going to /dev/null. Null rather than an empty string: an empty string equals the
 * next empty one, so two unfingerprintable calls would read as a repeat of each other.
 */
export const ordered = (value) => {
  try {
    return JSON.stringify(value, (_key, held) =>
      held && typeof held === 'object' && !Array.isArray(held)
        ? Object.fromEntries(Object.keys(held).sort().map((key) => [key, held[key]]))
        : held,
    );
  } catch {
    return null;
  }
};

function toolCalls(entry) {
  if (entry?.type !== 'assistant') return [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_use');
}

/** timeline answers the tool calls a session transcript records, as rows of inert text. */
export function timeline(source, { trim = '', maxRows = MAX_ROWS } = {}) {
  const prefix = plain(trim, 200).replace(/\/+$/, '');
  const rows = [];
  const counts = Object.create(null);
  const byId = new Map();
  let started = null;
  let total = 0;
  let failures = 0;
  let streak = 0;
  let longest = 0;
  let signature = '';
  let repeat = 0;
  let repeated = 0;
  let repeating = '';

  for (const line of String(source ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry?.timestamp ?? '');
    if (Number.isFinite(at) && started === null) started = at;
    for (const call of toolCalls(entry)) {
      const name = plain(call?.name, 40) || 'unknown';
      counts[name] = (counts[name] ?? 0) + 1;
      total += 1;
      const detailOf = DETAIL_OF[name];
      const input = call?.input && typeof call.input === 'object' ? call.input : {};
      const detail = shorten(detailOf ? detailOf(input) : '', prefix);
      const fingerprint = ordered(input);
      const seen = fingerprint === null ? `\u0000unfingerprintable ${total}` : `${name}\u0000${fingerprint}`;
      repeat = seen === signature ? repeat + 1 : 1;
      signature = seen;
      if (repeat > repeated) {
        repeated = repeat;
        repeating = detail ? `${name} (${detail})` : name;
      }
      if (rows.length >= maxRows) continue;
      const row = {
        at: Number.isFinite(at) && started !== null ? elapsed(at - started) : '',
        name,
        detail,
        failed: false,
      };
      rows.push(row);
      if (typeof call?.id === 'string') byId.set(call.id, row);
    }
    for (const result of toolResults(entry)) {
      if (!errored(result)) {
        streak = 0;
        continue;
      }
      failures += 1;
      streak += 1;
      longest = Math.max(longest, streak);
      const row = byId.get(result?.tool_use_id);
      if (row) row.failed = true;
    }
  }

  return {
    rows,
    counts,
    total,
    dropped: Math.max(0, total - rows.length),
    failures,
    streak,
    longest,
    repeat,
    repeated,
    repeating,
  };
}

const TOKEN_FIELDS = Object.freeze({
  input_tokens: 'input_tokens',
  output_tokens: 'output_tokens',
  cache_read_tokens: 'cache_read_input_tokens',
  cache_creation_tokens: 'cache_creation_input_tokens',
});

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** emptyTally answers the token record `live` accumulates into, in the names the run report already uses. */
export function emptyTally() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
  };
}

/** tallyOf answers one usage record in the token names every run report uses. */
export function tallyOf(usage) {
  const tally = emptyTally();
  if (!usage || typeof usage !== 'object') return tally;
  for (const [into, from] of Object.entries(TOKEN_FIELDS)) tally[into] = positive(usage[from]);
  const ttl = usage.cache_creation;
  if (ttl && typeof ttl === 'object') {
    tally.cache_write_5m_tokens = positive(ttl.ephemeral_5m_input_tokens);
    tally.cache_write_1h_tokens = positive(ttl.ephemeral_1h_input_tokens);
  }
  return tally;
}

/** addTally adds one token record into another without letting unusable values poison the sum. */
export function addTally(into, from) {
  for (const key of Object.keys(into)) into[key] += positive(from?.[key]);
  return into;
}

export function usageOnce(billed, entry) {
  const { id, usage } = entry?.message ?? {};
  if (!id) return usage;
  if (billed.has(id)) return null;
  billed.add(id);
  return usage;
}

/** live answers what a stream is doing now and what it has spent, in one pass. */
export function live(source, { trim = '' } = {}) {
  const prefix = plain(trim, 200).replace(/\/+$/, '');
  const open = new Map();
  const tokens = emptyTally();
  const billed = new Set();
  const narration = [];
  let last = null;
  let calls = 0;

  for (const line of String(source ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === 'assistant') {
      addTally(tokens, tallyOf(usageOnce(billed, entry)));
      const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      for (const block of content) {
        if (block?.type !== 'text') continue;
        narration.push(block.text);
      }
    }
    for (const call of toolCalls(entry)) {
      const name = plain(call?.name, 40) || 'unknown';
      const detailOf = DETAIL_OF[name];
      const input = call?.input && typeof call.input === 'object' ? call.input : {};
      const row = { name, detail: detailOf ? detailOf(input) : '' };
      calls += 1;
      last = row;
      if (typeof call?.id === 'string') open.set(call.id, row);
    }
    for (const result of toolResults(entry)) {
      if (typeof result?.tool_use_id === 'string') open.delete(result.tool_use_id);
    }
  }

  let said = '';
  for (let index = narration.length - 1; index >= 0 && said === ''; index -= 1) {
    said = plain(narration[index], MAX_SAID_CHARS);
  }
  const [pending] = [...open.values()].slice(-1);
  const current = pending ?? last;
  const doing = current ? { name: current.name, detail: shorten(current.detail, prefix) } : null;
  return { said, doing, calls, tokens };
}

function excerptRow(block, prefix, tools) {
  if (block?.type === 'text') {
    const said = plain(block.text, 600);
    return said ? `Assistant: ${said}` : '';
  }
  if (block?.type !== 'tool_use') return '';
  const name = plain(block?.name, 40) || 'unknown';
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  const detailOf = DETAIL_OF[name];
  const detail = shorten(detailOf ? detailOf(input) : '', prefix);
  if (typeof block?.id === 'string') tools.set(block.id, name);
  return `Tool: ${name}${detail ? ` ${detail}` : ''}`;
}

export function excerpt(
  source,
  { trim = '', maxRows = MAX_EXCERPT_ROWS, maxChars = MAX_EXCERPT_CHARS } = {},
) {
  const prefix = plain(trim, 200).replace(/\/+$/, '');
  const rows = [];
  const tools = new Map();
  for (const line of String(source ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === 'assistant') {
      const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      for (const block of content) {
        const row = excerptRow(block, prefix, tools);
        if (row) rows.push(row);
      }
    }
    for (const result of toolResults(entry)) {
      const name = tools.get(result?.tool_use_id) ?? 'tool';
      rows.push(`Result: ${name} ${errored(result) ? 'failed' : 'completed'}`);
    }
  }
  const rowLimit = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : MAX_EXCERPT_ROWS;
  const charLimit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_EXCERPT_CHARS;
  const kept = [];
  let size = 0;
  for (const row of rows.slice(-rowLimit).toReversed()) {
    if (size + row.length + 1 > charLimit) break;
    kept.push(row);
    size += row.length + 1;
  }
  return kept.toReversed().join('\n');
}

/** format renders a timeline as the block the job log carries. */
export function format({ rows, counts, total, dropped, failures, longest }) {
  if (!total) return 'No tool calls were recorded for this run.';
  const lines = rows.map(({ at, name, detail, failed }) =>
    `  ${(at || '-').padStart(7)}  ${failed ? 'x' : ' '} ${detail ? name.padEnd(NAME_COLUMN) : name}${detail}`.trimEnd(),
  );
  if (dropped) lines.push(`  ... ${counted(dropped, 'further tool call')} not listed.`);
  const tally = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
  lines.push('', `  ${counted(total, 'tool call')}: ${tally}`);
  if (failures) {
    lines.push(`  ${failures} failed (marked x), longest run of consecutive failures: ${longest}`);
  }
  return lines.join('\n');
}

/**
 * breaker answers whether a run has stopped making progress, and why.
 *
 * Two shapes, because neither sees the other. A run of failures is a run that cannot do the thing; a run
 * of identical calls is a run doing the same thing and getting nowhere, every call of which succeeds.
 * Both count consecutive occurrences and reset on anything else, because around one call in fourteen
 * fails on a healthy run and a rate would stop work that was going fine.
 */
export function breaker(view, { failures = 0, repeats = 0 } = {}) {
  const cap = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const failureLimit = cap(failures);
  const repeatLimit = cap(repeats);
  if (failureLimit > 0 && view.streak >= failureLimit) {
    return {
      tripped: true,
      cause: 'failures',
      reason: `${view.streak} tool calls in a row failed, which reaches the configured limit of ${failureLimit}`,
    };
  }
  if (repeatLimit > 1 && view.repeat >= repeatLimit) {
    const what = view.repeating ? ` - ${view.repeating} -` : '';
    return {
      tripped: true,
      cause: 'repeats',
      reason: `the same tool call ran ${view.repeat} times in a row${what} which reaches the configured limit of ${repeatLimit}`,
    };
  }
  return { tripped: false, cause: '', reason: '' };
}

/** summary renders a run as the markdown the job summary carries. */
export function summary(views, dropped = 0, stopped = '') {
  const total = views.reduce((sum, { view }) => sum + view.total, 0);
  const failures = views.reduce((sum, { view }) => sum + view.failures, 0);
  const headline = total ? `${counted(total, 'tool call')}, ${failures} failed` : 'no tool calls recorded';
  const body = rendered(views, dropped).replaceAll('`', "'");
  const said = plain(stopped, 200).replaceAll('`', "'");
  return [
    '## What the run did',
    '',
    ...(said
      ? [
          '> [!WARNING]',
          `> This run was stopped on purpose: ${said}`,
          '>',
          '> An `SDK execution error` with `code 143` in the log is that stop, not a fault: 143 is SIGTERM.',
          '',
        ]
      : []),
    `<details><summary>${headline}</summary>`,
    '',
    '````text',
    body,
    '````',
    '',
    '</details>',
    '',
  ].join('\n') + '\n';
}

/**
 * findTranscript answers the session transcript this run wrote, or an empty string.
 *
 * `since` is a hard freshness bound in epoch milliseconds, not a preference. Without a session id the
 * newest file wins, and on a self-hosted runner `$HOME/.claude/projects` survives the job that wrote
 * it - so an earlier job's transcript, or this job's own classifier run, would otherwise be judged as
 * if it were this run's.
 */
export function encodeProject(cwd) {
  const text = typeof cwd === 'string' ? cwd : '';
  return text ? text.replace(/[^A-Za-z0-9]/g, '-') : '';
}

export function findTranscript(root, sessionId, since = 0, cwd = '') {
  const wanted = plain(sessionId, 200);
  const floor = Number.isFinite(since) && since > 0 ? since : 0;
  const mine = encodeProject(cwd);
  let newest = { path: '', at: -1 };
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  const scoped = mine && projects.some((p) => p.isDirectory() && p.name === mine);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (scoped && project.name !== mine) continue;
    const dir = join(root, project.name);
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dir, file);
      if (wanted && file === `${wanted}.jsonl`) return path;
      try {
        const at = statSync(path).mtimeMs;
        if (at >= floor && at > newest.at) newest = { path, at };
      } catch {
        continue;
      }
    }
  }
  return newest.path;
}

/**
 * subagentsOf answers the transcripts the subagents of one session wrote.
 *
 * The CLI puts them a directory deeper, under `<project>/<session-id>/subagents/`, so the two-level
 * walk above never reaches one. A flow that delegates does most of its tool calls in these files: a
 * review that spawns dimension reviewers reports a handful of `Agent` rows for hundreds of calls, and
 * a subagent stuck in a loop is invisible to a breaker reading only the parent.
 */
export function subagentsOf(path) {
  if (!path.endsWith('.jsonl')) return [];
  const dir = join(path.slice(0, -'.jsonl'.length), 'subagents');
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/** TRIPPED is the exit code the watchdog loop tests for. Any other non-zero is a crash and is ignored. */
export const TRIPPED = 3;

const slurp = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const movedSince = (path, floor) => {
  if (!floor) return true;
  try {
    return statSync(path).mtimeMs >= floor;
  } catch {
    return false;
  }
};

const movedAt = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * read answers the streams this run wrote: the session transcript and one per subagent.
 *
 * `moving` is the bound the breaker reads with and the timeline does not. A transcript that has stopped
 * growing holds a trailing streak and a trailing run of repeats for ever, so a subagent that ended on
 * eight identical calls would trip on that same evidence at every later poll and kill a parent that was
 * working. A live stream can still reset its own counters, which is what made a finished stream judged
 * more harshly than a running one. The timeline wants the whole run, so it passes no bound.
 */
export function read({ moving = 0 } = {}) {
  const root = process.env.TRANSCRIPT_ROOT || join(process.env.HOME ?? '', '.claude', 'projects');
  const path = findTranscript(
    root,
    process.env.SESSION_ID,
    Number(process.env.TRANSCRIPT_SINCE),
    process.env.TRIM_PREFIX,
  );
  if (!path) return { streams: [], why: 'No session transcript was found' };
  const parent = slurp(path);
  if (parent === null) {
    return { streams: [], why: `The session transcript could not be read: ${plain(path)}` };
  }
  const streams = movedSince(path, moving) ? [{ name: '', source: parent, at: movedAt(path) }] : [];
  let dropped = 0;
  for (const agent of subagentsOf(path)) {
    if (!movedSince(agent, moving)) continue;
    if (streams.length >= MAX_STREAMS) {
      dropped += 1;
      continue;
    }
    const source = slurp(agent);
    if (source) {
      streams.push({ name: agent.split('/').pop().replace(/\.jsonl$/, ''), source, at: movedAt(agent) });
    }
  }
  return { streams, why: '', dropped };
}

const limits = () => ({
  failures: Number(process.env.MAX_CONSECUTIVE_FAILURES),
  repeats: Number(process.env.MAX_REPEATED_CALLS),
});

/** rendered answers the whole run as one block, the subagents named under the session that spawned them. */
export function rendered(views, dropped = 0) {
  const parts = views.map(({ name, view }) =>
    name ? `  ${plain(name, 60)}\n${format(view)}` : format(view),
  );
  const total = views.reduce((sum, { view }) => sum + view.total, 0);
  const parent = views[0]?.view.total ?? 0;
  if (views.length > 1) {
    parts.push(
      `  ${counted(total, 'tool call')} in all, ${total - parent} of them in ` +
        `${counted(views.length - 1, 'subagent')}.`,
    );
  }
  if (dropped) parts.push(`  ${counted(dropped, 'further subagent')} not listed.`);
  return parts.join('\n\n');
}

function report(views, dropped) {
  const stopped = process.env.STOPPED_BECAUSE;
  const block = rendered(views, dropped);
  const said = plain(stopped, 200);
  const preface = said
    ? `This run was stopped on purpose: ${said}\nAn "SDK execution error" with code 143 above is that stop, not a fault: 143 is SIGTERM.\n\n`
    : '';
  process.stdout.write(`${preface}${block}\n`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, summary(views, dropped, stopped));
  } catch (error) {
    process.stdout.write(`The job summary could not be written: ${plain(error?.message)}\n`);
  }
}

/** main runs the CLI surface: the timeline by default, or `--check` answering TRIPPED on a trip. */
export function main(argv) {
  const checking = argv.includes('--check');
  const window = Number(process.env.TRANSCRIPT_WINDOW_MS);
  const moving = checking && Number.isFinite(window) && window > 0 ? Date.now() - window : 0;
  const { streams, why, dropped } = read({ moving });
  const trim = process.env.TRIM_PREFIX;
  if (!checking) {
    if (why) {
      process.stdout.write(`${why}, so this run recorded no timeline.\n`);
      return 0;
    }
    report(
      streams.map(({ name, source }) => ({
        name,
        view: timeline(source, { trim, maxRows: name ? MAX_SUBAGENT_ROWS : MAX_ROWS }),
      })),
      dropped,
    );
    return 0;
  }
  if (why) return 0;
  const bounds = limits();
  for (const { name, source } of streams) {
    const verdict = breaker(timeline(source), bounds);
    if (!verdict.tripped) continue;
    const whose = name ? ` (in subagent ${plain(name, 60)})` : '';
    process.stdout.write(`${verdict.reason}${whose}\n`);
    return TRIPPED;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
