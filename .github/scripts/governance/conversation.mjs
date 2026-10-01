import { canonical, digest, historyDigest, record } from './artifacts.mjs';

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const MAX_STEPS = 256;

export class CarryRefused extends Error {}

export function boundedSteps(steps, name) {
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_STEPS) throw new Error(`${name} is not a step limit from 1 to ${MAX_STEPS}`);
  return steps;
}

export function reminderText(body) {
  const lines = JSON.parse(body.toString('utf8'))?.text_lines;
  if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line !== 'string')) {
    throw new Error("opencode's step-limit reminder is malformed");
  }
  return lines.join('\n');
}

const MAX_BLOCKS = 1024;
const MAX_EVENTS = 65_536;
const MAX_TOOL_USES = 1024;
const MAX_MESSAGES = 512;

export const MAX_CARRIED_TURNS = MAX_MESSAGES - 2;
const TERMINAL_REASONS = new Set(['end_turn', 'max_tokens', 'model_context_window_exceeded', 'refusal', 'stop_sequence']);
const CACHE_BOUNDARY = 'the request moved the provider cache boundary';

function shape(value, required, optional, name) {
  const object = record(value, name);
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  const unexpected = Object.keys(object).filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length || unexpected.length) {
    const missed = missing.length ? `it names none of ${missing.join(', ')}` : '';
    const added = unexpected.length ? `${missed ? 'it also names' : 'it names'} ${unexpected.join(', ')}` : '';
    throw new Error(`${name} has an unsupported shape: ${[missed, added].filter(Boolean).join(', and ')}`);
  }
  return object;
}

