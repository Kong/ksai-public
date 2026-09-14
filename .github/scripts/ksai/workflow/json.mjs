const WHITESPACE = /[ \t\r\n]/;

const at = (source, index, message) => new Error(`${message} at byte ${Buffer.byteLength(source.slice(0, index))}`);

class Reader {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  space() {
    while (WHITESPACE.test(this.source[this.index] ?? '')) this.index += 1;
  }

  value() {
    this.space();
    const token = this.source[this.index];
    if (token === '{') return this.object();
    if (token === '[') return this.array();
    if (token === '"') return this.string();
    if (this.source.startsWith('true', this.index)) return this.literal('true', true);
    if (this.source.startsWith('false', this.index)) return this.literal('false', false);
    if (this.source.startsWith('null', this.index)) return this.literal('null', null);
    return this.number();
  }

  literal(token, value) {
    this.index += token.length;
    return value;
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (token === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index));
      }
      if (token === '\\') {
        this.index += 1;
        if (this.source[this.index] === 'u') this.index += 4;
      }
      this.index += 1;
    }
    throw at(this.source, start, 'unterminated JSON string');
  }

  number() {
    const source = this.source.slice(this.index);
    const matched = source.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!matched) throw at(this.source, this.index, 'invalid JSON value');
    const token = matched[0];
    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value) || Object.is(value, -0)) throw at(this.source, this.index, 'non-I-JSON number');
    if (!/[.eE]/.test(token) && !Number.isSafeInteger(value)) throw at(this.source, this.index, 'integer outside I-JSON range');
    return value;
  }

  array() {
    const value = [];
    this.index += 1;
    this.space();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value());
      this.space();
      const token = this.source[this.index];
      this.index += 1;
      if (token === ']') return value;
      if (token !== ',') throw at(this.source, this.index - 1, 'JSON array needs a comma or closing bracket');
    }
  }

  object() {
    const value = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.space();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return value;
    }
    for (;;) {
      this.space();
      if (this.source[this.index] !== '"') throw at(this.source, this.index, 'JSON object key is not a string');
      const key = this.string();
      if (keys.has(key)) throw at(this.source, this.index, `duplicate JSON key ${JSON.stringify(key)}`);
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ':') throw at(this.source, this.index, 'JSON object key needs a colon');
      this.index += 1;
      value[key] = this.value();
      this.space();
      const token = this.source[this.index];
      this.index += 1;
      if (token === '}') return value;
      if (token !== ',') throw at(this.source, this.index - 1, 'JSON object needs a comma or closing bracket');
    }
  }
}

function hasLoneSurrogate(value) {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.codePointAt(index);
      if (code >= 0xD800 && code <= 0xDFFF) return true;
      if (code > 0xFFFF) index += 1;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((held) => hasLoneSurrogate(held));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, held]) => hasLoneSurrogate(key) || hasLoneSurrogate(held));
  }
  return false;
}

/** Parse one strict UTF-8 I-JSON value, retaining duplicate-key refusal. */
export function parseIJson(bytes, source = 'JSON') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${source} is not UTF-8`);
  }
  const reader = new Reader(text);
  let value;
  try {
    value = reader.value();
    reader.space();
    if (reader.index !== text.length) throw at(text, reader.index, 'trailing JSON bytes');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${detail}`, { cause: error });
  }
  if (hasLoneSurrogate(value)) throw new Error(`${source} contains a lone Unicode surrogate`);
  return value;
}

/** Encode an I-JSON value using RFC 8785 member ordering. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((held) => canonicalJson(held)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('value is not I-JSON');
}
