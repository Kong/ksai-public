import { readFileSync, statSync } from 'node:fs';

const MCP_SPAN = 'MCP.connectTransport';
const MODEL_SPAN = 'ai.streamText.doStream';
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
const MAX_COMPACTION_BYTES = 32 * 1024;
const COMPACTION_VERSION = '1.18.31';
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

const groups = (value) => (Array.isArray(value) ? value : []);

const MODEL_KEYS = Object.freeze(['gen_ai.request.model', 'ai.model.id']);

/*
 * modelOf answers the model a span says served it, which is not the arm the run was started on. A
 * side call - a session title above all - is a model span like any other, so a count that does not
 * separate the two reads as review turns and is not. Sandbox-authored like every other span field.
 */
function modelOf(span) {
  for (const key of MODEL_KEYS) {
    const named = groups(span?.attributes).find((one) => one?.key === key);
    const value = named?.value?.stringValue ?? named?.value?.string_value;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

export const supportsCompaction = (version) => String(version ?? '').trim() === COMPACTION_VERSION;

function timing(span) {
  const rawStart = span?.startTimeUnixNano ?? span?.start_time_unix_nano;
  const rawEnd = span?.endTimeUnixNano ?? span?.end_time_unix_nano;
  if (!/^\d{1,20}$/.test(String(rawStart ?? '')) || !/^\d{1,20}$/.test(String(rawEnd ?? ''))) return null;
  const start = BigInt(String(rawStart));
  const end = BigInt(String(rawEnd));
  if (end < start) return null;
  const durationMs = Number(end - start) / 1_000_000;
  const startMs = Number(start / 1_000_000n);
  const endMs = Number(end / 1_000_000n);
  if (!Number.isFinite(durationMs) || durationMs > MAX_SPAN_MS || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) return null;
  return { durationMs, endMs, startMs };
}

function spans(payload) {
  return groups(payload?.resourceSpans).flatMap((resource) =>
    groups(resource?.scopeSpans).flatMap((scope) => groups(scope?.spans)),
  );
}

export function traceObserver({ arm = '' } = {}) {
  const named = String(arm ?? '').trim();
  let active = null;
  const observe = (signal, payload) => {
    if (signal !== 'traces' || !active) return;
    for (const span of spans(payload)) {
      if (span?.name !== MCP_SPAN && span?.name !== MODEL_SPAN) continue;
      const measured = timing(span);
      if (!measured) continue;
      if (span.name !== MODEL_SPAN) {
        active.mcp.push(measured);
        continue;
      }
      const model = modelOf(span);
      active.models.push({ ...measured, side: named !== '' && model !== '' && model !== named });
    }
  };
  const begin = (beganAt) => {
    const sample = {
      beganAt,
      mcp: [],
      models: [],
    };
    active = sample;
    return (endedAt) => {
      if (active === sample) active = null;
      const within = ({ startMs, endMs }) => startMs >= beganAt && endMs <= endedAt;
      const models = sample.models.filter(within);
      const mcp = sample.mcp.filter(within);
      const firstModel = models.reduce((first, span) => Math.min(first, span.startMs), Infinity);
      const firstMcp = mcp.reduce((first, span) => span.startMs < first.startMs ? span : first, { startMs: Infinity });
      return {
        startup_ms: Number.isFinite(firstModel) ? firstModel - beganAt : null,
        first_mcp_ms: Number.isFinite(firstMcp.startMs) ? firstMcp.durationMs : null,
        mcp_connect_ms: mcp.length ? mcp.reduce((total, span) => total + span.durationMs, 0) : null,
        mcp_connects: mcp.length,
        model_ms: models.length ? models.reduce((total, span) => total + span.durationMs, 0) : null,
        model_calls: models.length,
        side_calls: named === '' ? null : models.filter((span) => span.side).length,
        side_ms: named === '' ? null : models.filter((span) => span.side).reduce((total, span) => total + span.durationMs, 0),
      };
    };
  };
  return { begin, observe };
}

/** toolTiming measures the event-stream latency to the first completed tool call in one process. */
export function toolTiming(events, beganAt, endedAt) {
  /*
   * A sub-millisecond start is precision rather than corruption, and the decision record invalidates
   * a *malformed* event. Both sibling readers of this stream already expect one - `tool-spans.mjs`
   * rounds before it builds a nanosecond stamp - so rejecting it here measured nothing on a stream
   * the rest of the repository reads happily. A start that is missing or outside the invocation
   * still invalidates: there is no clock to measure from, and borrowing another one would report a
   * latency nobody observed.
   *
   * The earliest start is found by walking the map rather than spreading it into `Math.min`, whose
   * argument list is bounded; enough distinct call IDs in one segment would throw a RangeError out
   * of `invoke` and discard a run the child may already have submitted.
   */
  const tools = Array.isArray(events) ? events.filter((event) => event?.type === 'tool_use') : [];
  const calls = new Map();
  for (const event of tools) {
    const id = event?.part?.callID ?? event?.part?.id;
    const said = Number(event?.part?.state?.time?.start);
    const start = Number.isFinite(said) ? Math.round(said) : NaN;
    if (typeof id !== 'string' || id === '' || !Number.isSafeInteger(start) || start < beganAt || start > endedAt) {
      return { first_tool_ms: null, tool_calls: null };
    }
    if (calls.has(id) && calls.get(id) !== start) return { first_tool_ms: null, tool_calls: null };
    calls.set(id, start);
  }
  let first = Infinity;
  for (const at of calls.values()) if (at < first) first = at;
  return {
    first_tool_ms: calls.size ? first - beganAt : null,
    tool_calls: calls.size,
  };
}

/** mcpServerCount reports active MCP servers in the trusted runtime configuration. */
export function mcpServerCount(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!Object.hasOwn(config, 'mcp')) return 0;
  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) return null;
  const servers = Object.values(config.mcp);
  if (servers.some((server) => !server || typeof server !== 'object' || Array.isArray(server))) return null;
  return servers.filter((server) => server.enabled !== false).length;
}

const unavailableCompaction = () => ({ compaction_count: null, compactions: null });

/** compactionSample reduces one bounded plugin sidecar into its invocation sample. */
export function compactionSample(path, beganAt, endedAt) {
  if (!path || !Number.isFinite(beganAt) || !Number.isFinite(endedAt) || endedAt < beganAt) {
    return unavailableCompaction();
  }
  let source;
  try {
    const status = statSync(path);
    if ((status.mode & 0o777) !== 0o600 || status.size > MAX_COMPACTION_BYTES) {
      return unavailableCompaction();
    }
    source = readFileSync(path, 'utf8');
  } catch {
    return unavailableCompaction();
  }
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2 || lines.length > 66) return unavailableCompaction();
  let records;
  try {
    records = lines.map((line) => JSON.parse(line));
  } catch {
    return unavailableCompaction();
  }
  if (records[0]?.type !== 'ksai_compaction_ready' || records[0]?.version !== 1) {
    return unavailableCompaction();
  }
  if (records.at(-1)?.type !== 'ksai_compaction_complete' || records.at(-1)?.version !== 1) {
    return unavailableCompaction();
  }
  const compactions = [];
  for (const record of records.slice(1, -1)) {
    const observed = record?.observed_at_ms;
    if (
      record?.type !== 'session.compacted' ||
      !SESSION.test(String(record?.session_id ?? '')) ||
      !Number.isSafeInteger(observed) ||
      observed < beganAt ||
      observed > endedAt
    ) {
      return unavailableCompaction();
    }
    compactions.push({ session_id: record.session_id, offset_ms: observed - beganAt });
  }
  return { compaction_count: compactions.length, compactions };
}
