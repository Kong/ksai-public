'use strict';

const READ_TIMEOUT_MS = 15_000;
const READ_TRIES = 3;
const READS = new Set(['GET', 'HEAD']);
const GRAPHQL_WRITES = /\b(?:mutation|subscription)\b/i;
const BODY_READS = ['arrayBuffer', 'json', 'text'];

function isRead(options) {
  const method = String(options.method ?? 'GET').toUpperCase();
  if (READS.has(method)) return true;
  return method === 'POST'
    && String(options.url ?? '').endsWith('/graphql')
    && typeof options.query === 'string'
    && !GRAPHQL_WRITES.test(options.query);
}

function boundReads(github, { core, timeout = READ_TIMEOUT_MS }) {
  let tries = READ_TRIES;
  github.hook.wrap('request', async (request, options) => {
    if (!isRead(options)) return request(options);
    const base = options.request ?? {};
    const fetch = base.fetch ?? globalThis.fetch;
    for (let attempt = 1; ; attempt += 1) {
      const timers = new Set();
      let latest = /** @type {AbortSignal | null} */ (null);
      const bounded = async (url, init = {}) => {
        const deadline = new AbortController();
        latest = deadline.signal;
        const timer = setTimeout(() => deadline.abort(), timeout);
        timers.add(timer);
        const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
        let response;
        try {
          response = await fetch(url, { ...init, signal });
        } catch (err) {
          if (!deadline.signal.aborted) clearTimeout(timer);
          throw err;
        }
        for (const read of BODY_READS) {
          const original = response[read].bind(response);
          response[read] = () => original().finally(() => clearTimeout(timer));
        }
        return response;
      };
      options.request = { ...base, fetch: bounded };
      const cut = () => latest?.aborted === true;
      let failure;
      try {
        const answer = await request(options);
        base.signal?.throwIfAborted();
        if (!cut()) return answer;
      } catch (err) {
        if (!cut() || base.signal?.aborted) throw err;
        failure = err;
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
      const said = `GitHub did not answer ${options.method} ${options.url} within ${timeout / 1000}s`;
      if (attempt >= tries) {
        tries = 1;
        throw new Error(`${said}, after ${attempt} ${attempt === 1 ? 'try' : 'tries'}`, { cause: failure ?? latest?.reason });
      }
      core.warning(`${said}, so it is asked again`);
    }
  });
}

module.exports = { boundReads, READ_TIMEOUT_MS, READ_TRIES };
