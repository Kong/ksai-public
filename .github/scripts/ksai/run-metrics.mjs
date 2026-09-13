import { readFileSync } from 'node:fs';

import { runMain } from '../lib/main.mjs';
import { attributes, pairs, post, runAttributes, runSeries } from '../lib/otlp.mjs';

const DELTA = 1;

const SCOPE = 'io.kongcloud.ksai';

const COST_METRIC = 'ksai.run.cost.usage';

const MODEL_COST_METRIC = 'ksai.run.model.cost.usage';

const TOKEN_METRIC = 'ksai.run.token.usage';

const STEP_METRIC = 'ksai.run.step.count';

const DURATION_METRIC = 'ksai.run.duration';

const REFUSED_METRIC = 'ksai.run.tool.refused';

const TOKEN_TYPES = Object.freeze([
  ['uncached', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cacheRead', 'cache_read_input_tokens'],
  ['cacheCreation', 'cache_creation_input_tokens'],
]);

/**
 * spent answers what a run spent, read off the execution log every engine and flow already writes.
 *
 * A run a signal ended still has one: `executionLog` answers an empty result above exit 128 and
 * reports the spend anyway, so what is measured here is what was spent up to the point it stopped.
 */
export function spent(raw) {
  let log = [];
  try {
    log = JSON.parse(raw);
  } catch {
    log = [];
  }
  if (!Array.isArray(log)) return null;
  const result = log.findLast?.((entry) => entry?.type === 'result');
  if (!result) return null;
  const usage = result.usage ?? {};
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials.length
    : Number(result.permission_denials_count);
  return {
    tokens: TOKEN_TYPES.map(([type, field]) => ({ type, count: Math.round(Number(usage[field]) || 0) })).filter(
      (one) => one.count > 0,
    ),
    modelCost: Number(result.total_cost_usd),
    steps: Math.round(Number(result.num_turns) || 0),
    durationMs: Math.round(Number(result.duration_ms) || 0),
    refused: Number.isFinite(denials) ? denials : 0,
  };
}

/**
 * whole renders an integer the way OTLP/JSON reads one, or nothing where it is not one.
 *
 * `String(1e30)` is `"1e+30"`, which is not a decimal int64 and is refused by an intake rather than
 * stored. Only a forged or corrupt execution log reaches those magnitudes, and a metric nobody can
 * read is worse than a series that says one figure was not a number.
 */
function whole(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || Math.abs(at) > Number.MAX_SAFE_INTEGER) return '';
  return String(BigInt(Math.round(at)));
}

const sum = (name, points) => ({
  name,
  sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: points },
});

const gauge = (name, points) => ({ name, gauge: { dataPoints: points } });

/**
 * payload answers the metrics one run publishes, or null where it measured nothing worth publishing.
 *
 * The cost is handed in rather than read off the log, so this reports the figure the run already
 * reported to the control plane's spend endpoint. Two numbers for one run's money read as a
 * discrepancy nobody can resolve from either side. That figure also carries the classifier, the
 * triage, the dispute and the status summariser, so the model run's own cost goes out beside it:
 * dividing the total by the tokens would charge every arm for an overhead that is not its own.
 *
 * The whole environment is passed on rather than the two values this function happens to read,
 * because `runAttributes` reads six more and a literal with two of them answers four attributes.
 *
 * **The naming goes on the data points as well as the resource.** Datadog's direct OTLP intake
 * promotes a resource attribute to a span tag and not to a metric tag, so a metric naming its run
 * only there arrives groupable by `service` alone - which is one undifferentiated series per
 * metric, and the question this exists to answer is which arm is cheaper than which.
 */
export function payload({ measured = null, cost = null, env = {}, at = Date.now() } = {}) {
  if (!measured) return null;
  const nanos = String(at * 1_000_000);
  const named = runSeries(env);
  const stamps = { startTimeUnixNano: nanos, timeUnixNano: nanos, attributes: attributes(named) };
  const metrics = [];
  const spend = Number(String(cost ?? '').trim());
  if (String(cost ?? '').trim() !== '' && Number.isFinite(spend) && spend >= 0) {
    metrics.push(sum(COST_METRIC, [{ ...stamps, asDouble: spend }]));
  }
  if (Number.isFinite(measured.modelCost) && measured.modelCost >= 0) {
    metrics.push(sum(MODEL_COST_METRIC, [{ ...stamps, asDouble: measured.modelCost }]));
  }
  if (measured.tokens.length > 0) {
    metrics.push(
      sum(
        TOKEN_METRIC,
        measured.tokens
          .filter((one) => whole(one.count) !== '')
          .map((one) => ({
            ...stamps,
            asInt: whole(one.count),
            attributes: attributes([...named, ['type', one.type]]),
          })),
      ),
    );
  }
  if (whole(measured.steps) !== '' && measured.steps > 0) metrics.push(sum(STEP_METRIC, [{ ...stamps, asInt: whole(measured.steps) }]));
  if (whole(measured.durationMs) !== '' && measured.durationMs > 0) {
    metrics.push(gauge(DURATION_METRIC, [{ ...stamps, asInt: whole(measured.durationMs) }]));
  }
  if (whole(measured.refused) !== '') metrics.push(sum(REFUSED_METRIC, [{ ...stamps, asInt: whole(measured.refused) }]));
  if (metrics.length === 0) return null;
  return {
    resourceMetrics: [
      {
        resource: { attributes: attributes(runAttributes(env)) },
        scopeMetrics: [{ scope: { name: SCOPE }, metrics }],
      },
    ],
  };
}

/**
 * report publishes what this run spent, and answers null wherever there is nothing to publish.
 *
 * Nothing here may cost the review or its spend report: the push is the last thing a run does with
 * figures it has already published everywhere else, so a refusal is a warning and never an exit.
 */
export async function report({ env = process.env, fetchImpl = fetch, at = Date.now() } = {}) {
  const auth = String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').trim();
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!auth || !endpoint) return null;
  let raw = '';
  try {
    raw = readFileSync(String(env.EXECUTION_FILE ?? ''), 'utf8');
  } catch {
    console.log('::warning::the execution log could not be read, so this run published no spend metrics');
    return null;
  }
  const body = payload({ measured: spent(raw), cost: env.SPEND_COST, env, at });
  if (!body) return null;
  const outcome = await post({
    endpoint,
    signal: 'metrics',
    headers: Object.fromEntries(pairs(auth)),
    body: JSON.stringify(body),
    fetchImpl,
  });
  if (!outcome.ok) {
    console.log(
      `::warning::what this run spent did not reach ${endpoint} as metrics (${outcome.said}), which changes nothing about the review or its spend report`,
    );
    return false;
  }
  return true;
}

await runMain(import.meta.url, async () => {
  await report();
});
