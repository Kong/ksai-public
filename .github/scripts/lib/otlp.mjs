const EXPORT_TIMEOUT_MS = 10_000;

const SERVICE = 'ksai';

/**
 * PER_RUN names the attributes that identify one run rather than a class of them.
 *
 * They belong on a resource and on a span, and never on a metric's data points: a tag whose value
 * is new every run is a new timeseries every run, which is what a trace is for and what a metric
 * is billed for. `runSeries` is the same naming with these left out.
 */
const PER_RUN = Object.freeze(['run', 'attempt', 'job', 'job_index']);

/**
 * pairs reads the `k=v,k=v` form that OTLP headers and resource attributes are both written in.
 *
 * The split is on the first `=` alone, because a resource attribute's value is allowed to hold one.
 */
export function pairs(text) {
  const out = [];
  for (const entry of String(text ?? '').split(',')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at).trim();
    if (key !== '') out.push([key, entry.slice(at + 1).trim()]);
  }
  return out;
}

/**
 * runAttributes names the run a record belongs to, and the trusted side is the only thing that names it.
 *
 * One implementation, because a trace and a metric that name the same run differently cannot be
 * read together. It is handed an environment, never a literal holding the two values a caller
 * happens to think of: six of these come off names a step does not spell, and a literal missing
 * them answers four attributes rather than ten.
 *
 * `job` and `job_index` are here because two legs of one run otherwise collapse into one series -
 * the same reason the control plane's spend attempt names both. `service.name` is here because Datadog routes on it: anything that could name it
 * could write a record into any service in the organisation.
 */
export function runAttributes(env = process.env) {
  const named = new Map();
  for (const [key, value] of pairs(env.OTEL_RESOURCE_ATTRIBUTES)) named.set(key, value);
  if (!named.has('service.name')) named.set('service.name', SERVICE);
  for (const [key, value] of [
    ['repo', env.GITHUB_REPOSITORY],
    ['engine', String(env.ENGINE ?? '').trim() || 'opencode'],
    ['flow', env.FLOW],
    ['model', env.MODEL],
    ['effort', env.VARIANT],
    ['run', env.GITHUB_RUN_ID],
    ['attempt', env.GITHUB_RUN_ATTEMPT],
    ['job', env.GITHUB_JOB],
    ['job_index', env.KSAI_JOB_INDEX],
  ]) {
    named.set(key, String(value ?? '').trim());
  }
  return [...named].filter(([, value]) => String(value ?? '').trim() !== '');
}

/** attributes renders `k=v` pairs as the attribute list every OTLP/JSON signal carries. */
export function attributes(entries) {
  return entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

/**
 * post sends one OTLP/JSON payload and answers how it went, rather than deciding what to say about it.
 *
 * It never throws and it never rejects: an export is the least important thing any of its callers
 * does, and the caller is the one that knows which sentence a lost export deserves.
 */
export async function post({
  endpoint,
  signal,
  headers = {},
  contentType = 'application/json',
  body,
  fetchImpl = fetch,
  timeoutMs = EXPORT_TIMEOUT_MS,
}) {
  const at = `${String(endpoint ?? '')
    .trim()
    .replace(/\/+$/, '')}/v1/${signal}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(at, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': contentType, ...headers },
      body,
    });
    return response.ok ? { ok: true, said: '' } : { ok: false, said: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, said: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * runSeries names the class of run a measurement belongs to, for a signal that is aggregated.
 *
 * Datadog's direct OTLP intake promotes a resource attribute to a span tag and not to a metric tag,
 * so a metric that names its run only on the resource arrives groupable by nothing: measured on the
 * live intake, a day of `ksai.run.step.count` grouped by any of these answered `N/A` while the same
 * names were present on the traces from the same runs. The identity therefore goes on the data
 * points too - **less whatever identifies one run**, which would be a new timeseries per review.
 */
export function runSeries(env = process.env) {
  return runAttributes(env).filter(([key]) => !PER_RUN.includes(key));
}

/**
 * SEVERITY maps the three levels this repository emits onto the numbers OTLP defines for them.
 *
 * Datadog does not index the reserved `status` facet for these records, so the text is what a
 * reader filters on: `@otel.severity_text:Warn`. The number still has to be right, because the
 * intake derives its own level from it and a record with a level nothing set sorts as unknown.
 */
export const SEVERITY = Object.freeze({ Info: 9, Warn: 13, Error: 17 });

/**
 * logs renders OTLP/JSON log records, or nothing where there is nothing worth sending.
 *
 * The run's identity goes on the resource alone rather than onto every record. Datadog promotes a
 * resource attribute to a log tag - which is why `@repo` and `@flow` already answer for the records
 * the opencode relay forwards - so repeating ten attributes per record would buy nothing and be
 * billed by the byte. Per-record attributes are for what distinguishes one record from its
 * neighbours, and nothing else.
 *
 * A record whose body is empty is dropped rather than sent: a log line saying nothing still costs
 * indexing, and an empty body is always a value a caller failed to compute rather than a fact.
 */
export function logs({ scope = '', lines = [], env = process.env, at = Date.now() } = {}) {
  const nanos = String(at * 1_000_000);
  const records = lines
    .filter((one) => String(one?.body ?? '').trim() !== '')
    .map((one) => {
      const level = one.severity in SEVERITY ? one.severity : 'Info';
      return {
        timeUnixNano: nanos,
        observedTimeUnixNano: nanos,
        severityNumber: SEVERITY[level],
        severityText: level,
        body: { stringValue: String(one.body) },
        ...(one.attributes?.length ? { attributes: attributes(one.attributes) } : {}),
      };
    });
  if (records.length === 0) return null;
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes(runAttributes(env)) },
        scopeLogs: [{ scope: { name: scope }, logRecords: records }],
      },
    ],
  };
}
