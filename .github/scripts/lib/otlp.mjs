const EXPORT_TIMEOUT_MS = 10_000;

const SERVICE = 'ksai';

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