function text(value, name, maximum = MAX_RESPONSE_BYTES) {
  if (typeof value !== 'string' || value.length > maximum || /[\0\r]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function identifier(value, name) {
  const result = text(value, name, 256);
  if (!result || result.includes('\n')) throw new Error(`${name} is invalid`);
  return result;
}

function indexOf(event, expected) {
  if (event.index !== expected) throw new Error('a content block event names a block other than the open one');
}

function nextIndex(event, after) {
  if (!Number.isSafeInteger(event.index) || event.index <= after) throw new Error("the response's content block indices do not increase");
  return event.index;
}

function frames(bytes) {
  if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw new IncompleteAnswer('the response is empty or oversized');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new IncompleteAnswer('the response is not UTF-8', { cause: error });
  }
  const normalized = decoded.includes('\r') ? decoded.replaceAll('\r\n', '\n') : decoded;
  if (normalized.includes('\r') || !normalized.endsWith('\n\n')) throw new IncompleteAnswer('the response stream is incomplete');
  const events = normalized.slice(0, -2).split('\n\n');
  if (!events.length || events.length > MAX_EVENTS || events.some((frame) => !frame)) {
    throw new Error('the response has an invalid event count');
  }
  return events.map((frame) => {
    const lines = frame.split('\n');
    if (lines.length !== 2 || !lines[0].startsWith('event: ') || !lines[1].startsWith('data: ')) {
      throw new Error('the response has an unsupported event frame');
    }
    const name = identifier(lines[0].slice(7), 'the response event name');
    const event = record(JSON.parse(lines[1].slice(6)), 'the response event');
    if (event.type !== name) throw new Error('the response event name does not match its data');
    return event;
  });
}

function messageStart(event, model) {
  shape(event, ['type', 'message'], [], 'message_start');
  const message = shape(
    event.message,
    ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence'],
    ['container', 'stop_details', 'usage'],
    'message_start message',
  );
  identifier(message.id, 'the response message id');
  if (
    message.type !== 'message' ||
    message.role !== 'assistant' ||
    message.model !== model ||
    !Array.isArray(message.content) ||
    message.content.length !== 0 ||
    message.stop_reason !== null ||
    message.stop_sequence !== null ||
    (message.container ?? null) !== null ||
    (message.stop_details ?? null) !== null
  ) {
    throw new Error('message_start does not answer the governed request');
  }
}

function startBlock(event, tools) {
  shape(event, ['type', 'index', 'content_block'], [], 'content_block_start');
  const block = record(event.content_block, 'the content block');
  if (block.type === 'text') {
    shape(block, ['type', 'text'], ['citations'], 'the text block');
    if ((block.citations ?? null) !== null && (!Array.isArray(block.citations) || block.citations.length !== 0)) {
      throw new Error('the text block carries citations');
    }
    return { type: 'text', text: text(block.text, 'the text block') };
  }
  if (block.type === 'thinking') {
    shape(block, ['type', 'thinking', 'signature'], [], 'the thinking block');
    return { type: 'thinking', thinking: text(block.thinking, 'the thinking block'), signature: text(block.signature, 'the thinking signature', 65_536), signed: false };
  }
  if (block.type === 'tool_use') {
    shape(block, ['type', 'id', 'name', 'input'], ['caller', 'toolset_name'], 'the tool_use block');
    const name = identifier(block.name, 'the tool_use name');
    const caller = block.caller === undefined ? undefined : shape(block.caller, ['type'], [], 'the tool_use caller');
    if (
      Object.keys(record(block.input, 'the tool_use input')).length !== 0 ||
      !tools.includes(name) ||
      (caller !== undefined && caller.type !== 'direct') ||
      (block.toolset_name ?? null) !== null
    ) {
      throw new Error('the tool_use block is outside the governed tools');
    }
    return { type: 'tool_use', id: identifier(block.id, 'the tool_use id'), name, partial: '', ...(caller === undefined ? {} : { caller: { type: 'direct' } }) };
  }
  throw new Error(`content block ${String(block.type)} is unsupported`);
}

function appendDelta(event, block, expected) {
  shape(event, ['type', 'index', 'delta'], [], 'content_block_delta');
  indexOf(event, expected);
  const delta = record(event.delta, 'the content block delta');
  if (block.type === 'text') {
    shape(delta, ['type', 'text'], [], 'the text delta');
    if (delta.type !== 'text_delta') throw new Error('the text block received another delta');
    block.text += text(delta.text, 'the text delta');
    return;
  }
  if (block.type === 'thinking') {
    if (delta.type === 'thinking_delta') {
      shape(delta, ['type', 'thinking'], [], 'the thinking delta');
      if (block.signed) throw new Error('thinking arrived after its signature');
      block.thinking += text(delta.thinking, 'the thinking delta');
      return;
    }
    shape(delta, ['type', 'signature'], [], 'the signature delta');
    if (delta.type !== 'signature_delta' || block.signed) throw new Error('the thinking signature is duplicated or malformed');
    block.signature += text(delta.signature, 'the thinking signature', 65_536);
    block.signed = true;
    return;
  }
  shape(delta, ['type', 'partial_json'], [], 'the tool input delta');
  if (delta.type !== 'input_json_delta') throw new Error('the tool_use block received another delta');
  block.partial += text(delta.partial_json, 'the tool input delta');
}

function finishBlock(block) {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'thinking') {
    if (!block.signed || !block.signature) throw new Error('the thinking block has no complete signature');
    return { type: 'thinking', thinking: block.thinking, signature: block.signature };
  }
  const input = JSON.parse(block.partial || '{}');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('the tool input is not an object');
  return { type: 'tool_use', id: block.id, name: block.name, input, ...(block.caller === undefined ? {} : { caller: block.caller }) };
}

function messageDelta(event) {
  shape(event, ['type', 'delta'], ['context_management', 'usage'], 'message_delta');
  const delta = shape(event.delta, ['stop_reason'], ['stop_sequence', 'container', 'stop_details'], 'the message_delta payload');
  if ((delta.container ?? null) !== null || (delta.stop_details ?? null) !== null || (event.context_management ?? null) !== null) {
    throw new Error('message_delta does not answer the governed request');
  }
  const reason = identifier(delta.stop_reason, 'the stop reason');
  if (reason !== 'tool_use' && !TERMINAL_REASONS.has(reason)) throw new Error(`stop reason ${reason} is unsupported`);
  if ((delta.stop_sequence ?? null) !== null) text(delta.stop_sequence, 'the stop sequence', 256);
  return reason;
}

