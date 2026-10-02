import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { authHeaders, bearer } from '../lib/opencode-token.mjs';
import { ARTIFACTS, promptRendering } from '../lib/cp-prompts.mjs';
import { canonical, digest, record as objectOf } from '../governance/artifacts.mjs';
import { boundedSteps, CarryRefused, carriedOf, conversation, MAX_RESPONSE_BYTES, reminderText } from '../governance/conversation.mjs';
import { governRequest } from '../governance/provider.mjs';
import { originProblem } from './federated-token.mjs';

export { MAX_RESPONSE_BYTES };

const REQUEST_BYTES = 32 * 1024 * 1024;
const OBSERVATION_BYTES = 256 * 1024 * 1024;
const retainedBytes = new Map();

function heldArtifact(dir, expected) {
  const prompt = readFileSync(join(dir, ARTIFACTS.prompt), 'utf8');
  if (digest(prompt) !== expected.finalDigest) throw new Error('the governed artifact differs from its expected digest');
  const tools = new Map();
  for (const file of readdirSync(join(dir, ARTIFACTS.tools))) {
    if (!/^[a-z][a-z0-9_-]{0,63}\.json$/.test(file)) throw new Error('the governed tool directory contains an unexpected file');
    const tool = JSON.parse(readFileSync(join(dir, ARTIFACTS.tools, file), 'utf8'));
    if (tool.name !== file.slice(0, -5) || !Array.isArray(tool.description_lines)) throw new Error('the governed tool is malformed');
    tools.set(tool.name, { name: tool.name, description: tool.description_lines.join('\n'), schema: canonical(tool.input_schema) });
  }
  const limit = expected.steps === undefined
    ? null
    : { steps: boundedSteps(expected.steps, 'the governed step limit'), reminder: reminderText(readFileSync(join(dir, ARTIFACTS.reminder))) };
  const carried = carriedOf(expected.carried);
  const opens = carried ? readFileSync(join(dir, ARTIFACTS.original), 'utf8') : prompt;
  if (carried && digest(opens) !== carried.original) throw new Error('the carried render differs from the one its history was governed by');
  const governed = { prompt, opens, model: expected.model, tools, limit, carried };
  return { key: `${openingOf(expected)}\u0000${expected.model}`, governed, talk: talkOf(governed) };
}

const openingOf = (expected) => expected.carried?.original ?? expected.finalDigest;

function talkOf(governed) {
  return conversation(governed.prompt, governed.model, [...governed.tools.keys()], governed.limit, governed.carried);
}

function governedArtifact(root, wanted, model, depth = 0) {
  if (depth > 4) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = governedArtifact(path, wanted, model, depth + 1);
      if (found) return found;
    }
    if (entry.name !== ARTIFACTS.expect || !entry.isFile()) continue;
    const expected = JSON.parse(readFileSync(path, 'utf8'));
    if (openingOf(expected) === wanted && expected.model === model) return heldArtifact(root, expected);
  }
  return null;
}

function governedAt(dir) {
  return heldArtifact(dir, JSON.parse(readFileSync(join(dir, ARTIFACTS.expect), 'utf8')));
}

export function enforceGovernedRequest(body, env, state = null) {
  const root = String(env.KSAI_GOVERNED_DIR ?? '');
  if (!root) throw new Error('a governed provider request has no trusted artifacts');
  const text = body.toString('utf8');
  const request = objectOf(JSON.parse(text), 'the provider request');
  const first = request.messages?.[0];
  const prompt = first?.role === 'user' && first.content?.[0]?.type === 'text' ? first.content[0].text : '';
  const wanted = digest(prompt);
  const held = state?.held ?? governedArtifact(root, wanted, request.model);
  if (!held) throw new Error('the provider request names no governed prompt this run rendered');
  if (held.key !== `${wanted}\u0000${request.model}`) throw new Error('the provider request names another governed prompt than the one this run holds');
  if (state) state.held = held;
  return { body: Buffer.from(governRequest(text, held.governed, held.talk, request)), talk: held.talk };
}

