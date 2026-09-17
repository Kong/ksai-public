import { createServer } from 'node:http';

import { authHeaders, bearer } from '../lib/opencode-token.mjs';
import { originProblem } from './federated-token.mjs';

const REQUEST_BYTES = 32 * 1024 * 1024;

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

export async function relayProviderRequest(request, env, fetchImpl = fetch, token = bearer, timeoutMs = 10 * 60_000, gone = new AbortController().signal) {
  const origin = String(env.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (originProblem(origin)) throw new Error(`provider relay received an invalid origin: ${originProblem(origin)}`);
  const target = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method !== 'POST' || target.pathname !== '/v1/messages' || target.search) return null;
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
  try {
    return await fetchImpl(`${origin}${target.pathname}`, {
      method: 'POST',
      headers,
      body: await bodyOf(request),
      signal: AbortSignal.any([abort.signal, gone]),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** startProviderRelay keeps the bearer and provider origin outside the model process. */
export async function startProviderRelay({ env = process.env, fetchImpl = fetch, token = bearer } = {}) {
  const server = createServer(async (request, response) => {
    const gone = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) gone.abort(new Error('provider relay client closed the request'));
    });
    try {
      const upstream = await relayProviderRequest(request, env, fetchImpl, token, undefined, gone.signal);
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