export class UpstreamFailure extends Error {}

export class IncompleteAnswer extends Error {}

export class GivenUp extends Error {}

function parseResponse(bytes, model, tools) {
  const blocks = [];
  let open = null;
  let openIndex = -1;
  let stop = '';
  let state = 'initial';
  for (const event of frames(bytes)) {
    switch (event.type) {
      case 'ping':
        shape(event, ['type'], [], 'ping');
        if (state === 'initial' || state === 'stopped') throw new Error('ping is out of sequence');
        break;
      case 'message_start':
        if (state !== 'initial') throw new Error('message_start is out of sequence');
        messageStart(event, model);
        state = 'content';
        break;
      case 'content_block_start':
        if (state !== 'content' || open || blocks.length >= MAX_BLOCKS) throw new Error('content_block_start is out of sequence');
        open = startBlock(event, tools);
        openIndex = nextIndex(event, openIndex);
        break;
      case 'content_block_delta':
        if (state !== 'content' || !open) throw new Error('content_block_delta is out of sequence');
        appendDelta(event, open, openIndex);
        break;
      case 'content_block_stop':
        shape(event, ['type', 'index'], [], 'content_block_stop');
        if (state !== 'content' || !open) throw new Error('content_block_stop is out of sequence');
        indexOf(event, openIndex);
        blocks.push(finishBlock(open));
        open = null;
        break;
      case 'message_delta':
        if (state !== 'content' || open || stop) throw new Error('message_delta is out of sequence');
        stop = messageDelta(event);
        state = 'delta';
        break;
      case 'message_stop':
        shape(event, ['type'], [], 'message_stop');
        if (state !== 'delta') throw new Error('message_stop is out of sequence');
        state = 'stopped';
        break;
      case 'error': {
        const failure = record(shape(event, ['type', 'error'], [], 'error').error, 'the upstream error');
        throw new UpstreamFailure(`${text(failure.type, 'the upstream error type', 64)}: ${text(failure.message ?? '', 'the upstream error message', 512)}`);
      }
      default:
        throw new Error(`response event ${String(event.type)} is unsupported`);
    }
  }
  if (state !== 'stopped' || open || !stop || !blocks.length) throw new IncompleteAnswer('the response did not complete one message');
  const toolUseIDs = blocks.flatMap((block) => ('id' in block ? [block.id] : []));
  if (toolUseIDs.length > MAX_TOOL_USES || new Set(toolUseIDs).size !== toolUseIDs.length || (stop === 'tool_use') !== (toolUseIDs.length > 0)) {
    throw new Error('the response has an invalid tool_use completion');
  }
  return {
    assistant: { role: 'assistant', content: blocks },
    terminal: stop !== 'tool_use',
    toolUseIDs,
  };
}

const EPHEMERAL = canonical({ type: 'ephemeral' });

function withoutCacheBoundary(messages) {
  const expected = new Set(
    messages
      .map((message, index) => ({ index, message }))
      .slice(-2)
      .map(({ index, message }) => {
        if (!Array.isArray(message?.content) || !message.content.length) throw new Error(CACHE_BOUNDARY);
        return `${index}:${message.content.length - 1}`;
      }),
  );
  return messages.map((message, messageIndex) => {
    if (!Array.isArray(message?.content)) return message;
    let bounded = false;
    const content = message.content.map((block, blockIndex) => {
      if (block === null || typeof block !== 'object' || !Object.hasOwn(block, 'cache_control')) return block;
      const { cache_control: boundary, ...rest } = block;
      if (!expected.has(`${messageIndex}:${blockIndex}`) || canonical(boundary) !== EPHEMERAL) throw new Error(CACHE_BOUNDARY);
      bounded = true;
      return rest;
    });
    return bounded ? { ...message, content } : message;
  });
}

