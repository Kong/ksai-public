const EXPORT_TIMEOUT_MS = 10_000;

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
