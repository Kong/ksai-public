import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { OPENCODE_V2_VERSION, SESSION_EVENT } from '../lib/opencode-v2.mjs';
import lock from '../vendor/opencode-client/package-lock.json' with { type: 'json' };
import manifest from '../vendor/opencode-client/package.json' with { type: 'json' };

export const CLIENT = new URL('../vendor/opencode-client/node_modules/@opencode/client/dist/promise/index.js', import.meta.url);

const CLIENT_VERSION = String(lock.packages?.['node_modules/@opencode/client']?.version ?? '');

const PINNED_CLIENT = String(manifest.dependencies?.['@opencode/client'] ?? '');

export function clientProblem(client = CLIENT_VERSION, engine = OPENCODE_V2_VERSION, pinned = PINNED_CLIENT) {
  if (pinned !== engine) return `the vendored @opencode/client is pinned to ${pinned || 'nothing'}, and this driver speaks to OpenCode ${engine}`;
  return client === engine ? '' : `the vendored @opencode/client is ${client || 'unpinned'}, and this driver speaks to OpenCode ${engine}`;
}

const STOPPED = 143;

const SERVE_ARGS = Object.freeze(['serve', '--stdio', '--port', '0', '--print-logs', '--log-level', 'warn']);

const DROPPED = /\.delta$|^session\.step\.streamed$|^session\.reasoning\./;

const TERMINAL = Object.freeze({
  'session.execution.succeeded': 0,
  'session.execution.failed': 1,
  'session.execution.interrupted': 1,
});

export function modelRef(model, variant = '') {
  const id = String(model ?? '').trim();
  if (!id) throw new Error('MODEL names no model');
  const chosen = String(variant ?? '').trim();
  return { providerID: 'anthropic', id, ...(chosen ? { variant: chosen } : {}) };
}

export function expectedPlugins(config) {
  const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
  return {
    files: plugins.filter((one) => one && typeof one === 'object' && typeof one.package === 'string').map((one) => join(one.package, 'index.mjs')),
    removed: plugins.filter((one) => typeof one === 'string' && one.startsWith('-')).map((one) => one.slice(1)),
  };
}

export function inventoryProblem(listed, expected) {
  const plugins = Array.isArray(listed) ? listed : [];
  for (const file of expected.files) {
    const found = plugins.find((one) => one?.source?.path === file);
    if (!found) return `the plugin at ${file} was not loaded (${plugins.length} plugins listed), and OpenCode drops a plugin it cannot load without a word`;
    if (found.state?.status !== 'active') return `the plugin at ${file} is ${found.state?.status ?? 'in no state'}: ${String(found.state?.error?.message ?? found.state?.error ?? '').slice(0, 300)}`;
  }
  for (const id of expected.removed) {
    if (plugins.some((one) => one?.id === id)) return `the built-in plugin ${id} is still loaded although the config removes it`;
  }
  return '';
}

const SETTLED = new Set(['active', 'failed']);

const sleep = (ms) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

const settledIn = (plugins, files) => plugins.length > 0 && files.every((file) => SETTLED.has(plugins.find((one) => one?.source?.path === file)?.state?.status));

export async function settledInventory(list, expected, { timeoutMs = 30_000, everyMs = 200, now = Date.now, pause = sleep } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const listed = await list();
    const plugins = Array.isArray(listed?.data) ? listed.data : [];
    if (settledIn(plugins, expected.files) || now() >= deadline) return plugins;
    await pause(everyMs);
  }
}

export function recorder(root, parentID = '') {
  const tree = new Set([root]);
  const lines = [{ type: SESSION_EVENT, created: Date.now(), data: { sessionID: root, parentID: null, resumed: parentID !== '' } }];
  return {
    tree,
    accept(event) {
      const data = event?.data;
      const session = typeof data?.sessionID === 'string' ? data.sessionID : '';
      if (event?.type === 'session.created' && session && tree.has(String(data.parentID ?? ''))) {
        tree.add(session);
        return [{ type: SESSION_EVENT, created: event.created, data: { sessionID: session, parentID: data.parentID } }];
      }
      if (!session || !tree.has(session) || DROPPED.test(String(event.type))) return [];
      return [{ type: event.type, created: event.created, data }];
    },
    opening: () => lines,
    ended(event) {
      if (event?.data?.sessionID !== root) return null;
      return Object.hasOwn(TERMINAL, event.type) ? TERMINAL[event.type] : null;
    },
  };
}

