const MCP_SPAN = 'MCP.connectTransport';
const MODEL_SPAN = 'ai.streamText.doStream';
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;

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
