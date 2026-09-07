import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { TRIPPED, breaker, plain, rendered, summary, timeline } from '../ksai/progress.mjs';
import { main as stagesMain } from '../ksai/stages.mjs';
import { parsed } from '../lib/opencode.mjs';

const CLAUDE_NAME = Object.assign(Object.create(null), {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Glob',
  task: 'Task',
  skill: 'Skill',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
});

const INPUT_KEY = Object.assign(Object.create(null), {
  Read: [['filePath', 'file_path']],
  Write: [['filePath', 'file_path']],
  Edit: [['filePath', 'file_path']],
  Glob: [
    ['pattern', 'pattern'],
    ['path', 'pattern'],
  ],
  Grep: [['pattern', 'pattern']],
  Task: [['description', 'description']],
  Skill: [['name', 'skill']],
  WebFetch: [['url', 'url']],
  WebSearch: [['query', 'query']],
  Bash: [['description', 'description']],
});

/**
 * detailed answers the input the shared timeline reads a detail out of.
 *
 * `Bash` carries its `description` and never its `command`, which is the rule
 * `docs/decisions/run-visibility.md` states for the Claude engine and which holds here for the same
 * reason: the command is the string most likely to carry a value that should not be repeated. Where
 * opencode's caller wrote no description the row is the tool name and its elapsed time, which is
 * less than the Claude engine shows and more than nothing.
 *
 * The command is replaced by a digest of itself rather than dropped, because the breaker fingerprints
 * this same input to find a repeat. Dropping it left every `bash` call fingerprinting as `{}`, so nine
 * different commands read as nine identical ones and the repeat breaker killed a healthy run at its
 * twenty-second step. The digest distinguishes them and no renderer reads the key, so the command text
 * still reaches nothing that prints.
 */
export function detailed(name, input) {
  const out = { ...input };
  for (const [from, to] of INPUT_KEY[name] ?? []) {
    if (typeof input?.[from] === 'string' && out[to] === undefined) out[to] = input[from];
  }
  if (typeof out.command === 'string') {
    out.command_digest = createHash('sha256').update(out.command).digest('hex').slice(0, 16);
  }
  delete out.command;
  return out;
}

/**
 * transcript answers opencode's event stream in the shape `ksai/progress.mjs` already reads, so the
 * timeline, the loop breakers and the job summary are one implementation for both engines.
 *
 * Only `state.input` and `state.status` are read. `state.output` and `state.metadata` hold what the
 * tree under work printed, and no tool result is read here for the reason the Claude reader gives.
 */
/**
 * usageOf answers the tokens a `step_finish` reported, in the shape the shared stage reader sums.
 *
 * opencode reports spend per step rather than per tool call, so the tokens are on an event the
 * timeline otherwise ignores. Skipping those events left every counter in the stage record at 0,
 * which prints as a measured figure rather than as an absent one.
 */
function usageOf(part) {
  const tokens = part?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  return {
    input_tokens: Number(tokens.input) || 0,
    output_tokens: Number(tokens.output) || 0,
    cache_read_input_tokens: Number(tokens.cache?.read) || 0,
    cache_creation_input_tokens: Number(tokens.cache?.write) || 0,
  };
}

export function transcript(events) {
  const lines = [];
  for (const event of events) {
    if (event?.type === 'step_finish') {
      const usage = usageOf(event.part);
      const at = Number(event.timestamp);
      if (usage) {
        lines.push(
          JSON.stringify({
            timestamp: Number.isFinite(at) ? new Date(at).toISOString() : undefined,
            type: 'assistant',
            message: { content: [], usage },
          }),
        );
      }
      continue;
    }
    if (event?.type !== 'tool_use') continue;
    const part = event.part ?? {};
    const state = part.state ?? {};
    const stamp = (value, fallback) => {
      const at = Number(Number.isFinite(Number(value)) ? value : fallback);
      return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
    };
    const began = stamp(state.time?.start, event.timestamp);
    const ended = stamp(state.time?.end, state.time?.start ?? event.timestamp);
    const name = CLAUDE_NAME[part.tool] ?? plain(part.tool, 40) ?? 'unknown';
    const id = typeof part.callID === 'string' ? part.callID : `call_${lines.length}`;
    const input = state.input && typeof state.input === 'object' ? state.input : {};
    // Every call gets its result, not only a failed one. The shared reader opens a delegation window
    // on a `Task` call and closes it on the matching result, so a call with no result is a window that
    // never closes - which is how every opencode run reported all of its time as the orchestrator's
    // and none of it delegated, while the audit it had run took minutes.
    lines.push(
      JSON.stringify({
        timestamp: began,
        type: 'assistant',
        // `usage` is read off an assistant entry by the shared stage reader. Without it every token
        // counter in the stage record stays 0, which prints as a measurement rather than as absent.
        message: { content: [{ type: 'tool_use', name, id, input: detailed(name, input) }] },
      }),
      JSON.stringify({
        timestamp: ended,
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, ...(state.status === 'error' ? { is_error: true } : {}) }],
        },
      }),
    );
  }
  return lines.join('\n');
}

