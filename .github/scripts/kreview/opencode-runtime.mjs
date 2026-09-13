import { readFileSync, statSync } from 'node:fs';

const MCP_SPAN = 'MCP.connectTransport';
const MODEL_SPAN = 'ai.streamText.doStream';
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
const MAX_COMPACTION_BYTES = 32 * 1024;
const COMPACTION_VERSION = '1.18.30';
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

const groups = (value) => (Array.isArray(value) ? value : []);

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

export function traceObserver() {
  let active = null;
  const observe = (signal, payload) => {
    if (signal !== 'traces' || !active) return;
    for (const span of spans(payload)) {
      if (span?.name !== MCP_SPAN && span?.name !== MODEL_SPAN) continue;
      const measured = timing(span);
      if (!measured) continue;
      active[span.name === MODEL_SPAN ? 'models' : 'mcp'].push(measured);
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
      };
    };
  };
  return { begin, observe };
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
