import { attributes, pairs, post } from '../lib/otlp.mjs';

const DELTA = 1;

const SCOPE = 'com.anthropic.claude_code';

const SERVICE = 'claude-code';

const TOKEN_METRIC = 'claude_code.token.usage';

const COST_METRIC = 'claude_code.cost.usage';

const TOKEN_TYPES = Object.freeze([
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cacheRead', 'cache_read_tokens'],
  ['cacheCreation', 'cache_creation_tokens'],
]);

function sum(name, points) {
  return { name, sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: points } };
}

export function payload({ tally = {}, cost = null, model = '', resource = '', at = Date.now() } = {}) {
  const nanos = String(at * 1_000_000);
  const stamps = { startTimeUnixNano: nanos, timeUnixNano: nanos };
  const named = (type) => [
    { key: 'model', value: { stringValue: model } },
    { key: 'type', value: { stringValue: type } },
  ];
  const tokens = TOKEN_TYPES.filter(([, field]) => Number(tally[field]) > 0).map(([type, field]) => ({
    ...stamps,
    asInt: String(Math.round(Number(tally[field]))),
    attributes: named(type),
  }));
  const metrics = tokens.length ? [sum(TOKEN_METRIC, tokens)] : [];
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
    metrics.push(
      sum(COST_METRIC, [{ ...stamps, asDouble: cost, attributes: [{ key: 'model', value: { stringValue: model } }] }]),
    );
  }
  if (!metrics.length) return null;
  const grouping = pairs(resource);
  const withService = grouping.some(([key]) => key === 'service.name')
    ? grouping
    : [['service.name', SERVICE], ...grouping];
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes(withService) },
        scopeMetrics: [{ scope: { name: SCOPE }, metrics }],
      },
    ],
  };
}

export async function report({
  tally = {},
  cost = null,
  model = '',
  env = process.env,
  fetchImpl = fetch,
  at = Date.now(),
} = {}) {
  const auth = String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').trim();
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!auth || !endpoint) return null;
  const body = payload({ tally, cost, model, resource: env.OTEL_RESOURCE_ATTRIBUTES, at });
  if (!body) return null;
  const outcome = await post({
    endpoint,
    signal: 'metrics',
    headers: Object.fromEntries(pairs(auth)),
    body: JSON.stringify(body),
    fetchImpl,
  });
  if (!outcome.ok) {
    console.log(`::warning::the metrics for this call could not be exported: ${outcome.said}`);
    return false;
  }
  return true;
}