export function forward(socketPath, listen = createServer, connect = createConnection) {
  return new Promise((resolvePromise, reject) => {
    const server = listen((socket) => {
      const upstream = connect(socketPath);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const close = () =>
        new Promise((done) => {
          server.close(() => done());
        });
      resolvePromise({ url: `http://127.0.0.1:${port}`, close });
    });
  });
}

const line = (value) => `${JSON.stringify(value)}\n`;

function startServer(env, launch = spawn) {
  const password = randomBytes(32).toString('base64url');
  const server = launch('opencode', SERVE_ARGS, {
    env: { ...env, OPENCODE_PASSWORD: password },
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: process.cwd(),
  });
  const ready = new Promise((resolvePromise, reject) => {
    const lines = createInterface({ input: server.stdout });
    lines.once('line', (said) => {
      try {
        resolvePromise(JSON.parse(said).url);
      } catch {
        reject(new Error('the OpenCode server announced no address'));
      }
    });
    server.once('exit', (code) => reject(new Error(`the OpenCode server exited before it was ready (${code})`)));
    server.once('error', reject);
  });
  const exited = new Promise((done) => {
    server.once('exit', () => done());
  });
  const stop = async () => {
    server.stdin.end();
    const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  };
  return { ready, password, stop };
}

async function connected(env) {
  const problem = clientProblem();
  if (problem) throw new Error(problem);
  const { OpenCode } = await import(CLIENT.href);
  const server = startServer(env);
  const url = await server.ready;
  const client = OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}` } });
  return { client, url, server };
}

async function relays(env) {
  const opened = [];
  const extra = {};
  if (env.KSAI_PROVIDER_SOCKET) {
    const provider = await forward(env.KSAI_PROVIDER_SOCKET);
    opened.push(provider);
    extra.KSAI_PROVIDER_RELAY = provider.url;
  }
  if (env.KSAI_OTEL_SOCKET) {
    const otel = await forward(env.KSAI_OTEL_SOCKET);
    opened.push(otel);
    extra.OTEL_EXPORTER_OTLP_ENDPOINT = otel.url;
  }
  return { extra, close: () => Promise.all(opened.map((one) => one.close())) };
}

function controlLines(input) {
  const pending = [];
  const waiting = [];
  const push = (said) => {
    const next = waiting.shift();
    if (next) next(said);
    else pending.push(said);
  };
  const lines = createInterface({ input });
  lines.on('line', (said) => {
    try {
      push(JSON.parse(said));
    } catch {}
  });
  lines.on('close', () => {
    while (waiting.length) waiting.shift()({ stop: 'closed' });
    pending.push({ stop: 'closed' });
  });
  const next = () =>
    pending.length
      ? Promise.resolve(pending.shift())
      : new Promise((resolvePromise) => {
          waiting.push(resolvePromise);
        });
  return Object.assign(next, {
    push,
    close: () => {
      lines.close();
      input.destroy?.();
    },
  });
}

const reachable = (target, connect = createConnection) =>
  new Promise((done) => {
    const socket = connect(target);
    socket.setTimeout(5000, () => {
      socket.destroy();
      done(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });

export async function networkProblem(port, env = process.env, connect = createConnection) {
  if (!env.KSAI_PROVIDER_SOCKET) return 'no provider relay socket is bound into the sandbox';
  if (await reachable({ host: '127.0.0.1', port: Number(port) }, connect)) return `the runner's loopback port ${port} is reachable from the engine sandbox`;
  for (const name of ['KSAI_PROVIDER_SOCKET', 'KSAI_OTEL_SOCKET']) {
    if (env[name] && !(await reachable({ path: env[name] }, connect))) return `${name} does not answer inside the sandbox`;
  }
  return '';
}

