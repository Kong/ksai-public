const MCP_SPAN = 'MCP.connectTransport';
const MODEL_SPAN = 'ai.streamText.doStream';
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;

const groups = (value) => (Array.isArray(value) ? value : []);

const MODEL_KEYS = Object.freeze(['gen_ai.request.model', 'ai.model.id']);

const identityText = (value, most, pattern = /^\P{Cc}+$/u) =>
  typeof value === 'string' && value.length <= most && pattern.test(value) ? value : null;

export const invocationIdentity = (session) => ({
  host_session_id: identityText(session, 128, /^[A-Za-z0-9_.:-]+$/),
});

export function executionIdentity(env = {}) {
  const repository = identityText(env.GITHUB_REPOSITORY, 201, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const run = identityText(env.GITHUB_RUN_ID, 20, /^\d+$/);
  if (!repository || !run) return null;
  const index = identityText(env.KSAI_JOB_INDEX ?? '0', 4, /^\d+$/);
  return {
    repository,
    workflow: identityText(env.GITHUB_WORKFLOW, 256),
    workflow_ref: identityText(env.GITHUB_WORKFLOW_REF, 1024),
    run_id: run,
    run_attempt: identityText(env.GITHUB_RUN_ATTEMPT, 10, /^\d+$/),
    job: identityText(env.GITHUB_JOB, 100, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    job_index: index === null ? null : Number(index),
  };
}

const ATTRIBUTION_STAGES = Object.freeze([
  'token', 'request_guard', 'upstream_headers', 'upstream_response',
  'response_validation', 'tool_execution', 'server_startup', 'session_drain',
]);
const ATTRIBUTION_LIMIT = 4096;
const LIFECYCLE_STAGES = Object.freeze({
  'ServerProcess.start': 'server_startup',
  'SessionRunner.drain': 'session_drain',
});

function unionIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (last && interval.startMs <= last.endMs) last.endMs = Math.max(last.endMs, interval.endMs);
    else out.push({ startMs: interval.startMs, endMs: interval.endMs });
  }
  return out;
}

const intervalTime = (intervals) => intervals.reduce((total, one) => total + one.endMs - one.startMs, 0);

function overlapTime(left, right) {
  let total = 0;
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    total += Math.max(0, Math.min(left[a].endMs, right[b].endMs) - Math.max(left[a].startMs, right[b].startMs));
    if (left[a].endMs <= right[b].endMs) a += 1;
    else b += 1;
  }
  return total;
}

