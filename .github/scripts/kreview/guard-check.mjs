import { createHash } from 'node:crypto';

export const GUARD_CHECK = Object.freeze({
  capability: 'ksai-guard-check-v2',
  version: '2',
  path: '/v1/guard/check',
  itemsMost: 64,
  bytesMost: 4 << 20,
  answerMost: 1 << 20,
  withinMs: 30_000,
  toolWithinMs: 50_000,
  readWithinMs: 10_000,
});

const ACTIONS = new Set(['allow', 'withhold', 'stop']);
const GENERATION = /^sha256:[0-9a-f]{64}$/;
const TOOL = /^[A-Za-z0-9.:_-]{1,64}$/;
const INCIDENT = /^inc_[a-z0-9]{26}$/;

export class GuardStopped extends Error {}
export class GuardIncoherent extends Error {}

export const digestOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const toolOf = (name) => (TOOL.test(String(name ?? '')) ? String(name) : 'unknown');

const incidentOf = (result) => (typeof result?.incident === 'string' && INCIDENT.test(result.incident) ? ` (${result.incident})` : '');

const pathOf = (path) => (typeof path === 'string' && Buffer.byteLength(path, 'utf8') <= 4096 && !path.includes('\0') ? path : '');

const leaf = (id, kind, tool, text, set, path = '', digest = '', via = '') => ({
  id, kind, ...(kind === 'tool_output' ? { tool: toolOf(tool) } : {}), ...(pathOf(path) ? { path: pathOf(path) } : {}), text: String(text ?? ''), set,
  ...(digest ? { digest } : {}), ...(via ? { via } : {}),
});

function thinkingTexts(texts, id, message, block) {
  const scalar = typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string') &&
    Object.keys(block).every((key) => key === 'type' || key === 'thinking' || key === 'signature');
  if (scalar && message.role === 'assistant') return;
  texts.push(leaf(`${id}.thinking`, 'message', '', scalar ? block.thinking : JSON.stringify(block), null));
}

const renderOf = (renders, at, index, message, block) => {
  if (message?.role !== 'user' || block?.type !== 'text' || typeof block.text !== 'string') return null;
  if (!renders) return at === 0 && index === 0 ? { digest: digestOf(block.text) } : null;
  const digest = digestOf(block.text);
  if (digest === renders.current) return { digest };
  return renders.carried.includes(digest) ? { digest, via: renders.current } : null;
};

export function textsOf(request, renders = null) {
  const texts = [];
  const unsupported = [];
  const tools = new Map();
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  for (const [at, message] of messages.entries()) {
    const base = `messages.${at}.content`;
    const content = message?.content;
    if (typeof content === 'string') {
      texts.push(leaf(base, 'message', '', content, (text) => { message.content = text; }));
      continue;
    }
    if (!Array.isArray(content)) {
      unsupported.push(base);
      continue;
    }
    for (const [index, block] of content.entries()) {
      const id = `${base}.${index}`;
      const render = renderOf(renders, at, index, message, block);
      if (render) {
        texts.push(leaf(`${id}.text`, 'governed_prompt', '', '', null, '', render.digest, render.via));
        continue;
      }
      switch (block?.type) {
        case 'text':
          texts.push(leaf(`${id}.text`, 'message', '', block.text, (text) => { block.text = text; }));
          break;
        case 'thinking':
          thinkingTexts(texts, id, message, block);
          break;
        case 'tool_use':
          tools.set(block.id, block.name);
          texts.push(leaf(`${id}.input`, 'message', '', JSON.stringify(block.input ?? {}), null));
          break;
        case 'tool_result':
          resultTexts(texts, unsupported, id, block, tools.get(block.tool_use_id));
          break;
        case 'redacted_thinking':
          break;
        default:
          unsupported.push(id);
      }
    }
  }
  return { texts, unsupported };
}

function resultTexts(texts, unsupported, id, block, tool) {
  if (typeof block.content === 'string') {
    texts.push(leaf(`${id}.content`, 'tool_output', tool, block.content, (text) => { block.content = text; }));
    return;
  }
  if (block.content === undefined) return;
  if (!Array.isArray(block.content)) {
    unsupported.push(`${id}.content`);
    return;
  }
  for (const [index, inner] of block.content.entries()) {
    if (inner?.type === 'text') texts.push(leaf(`${id}.content.${index}.text`, 'tool_output', tool, inner.text, (text) => { inner.text = text; }));
    else unsupported.push(`${id}.content.${index}`);
  }
}

