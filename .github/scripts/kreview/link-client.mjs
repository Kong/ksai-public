import { generateKeyPairSync, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Cursor, GapError, LinkRefused, SUBPROTOCOL, VERSION, keyId, linkId, open, publicKeyOf, rawPublicKey, sign } from '../lib/link-protocol.mjs';

export const CLOSED = Object.freeze({ normal: 1000, restart: 1012, refused: 4001, protocol: 4002, key: 4003, gap: 4008, superseded: 4009, ended: 4010 });

const FINAL = /** @type {Set<number>} */ (new Set([CLOSED.key, CLOSED.ended]));
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CEILING_MS = 8000;
const WEBSOCKET_TRIES = 2;
const WATCH_MS = 1000;
const TOKEN_MARGIN_MS = 60_000;
const HANDSHAKE_MS = 30_000;
const CLOSE_GRACE_MS = 1000;

export class LinkEnded extends Error {
  constructor(code, reason) {
    super(`the link ended (${code}): ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

class Closed extends Error {
  constructor(code, reason) {
    super(`the connection closed (${code}): ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

const reasonOf = (signal) => (signal.reason instanceof Error ? signal.reason : new Closed(1006, 'the connection was given up'));

async function within(promise, signal) {
  let abort = () => {};
  const aborted = new Promise((_, reject) => {
    abort = () => reject(reasonOf(signal));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  aborted.catch(() => {});
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function farewellOf(reason) {
  const farewell = { reason, sent: false, grace: undefined };
  farewell.settled = new Promise((resolve) => {
    farewell.settle = () => {
      clearTimeout(farewell.grace);
      resolve();
    };
  });
  return farewell;
}

async function closedIfLate(opening, signal) {
  try {
    const opened = await opening;
    if (signal.aborted) opened.close(CLOSED.normal, 'the host gave up on this connection');
  } catch {}
}

function inbox() {
  const pending = [];
  const waiting = [];
  let ended = null;
  return {
    push(item) {
      if (ended) return;
      const next = waiting.shift();
      if (next) next(item);
      else pending.push(item);
    },
    end(code, reason) {
      if (ended) return;
      ended = { closed: { code, reason } };
      while (waiting.length) waiting.shift()(ended);
    },
    next() {
      if (pending.length) return Promise.resolve(pending.shift());
      if (ended) return Promise.resolve(ended);
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}

export function websocketTransport(endpoint, { connect = (url, init) => new WebSocket(url, init), asks = {} } = {}) {
  const url = `${String(endpoint).replace(/^http/, 'ws').replace(/\/$/, '')}/v1/run/link`;
  return {
    name: 'websocket',
    open({ token, hello, signal = new AbortController().signal }) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(reasonOf(signal));
          return;
        }
        const socket = connect(url, { protocols: [SUBPROTOCOL], headers: { ...asks, authorization: `Bearer ${token}` } });
        const frames = inbox();
        let opened = false;
        signal.addEventListener('abort', () => {
          socket.close(CLOSED.normal, 'the host gave up on this connection');
          frames.end(1006, 'the host gave up on this connection');
          if (!opened) reject(reasonOf(signal));
        }, { once: true });
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          if (socket.protocol !== SUBPROTOCOL) {
            socket.close(CLOSED.protocol, 'a link speaks ' + SUBPROTOCOL);
            reject(new Closed(CLOSED.protocol, `the engine speaks ${socket.protocol || 'no subprotocol'}`));
            return;
          }
          opened = true;
          socket.send(hello);
          resolve({
            next: () => frames.next(),
            send: async (frame) => socket.send(frame),
            prove: async (frame) => socket.send(frame),
            close: (code = CLOSED.normal, reason = '') => socket.close(code, reason),
          });
        });
        socket.addEventListener('message', (event) => {
          frames.push({ frame: typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8') });
        });
        socket.addEventListener('close', (event) => {
          frames.end(event.code, event.reason);
          if (!opened) reject(new Closed(event.code || 1006, event.reason || 'the websocket did not open'));
        });
        socket.addEventListener('error', () => {
          if (!opened) reject(new Closed(1006, 'the websocket did not open'));
        });
      });
    },
  };
}

async function framesOf(response) {
  const said = await response.json();
  return Array.isArray(said) ? said : [];
}

function closeOf(response) {
  const code = Number(response.headers.get('ksai-link-close'));
  return Number.isInteger(code) && code > 0 ? code : response.status === 503 ? CLOSED.restart : CLOSED.protocol;
}

export function pollTransport(endpoint, job, { fetch = globalThis.fetch, holdMs = 30_000, asks = {} } = {}) {
  const base = `${String(endpoint).replace(/\/$/, '')}/v1/run/link`;
  const post = (path, token, body, signal) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { ...asks, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal });
  return {
    name: 'poll',
    async open({ token, hello, cursors, fresh, signal = new AbortController().signal }) {
      const claimed = payloadOf(hello);
      const hostRaw = Buffer.from(String(claimed.body?.key), 'base64');
      const signers = { [keyId(hostRaw)]: { party: 'host', key: publicKeyOf(hostRaw) } };
      const greeting = open(hello, { link: claimed.link, job, epoch: 1, to: 'engine', signers });
      if (greeting.kind !== 'hello' || greeting.body.transport !== 'poll') throw new LinkRefused('link: a polling connection needs a signed polling hello');
      const opened = await post('/open', token, hello, AbortSignal.any([signal, AbortSignal.timeout(holdMs)]));
      if (!opened.ok) throw new Closed(closeOf(opened), (await opened.text()).trim());
      if (signal.aborted) throw reasonOf(signal);
      const frames = inbox();
      for (const frame of await within(framesOf(opened), signal)) frames.push({ frame: JSON.stringify(frame) });
      const stopped = new AbortController();
      const stop = (code, reason) => {
        signal.removeEventListener('abort', upstream);
        stopped.abort(new Closed(code, reason));
        frames.end(code, reason);
      };
      const upstream = () => {
        const error = reasonOf(signal);
        stop(error.code ?? 1006, error.reason ?? error.message);
      };
      if (signal.aborted) upstream();
      else signal.addEventListener('abort', upstream, { once: true });
      let epoch = 0;
      const query = (extra) => `?${new URLSearchParams({ job, epoch: String(epoch), ...extra })}`;
      const receiving = async (proof) => {
        while (!stopped.signal.aborted) {
          try {
            const { after, plugin_after: pluginAfter } = cursors();
            const bearer = await within(fresh(), stopped.signal);
            if (stopped.signal.aborted) return;
            const answered = await post(`/receive${query({ after: String(after), plugin_after: String(pluginAfter) })}`, bearer, proof, AbortSignal.any([stopped.signal, AbortSignal.timeout(holdMs)]));
            if (!answered.ok) {
              stop(closeOf(answered), (await answered.text()).trim());
              return;
            }
            for (const frame of await framesOf(answered)) frames.push({ frame: JSON.stringify(frame) });
          } catch (error) {
            if (!stopped.signal.aborted) stop(1006, String(error?.message ?? error));
            return;
          }
        }
      };
      const sendOne = async (frame) => {
        if (stopped.signal.aborted) throw reasonOf(stopped.signal);
        try {
          const bearer = await within(fresh(), stopped.signal);
          if (stopped.signal.aborted) throw reasonOf(stopped.signal);
          const answered = await post(`/send${query({})}`, bearer, frame, AbortSignal.any([stopped.signal, AbortSignal.timeout(holdMs)]));
          if (!answered.ok) {
            const code = closeOf(answered);
            const reason = (await answered.text()).trim();
            stop(code, reason);
            throw new Closed(code, reason);
          }
          for (const reply of await framesOf(answered)) frames.push({ frame: JSON.stringify(reply) });
        } catch (error) {
          if (!stopped.signal.aborted) {
            const ended = error instanceof Closed ? error : new Closed(1006, String(error?.message ?? error));
            stop(ended.code, ended.reason);
          }
          throw error;
        }
      };
      let sending = Promise.resolve();
      let heartbeating = null;
      let queuedPing = null;
      const sendHeartbeat = (frame) => {
        queuedPing = frame;
        if (heartbeating) return heartbeating;
        const active = (async () => {
          try {
            while (queuedPing !== null && !stopped.signal.aborted) {
              const next = queuedPing;
              queuedPing = null;
              await sendOne(next);
            }
          } finally {
            heartbeating = null;
            queuedPing = null;
          }
        })();
        heartbeating = active;
        return active;
      };
      return {
        next: () => frames.next(),
        async send(frame) {
          if (stopped.signal.aborted) throw reasonOf(stopped.signal);
          let message;
          try {
            message = payloadOf(frame);
          } catch {}
          if (message?.kind === 'ping') {
            open(frame, { link: greeting.link, job, epoch, to: 'engine', signers });
            return sendHeartbeat(frame);
          }
          const sent = sending.then(() => sendOne(frame));
          sending = sent.catch(() => {});
          if (message?.kind === 'bye') sent.then(() => stop(CLOSED.normal, 'bye')).catch(() => {});
          return sent;
        },
        async prove(frame, at) {
          if (stopped.signal.aborted) throw reasonOf(stopped.signal);
          epoch = at;
          receiving(frame);
        },
        close(code = CLOSED.normal, reason = '') {
          stop(code, reason);
        },
      };
    },
  };
}

const payloadOf = (frame) => {
  const envelope = JSON.parse(frame);
  return JSON.parse(Buffer.from(String(envelope.payload), 'base64').toString('utf8'));
};

const expiryOf = (token) => {
  try {
    return Number(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp) * 1000 || 0;
  } catch {
    return 0;
  }
};

export function linkClient({
  endpoint, repository, runId, attempt, job, mint, verifyCertificate, runner, jobStartedAt = Date.now(),
  onMessage, onPlugin = (_session, _frame, _message) => {}, onLapse, onEnded = (_error) => {}, onTick = () => {}, onAcked = (_message) => {}, onWelcome = (_body) => {}, log = (_said) => {},
  transports = { websocket: websocketTransport(endpoint), poll: pollTransport(endpoint, job) },
  clock = () => performance.now(), wall = Date.now, pause = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
  bootstrapMs = 300_000, handshakeMs = HANDSHAKE_MS, key = generateKeyPairSync('ed25519').privateKey, jitter = (ceiling) => randomInt(0, Math.max(1, ceiling)),
  every = (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
}) {
  const link = linkId({ repository, runId, attempt, job });
  const raw = rawPublicKey(key);
  const hostCursor = new Cursor();
  const pluginCursor = new Cursor();
  const pending = [];
  const relayed = new Map();
  let seq = 0;
  let epoch = 0;
  let signers = null;
  let conn = null;
  let leaseUntil = 0;
  let pingEvery = 20_000;
  let pingN = 0;
  const pinged = new Map();
  let lagMs = 0;
  let stopped = false;
  let welcomed = false;
  let token = '';
  let dialing = null;
  let farewell = null;

  const fresh = async () => {
    if (token === '' || expiryOf(token) - TOKEN_MARGIN_MS < wall()) token = await mint();
    return token;
  };

  const signed = (message) => sign(key, { v: VERSION, link, job, from: 'host', to: 'engine', ack: 0, ...message });

  const transmit = async (message) => conn?.send(signed({ ...message, epoch }));

  const bid = (connection) => {
    const ending = dialing;
    farewell.sent = true;
    clearTimeout(farewell.grace);
    farewell.grace = setTimeout(() => ending?.abort(new Closed(1006, `the engine did not settle the link in ${CLOSE_GRACE_MS} ms`)), CLOSE_GRACE_MS);
    Promise.resolve().then(() => connection.send(signed({ epoch, seq: 0, kind: 'bye', body: { reason: farewell.reason } }))).catch(() => {});
  };

  const welcomeOf = (frame) => {
    const peeked = payloadOf(frame);
    if (peeked.kind !== 'welcome') throw new LinkRefused(`link: the engine opened with ${peeked.kind}, not a welcome`);
    const certificate = verifyCertificate(peeked.body?.cert, { repository, runId, attempt, job, link });
    signers = { [keyId(certificate.raw)]: { party: 'engine', key: certificate.key } };
    return open(frame, { link, job, epoch: peeked.epoch, to: 'host', signers });
  };

  const adopt = (welcome) => {
    epoch = welcome.epoch;
    const { resume, ping_every_ms: pingMs, lease_ms: leaseMs } = welcome.body;
    pingEvery = pingMs;
    if (!welcomed) leaseUntil = clock() + leaseMs;
    welcomed = true;
    while (pending.length && pending[0].seq <= resume.acked) onAcked(pending.shift());
    for (const [session, frames] of relayed) {
      const acked = resume.plugins.find((one) => one.session === session)?.acked ?? 0;
      relayed.set(session, frames.filter((one) => one.seq > acked));
    }
    const replayed = [...pending.map((message) => transmit(message)), ...[...relayed.values()].flat().map((one) => conn.send(one.frame))];
    onWelcome(welcome.body);
    return Promise.all(replayed);
  };

  const received = (frame) => {
    const peeked = payloadOf(frame);
    if (peeked.to === 'plugin') {
      const message = open(frame, { link, job, epoch, to: 'plugin', signers });
      if (pluginCursor.accept(message.seq)) onPlugin(message.body.session, frame, message);
      return;
    }
    if (Number.isInteger(peeked.epoch) && peeked.epoch < epoch) {
      open(frame, { link, job, epoch: peeked.epoch, to: 'host', signers });
      return;
    }
    const message = open(frame, { link, job, epoch, to: 'host', signers });
    while (pending.length && pending[0].seq <= message.ack) onAcked(pending.shift());
    if (message.kind === 'lease') {
      const sent = pinged.get(message.body.n);
      pinged.delete(message.body.n);
      if (sent !== undefined) leaseUntil = Math.max(leaseUntil, sent + message.body.lease_ms);
      return;
    }
    if (message.kind === 'reconnect') throw new Closed(CLOSED.restart, 'the engine asked for a new connection');
    if (hostCursor.accept(message.seq)) onMessage(message);
  };

  const pingOn = (connection, now) => {
    pingN += 1;
    pinged.set(pingN, now);
    connection.send(signed({ epoch, seq: 0, kind: 'ping', body: { n: pingN, runner_wall_ms: wall(), loop_lag_ms: lagMs } })).catch(() => {});
  };

  const pinging = (connection) => {
    let last = clock();
    return every(pingEvery, () => {
      const now = clock();
      lagMs = Math.max(0, Math.round(now - last - pingEvery));
      last = now;
      pingOn(connection, now);
      onTick();
    });
  };

  const connectOnce = async (transport, reached) => {
    const hello = signed({
      epoch: 1, seq: 0, kind: 'hello',
      body: {
        key: raw.toString('base64'), transport: transport.name,
        resume: { acked: hostCursor.last, plugin_acked: pluginCursor.last }, job_elapsed_ms: Math.max(0, wall() - jobStartedAt), runner,
      },
    });
    const giving = new AbortController();
    dialing = giving;
    if (farewell) farewell.sent = false;
    const deadline = setTimeout(() => giving.abort(new Closed(1006, `the ${transport.name} handshake did not finish in ${handshakeMs} ms`)), handshakeMs);
    let connection = null;
    let stop = () => {};
    try {
      token = await within(mint(), giving.signal);
      const opening = transport.open({
        token, hello, fresh, signal: giving.signal, cursors: () => ({ after: hostCursor.last, plugin_after: pluginCursor.last }),
      });
      closedIfLate(opening, giving.signal);
      connection = await within(opening, giving.signal);
      const first = await within(connection.next(), giving.signal);
      if (first.closed) throw new Closed(first.closed.code, first.closed.reason);
      const welcome = welcomeOf(first.frame);
      await within(connection.prove(signed({ epoch: welcome.epoch, seq: 0, kind: 'proof', body: { challenge: welcome.body.challenge } }), welcome.epoch), giving.signal);
      clearTimeout(deadline);
      conn = connection;
      const replayed = adopt(welcome);
      if (farewell) bid(connection);
      await within(replayed, giving.signal);
      reached();
      log(`linked over ${transport.name} on epoch ${epoch}`);
      stop = pinging(connection);
      for (;;) {
        const next = await within(connection.next(), giving.signal);
        if (next.closed) throw new Closed(next.closed.code, next.closed.reason);
        try {
          received(next.frame);
        } catch (error) {
          if (error instanceof GapError) {
            connection.close(CLOSED.gap, 'a message never arrived');
            throw new Closed(CLOSED.gap, 'a message never arrived');
          }
          throw error;
        }
      }
    } finally {
      clearTimeout(deadline);
      stop();
      conn = null;
      dialing = null;
      connection?.close(CLOSED.normal, 'the host is done with this connection');
    }
  };

  const lapsed = () => (welcomed ? clock() > leaseUntil : false);

  const giveUp = (why) => {
    stopped = true;
    conn?.close(CLOSED.normal, why);
    dialing?.abort(new Closed(CLOSED.normal, why));
    farewell?.settle();
    onLapse();
  };

  const run = async () => {
    const began = clock();
    let failures = 0;
    let restarts = 0;
    let websocketFailures = 0;
    const unwatch = every(WATCH_MS, () => {
      if (stopped) return;
      if (lapsed()) giveUp('lease');
      else if (!welcomed && clock() - began > bootstrapMs) giveUp('bootstrap');
    });
    try {
      while (!stopped) {
        if (!welcomed && clock() - began > bootstrapMs) {
          giveUp('bootstrap');
          return;
        }
        const transport = websocketFailures >= WEBSOCKET_TRIES ? transports.poll : transports.websocket;
        let code = 0;
        let linked = false;
        try {
          await connectOnce(transport, () => {
            linked = true;
          });
        } catch (error) {
          code = error instanceof Closed ? error.code : 1006;
          if (stopped) return;
          if (!farewell?.sent || code !== CLOSED.normal) log(`the ${transport.name} link dropped: ${error.message}`);
          if (error instanceof LinkRefused) code = CLOSED.protocol;
        }
        if (stopped) return;
        if (farewell && (farewell.sent && code === CLOSED.normal || FINAL.has(code) || lapsed())) {
          stopped = true;
          farewell.settle();
          return;
        }
        if (farewell) clearTimeout(farewell.grace);
        if (FINAL.has(code)) {
          stopped = true;
          onEnded(new LinkEnded(code, code === CLOSED.key ? 'another host holds this link' : 'the link has ended'));
          return;
        }
        if (transport === transports.websocket) websocketFailures = linked ? 0 : websocketFailures + 1;
        else if (linked) websocketFailures = 0;
        if (code === CLOSED.restart) {
          failures = 0;
          restarts = linked ? 1 : restarts + 1;
        } else {
          restarts = 0;
          failures += 1;
        }
        await pause(Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS + jitter(BACKOFF_FLOOR_MS * 2 ** Math.min(failures || restarts, 5))));
      }
    } finally {
      unwatch();
    }
  };

  return {
    link,
    key,
    start: () => run(),
    send(kind, id, body) {
      seq += 1;
      const message = { seq, id, kind, body };
      pending.push(message);
      if (conn) transmit(message).catch(() => {});
      return seq;
    },
    ping() {
      if (conn) pingOn(conn, clock());
    },
    relay(session, frame) {
      const { seq: at } = payloadOf(frame);
      const frames = relayed.get(session) ?? [];
      frames.push({ seq: at, frame });
      relayed.set(session, frames);
      if (conn) conn.send(frame).catch(() => {});
    },
    async close(reason) {
      if (!farewell) {
        farewell = farewellOf(reason);
        if (stopped || !welcomed) farewell.settle();
        else if (conn) bid(conn);
      }
      await farewell.settled;
      stopped = true;
      conn?.close(CLOSED.normal, farewell.reason);
      dialing?.abort(new Closed(CLOSED.normal, farewell.reason));
    },
  };
}