export function runtimeAttribution({ now = Date.now } = {}) {
  let active = null;
  const add = (sample, stage, startMs, endMs = null) => {
    if (!sample || !ATTRIBUTION_STAGES.includes(stage)) return null;
    if (sample.intervals.length >= ATTRIBUTION_LIMIT) {
      sample.dropped += 1;
      return null;
    }
    const interval = { stage, startMs, endMs };
    sample.intervals.push(interval);
    return interval;
  };
  const measure = (stage) => {
    const sample = active;
    if (!sample) return () => {};
    const interval = add(sample, stage, now());
    let finished = false;
    return (status = 0) => {
      if (finished || active !== sample) return;
      finished = true;
      if (interval) interval.endMs = now();
      if (stage === 'upstream_headers' && Number.isInteger(status) && status >= 100 && status <= 599) {
        sample.statuses[status] = (sample.statuses[status] ?? 0) + 1;
      }
    };
  };
  const observe = (signal, payload) => {
    if (signal !== 'traces' || !active) return;
    for (const span of spans(payload)) {
      const stage = typeof span?.name === 'string' && Object.hasOwn(LIFECYCLE_STAGES, span.name) ? LIFECYCLE_STAGES[span.name] : '';
      if (!stage) continue;
      const measured = timing(span);
      if (measured) add(active, stage, measured.startMs, measured.endMs);
    }
  };
  const begin = (beganAt) => {
    const sample = { intervals: [], dropped: 0, statuses: Object.create(null) };
    active = sample;
    return (endedAt, calls = []) => {
      if (active === sample) active = null;
      let unavailableTools = 0;
      for (const call of calls) {
        const start = Number.isFinite(call.called) ? Math.round(call.called) : NaN;
        const end = Number.isFinite(call.ended) ? Math.round(call.ended) : null;
        if (!Number.isSafeInteger(start) || start < beganAt || start > endedAt ||
            (end !== null && (!Number.isSafeInteger(end) || end < start || end > endedAt))) {
          unavailableTools += 1;
          continue;
        }
        add(sample, 'tool_execution', start, end);
      }
      let invalid = 0;
      const rows = sample.intervals.flatMap((one) => {
        const end = one.endMs ?? endedAt;
        if (!Number.isFinite(one.startMs) || !Number.isFinite(end) || end < one.startMs) {
          invalid += 1;
          return [];
        }
        if (end < beganAt || one.startMs > endedAt) return [];
        return [{ ...one, startMs: Math.max(beganAt, one.startMs), endMs: Math.min(endedAt, end), incomplete: one.endMs === null }];
      });
      const stages = Object.fromEntries(ATTRIBUTION_STAGES.map((stage) => {
        const held = rows.filter((one) => one.stage === stage);
        return [stage, {
          sum_ms: intervalTime(held), union_ms: intervalTime(unionIntervals(held)),
          intervals: held.length, incomplete: held.filter((one) => one.incomplete).length,
        }];
      }));
      const total = Math.max(0, endedAt - beganAt);
      const measured = intervalTime(unionIntervals(rows));
      const reliable = sample.dropped === 0 && invalid === 0;
      return {
        version: 1,
        source: 'trusted-provider-relay+unauthenticated-event-feed+unauthenticated-otel',
        total_ms: total,
        measured_ms: reliable ? measured : null,
        unmeasured_ms: reliable ? Math.max(0, total - measured) : null,
        overlap_ms: reliable ? Object.values(stages).reduce((sum, one) => sum + one.union_ms, 0) - measured : null,
        provider_tool_overlap_ms: reliable ? overlapTime(
          unionIntervals(rows.filter((one) => one.stage === 'upstream_response')),
          unionIntervals(rows.filter((one) => one.stage === 'tool_execution')),
        ) : null,
        unavailable_tool_calls: unavailableTools,
        dropped_intervals: sample.dropped,
        invalid_intervals: invalid,
        upstream_status_counts: sample.statuses,
        stages,
      };
    };
  };
  return { begin, measure, observe };
}

export function attributionSummary(invocations) {
  const rows = invocations.map((one) => one.attribution);
  if (!rows.length || rows.some((one) => one?.version !== 1)) return null;
  const sum = (field, values = rows) => values.every((one) => Number.isFinite(one[field]) && one[field] >= 0)
    ? values.reduce((total, one) => total + one[field], 0) : null;
  const statuses = Object.create(null);
  for (const row of rows) {
    for (const [status, count] of Object.entries(row.upstream_status_counts)) statuses[status] = (statuses[status] ?? 0) + count;
  }
  return {
    version: 1,
    source: rows[0].source,
    ...Object.fromEntries([
      'total_ms', 'measured_ms', 'unmeasured_ms', 'overlap_ms', 'provider_tool_overlap_ms',
      'unavailable_tool_calls', 'dropped_intervals', 'invalid_intervals',
    ].map((field) => [field, sum(field)])),
    upstream_status_counts: statuses,
    stages: Object.fromEntries(ATTRIBUTION_STAGES.map((stage) => [stage, Object.fromEntries(
      ['sum_ms', 'union_ms', 'intervals', 'incomplete'].map((field) => [field, sum(field, rows.map((one) => one.stages[stage]))]),
    )])),
  };
}


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

export function traceObserver({ arm = '', model: modelSpan = MODEL_SPAN, mcp: mcpSpan = MCP_SPAN } = {}) {
  const named = String(arm ?? '').trim();
  let active = null;
  const observe = (signal, payload) => {
    if (signal !== 'traces' || !active) return;
    for (const span of spans(payload)) {
      if (span?.name !== mcpSpan && span?.name !== modelSpan) continue;
      const measured = timing(span);
      if (!measured) continue;
      if (span.name !== modelSpan) {
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

/** mcpServerCount reports active MCP servers in the trusted runtime configuration. */
export function mcpServerCount(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!Object.hasOwn(config, 'mcp')) return 0;
  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) return null;
  const servers = Object.values(config.mcp);
  if (servers.some((server) => !server || typeof server !== 'object' || Array.isArray(server))) return null;
  return servers.filter((server) => server.enabled !== false).length;
}
