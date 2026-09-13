import { runMain } from '../lib/main.mjs';
import { attributes, logs, pairs, post, runAttributes, runSeries } from '../lib/otlp.mjs';

const BILLED_APART = Object.freeze(['team', 'workflow']);

const DELTA = 1;

const SCOPE = 'io.kongcloud.ksai';

const ARMED_METRIC = 'ksai.watchdog.armed';

const FIRED_METRIC = 'ksai.watchdog.fired';

const UNWATCHED_METRIC = 'ksai.watchdog.unwatched';

const MISSED_METRIC = 'ksai.watchdog.missed';

const OVERRUN_METRIC = 'ksai.watchdog.overrun';

const HEADROOM_METRIC = 'ksai.watchdog.headroom';

const CAUSES = new Set(['ceiling', 'progress', 'halt']);

const yes = (value) => String(value ?? '').trim() === 'true';

/**
 * stamp reads a millisecond timestamp the arm step published, or nothing where it published none.
 *
 * A run whose arm step was skipped carries an empty string here, and `Number('')` is 0 - which
 * would derive a budget of minus fifty-eight years and report it as a measurement.
 */
function stamp(value) {
  const at = Number(String(value ?? '').trim());
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/**
 * measured answers what the watchdog did, read off the outputs the arm and disarm steps published.
 *
 * `cause` is validated against the three the loop can write rather than passed through: it becomes
 * a metric tag, and a tag whose values are whatever a file happened to contain is a cardinality
 * leak into the bill.
 */
export function measured(env = {}, at = Date.now()) {
  const armedAt = stamp(env.WATCHDOG_ARMED_AT_MS);
  const killAt = stamp(env.WATCHDOG_KILL_AT_MS);
  const said = String(env.WATCHDOG_CAUSE ?? '').trim();
  return {
    fired: yes(env.WATCHDOG_FIRED),
    cause: CAUSES.has(said) ? said : '',
    unwatched: yes(env.WATCHDOG_UNWATCHED),
    missed: yes(env.WATCHDOG_MISSED),
    overrun: yes(env.WATCHDOG_OVERRUN),
    budgetMs: armedAt !== null && killAt !== null && killAt > armedAt ? killAt - armedAt : null,
    headroomMs: killAt !== null ? killAt - at : null,
  };
}

const sum = (name, points) => ({
  name,
  sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: points },
});

const gauge = (name, points) => ({ name, gauge: { dataPoints: points } });

/**
 * payload answers the metrics one armed watchdog publishes.
 *
 * `armed` is published by every run that reached this step, and it is the denominator for all four
 * counters beside it: a trip rate needs to know how many runs were watched and did not trip, and a
 * run that did not trip publishes no `fired` point to be counted.
 *
 * The naming goes on the data points as well as the resource, because Datadog's direct OTLP intake
 * promotes a resource attribute to a span tag and not to a metric tag - the same reason
 * `run-metrics.mjs` calls `runSeries`.
 *
 * **Two of those names are left off, because a metric is billed per tag combination.** `team` and
 * `workflow` are both settled by the repository for this question, so carrying them multiplies the
 * series count across a grouping nobody asks for - whether the watchdog trips more on one workflow
 * of a repository than on another. They stay on the resource, where the logs and traces beside
 * these still answer by them and nothing is billed per combination.
 *
 * Only `armed` and `headroom` are published by every run. The four counters are published when
 * their condition holds and are absent otherwise, so a fleet that trips rarely pays for the two.
 */
export function payload({ said = null, env = {}, at = Date.now() } = {}) {
  if (!said) return null;
  const nanos = String(at * 1_000_000);
  const named = runSeries(env).filter(([key]) => !BILLED_APART.includes(key));
  const stamps = { startTimeUnixNano: nanos, timeUnixNano: nanos, attributes: attributes(named) };
  /** @type {Array<Record<string, unknown>>} */
  const metrics = [sum(ARMED_METRIC, [{ ...stamps, asInt: '1' }])];
  if (said.fired) {
    metrics.push(
      sum(FIRED_METRIC, [
        { ...stamps, asInt: '1', attributes: attributes([...named, ['cause', said.cause || 'ceiling']]) },
      ]),
    );
  }
  if (said.unwatched) metrics.push(sum(UNWATCHED_METRIC, [{ ...stamps, asInt: '1' }]));
  if (said.missed) metrics.push(sum(MISSED_METRIC, [{ ...stamps, asInt: '1' }]));
  if (said.overrun) metrics.push(sum(OVERRUN_METRIC, [{ ...stamps, asInt: '1' }]));
  if (said.headroomMs !== null) metrics.push(gauge(HEADROOM_METRIC, [{ ...stamps, asInt: String(said.headroomMs) }]));
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
 * lines answers the log records this run deserves, which for an ordinary run is none.
 *
 * Three of these are conditions the disarm step could until now only put in a GitHub annotation,
 * where they are visible to whoever opens that one job and to nobody else. An unwatched run is the
 * one worth waking up for: it means nothing would have stopped that run before the job ceiling.
 *
 * **The reason the loop recorded is deliberately not here.** It quotes a tool call the model wrote,
 * which is why every surface that publishes it puts it through `scrub` first; the cause is the part
 * that is ours, is bounded to three values, and is what a reader groups by. A free-text field
 * carrying model output into a log index is the thing this pipeline is built not to do.
 */
export function lines(said = null) {
  if (!said) return [];
  const out = [];
  if (said.unwatched) {
    out.push({
      severity: 'Warn',
      body: 'the watchdog loop was not running when this run ended, and it neither stopped the run nor recorded a ceiling it could not act on: this run was unwatched',
    });
  }
  if (said.missed) {
    out.push({
      severity: 'Warn',
      body: 'the watchdog reached its ceiling and found no CLI process to stop, so nothing was salvaged',
    });
  }
  if (said.overrun) {
    out.push({
      severity: 'Warn',
      body: 'the watchdog loop had to be killed outright, so a trip it was in the middle of did not finish and the stop this run reports may be missing its reason',
    });
  }
  if (said.fired) {
    out.push({
      severity: 'Info',
      body: `the watchdog stopped this run on ${said.cause || 'ceiling'}`,
      attributes: [['ksai.watchdog.cause', said.cause || 'ceiling']],
    });
  }
  return out;
}

/**
 * report publishes what the watchdog did, and answers null wherever there is nothing to publish.
 *
 * Nothing here may cost the run: this is the last thing a job does with facts it has already put in
 * its own annotations, so a refusal is a warning and never an exit.
 */
export async function report({ env = process.env, fetchImpl = fetch, at = Date.now() } = {}) {
  const auth = String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').trim();
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!auth || !endpoint) return null;
  const said = measured(env, at);
  const headers = Object.fromEntries(pairs(auth));
  const body = payload({ said, env, at });
  if (!body) return null;
  const sent = [['metrics', JSON.stringify(body)]];
  const written = logs({ scope: SCOPE, lines: lines(said), env, at });
  if (written) sent.push(['logs', JSON.stringify(written)]);
  let ok = true;
  for (const [signal, text] of sent) {
    const outcome = await post({ endpoint, signal, headers, body: text, fetchImpl });
    if (!outcome.ok) {
      ok = false;
      console.log(
        `::warning::what the watchdog did did not reach ${endpoint} as ${signal} (${outcome.said}), which changes nothing about this run`,
      );
    }
  }
  return ok;
}

await runMain(import.meta.url, async () => {
  await report();
});
