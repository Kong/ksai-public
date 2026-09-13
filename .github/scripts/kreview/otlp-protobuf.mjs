const EMPTY = Buffer.alloc(0);

const VARINT = 0;

const FIXED64 = 1;

const DELIMITED = 2;

const FIXED32 = 5;

const TRACE_ID_BYTES = 16;

const SPAN_ID_BYTES = 8;

const MAX_VALUE_BYTES = 1024;

const TRUNCATED = Buffer.from('… truncated', 'utf8');

const INT64_MAX = 2n ** 63n - 1n;

const INT64_MIN = -(2n ** 63n);

const SPAN_KIND = Object.freeze({
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
});

const STATUS_CODE = Object.freeze({
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
});

const SEVERITY_NUMBER = Object.freeze({
  SEVERITY_NUMBER_UNSPECIFIED: 0,
  SEVERITY_NUMBER_TRACE: 1,
  SEVERITY_NUMBER_DEBUG: 5,
  SEVERITY_NUMBER_INFO: 9,
  SEVERITY_NUMBER_WARN: 13,
  SEVERITY_NUMBER_ERROR: 17,
  SEVERITY_NUMBER_FATAL: 21,
});

/**
 * ANY_VALUE is the one message whose fields are written even at their default value.
 *
 * They are a protobuf `oneof`, which has explicit presence: `boolValue: false` is field 2 set to
 * zero and not an absent field. Omitting it loses every `false`, `0` and `""` an agent recorded -
 * which are the states that most often explain a review that went wrong.
 */
const ANY_VALUE = () => ({
  stringValue: [1, 'string', null, true],
  boolValue: [2, 'bool', null, true],
  intValue: [3, 'varint', null, true],
  doubleValue: [4, 'double', null, true],
  arrayValue: [5, 'message', ARRAY_VALUE, true],
  kvlistValue: [6, 'message', KEY_VALUE_LIST, true],
});

const ARRAY_VALUE = () => ({ values: [1, 'repeated', ANY_VALUE] });

const KEY_VALUE_LIST = () => ({ values: [1, 'repeated', KEY_VALUE] });

const KEY_VALUE = () => ({ key: [1, 'string'], value: [2, 'message', ANY_VALUE] });

const SCOPE = () => ({
  name: [1, 'string'],
  version: [2, 'string'],
  attributes: [3, 'repeated', KEY_VALUE],
  droppedAttributesCount: [4, 'uint32'],
});

const RESOURCE = () => ({ attributes: [1, 'repeated', KEY_VALUE], droppedAttributesCount: [2, 'uint32'] });

const STATUS = () => ({ message: [2, 'string'], code: [3, 'enum', STATUS_CODE] });

const SPAN_EVENT = () => ({
  timeUnixNano: [1, 'fixed64'],
  name: [2, 'string'],
  attributes: [3, 'repeated', KEY_VALUE],
  droppedAttributesCount: [4, 'uint32'],
});

const SPAN_LINK = () => ({
  traceId: [1, 'hex', TRACE_ID_BYTES],
  spanId: [2, 'hex', SPAN_ID_BYTES],
  traceState: [3, 'string'],
  attributes: [4, 'repeated', KEY_VALUE],
  droppedAttributesCount: [5, 'uint32'],
  flags: [6, 'fixed32'],
});

const SPAN = () => ({
  traceId: [1, 'hex', TRACE_ID_BYTES],
  spanId: [2, 'hex', SPAN_ID_BYTES],
  traceState: [3, 'string'],
  parentSpanId: [4, 'hex', SPAN_ID_BYTES],
  name: [5, 'string'],
  kind: [6, 'enum', SPAN_KIND],
  startTimeUnixNano: [7, 'fixed64'],
  endTimeUnixNano: [8, 'fixed64'],
  attributes: [9, 'repeated', KEY_VALUE],
  droppedAttributesCount: [10, 'uint32'],
  events: [11, 'repeated', SPAN_EVENT],
  droppedEventsCount: [12, 'uint32'],
  links: [13, 'repeated', SPAN_LINK],
  droppedLinksCount: [14, 'uint32'],
  status: [15, 'message', STATUS],
  flags: [16, 'fixed32'],
});