async function finishGovernedResponse(response, talk, answered = (_bytes) => {}) {
  if (!response.ok || !response.body) {
    talk.failed();
    return;
  }
  const reader = response.clone().body.getReader();
  const chunks = [];
  let size = 0;
  let tallied = false;
  const tally = () => {
    if (tallied) return;
    tallied = true;
    answered(Buffer.concat(chunks));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('the provider response exceeds the governed limit');
      chunks.push(Buffer.from(value));
    }
    tally();
    talk.response(Buffer.concat(chunks));
  } catch (error) {
    tally();
    talk.failed();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function recordProviderRequest(body, env, governed = null) {
  const root = join(String(env.RUNNER_TEMP ?? ''), 'ksai-provider-observations');
  if (!env.RUNNER_TEMP) throw new Error('provider observations require RUNNER_TEMP');
  const request = JSON.parse(body.toString('utf8'));
  const first = request.messages?.[0];
  const text = first?.role === 'user' && first.content?.[0]?.type === 'text' ? first.content[0].text : '';
  const setting = promptRendering(env);
  if (typeof request.model !== 'string' || !request.model || (setting === 'cp' && !text)) {
    throw new Error('provider request does not identify its model and governed prompt');
  }
  const id = randomBytes(16).toString('hex');
  const mode = ['cp', 'shadow'].includes(setting) ? setting : 'local';
  const metadata = {
    id, mode, model: request.model, prompt_digest: text ? digest(text) : '',
    ...(governed?.carried ? { continuation_digest: digest(governed.prompt) } : {}),
    request_digest: digest(body), request_bytes: body.length, status: 0,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const retained = mode === 'cp' ? Buffer.from(JSON.stringify({ messages: request.messages.slice(1) })) : body;
  const used = retainedBytes.get(root) ?? readdirSync(root).filter((name) => /\.(body|dynamic)$/.test(name))
    .reduce((size, name) => size + statSync(join(root, name)).size, 0);
  if (used + retained.length > OBSERVATION_BYTES) throw new Error('provider observations exceed the run storage limit');
  writeFileSync(join(root, `${id}.${mode === 'cp' ? 'dynamic' : 'body'}`), retained, { mode: 0o600, flag: 'wx' });
  retainedBytes.set(root, used + retained.length);
  const path = join(root, `${id}.json`);
  writeFileSync(path, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
  return (status) => writeFileSync(path, JSON.stringify({ ...metadata, status }), { mode: 0o600 });
}

const bodyOf = async (request, limit = REQUEST_BYTES) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('provider request exceeds the relay limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const responseHeaders = (headers) => {
  const out = Object.create(null);
  for (const [name, value] of headers) {
    if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) {
      out[name] = value;
    }
  }
  return out;
};

export async function relayProviderRequest(request, env, fetchImpl = fetch, token = bearer, timeoutMs = 10 * 60_000, gone = new AbortController().signal, record = null, state = null, queries = ['']) {
  const origin = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (originProblem(origin)) throw new Error(`provider relay received an invalid origin: ${originProblem(origin)}`);
  const target = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method !== 'POST' || target.pathname !== '/v1/messages' || !queries.includes(target.search)) return null;
  if (state?.completion) {
    const failure = await state.completion;
    if (failure) throw failure;
  }
  const held = await token({ env });
  if (!held) throw new Error('provider relay received no bearer');
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !['authorization', 'host', 'content-length', 'connection', 'x-api-key'].includes(name.toLowerCase())) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  for (const [name, value] of Object.entries(authHeaders(held, { ANTHROPIC_AUTH: env.ANTHROPIC_AUTH }))) {
    headers.set(name, value);
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('provider relay timed out')), timeoutMs);
  let talk;
  try {
    let body = await bodyOf(request);
    if (env.KSAI_PROVIDER_OBSERVATIONS === 'true' && promptRendering(env) === 'cp') {
      ({ body, talk } = enforceGovernedRequest(body, env, state));
    }
    const pinned = { session: state?.session ?? '', model: state?.held?.governed.model };
    const unadmitted = talk ? (state?.admit?.(pinned.session, pinned.model) ?? '') : '';
    if (unadmitted) throw new Error(`the provider call was not made, because its usage could not be counted: ${unadmitted}`);
    const completed = record?.(body, env, talk ? state?.held?.governed : null);
    const upstream = await fetchImpl(`${origin}${target.pathname}${target.search}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([abort.signal, gone]),
    });
    completed?.(upstream.status);
    if (talk && state) {
      const answered = (bytes) => state.counted?.(pinned.session, pinned.model, { status: upstream.status, bytes });
      state.completion = finishGovernedResponse(upstream, talk, answered).then(() => null, (error) => error);
    }
    return upstream;
  } catch (error) {
    talk?.failed();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** startProviderRelay keeps the bearer and provider origin outside the model process. */
export async function startProviderRelay({ env = process.env, fetchImpl = fetch, token = bearer, record = env.KSAI_PROVIDER_OBSERVATIONS === 'true' ? recordProviderRequest : null, socket = '', stallMs = 0, queries = [''], counted = null, admit = null } = {}) {
  const state = { completion: null, held: null, governing: '', session: '', counted, admit, carryRefused: new Map() };
  const server = createServer(async (request, response) => {
    const gone = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) gone.abort(new Error('provider relay client closed the request'));
    });
    let idle = null;
    const arm = () => {
      if (!stallMs) return;
      if (idle) {
        idle.refresh();
        return;
      }
      idle = setTimeout(() => {
        const stalled = new Error(`the provider stream sent nothing for ${stallMs}ms`);
        gone.abort(stalled);
        if (response.headersSent) response.destroy(stalled);
      }, stallMs);
    };
    try {
      const upstream = await relayProviderRequest(request, env, fetchImpl, token, stallMs || undefined, gone.signal, record, state, queries);
      if (!upstream) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (!upstream.body) return response.end();
      arm();
      for await (const chunk of upstream.body) {
        arm();
        response.write(chunk);
      }
      response.end();
    } catch (error) {
      if (error instanceof CarryRefused && !state.carryRefused.has(state.governing)) state.carryRefused.set(state.governing, error.message);
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify({ error: { type: 'relay_error', message: String(error?.message ?? error) } })}\n`);
    } finally {
      clearTimeout(idle);
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    if (socket) server.listen(socket, () => resolvePromise());
    else server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!socket && (!address || typeof address === 'string')) throw new Error('provider relay did not bind TCP');
  let closed = false;
  return {
    url: socket ? '' : `http://127.0.0.1:${typeof address === 'object' ? address?.port : ''}`,
    socket,
    govern: (dir, session = '') => {
      state.session = session;
      state.held = governedAt(dir);
      state.completion = null;
      state.governing = dir;
    },
    settled: () => state.held?.talk.settled() ?? null,
    drained: () => state.completion,
    carryRefused: (dir) => state.carryRefused.get(dir) ?? '',
    restart: () => {
      if (state.held) state.held = { ...state.held, talk: talkOf(state.held.governed) };
      state.completion = null;
    },
    close: () => new Promise((resolvePromise) => {
      if (closed) {
        resolvePromise();
        return;
      }
      closed = true;
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    }),
  };
}
