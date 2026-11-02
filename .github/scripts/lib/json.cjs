'use strict';

const WHITESPACE = /[ \t\r\n]/;
const opaqueNone = (_path) => false;

const at = (source, index, message) => new Error(`${message} at byte ${Buffer.byteLength(source.slice(0, index))}`);

class Reader {
  constructor(source, opaque = opaqueNone, deferTyped = false) {
    this.source = source;
    this.index = 0;
    this.opaque = opaque;
    this.deferTyped = deferTyped;
    this.violation = null;
  }

  rejectTyped(index, message) {
    if (this.deferTyped && this.violation) return;
    const error = at(this.source, index, message);
    if (!this.deferTyped) throw error;
    this.violation ??= error;
  }

  space() {
    while (WHITESPACE.test(this.source[this.index] ?? '')) this.index += 1;
  }

  value(path = [], strict = true) {
    this.space();
    const typed = strict && !this.opaque(path);
    const token = this.source[this.index];
    if (token === '{') return this.object(path, typed);
    if (token === '[') return this.array(path, typed);
    if (token === '"') return this.string(typed);
    if (this.source.startsWith('true', this.index)) return this.literal('true', true);
    if (this.source.startsWith('false', this.index)) return this.literal('false', false);
    if (this.source.startsWith('null', this.index)) return this.literal('null', null);
    return this.number(typed);
  }

  literal(token, value) {
    this.index += token.length;
    return value;
  }

  string(strict) {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (token === '"') {
        this.index += 1;
        const value = JSON.parse(this.source.slice(start, this.index));
        if (strict && hasLoneSurrogate(value)) this.rejectTyped(start, 'lone Unicode surrogate');
        return value;
      }
      if (token === '\\') {
        this.index += 1;
        if (this.source[this.index] === 'u') this.index += 4;
      }
      this.index += 1;
    }
    throw at(this.source, start, 'unterminated JSON string');
  }

  number(strict) {
    const source = this.source.slice(this.index);
    const matched = source.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!matched) throw at(this.source, this.index, 'invalid JSON value');
    const token = matched[0];
    this.index += token.length;
    const value = Number(token);
    if (strict && (!Number.isFinite(value) || Object.is(value, -0))) this.rejectTyped(this.index, 'non-I-JSON number');
    if (strict && !/[.eE]/.test(token) && !Number.isSafeInteger(value)) this.rejectTyped(this.index, 'integer outside I-JSON range');
    return value;
  }

  array(path, strict) {
    const value = [];
    this.index += 1;
    this.space();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value([...path, value.length], strict));
      this.space();
      const token = this.source[this.index];
      this.index += 1;
      if (token === ']') return value;
      if (token !== ',') throw at(this.source, this.index - 1, 'JSON array needs a comma or closing bracket');
    }
  }

  object(path, strict) {
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
      const key = this.string(strict);
      if (strict && keys.has(key)) this.rejectTyped(this.index, `duplicate JSON key ${JSON.stringify(key)}`);
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ':') throw at(this.source, this.index, 'JSON object key needs a colon');
      this.index += 1;
      value[key] = this.value([...path, key], strict);
      this.space();
      const token = this.source[this.index];
      this.index += 1;
      if (token === '}') return value;
      if (token !== ',') throw at(this.source, this.index - 1, 'JSON object needs a comma or closing bracket');
    }
  }
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code >= 0xD800 && code <= 0xDFFF) return true;
    if (code > 0xFFFF) index += 1;
  }
  return false;
}

function parseIJson(bytes, source = 'JSON', { opaque = opaqueNone, strictWhen = null } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${source} is not UTF-8`);
  }
  const reader = new Reader(text, opaque, typeof strictWhen === 'function');
  let value;
  try {
    value = reader.value();
    reader.space();
    if (reader.index !== text.length) throw at(text, reader.index, 'trailing JSON bytes');
    if (reader.violation && strictWhen(value)) throw reader.violation;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${detail}`, { cause: error });
  }
  return value;
}

/** Encode an I-JSON value using RFC 8785 member ordering. */
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((held) => canonicalJson(held)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('value is not I-JSON');
}

module.exports = { canonicalJson, parseIJson };