export const wireOf = ({ id, kind, tool, path, text, digest, via }) => JSON.stringify({
  id, kind, ...(tool ? { tool } : {}), ...(path ? { path } : {}), digest: digest ?? digestOf(text), ...(via ? { via } : {}), text,
});

export const checkBody = (wires) => `{"api_version":"${GUARD_CHECK.version}","hook":"runner","items":[${wires.join(',')}]}`;

const ENVELOPE_BYTES = Buffer.byteLength(checkBody([]), 'utf8');

export function batchesOf(texts) {
  const batches = [];
  const oversize = [];
  let batch = [];
  let bytes = ENVELOPE_BYTES;
  for (const one of texts) {
    const wire = wireOf(one);
    const size = Buffer.byteLength(wire, 'utf8') + 1;
    if (ENVELOPE_BYTES + size > GUARD_CHECK.bytesMost) {
      oversize.push(one.id);
      continue;
    }
    if (batch.length === GUARD_CHECK.itemsMost || bytes + size > GUARD_CHECK.bytesMost) {
      batches.push(batch);
      batch = [];
      bytes = ENVELOPE_BYTES;
    }
    batch.push({ ...one, wire });
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return { batches, oversize };
}

export function answerOf(asked, said) {
  if (said?.api_version !== GUARD_CHECK.version || !GENERATION.test(String(said.generation ?? ''))) {
    throw new Error('the control plane answered no guard generation');
  }
  const expires = Date.parse(String(said.expires_at ?? ''));
  if (!Number.isFinite(expires)) throw new Error('the control plane answered no guard expiry');
  if (!Array.isArray(said.items) || said.items.length !== asked.length) throw new Error('the control plane answered another number of guard results than it was asked');
  for (const [at, item] of said.items.entries()) {
    if (item?.id !== asked[at].id) throw new Error(`the guard answer names another item where it was asked about ${asked[at].id}`);
    if (!ACTIONS.has(item.action)) throw new Error(`the guard answer names an unknown action for ${asked[at].id}`);
    if (item.action === 'withhold' && (typeof item.notice !== 'string' || item.notice === '')) throw new Error(`the guard withheld ${asked[at].id} with no notice`);
  }
  return { generation: said.generation, expires, items: said.items };
}

export async function checkedTexts(texts, check, now = Date.now) {
  const { batches, oversize } = batchesOf(texts);
  if (oversize.length) throw new Error(`${oversize.length} texts pass the bound of one guard check`);
  let first = null;
  const results = [];
  for (const batch of batches) {
    const answer = answerOf(batch, await check(batch));
    first ??= answer;
    if (answer.generation !== first.generation) throw new GuardIncoherent('the guard policy changed while one request was checked');
    if (now() >= first.expires) throw new GuardIncoherent('the guard authority expired while one request was checked');
    results.push(...answer.items);
  }
  return results;
}

export async function checkedRequest(body, { check, required, now = Date.now, renders = null }) {
  for (let attempt = 0; ; attempt += 1) {
    const request = JSON.parse(body.toString('utf8'));
    const { texts, unsupported } = textsOf(request, renders);
    if (unsupported.length && required) throw new GuardStopped(`the provider request holds ${unsupported.length} parts that the guard cannot check`);
    let results;
    try {
      results = texts.length ? await checkedTexts(texts, check, now) : [];
    } catch (error) {
      if (error instanceof GuardIncoherent && attempt === 0) continue;
      if (required) throw new GuardStopped(`the guard could not check the provider request: ${error.message}`, { cause: error });
      return { body, withheld: 0, unchecked: true };
    }
    let withheld = 0;
    for (const [at, result] of results.entries()) {
      if (result.action === 'stop') throw new GuardStopped(`the guard stopped the run at ${texts[at].id}${incidentOf(result)}`);
      if (result.action !== 'withhold') continue;
      if (!texts[at].set) throw new GuardStopped(`the guard withheld ${texts[at].id}, which no notice can replace`);
      texts[at].set(result.notice);
      withheld += 1;
    }
    return { body: withheld ? Buffer.from(JSON.stringify(request), 'utf8') : body, withheld, unchecked: false };
  }
}

export function requestGate({ check, required, now = Date.now }) {
  return { required, checked: async (body, renders = null) => (await checkedRequest(body, { check, required, now, renders })).body };
}

export function guardToken({ mintFor, env, fetchImpl }) {
  return (signal) => mintFor({ env, fetch: fetchImpl, signal, holds: GUARD_CHECK.withinMs })('ksai-cp');
}

const bounded = (work, signal) => {
  work.catch(() => {});
  let abort = () => {};
  const ended = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([work, ended]).finally(() => signal.removeEventListener('abort', abort));
};

const ID = /^[A-Za-z0-9.:_-]{1,128}$/;

const deadlined = (work, within) => {
  let timer;
  work.catch(() => {});
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the check took more than ${within / 1000} s`)), within);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

export function toolCheck({ check, latch, latched, required = () => false, within = GUARD_CHECK.toolWithinMs, now = Date.now }) {
  const failed = (why) => {
    if (required()) latch(`a required check of a tool output failed: ${why}`);
    return { error: why };
  };
  return async (asked) => {
    const items = Array.isArray(asked?.items) ? asked.items : [];
    if (!items.length || items.length > GUARD_CHECK.itemsMost) return failed(`a tool check holds 1 to ${GUARD_CHECK.itemsMost} items`);
    const texts = [];
    for (const item of items) {
      if (!ID.test(String(item?.id ?? '')) || typeof item.text !== 'string') return failed('each tool item has an ID and a text');
      texts.push(leaf(item.id, 'tool_output', asked.tool, item.text, null, asked.path));
    }
    if (latched()) return { items: texts.map(({ id }) => ({ id, action: 'stop' })) };
    let results;
    try {
      results = await deadlined(checkedTexts(texts, check, now), within);
    } catch (error) {
      return failed(String(error?.message ?? error));
    }
    const stopped = results.find((result) => result.action === 'stop');
    if (stopped) latch(`a tool output stopped the run${incidentOf(stopped)}`);
    return { items: results.map(({ id, action, notice }) => ({ id, action, ...(action === 'withhold' ? { notice } : {}) })) };
  };
}

export function guardHost({ provider, check }) {
  return {
    handle: (asked) => (provider.gated()
      ? toolCheck({ check, latch: provider.latch, latched: provider.latched, required: provider.required })(asked)
      : { error: 'no guard gate is on for this run' }),
    refused: (why) => {
      if (provider.required()) provider.latch(`a required check of a tool output went unanswered: ${why}`);
    },
  };
}

async function boundedText(response, most) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > most) throw new Error('the guard answer passes its bound');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

const REFUSALS = new Set(['malformed-check', 'render-not-kept', 'render-changed', 'carrier-untrusted', 'checkpoint-gone', 'lineage-changed', 'lineage-unnamed']);

async function reasonOf(response) {
  await response.body?.cancel().catch(() => {});
  const refusal = String(response.headers?.get('x-ksai-guard-refusal') ?? '');
  return REFUSALS.has(refusal) ? ` (${refusal})` : '';
}

export function controlPlaneCheck({ endpoint, fetchImpl = fetch, token, within = GUARD_CHECK.withinMs }) {
  const base = String(endpoint ?? '').replace(/\/+$/, '');
  return async (batch) => {
    if (!base) throw new Error('the run names no control plane to check its texts with');
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new Error(`the guard check took more than ${within / 1000} s`)), within);
    try {
      const bearer = await bounded(Promise.resolve().then(() => token(late.signal)), late.signal);
      const response = await fetchImpl(`${base}${GUARD_CHECK.path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: checkBody(batch.map((one) => one.wire ?? wireOf(one))),
        signal: late.signal,
      });
      if (!response.ok) throw new Error(`the control plane answered the guard check with ${response.status}${await reasonOf(response)}`);
      const said = await boundedText(response, GUARD_CHECK.answerMost);
      try {
        return JSON.parse(said);
      } catch {
        throw new Error('the control plane answered the guard check with a body that is not JSON');
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