const SCOPE_SPANS = () => ({
  scope: [1, 'message', SCOPE],
  spans: [2, 'repeated', SPAN],
  schemaUrl: [3, 'string'],
});

const RESOURCE_SPANS = () => ({
  resource: [1, 'message', RESOURCE],
  scopeSpans: [2, 'repeated', SCOPE_SPANS],
  schemaUrl: [3, 'string'],
});

const LOG_RECORD = () => ({
  timeUnixNano: [1, 'fixed64'],
  severityNumber: [2, 'enum', SEVERITY_NUMBER],
  severityText: [3, 'string'],
  body: [5, 'message', ANY_VALUE],
  attributes: [6, 'repeated', KEY_VALUE],
  droppedAttributesCount: [7, 'uint32'],
  flags: [8, 'fixed32'],
  traceId: [9, 'hex', TRACE_ID_BYTES],
  spanId: [10, 'hex', SPAN_ID_BYTES],
  observedTimeUnixNano: [11, 'fixed64'],
  eventName: [12, 'string'],
});

const SCOPE_LOGS = () => ({
  scope: [1, 'message', SCOPE],
  logRecords: [2, 'repeated', LOG_RECORD],
  schemaUrl: [3, 'string'],
});

const RESOURCE_LOGS = () => ({
  resource: [1, 'message', RESOURCE],
  scopeLogs: [2, 'repeated', SCOPE_LOGS],
  schemaUrl: [3, 'string'],
});

const REQUESTS = Object.freeze({
  traces: () => ({ resourceSpans: [1, 'repeated', RESOURCE_SPANS] }),
  logs: () => ({ resourceLogs: [1, 'repeated', RESOURCE_LOGS] }),
});

const snake = (key) => key.replaceAll(/[A-Z]/g, (one) => `_${one.toLowerCase()}`);

function held(value, key) {
  if (Object.hasOwn(value, key)) return value[key];
  const other = snake(key);
  return Object.hasOwn(value, other) ? value[other] : undefined;
}

function varint(value) {
  let left = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const byte = Number(left & 0x7fn);
    left >>= 7n;
    bytes.push(left > 0n ? byte | 0x80 : byte);
  } while (left > 0n);
  return Buffer.from(bytes);
}

const key = (number, wire) => varint((number << 3) | wire);

const entry = (number, bytes) => Buffer.concat([key(number, DELIMITED), varint(bytes.length), bytes]);

const delimited = (number, bytes) => (bytes.length === 0 ? EMPTY : entry(number, bytes));

/**
 * capped answers at most `ceiling` bytes of UTF-8, cut on a code point rather than in the middle of one.
 *
 * The ceiling is bytes and not characters: counting string indices let one CJK or emoji value reach
 * four kibibytes on a one-kibibyte ceiling. Cutting between the bytes of a code point would put a
 * lone continuation byte on the wire, which a strict receiver refuses.
 */
function capped(text, ceiling) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ceiling) return bytes;
  const marked = ceiling > TRUNCATED.length;
  let at = marked ? ceiling - TRUNCATED.length : ceiling;
  while (at > 0 && (bytes[at] & 0xc0) === 0x80) at -= 1;
  return marked ? Buffer.concat([bytes.subarray(0, at), TRUNCATED]) : bytes.subarray(0, at);
}

