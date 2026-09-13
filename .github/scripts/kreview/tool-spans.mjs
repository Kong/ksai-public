import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { runMain } from '../lib/main.mjs';
import { CLAUDE_NAME, parsed, refused } from '../lib/opencode.mjs';
import { attributes, pairs, post, runAttributes } from '../lib/otlp.mjs';
import { encoded } from './otlp-protobuf.mjs';

const SCOPE = 'io.kongcloud.ksai';

const CONTENT_TYPE = 'application/x-protobuf';

const TRACEPARENT = /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i;

const MAX_SPANS = 4096;

const ERROR = 2;

const OUTCOMES = Object.freeze({ ok: 'ok', error: 'error', refused: 'refused' });

const hex = (bytes, ...parts) =>
  createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, bytes * 2);

/**
 * runKey names this run, and it is what every identifier here is derived from.
 *
 * Deterministic rather than random, so a re-read of the same stream answers the same span twice
 * rather than two spans for one tool call.
 */
export function runKey(env = process.env) {
  return [env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB, env.KSAI_JOB_INDEX]
    .map((one) => String(one ?? ''))
    .join(':');
}

/**
 * traceContext answers the trace these spans belong under, and who their root's parent is.
 *
 * The control plane hands a run the trace it handled that delivery under, in the standard W3C form,
 * and where it does the review's spans join the delivery that caused them. Where it does not - which
 * is every run today, and every run that reads no record - the trace is derived from the run itself,
 * so a review is still one trace rather than a handful of orphans.
 */
export function traceContext(env = process.env) {
  const named = TRACEPARENT.exec(String(env.KSAI_TRACEPARENT ?? '').trim());
  if (named) return { traceId: named[1].toLowerCase(), parentSpanId: named[2].toLowerCase(), dispatched: true };
  return { traceId: hex(16, 'trace', runKey(env)), parentSpanId: '', dispatched: false };
}

/**
 * stamp renders a millisecond reading as the nanoseconds OTLP carries, or nothing where it is not one.
 *
 * `String(1e15 * 1e6)` is `'1e+21'`, which is not a decimal integer and throws on the way into a
 * `BigInt` - taking the whole timeline down over one corrupt line rather than the line.
 */
const stamp = (value) => {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0 || at > Number.MAX_SAFE_INTEGER) return '';
  return String(BigInt(Math.round(at)) * 1_000_000n);
};

const CHILD_SESSION = /^ses_[a-zA-Z0-9]+$/;

/**
 * opened answers the sub-agent session a call started, and empty for every call that started none.
 *
 * The same three terms its sibling `childSessions` requires: the tool is `task`, the id is one, and
 * the call names the session it is running under as the child's parent. Without the last, an event
 * naming its own session reparents every later call of that session under a span that has already
 * ended.
 */
function opened(tool, state, session) {
  const id = state?.metadata?.sessionId;
  if (tool !== 'task' || typeof id !== 'string' || !CHILD_SESSION.test(id)) return '';
  return state.metadata.parentSessionId === session && id !== session ? id : '';
}

function callSpan({ event, context, env, parents }) {
  const part = event.part ?? {};
  const state = part.state ?? {};
  const began = stamp(state.time?.start);
  const ended = stamp(state.time?.end);
  /* A call still running when the review was killed has no end, so it has no duration to report -
     substituting its start published a nought-millisecond span that had not finished. */
  if (!began || !ended) return null;
  const tool = String(part.tool ?? 'unknown');
  const callId = typeof part.callID === 'string' ? part.callID : `${tool}:${began}`;
  const outcome = refused(state) ? OUTCOMES.refused : state.status === 'error' ? OUTCOMES.error : OUTCOMES.ok;
  const session = typeof event.sessionID === 'string' ? event.sessionID : '';
  const child = opened(tool, state, session);
  const span = {
    traceId: context.traceId,
    spanId: hex(8, 'span', runKey(env), callId),
    parentSpanId: parents.get(session) ?? context.runSpanId,
    name: CLAUDE_NAME[tool] ?? tool,
    kind: 1,
    startTimeUnixNano: began,
    endTimeUnixNano: ended,
    attributes: attributes(
      [
        ['ksai.tool', tool],
        ['ksai.tool.outcome', outcome],
        ['ksai.session', session],
        ['ksai.session.child', child],
      ].filter(([, value]) => value !== ''),
    ),
    status: outcome === OUTCOMES.ok ? undefined : { code: ERROR, message: outcome },
  };
  return { span, child };
}

/**
 * spansFrom replays an event stream as the timeline it already is, and carries none of its content.
 *
 * A completed tool call times itself to the millisecond, so what a slow review spent its minutes on
 * is in the stream already - as a file somebody downloads and greps. **No input and no output text
 * reaches a span**: the name of the tool, how the call ended and which session it ran under are the
 * whole attribute set, because everything else in a tool call is the reviewed repository's content.
 *
 * A refused call reads differently from one that failed on its own, or an operator cannot tell a
 * profile scoped too tightly from a model that kept asking for what it was told not to do.
 */
