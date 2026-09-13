import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';

import { collectSecrets, scrub } from '../lib/opencode.mjs';
import { attributes, pairs, post } from '../lib/otlp.mjs';
import { encoded } from './otlp-protobuf.mjs';

const SIGNALS = Object.freeze({ '/v1/traces': 'traces', '/v1/logs': 'logs' });

const RESOURCE_KEYS = Object.freeze(['resourceSpans', 'resourceLogs']);

const SERVICE = 'ksai';

const CONTENT_TYPE = 'application/x-protobuf';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const MAX_POSTS = 512;

const MAX_RESOURCES = 64;

const MAX_RECORDS = 10_000;

const MAX_ELEMENTS = 100_000;

const MAX_DEPTH = 8;

const MAX_IN_FLIGHT = 8;

const MAX_VALUE_BYTES = 1024;

const INFO = 9;

const SEVERITIES = Object.freeze({
  SEVERITY_NUMBER_UNSPECIFIED: 0,
  SEVERITY_NUMBER_TRACE: 1,
  SEVERITY_NUMBER_DEBUG: 5,
  SEVERITY_NUMBER_INFO: 9,
  SEVERITY_NUMBER_WARN: 13,
  SEVERITY_NUMBER_ERROR: 17,
  SEVERITY_NUMBER_FATAL: 21,
});

const STORE_SPAN = 'db.system.name';

const DRAIN_MS = 10_000;

/**
 * target answers where an export goes and what authenticates it, and null wherever telemetry is off.
 *
 * The auth header is the switch, exactly as it is for the metrics this fleet already exports: an
 * endpoint with no key reaches an intake that refuses it, so the pair is read as one value.
 */
export function target(env = process.env) {
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    .trim()
    .replace(/\/+$/, '');
  const auth = String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').trim();
  if (!endpoint || !auth) return null;
  return { endpoint, headers: Object.fromEntries(pairs(auth)) };
}

/**
 * runAttributes names the run a record belongs to, and the trusted side is the only thing that names it.
 *
 * The same values are handed to the agent as `OTEL_RESOURCE_ATTRIBUTES` so its own exporter stamps
 * them, and that is a convenience rather than the guarantee. `service.name` is here because Datadog
 * routes on it: a sandbox that could name it could write an ERROR log into any service in the org.
 */
export function runAttributes(env = process.env) {
  const named = new Map();
  for (const [key, value] of pairs(env.OTEL_RESOURCE_ATTRIBUTES)) named.set(key, value);
  if (!named.has('service.name')) named.set('service.name', SERVICE);
  for (const [key, value] of [
    ['repo', env.GITHUB_REPOSITORY],
    ['engine', 'opencode'],
    ['flow', env.FLOW],
    ['model', env.MODEL],
    ['effort', env.VARIANT],
    ['run', env.GITHUB_RUN_ID],
    ['attempt', env.GITHUB_RUN_ATTEMPT],
  ]) {
    named.set(key, String(value ?? '').trim());
  }
  return [...named].filter(([, value]) => String(value ?? '').trim() !== '');
}

/**
 * stamped answers the payload with every resource replaced by the attributes the trusted side named.
 *
 * The replacement is whole rather than a merge. Keeping what the payload also carried would keep
 * `service.name`, `host.name`, `deployment.environment`, `ddsource` and `ddtags` - the keys that
 * decide which service, host and environment a record lands in - and on `flow: test` the reviewed
 * pull request's own code runs inside the sandbox that writes them. A body this cannot read answers
 * null, because an untagged record cannot be attributed to a repository, an engine or a run.
 *
 * A payload naming more resources than a batch can carry answers null before any of them is written.
 * The attributes go into every entry, so four hundred thousand empty ones in a 1.2 mebibyte body
 * became seventy-three mebibytes on the wire and ten seconds of the loop this relay answers from.
 */
export function stamped(body, named) {
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (RESOURCE_KEYS.some((key) => Array.isArray(payload[key]) && payload[key].length > MAX_RESOURCES)) return null;
  const list = attributes(named);
  let resources = 0;
  for (const key of RESOURCE_KEYS) {
    const group = payload[key];
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') continue;
      entry.resource = { attributes: list };
      resources += 1;
    }
  }
  return resources > 0 ? payload : null;
}

const storeSpan = (span) => (span?.attributes ?? []).some((one) => one?.key === STORE_SPAN);

