import { canonical, digest, record } from '../governance/artifacts.mjs';
import { MAX_RESPONSE_BYTES } from '../governance/conversation.mjs';

export const COUNTERS = 'invocation-calls-v1';

export const PAIRS_MOST = 256;

export const MODELS_MOST = 64;

export const TOKENS_MOST = 10_000_000_000;

const FIELDS = Object.freeze({ input: 'input_tokens', output: 'output_tokens', cache_read: 'cache_read_input_tokens', cache_write: 'cache_creation_input_tokens' });

const NAMES = Object.freeze(Object.keys(FIELDS));

const zero = () => Object.fromEntries(NAMES.map((name) => [name, 0]));

function reported(usage, where) {
  if (usage === undefined || usage === null) return {};
  const held = record(usage, `the ${where} usage`);
  const out = {};
  for (const name of NAMES) {
    const value = held[FIELDS[name]];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`the ${where} usage names ${FIELDS[name]} that is not a token count`);
    out[name] = value;
  }
  return out;
}

function* framesOf(bytes) {
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('the answer is oversized');
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const held = raw.includes('\r\n') ? Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1') : raw;
  let from = 0;
  for (let at = held.indexOf('\n\n'); at >= 0; at = held.indexOf('\n\n', from)) {
    yield held.subarray(from, at);
    from = at + 2;
  }
}

function eventOf(frame) {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(frame).split('\n');
  if (lines.length !== 2 || !lines[0].startsWith('event: ') || !lines[1].startsWith('data: ')) throw new Error('the answer has an unsupported event frame');
  const event = record(JSON.parse(lines[1].slice(6)), 'the answer event');
  if (event.type !== lines[0].slice(7)) throw new Error('the answer event name does not match its data');
  return event;
}

function indexOf(event, name) {
  if (!Number.isSafeInteger(event.index) || event.index < 0) throw new Error(`${name} names no content block index`);
  return event.index;
}

function grammar() {
  let state = 'initial';
  const started = new Set();
  const open = new Set();
  let last = -1;
  return (event) => {
    const out = (why) => {
      throw new Error(`${event.type} ${why}`);
    };
    const named = () => {
      if (state !== 'content' || !started.has(indexOf(event, event.type))) out('names no started content block');
      return event.index;
    };
    switch (event.type) {
      case 'message_start':
        if (state !== 'initial') out('is out of sequence');
        state = 'content';
        return;
      case 'ping':
        if (state === 'initial' || state === 'stopped') out('is out of sequence');
        return;
      case 'content_block_start': {
        if (state !== 'content') out('is out of sequence');
        record(event.content_block, 'the content block');
        const index = indexOf(event, event.type);
        if (index <= last) out('does not raise the content block index');
        started.add(index);
        open.add(index);
        last = index;
        return;
      }
      case 'content_block_delta':
        named();
        record(event.delta, 'the content block delta');
        return;
      case 'content_block_stop':
        open.delete(named());
        return;
      case 'message_delta':
        if (state !== 'content' || open.size) out('is out of sequence');
        record(event.delta, 'the message_delta payload');
        state = 'delta';
        return;
      case 'message_stop':
        if (state !== 'delta') out('is out of sequence');
        state = 'stopped';
        return;
      default:
        out('is not an event the provider sends');
    }
  };
}

export function callUsage({ status, bytes, model }) {
  if (!Number.isInteger(status) || status < 200 || status > 299) return { usage: zero(), ended: 'status' };
  const usage = zero();
  const raise = (seen) => {
    for (const [name, value] of Object.entries(seen)) usage[name] = Math.max(usage[name], value);
  };
  const follows = grammar();
  let stopped = false;
  try {
    for (const frame of framesOf(bytes)) {
      const event = eventOf(frame);
      if (stopped) throw new Error(`${event.type} follows message_stop`);
      if (event.type === 'error') {
        record(event.error, 'the upstream error');
        return { usage, ended: 'error' };
      }
      follows(event);
      if (event.type === 'message_start') {
        const message = record(event.message, 'the message_start message');
        if (message.model !== model) throw new Error(`the answer is from ${String(message.model)}, and ${model} was asked`);
        raise(reported(message.usage, 'message_start'));
      }
      if (event.type === 'message_delta') raise(reported(event.usage, 'message_delta'));
      if (event.type === 'message_stop') stopped = true;
    }
  } catch (error) {
    return { usage, ended: 'refused', reason: String(error?.message ?? error) };
  }
  return { usage, ended: stopped ? 'complete' : 'cut' };
}

const TALLIES = Object.freeze([...NAMES, 'calls', 'incomplete', 'refused']);

export function savedSnapshot(value) {
  const held = record(value, 'a saved usage snapshot');
  if (typeof held.session !== 'string' || !held.session || typeof held.model !== 'string' || !held.model || Object.keys(held).length !== TALLIES.length + 2) {
    throw new Error('a saved usage snapshot names no session and model');
  }
  for (const name of TALLIES) {
    if (!Number.isSafeInteger(held[name]) || held[name] < 0) throw new Error(`the saved usage of ${held.session} on ${held.model} holds no ${name} count`);
  }
  return { ...held };
}

export function usageCounter(saved = []) {
  const pairs = new Map(saved.map((one) => {
    const held = savedSnapshot(one);
    return [canonical([held.session, held.model]), held];
  }));
  if (pairs.size !== saved.length) throw new Error('the saved usage names one session and model twice');
  return {
    add(session, model, call) {
      if (call.ended === 'status') return;
      const key = canonical([session, model]);
      const held = pairs.get(key) ?? { session, model, ...zero(), calls: 0, incomplete: 0, refused: 0 };
      const next = { ...held };
      for (const name of NAMES) {
        next[name] = held[name] + call.usage[name];
        if (!Number.isSafeInteger(next[name])) throw new Error(`${name} of ${session} on ${model} would pass the largest exact count`);
        if (next[name] > TOKENS_MOST) throw new Error(`${name} of ${session} on ${model} would pass the ${TOKENS_MOST} tokens a source counts`);
        const whole = [...pairs.values()].reduce((sum, one) => sum + one[name], 0) - held[name] + next[name];
        if (whole > TOKENS_MOST) throw new Error(`${name} of the run would pass the ${TOKENS_MOST} tokens a source counts`);
      }
      next.calls += 1;
      if (call.ended === 'cut' || call.ended === 'error') next.incomplete += 1;
      if (call.ended === 'refused') next.refused += 1;
      pairs.set(key, next);
    },
    admits(session, model) {
      if (pairs.has(canonical([session, model]))) return '';
      if (pairs.size >= PAIRS_MOST) return `a source counts at most ${PAIRS_MOST} session and model pairs`;
      const models = new Set([...pairs.values()].map((one) => one.model));
      return !models.has(model) && models.size >= MODELS_MOST ? `a source counts at most ${MODELS_MOST} models` : '';
    },
    snapshots: () => [...pairs.values()].map((one) => ({ ...one })),
  };
}

export function usageEvent(source, snapshot) {
  const { session, model } = snapshot;
  const counted = NAMES.map((name) => snapshot[name]);
  return {
    id: `u1-${digest(canonical([source, session, model, ...counted])).slice(7, 39)}`,
    kind: 'usage',
    usage: { session, model, ...Object.fromEntries(NAMES.map((name, index) => [name, counted[index]])) },
  };
}