const blank = (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() === '';

function asReplayed(message) {
  return message?.role === 'assistant' && Array.isArray(message.content) && message.content.some(blank)
    ? { ...message, content: message.content.filter((block) => !blank(block)) }
    : message;
}

function toolContent(value) {
  if (typeof value === 'string') return;
  if (!Array.isArray(value) || !value.length) throw new Error('the tool_result content is invalid');
  for (const item of value) {
    const block = record(item, 'a tool_result content block');
    if (block.type === 'text') {
      shape(block, ['type', 'text'], [], 'a tool_result text block');
      text(block.text, 'a tool_result text');
      continue;
    }
    shape(block, ['type', 'source'], [], 'a tool_result image block');
    const source = shape(block.source, ['type', 'media_type', 'data'], [], 'a tool_result image source');
    if (block.type !== 'image' || source.type !== 'base64' || !/^image\/[a-z0-9.+-]+$/i.test(source.media_type) || typeof source.data !== 'string') {
      throw new Error('a tool_result content block is unsupported');
    }
  }
}

function resultIDs(messages, length, expected) {
  const suffix = messages.slice(length);
  if (suffix.length !== 1) throw new Error('the request did not answer with exactly one tool-result message');
  const message = shape(suffix[0], ['role', 'content'], [], 'the tool result message');
  if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.length) {
    throw new Error('the tool results are not user content');
  }
  const ids = message.content.map((block) => {
    const result = shape(block, ['type', 'tool_use_id', 'content'], ['is_error'], 'a tool_result block');
    if (result.type !== 'tool_result' || (result.is_error !== undefined && result.is_error !== true)) {
      throw new Error('a tool_result block is invalid');
    }
    toolContent(result.content);
    return identifier(result.tool_use_id, 'a tool_result id');
  });
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error('the tool results do not answer exactly the preceding tool_use ids');
  }
  return ids;
}

function reminded(normalized, limit, taken) {
  if (!limit || taken + 1 < limit.steps) return normalized;
  if (taken + 1 > limit.steps) throw new Error('the request goes past the governed step limit');
  const reminder = canonical({ role: 'assistant', content: [{ type: 'text', text: limit.reminder }] });
  if (canonical(normalized.at(-1)) !== reminder) throw new Error("the request at the step limit does not end with opencode's governed reminder");
  return normalized.slice(0, -1);
}

const SEALED = /^sha256:[0-9a-f]{64}$/;

export function carriedOf(value) {
  if (value === undefined || value === null) return null;
  const carried = shape(value, ['history', 'turns', 'original'], ['earlier'], 'the carried history');
  if (!SEALED.test(String(carried.history)) || !SEALED.test(String(carried.original))) throw new Error('the carried history names no digest');
  if (!Number.isSafeInteger(carried.turns) || carried.turns < 2 || carried.turns > MAX_CARRIED_TURNS) throw new Error('the carried history names no turn count it could hold');
  const earlier = carried.earlier ?? null;
  if (earlier !== null && !(Array.isArray(earlier) && earlier.length <= carried.turns - 2 && earlier.every((one) => typeof one === 'string' && SEALED.test(one)))) {
    throw new Error('the carried history names no renders it could have gone on with');
  }
  return { history: carried.history, turns: carried.turns, original: carried.original, ...(earlier === null ? {} : { earlier: [...earlier] }) };
}

const answers = (message) => Array.isArray(message?.content) && message.content.length > 0 && message.content.every((block) => block?.type === 'tool_result');

function openedOn(message, original) {
  const opened = message?.role === 'user' && Array.isArray(message.content) && message.content.length === 1 ? message.content[0] : null;
  return opened?.type === 'text' && typeof opened.text === 'string' && canonical(message) === canonical({ role: 'user', content: [{ type: 'text', text: opened.text }] }) && digest(opened.text) === original;
}