export async function run(env = process.env, { input = process.stdin, output = process.stdout, signals = process } = {}) {
  const write = (value) =>
    new Promise((done) => {
      if (output.write(line(value))) done();
      else output.once('drain', done);
    });
  const next = controlLines(input);
  const signalled = () => next.push({ stop: 'signal' });
  signals.once('SIGTERM', signalled);
  const first = await next();
  if (typeof first?.prompt !== 'string' || !first.prompt.trim()) {
    signals.off('SIGTERM', signalled);
    next.close();
    await write({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.driver', message: 'the driver was handed no prompt' } } });
    return 1;
  }
  const opened = await relays(env);
  const { client, server } = await connected({ ...env, ...opened.extra });
  const controller = new AbortController();
  let code = 1;
  try {
    const directory = process.cwd();
    const config = JSON.parse(readFileSync(String(env.OPENCODE_CONFIG ?? ''), 'utf8'));
    const model = modelRef(env.MODEL, env.VARIANT);
    const resumed = String(env.KSAI_RESUME_SESSION ?? '').trim();
    const agent = String(env.KSAI_AGENT ?? '').trim();
    const session = resumed
      ? await client.session.fork({ sessionID: resumed })
      : await client.session.create({ location: { directory }, model, ...(agent ? { agent } : {}) });
    if (resumed && agent) await client.session.switchAgent({ sessionID: session.id, agent });
    if (resumed) await client.session.switchModel({ sessionID: session.id, model });
    await client.session.update({ sessionID: session.id, title: 'ksai' });
    const expected = expectedPlugins(config);
    const problem = inventoryProblem(await settledInventory(() => client.plugin.list({ location: { directory } }), expected), expected);
    if (problem) {
      await write({ type: 'ksai.error', created: Date.now(), data: { sessionID: session.id, error: { type: 'ksai.plugins', message: problem } } });
      return 1;
    }
    const record = recorder(session.id, resumed);
    for (const one of record.opening()) await write(one);
    const feed = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    await feed.next();
    const finished = (async () => {
      for (;;) {
        const step = await feed.next().catch(() => ({ done: true }));
        if (step.done) return 1;
        const event = step.value;
        if (event?.type === 'permission.asked' && record.tree.has(String(event.data?.sessionID ?? ''))) {
          await client.permission.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: 'reject' }).catch(() => {});
        }
        for (const one of record.accept(event)) await write(one);
        const ended = record.ended(event);
        if (ended !== null) return ended;
      }
    })();
    const stopped = next().then(async (said) => {
      if (!said?.stop) return null;
      await client.session.interrupt({ sessionID: session.id }).catch(() => {});
      return STOPPED;
    });
    await client.session.prompt({ sessionID: session.id, text: first.prompt, files: [], delivery: 'steer' });
    code = await Promise.race([finished, stopped.then((one) => (one === null ? finished : one))]);
    if (code === STOPPED) await Promise.race([finished, sleep(10_000)]);
    return code;
  } catch (error) {
    await write({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.driver', message: String(error?.message ?? error).slice(0, 500) } } });
    return 1;
  } finally {
    signals.off('SIGTERM', signalled);
    controller.abort();
    next.close();
    await server.stop();
    await opened.close();
  }
}

export async function transfer(command, argument, env = process.env, { output = process.stdout } = {}) {
  const { client, url, server } = await connected(env);
  try {
    if (command === 'export') {
      output.write(`${JSON.stringify(await client.session.export({ sessionID: argument }))}\n`);
      return 0;
    }
    if (command === 'import') {
      const location = await client.location.get({ location: { directory: process.cwd() } });
      const response = await fetch(new URL('/api/experimental/session/import', url), {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(readFileSync(argument, 'utf8')), location: { directory: location.directory } }),
      });
      if (!response.ok) throw new Error(`the session was not imported: ${response.status}`);
      const imported = await response.json();
      const data = imported && typeof imported === 'object' && 'data' in imported ? imported.data : null;
      const id = data && typeof data === 'object' && 'id' in data ? data.id : '';
      if (typeof id !== 'string' || !id) throw new Error('the import named no session');
      output.write(`${id}\n`);
      return 0;
    }
    throw new Error(`unknown driver command ${command}`);
  } finally {
    await server.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command = 'run', argument = ''] = process.argv.slice(2);
  try {
    if (command === 'probe') {
      const problem = await networkProblem(argument);
      if (problem) console.error(problem);
      process.exitCode = problem ? 1 : 0;
    } else process.exitCode = command === 'run' ? await run() : await transfer(command, argument);
  } catch (error) {
    console.error(`opencode driver: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