/**
 * delegationsIn answers how many delegation calls a stream carries.
 *
 * They are subagents nothing here can measure: the events this engine writes carry only the parent
 * session, so a delegation's own calls are absent and cannot be recovered by splitting the stream.
 * The call itself is in the parent stream, which is what makes the count knowable at all.
 */
export function delegationsIn(events) {
  if (!Array.isArray(events)) return 0;
  return events.filter((event) => event?.type === 'tool_use' && CLAUDE_NAME[event?.part?.tool] === 'Task').length;
}

function source(env = process.env) {
  const path = env.OPENCODE_EVENTS_FILE;
  if (!path) return { text: '', why: 'No opencode event stream was named', delegations: 0 };
  try {
    const events = parsed(readFileSync(path, 'utf8'));
    return { text: transcript(events), why: '', delegations: delegationsIn(events) };
  } catch (error) {
    return { text: '', why: `The opencode event stream could not be read: ${plain(error?.message)}`, delegations: 0 };
  }
}

const movedAt = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * streams answers this run's work in the shape `ksai/progress.mjs`'s own reader answers, so the live
 * status reads one engine the way it reads the other.
 *
 * A stream is offered only once the reduction carries something. A partial line is dropped by
 * `parsed`, so a stream read while opencode is still writing is short rather than broken; an empty
 * one is absent rather than a run of zeroes, which a reader takes for a run that is stuck.
 */
export function streams(env = process.env) {
  const { text, why, delegations } = source(env);
  if (why) return { streams: [], why, dropped: 0 };
  if (text === '') return { streams: [], why: 'The opencode event stream carries no work yet', dropped: 0 };
  return {
    streams: [{ name: '', source: text, at: movedAt(env.OPENCODE_EVENTS_FILE) }],
    why: '',
    dropped: delegations,
  };
}

/** main runs the CLI surface `ksai/progress.mjs` does, over opencode's stream instead of a transcript. */
export function main(argv) {
  const checking = argv.includes('--check');
  const measuring = argv.includes('--stages');
  const { text, why, delegations } = source();
  if (why) {
    if (!checking) process.stdout.write(`${why}, so this run recorded no ${measuring ? 'stage timings' : 'timeline'}.\n`);
    return 0;
  }
  if (measuring)
    return stagesMain(process.env, { streams: [{ name: '', source: text }], why: '', dropped: delegations });
  const view = timeline(text, { trim: process.env.TRIM_PREFIX });
  if (checking) {
    const verdict = breaker(view, {
      failures: Number(process.env.MAX_CONSECUTIVE_FAILURES),
      repeats: Number(process.env.MAX_REPEATED_CALLS),
    });
    if (!verdict.tripped) return 0;
    process.stdout.write(`${verdict.reason}\n`);
    return TRIPPED;
  }
  const views = [{ name: '', view }];
  const stopped = process.env.STOPPED_BECAUSE;
  const said = plain(stopped, 200);
  const preface = said ? `This run was stopped on purpose: ${said}\n\n` : '';
  process.stdout.write(`${preface}${rendered(views)}\n`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, summary(views, 0, stopped));
    } catch (error) {
      process.stdout.write(`The job summary could not be written: ${plain(error?.message)}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