function carriedHistory(normalized, carried, opening, used) {
  if (normalized.length !== carried.turns + 1) throw new CarryRefused('the continuation does not carry exactly its governed history and one new turn');
  const prior = normalized.slice(0, carried.turns);
  if (!openedOn(prior[0], carried.original)) throw new CarryRefused('the continuation does not open on the render its history was governed by');
  if (carried.earlier) {
    const went = prior.slice(1).filter((message) => message?.role === 'user' && !answers(message));
    if (went.length !== carried.earlier.length || went.some((message, index) => !openedOn(message, carried.earlier[index]))) {
      throw new CarryRefused('the continuation does not carry exactly the renders its history went on with, in their order');
    }
  }
  const kept = prior.map((message) => canonical(message));
  if (historyDigest(kept) !== carried.history) throw new CarryRefused('the continuation changed the history it carries');
  const last = prior.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content) || last.content.some((block) => block?.type === 'tool_use')) {
    throw new CarryRefused('the continuation carries a turn the model did not finish');
  }
  if (canonical(normalized.at(-1)) !== opening) throw new CarryRefused('the continuation adds a turn other than its render');
  for (const message of prior) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use') continue;
      if (used.has(block.id)) throw new CarryRefused('the carried history replays a tool_use id');
      used.add(block.id);
    }
  }
  return [...kept, opening];
}

export function conversation(prompt, model, tools, limit = null, carried = null) {
  const opening = canonical({ role: 'user', content: [{ type: 'text', text: prompt }] });
  let history = [opening];
  let answered = history;
  let awaiting = false;
  let asked = 0;
  let terminal = false;
  let pending = [];
  let taken = 0;
  let settled = null;
  let carrying = carried;
  const used = new Set();
  return {
    request(messages) {
      if (terminal) throw new Error("a request followed the model's final answer");
      if (awaiting) throw new Error('requests overlapped');
      if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw new Error('the request changed the message history');
      const normalized = reminded(withoutCacheBoundary(messages), limit, taken).map((message) => asReplayed(message));
      if (carrying) {
        history = carriedHistory(normalized, carrying, opening, used);
        answered = history;
        carrying = null;
      }
      if (normalized.length < history.length || history.some((kept, index) => canonical(normalized[index]) !== kept)) {
        throw new Error('the request changed the message history');
      }
      if (pending.length) resultIDs(normalized, history.length, pending);
      else if (normalized.length !== history.length) throw new Error('the request added a turn the model did not take');
      answered = history;
      history = normalized.map((message, index) => history[index] ?? canonical(message));
      awaiting = true;
      asked += 1;
      return Boolean(limit) && taken + 1 === limit.steps;
    },
    ticket: () => (awaiting ? asked : 0),
    failed(ticket = asked) {
      if (!awaiting || ticket !== asked) return;
      history = answered;
      awaiting = false;
    },
    settled: () => settled,
    response(bytes, ticket = awaiting ? asked : 0) {
      if (!ticket) throw new Error('a response arrived with no request pending');
      if (!awaiting || ticket !== asked) throw new GivenUp('a response arrived for a request that was given up');
      const reply = parseResponse(bytes, model, tools);
      if (reply.toolUseIDs.some((id) => used.has(id))) throw new Error('the model replayed a tool_use id');
      if (history.length + 1 > MAX_MESSAGES) throw new Error('the message history is too long');
      for (const id of reply.toolUseIDs) used.add(id);
      history = [...history, canonical(asReplayed(reply.assistant))];
      taken += 1;
      awaiting = false;
      terminal = reply.terminal;
      pending = [...reply.toolUseIDs];
      if (terminal) {
        settled = { history: historyDigest(history), turns: history.length };
        history = [];
        answered = [];
        used.clear();
      }
      return reply;
    },
  };
}
