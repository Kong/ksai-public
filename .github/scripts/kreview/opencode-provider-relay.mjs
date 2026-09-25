import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { authHeaders, bearer } from '../lib/opencode-token.mjs';
import { promptRendering } from '../lib/cp-prompts.mjs';
import { canonical } from '../governance/artifacts.mjs';
import { conversation, MAX_RESPONSE_BYTES } from '../governance/conversation.mjs';
import { governRequest } from '../governance/provider.mjs';
import { originProblem } from './federated-token.mjs';

const REQUEST_BYTES = 32 * 1024 * 1024;
const OBSERVATION_BYTES = 256 * 1024 * 1024;
const digestOf = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function governedArtifact(root, digest, model, depth = 0) {
  if (depth > 4) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = governedArtifact(path, digest, model, depth + 1);
      if (found) return found;
    }
    if (entry.name !== 'expect.json' || !entry.isFile()) continue;
    const expected = JSON.parse(readFileSync(path, 'utf8'));
    if (expected.finalDigest !== digest || expected.model !== model) continue;
    const prompt = readFileSync(join(root, 'prompt.md'), 'utf8');
    if (digestOf(prompt) !== digest) throw new Error('the governed artifact differs from its expected digest');
    const tools = new Map();
    for (const file of readdirSync(join(root, 'tools'))) {
      if (!/^[a-z][a-z0-9_-]{0,63}\.json$/.test(file)) throw new Error('the governed tool directory contains an unexpected file');
      const tool = JSON.parse(readFileSync(join(root, 'tools', file), 'utf8'));
      if (tool.name !== file.slice(0, -5) || !Array.isArray(tool.description_lines)) throw new Error('the governed tool is malformed');
      tools.set(tool.name, { name: tool.name, description: tool.description_lines.join('\n'), schema: canonical(tool.input_schema) });
    }
    return { prompt, model, tools };
  }
  return null;
}

export function enforceGovernedRequest(body, env, state = null) {
  const root = String(env.KSAI_GOVERNED_DIR ?? '');
  if (!root) throw new Error('a governed provider request has no trusted artifacts');
  const request = JSON.parse(body.toString('utf8'));
  const first = request.messages?.[0];
  const prompt = first?.role === 'user' && first.content?.[0]?.type === 'text' ? first.content[0].text : '';
  const governed = governedArtifact(root, digestOf(prompt), request.model);
  if (!governed) throw new Error('the provider request names no governed prompt this run rendered');
  const talk = state?.talk ?? conversation(governed.prompt, governed.model, [...governed.tools.keys()]);
  const accepted = governRequest(body.toString('utf8'), governed, talk);
  if (state) state.talk = talk;
  return Buffer.from(accepted);
}

async function finishGovernedResponse(response, talk) {
  if (!response.ok || !response.body) {
    talk.failed();
    return;
  }
  const reader = response.clone().body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('the provider response exceeds the governed limit');
      chunks.push(Buffer.from(value));
    }
    talk.response(Buffer.concat(chunks));
  } catch (error) {
    talk.failed();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function recordProviderRequest(body, env) {
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
    id, mode, model: request.model, prompt_digest: text ? digestOf(text) : '',
    request_digest: digestOf(body), request_bytes: body.length, status: 0,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const retained = mode === 'cp' ? Buffer.from(JSON.stringify({ messages: request.messages.slice(1) })) : body;
  const used = readdirSync(root).filter((name) => /\.(body|dynamic)$/.test(name))
    .reduce((size, name) => size + statSync(join(root, name)).size, 0);
  if (used + retained.length > OBSERVATION_BYTES) throw new Error('provider observations exceed the run storage limit');
  writeFileSync(join(root, `${id}.${mode === 'cp' ? 'dynamic' : 'body'}`), retained, { mode: 0o600, flag: 'wx' });
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

export async function relayProviderRequest(request, env, fetchImpl = fetch, token = bearer, timeoutMs = 10 * 60_000, gone = new AbortController().signal, record = null, state = null) {
  const origin = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (originProblem(origin)) throw new Error(`provider relay received an invalid origin: ${originProblem(origin)}`);
  const target = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method !== 'POST' || target.pathname !== '/v1/messages' || target.search) return null;
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
      body = enforceGovernedRequest(body, env, state);
      talk = state?.talk;
    }
    const completed = record?.(body, env);
    const upstream = await fetchImpl(`${origin}${target.pathname}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([abort.signal, gone]),
    });
    completed?.(upstream.status);
    if (talk) state.completion = finishGovernedResponse(upstream, talk).then(() => null, (error) => error);
    return upstream;
  } catch (error) {
    talk?.failed();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** startProviderRelay keeps the bearer and provider origin outside the model process. */
export async function startProviderRelay({ env = process.env, fetchImpl = fetch, token = bearer, record = env.KSAI_PROVIDER_OBSERVATIONS === 'true' ? recordProviderRequest : null } = {}) {
  const state = { talk: null, completion: null };
  const server = createServer(async (request, response) => {
    const gone = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) gone.abort(new Error('provider relay client closed the request'));
    });
    try {
      const upstream = await relayProviderRequest(request, env, fetchImpl, token, undefined, gone.signal, record, state);
      if (!upstream) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (!upstream.body) return response.end();
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify({ error: { type: 'relay_error', message: String(error?.message ?? error) } })}\n`);
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider relay did not bind TCP');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
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