export function spansFrom({ events, children = [], context, env = process.env, say = console.log }) {
  const run = { ...context, runSpanId: hex(8, 'run', runKey(env)) };
  const calls = [];
  const parents = new Map();
  for (const event of events) {
    if (event?.type !== 'tool_use') continue;
    const made = callSpan({ event, context: run, env, parents });
    if (!made) continue;
    if (made.child) parents.set(made.child, made.span.spanId);
    calls.push(made.span);
  }
  /* A child's own calls are read after its parent's, so the session that started them has a span */
  for (const event of children) {
    if (event?.type !== 'tool_use') continue;
    const made = callSpan({ event, context: run, env, parents });
    if (made) calls.push(made.span);
  }
  if (calls.length === 0) return null;
  if (calls.length > MAX_SPANS) {
    say(`::notice::${calls.length - MAX_SPANS} tool calls are not in this run's exported timeline, which holds ${MAX_SPANS}`);
  }
  /* The window is every event's, not every tool call's: a review spends time before its first call
     and, on the turn that writes the review, after its last - which is the time being hunted. */
  const marks = events
    .map((one) => stamp(one?.timestamp))
    .filter(Boolean)
    .map(BigInt);
  const began = [...calls.map((one) => BigInt(one.startTimeUnixNano)), ...marks].reduce((low, at) => (at < low ? at : low));
  const ended = [...calls.map((one) => BigInt(one.endTimeUnixNano)), ...marks].reduce((high, at) => (at > high ? at : high));
  const root = {
    traceId: run.traceId,
    spanId: run.runSpanId,
    ...(run.parentSpanId ? { parentSpanId: run.parentSpanId } : {}),
    name: `ksai.${String(env.FLOW ?? 'run').trim() || 'run'}`,
    kind: 1,
    startTimeUnixNano: String(began),
    endTimeUnixNano: String(ended),
  };
  return [root, ...calls.slice(0, MAX_SPANS)];
}

/**
 * report publishes the timeline, and answers null wherever there is none to publish.
 *
 * A stream that fails to parse leaves the review and its spend report alone: this runs after both,
 * in a step that cannot fail the run, and every path out of it is a warning rather than an exit.
 */
export async function report({ env = process.env, fetchImpl = fetch, read = readFileSync } = {}) {
  const auth = String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').trim();
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!auth || !endpoint) return null;
  let spans = null;
  try {
    const events = parsed(String(read(String(env.EVENTS_FILE ?? ''), 'utf8')));
    spans = spansFrom({ events, children: childEvents(read, env.OPENCODE_CHILDREN_FILE), context: traceContext(env), env });
  } catch (error) {
    console.log(
      `::warning::the tool call timeline could not be read (${error?.message ?? error}), so this run published none`,
    );
    return null;
  }
  if (!spans) return null;
  const body = encoded('traces', {
    resourceSpans: [
      {
        resource: { attributes: attributes(runAttributes(env)) },
        scopeSpans: [{ scope: { name: SCOPE }, spans }],
      },
    ],
  });
  if (!body) return null;
  const outcome = await post({
    endpoint,
    signal: 'traces',
    headers: Object.fromEntries(pairs(auth)),
    contentType: CONTENT_TYPE,
    body,
    fetchImpl,
  });
  if (!outcome.ok) {
    console.log(
      `::warning::this run's tool call timeline did not reach ${endpoint} (${outcome.said}), which changes nothing about the review or what it reports spending`,
    );
    return false;
  }
  return true;
}

/**
 * childEvents answers the sub-agents' own tool calls, and an empty list for every way of having none.
 *
 * Its own `try`, because one unreadable children file may not discard a main stream that parsed:
 * the timeline of the review itself is the thing being published, and a sub-agent's is an addition.
 */
function childEvents(read, at) {
  const named = String(at ?? '').trim();
  if (!named) return [];
  const out = [];
  const list = (held) => (Array.isArray(held) ? held : []);
  try {
    const record = JSON.parse(String(read(named, 'utf8')));
    for (const session of list(record?.sessions)) {
      const parts = list(session?.messages).flatMap((message) => list(message?.parts));
      for (const part of parts) {
        if (part?.type === 'tool') out.push({ type: 'tool_use', part, sessionID: session?.info?.id });
      }
    }
  } catch (error) {
    console.log(
      `::warning::the sub-agent sessions could not be read (${error?.message ?? error}), so the timeline holds the review's own calls alone`,
    );
    return [];
  }
  return out;
}

await runMain(import.meta.url, async () => {
  await report();
});