function scalar(number, kind, value, detail, explicit, ceiling) {
  if (kind === 'string') {
    const bytes = capped(String(value), ceiling);
    return bytes.length === 0 ? (explicit ? entry(number, EMPTY) : EMPTY) : delimited(number, bytes);
  }
  if (kind === 'hex') {
    const text = String(value);
    if (!new RegExp(`^[\\da-f]{${detail * 2}}$`, 'i').test(text)) return EMPTY;
    return delimited(number, Buffer.from(text, 'hex'));
  }
  if (kind === 'bool') {
    return value || explicit ? Buffer.concat([key(number, VARINT), varint(value ? 1 : 0)]) : EMPTY;
  }
  if (kind === 'enum') {
    const named = typeof value === 'string' ? (detail?.[value] ?? 0) : Number(value);
    if (!Number.isFinite(named) || named === 0) return EMPTY;
    return Buffer.concat([key(number, VARINT), varint(Math.trunc(named))]);
  }
  if (kind === 'uint32') {
    const at = Number(value);
    if (!Number.isFinite(at) || Math.trunc(at) === 0) return EMPTY;
    return Buffer.concat([key(number, VARINT), varint(BigInt.asUintN(32, BigInt(Math.trunc(at))))]);
  }
  if (kind === 'varint') {
    let at = 0n;
    try {
      at = BigInt(value);
    } catch {
      return EMPTY;
    }
    if (at > INT64_MAX || at < INT64_MIN) return EMPTY;
    if (at === 0n && !explicit) return EMPTY;
    return Buffer.concat([key(number, VARINT), varint(at)]);
  }
  if (kind === 'fixed64') {
    let at = 0n;
    try {
      at = BigInt.asUintN(64, BigInt(value));
    } catch {
      return EMPTY;
    }
    if (at === 0n) return EMPTY;
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(at);
    return Buffer.concat([key(number, FIXED64), bytes]);
  }
  if (kind === 'fixed32') {
    const at = Number(value);
    if (!Number.isFinite(at) || at === 0) return EMPTY;
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(at >>> 0);
    return Buffer.concat([key(number, FIXED32), bytes]);
  }
  if (kind === 'double') {
    const at = Number(value);
    if (!Number.isFinite(at) || (at === 0 && !explicit)) return EMPTY;
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(at);
    return Buffer.concat([key(number, FIXED64), bytes]);
  }
  return EMPTY;
}

function encode(value, schema, ceiling) {
  if (!value || typeof value !== 'object') return EMPTY;
  const parts = [];
  for (const [name, spec] of Object.entries(schema())) {
    const [number, kind, detail, explicit] = spec;
    const found = held(value, name);
    if (found === undefined || found === null) continue;
    if (kind === 'repeated') {
      if (!Array.isArray(found)) continue;
      for (const one of found) parts.push(entry(number, encode(one, detail, ceiling)));
      continue;
    }
    if (kind === 'message') {
      const nested = encode(found, detail, ceiling);
      parts.push(explicit ? entry(number, nested) : delimited(number, nested));
      continue;
    }
    parts.push(scalar(number, kind, found, detail, explicit, ceiling));
  }
  return Buffer.concat(parts);
}

/**
 * encoded answers an OTLP/JSON payload as the protobuf the direct intake documents, or null.
 *
 * The CLI serialises JSON and Datadog's OTLP logs intake documents `http/protobuf` alone, so the
 * relay is where the two meet. Protobuf is the OTLP specification's required encoding and JSON its
 * optional one, so both signals are sent this way rather than only the one that has to be: a
 * backend that takes one takes the other, and one path is one thing to be wrong about.
 *
 * `AnyValue.bytesValue` is deliberately absent from the schema, so a binary value is dropped rather
 * than forwarded. The secret scrub runs over the JSON text, where that field is base64 - a secret
 * wrapped in it would pass the literal replacement and be decoded back to raw bytes on the way out.
 * A value this cannot read is a value it cannot vouch for, and none has appeared in any capture.
 *
 * A field this schema does not name is dropped rather than guessed at, and a value equal to its
 * proto3 default is omitted - except inside `AnyValue`, whose fields are a `oneof` and have
 * explicit presence. **Every string written carries a ceiling, and this is the only place one is
 * applied**: bounding a list of fields somebody enumerated left `span.name`, `status.message`, an
 * event attribute and six others carrying whatever length the agent logged them at.
 */
export function encoded(signal, payload, ceiling = MAX_VALUE_BYTES) {
  const schema = REQUESTS[signal];
  if (!schema || !payload || typeof payload !== 'object') return null;
  const bytes = encode(payload, schema, ceiling);
  return bytes.length > 0 ? bytes : null;
}