/**
 * elements answers how many pieces a payload is made of, and stops counting once that is too many.
 *
 * Every later step is linear in this number and two of them are string passes over the whole
 * payload, so it is the one measure that bounds both what the encoder produces and what the loop
 * this relay answers from spends producing it. A record ceiling does not: one span carrying a
 * million empty links gzips 970 to 1, so three kilobytes on the wire bought two megabytes of
 * protobuf and 1.4 seconds of a loop that also owns the bearer renewal and the review's deadline.
 *
 * **Past the depth limit it answers over the ceiling rather than nothing**, or a nest eight deep
 * hides whatever it holds from the count and the encoder walks it anyway. **Every member counts,
 * not only an array's length**, or a payload of a hundred thousand scalar keys is a payload this
 * measures at zero.
 */
function elements(value, depth = 0) {
  if (!value || typeof value !== 'object') return 0;
  if (depth > MAX_DEPTH) return MAX_ELEMENTS + 1;
  let counted = 0;
  for (const held of Object.values(value)) {
    counted += 1;
    if (Array.isArray(held)) {
      counted += held.length;
      for (const one of held) {
        if (counted > MAX_ELEMENTS) return counted;
        counted += elements(one, depth + 1);
      }
    } else if (held && typeof held === 'object') {
      counted += elements(held, depth + 1);
    }
    if (counted > MAX_ELEMENTS) return counted;
  }
  return counted;
}

const asArray = (held) => (Array.isArray(held) ? held : []);

const severityOf = (record) => {
  const named = record?.severityNumber ?? record?.severity_number;
  if (typeof named === 'string') return SEVERITIES[named] ?? INFO;
  return named === undefined || named === null ? INFO : Number(named);
};

/**
 * bounded answers the records this fleet exports, and drops the ones it does not.
 *
 * A record below `INFO`, which is where a CLI logs payloads, never leaves the runner: what a tool
 * call did and how it failed is the signal, and the prompt, the file and the tool result are not
 * telemetry. The length of what does leave is bounded in the encoder instead, because that is the
 * one place every exported string passes through - enumerating fields here left `span.name`,
 * `status.message` and an exception event's stack trace carrying whatever the agent logged.
 *
 * The agent's own store is not the review either: a trivial session emitted 512 spans of which all
 * but a handful were its SQLite, which answers nothing anybody asks after a slow review and is
 * volume Datadog bills for.
 */
export function bounded(payload) {
  if (elements(payload) > MAX_ELEMENTS) return null;
  let kept = 0;
  for (const group of asArray(payload.resourceSpans)) {
    for (const scope of asArray(group?.scopeSpans)) {
      scope.spans = asArray(scope?.spans).filter((span) => !storeSpan(span));
      kept += scope.spans.length;
    }
  }
  for (const group of asArray(payload.resourceLogs)) {
    for (const scope of asArray(group?.scopeLogs)) {
      scope.logRecords = asArray(scope?.logRecords).filter((record) => severityOf(record) >= INFO);
      kept += scope.logRecords.length;
    }
  }
  return kept > 0 && kept <= MAX_RECORDS ? payload : null;
}

/**
 * prepared answers the bytes one export is forwarded as, or null for one that is not forwarded.
 *
 * The run's secrets are redacted over the serialised payload, as the uploaded event stream already
 * is, and the redaction therefore covers the attributes as well as the records.
 */
/**
 * read answers at most `ceiling` bytes of an export's body, decompressing one that arrived compressed.
 *
 * **The ceiling is on what comes out, never on what came in.** Node's `maxOutputLength` is the whole
 * reason this is safe: a three-megabyte gzip inside `MAX_BODY_BYTES` inflates to a gigabyte, and
 * this decompresses inside the process that owns the review - measured at 5.3 GiB resident and a
 * 1.4 second stall of the loop the relay itself answers from. The caps are charged on the decoded
 * length for the same reason: counting the compressed bytes let one accepted post forward fifty-six
 * mebibytes against a thirty-two mebibyte budget.
 */
export function read(chunks, encoding, ceiling = MAX_BODY_BYTES) {
  const bytes = Buffer.concat(chunks);
  const named = String(encoding ?? '')
    .trim()
    .toLowerCase();
  if (named === '' || named === 'identity') return bytes.length > ceiling ? '' : bytes.toString('utf8');
  try {
    if (named === 'gzip') return gunzipSync(bytes, { maxOutputLength: ceiling }).toString('utf8');
    if (named === 'deflate') return inflateSync(bytes, { maxOutputLength: ceiling }).toString('utf8');
  } catch {
    return '';
  }
  return '';
}

export function prepared({ signal, body, named, secrets }) {
  try {
    const stampedPayload = stamped(body, named);
    if (!stampedPayload) return null;
    const payload = bounded(stampedPayload);
    if (!payload) return null;
    return encoded(signal, JSON.parse(scrub(JSON.stringify(payload), secrets)), MAX_VALUE_BYTES);
  } catch {
    return null;
  }
}

/**
 * startRelay listens on loopback for the agent's own OTLP exports and forwards them with the key.
 *
 * The sandbox may not hold the Datadog credential, so the CLI is pointed at this server instead of
 * at the intake, and the key stays in the parent process the sandbox has no view of. Every export
 * is answered before it is forwarded, so a slow or refused intake costs the review no time and no
 * outcome, and what a run may forward is bounded **by what leaves rather than by what arrived**: on
 * `flow: test` the reviewed pull request's own code reaches this port, Datadog bills what arrives,
 * and a small body can name a large export. What arrived is counted too, but only as a rate.
 */
export async function startRelay({ env = process.env, fetchImpl = fetch, say = console.log } = {}) {
  const where = target(env);
  if (!where) return null;
  const secrets = collectSecrets(env);
  const named = runAttributes(env);
  const counts = { forwarded: 0, dropped: 0, refused: 0, bytes: 0, sent: 0, posts: 0 };
  const flight = new Set();

  const forward = async (signal, body) => {
    const outcome = await post({
      endpoint: where.endpoint,
      signal,
      headers: where.headers,
      contentType: CONTENT_TYPE,
      body,
      fetchImpl,
    });
    if (outcome.ok) counts.forwarded += 1;
    else {
      counts.refused += 1;
      if (counts.refused === 1) {
        say(`::warning::the ${signal} this run exported were refused by ${where.endpoint}: ${outcome.said}`);
      }
    }
  };

  const server = createServer((request, response) => {
    const signal = SIGNALS[String(request.url ?? '').split('?')[0]];
    if (request.method !== 'POST' || !signal) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const give = () => {
      if (settled) return false;
      settled = true;
      counts.dropped += 1;
      return true;
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      /* A body past the cap is refused where it is read, or a chunked one streams for as long as
         the peer keeps it open and the cap bounds nothing. */
      if (give()) {
        counts.bytes += size;
        counts.posts += 1;
        /* The body is refused unread, so the connection cannot be reused: an exporter that keeps
           it alive would send its next export down a socket this one is about to destroy. */
        response.writeHead(413, { connection: 'close' }).end();
        request.destroy();
      }
    });
    request.on('error', () => {
      give();
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      try {
        const text = read(chunks, request.headers['content-encoding']);
        counts.bytes += size;
        counts.posts += 1;
        if (!text || flight.size >= MAX_IN_FLIGHT || counts.bytes > MAX_TOTAL_BYTES || counts.posts > MAX_POSTS) {
          counts.dropped += 1;
          return;
        }
        const body = prepared({ signal, body: text, named, secrets });
        if (!body || body.length > MAX_BODY_BYTES || counts.sent + body.length > MAX_TOTAL_BYTES) {
          counts.dropped += 1;
          return;
        }

        counts.sent += body.length;
        const sending = forward(signal, body)
          .catch(() => {
            counts.refused += 1;
          })
          .finally(() => flight.delete(sending));
        flight.add(sending);
      } catch {
        counts.dropped += 1;
      }
    });
  });

  await new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready(null));
  });
  server.unref();
  const bound = server.address();
  const port = bound && typeof bound === 'object' ? bound.port : 0;
  if (!port) {
    server.close();
    say('::warning::the telemetry relay took no port, so this run exports no trace and no log line');
    return null;
  }
  const url = `http://127.0.0.1:${port}`;
  say(`telemetry relayed from ${url} to ${where.endpoint}`);

  const close = async () => {
    const deadline = Date.now() + DRAIN_MS;
    while (flight.size > 0 && Date.now() < deadline) {
      let waiting = null;
      await Promise.race([
        Promise.allSettled(flight),
        new Promise((done) => {
          waiting = setTimeout(() => done(null), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (waiting) clearTimeout(waiting);
    }
    server.close();
    server.closeAllConnections?.();
    const lost = counts.dropped + counts.refused + flight.size;
    if (lost > 0) {
      say(
        `::warning::${lost} of this run's telemetry exports did not reach ${where.endpoint}, which changes nothing about the review or what it reports spending`,
      );
    }
    say(
      `telemetry: forwarded=${counts.forwarded} dropped=${counts.dropped} refused=${counts.refused} in-flight=${flight.size}`,
    );
    return { ...counts, in_flight: flight.size };
  };

  return { url, close, counts };
}
