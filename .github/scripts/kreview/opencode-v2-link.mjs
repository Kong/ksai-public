import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { digest } from '../governance/artifacts.mjs';
import { linkTrust, verifyLinkCertificate } from '../governance/link-certificate.mjs';
import { planToolsDigest, resumeTrust, verifyResumePermit } from '../governance/resume-permit.mjs';
import { VERSION, declaredFields, keyId, open, rawPublicKey, sign } from '../link/link-protocol.mjs';
import { connected, expectedPlugins, importedSession, inventoryProblem, modelRef, recorder, relays, settledInventory } from './opencode-v2-driver.mjs';
import { sessionPlanPolicy } from './link-session-policy.mjs';
import { GOVERNED_FILE, GOVERNED_UNDER, LINK_ASKS, PLUGIN_ENTRY } from './link-governed.mjs';

const DIRECTIVES = new Set(['note', 'stop', 'stop.enforce']);
const STOPPED = 143;
const EXPORT_MS = 15_000;
const CLOSE_MS = 5_000;
export const EXPORT_FILE = 'session.export.json';
export const SESSION_FILE = 'opencode-session';
export const RESUME_EXPORT = 'resume.export.json';
export const RESUME_ERROR = 'resume-error';
export const CARRY_REFUSED = LINK_ASKS.carry;

export function carryRefusedIn(dir) {
  try {
    return readFileSync(join(dir, CARRY_REFUSED), 'utf8').trim();
  } catch {
    return '';
  }
}
const RESUME_ERROR_BYTES = 200;
const GRACE_MS = 10_000;

export function resumeError(error) {
  let said = String(error?.message ?? error).replace(/[\0\s]+/g, ' ').trim() || 'the carried session was refused';
  while (Buffer.byteLength(said) > RESUME_ERROR_BYTES) said = said.slice(0, -1);
  return said;
}

const ranOn = (variant) => (variant === '' || variant === undefined || variant === null ? 'default' : variant);

export function carriedSession(env, plan, binding, dir, now = new Date()) {
  const original = plan.resume?.original;
  if (typeof original?.text !== 'string' || !original.text) throw new Error('the plan carries no original render to go on from');
  const permit = verifyResumePermit(plan.resume.permit, resumeTrust(env.KSAI_CP_ENDPOINT, pinsOf(env)), {
    repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: binding.job, link: binding.link,
    model: plan.model.id, variant: plan.variant ?? '', toolsDigest: planToolsDigest(plan),
    continuation: digest(Buffer.from(plan.prompt.text, 'utf8')), original: digest(Buffer.from(original.text, 'utf8')),
  }, now);
  const bytes = readFileSync(join(dir, RESUME_EXPORT));
  if (bytes.length !== permit.export.bytes || createHash('sha256').update(bytes).digest('hex') !== permit.export.sha256) {
    throw new Error('the carried export is not the one the permit names');
  }
  const held = JSON.parse(bytes.toString('utf8'));
  if (held?.info?.id !== permit.modelSession) throw new Error('the carried export is of another OpenCode session');
  const ran = held.info.model ?? {};
  if (ran.id !== plan.model.id || ranOn(ran.variant) !== ranOn(plan.variant)) throw new Error('the carried session ran another model');
  const messages = Array.isArray(held.messages) ? held.messages : [];
  const answered = messages.findLast((one) => one?.type === 'assistant');
  if (messages.at(-1)?.type !== 'idle' || messages.at(-1)?.outcome !== 'succeeded' || answered?.finish !== 'stop') {
    throw new Error('the carried session did not end on a finished answer');
  }
  return { permit, exported: held };
}

const line = (value) => `${JSON.stringify(value)}\n`;

export function lines(socket) {
  const pending = [];
  const waiting = [];
  let closed = false;
  createInterface({ input: socket }).on('line', (said) => {
    let parsed;
    try {
      parsed = JSON.parse(said);
    } catch {
      return;
    }
    const next = waiting.shift();
    if (next) next(parsed);
    else pending.push(parsed);
  });
  socket.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  return () => (pending.length ? Promise.resolve(pending.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => {
    waiting.push(resolve);
  }));
}

export function laidPlugin(entry, plan, { read = readFileSync, exists = existsSync } = {}) {
  const at = dirname(entry);
  const modules = plan.statics.filter((one) => String(one.destination ?? '').startsWith(GOVERNED_UNDER));
  if (!entry || !modules.some((one) => one.destination === `${GOVERNED_UNDER}${PLUGIN_ENTRY}`) || join(at, PLUGIN_ENTRY) !== entry) {
    throw new Error('the plan carries no governed plugin for the path the OpenCode config loads it from');
  }
  for (const one of modules) {
    let held;
    try {
      held = read(join(at, one.destination.slice(GOVERNED_UNDER.length)), 'utf8');
    } catch {
      throw new Error(`the host laid no ${one.destination}, so OpenCode would load a plugin the plan does not carry`);
    }
    if (held !== one.body) throw new Error(`the laid ${one.destination} is not the one the plan carries`);
  }
  if (!exists(join(dirname(at), GOVERNED_FILE))) throw new Error('the host laid no governed session for the plugin to read');
}

export function writeDirective(dir, message) {
  const at = join(dir, `${message.seq}.json`);
  writeFileSync(`${at}.part`, JSON.stringify({ kind: message.kind, template: message.body.template, values: message.body.values }), { mode: 0o600 });
  renameSync(`${at}.part`, at);
}

export const contextAsked = (asked) => declaredFields('plugin', 'engine', 'context.ask', asked, ['session']);

const pinsOf = (env) => (env.KSAI_TRUST_PINS ? JSON.parse(env.KSAI_TRUST_PINS) : undefined);

export const retryReply = (body) => ({ retry: body.retry, delay_ms: body.delay_ms });
export const contextReply = (body) => (body.error === undefined ? { manifest: body.manifest } : { error: body.error });

export function questions(path, name, ask, reply) {
  const waiting = new Map();
  const held = new Set();
  let asks = 0;
  const server = createServer((socket) => {
    held.add(socket);
    socket.once('close', () => held.delete(socket));
    createInterface({ input: socket }).once('line', (said) => {
      let asked;
      try {
        asked = JSON.parse(said);
      } catch {
        socket.destroy();
        return;
      }
      asks += 1;
      const id = `${name}/${asks}`;
      waiting.set(id, socket);
      socket.once('close', () => waiting.delete(id));
      ask(id, asked);
    });
  });
  return {
    listening: new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve(undefined));
    }),
    answer(id, body) {
      const socket = waiting.get(id);
      waiting.delete(id);
      socket?.end(line(reply(body)));
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of held) socket.destroy();
    }),
  };
}

export const driverError = (error) => ({
  type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.driver', message: [...String(error?.message ?? error)].slice(0, 500).join('') } },
});

export const feedEnded = (error) => driverError(`the OpenCode event stream ended before the session did${error ? `: ${error?.message ?? error}` : ''}`);

export async function linked(env = process.env, {
  connect = createConnection, output = process.stdout, signals = process, openRelays = relays, connectModel = connected,
} = {}) {
  const socket = connect(String(env.KSAI_LINK_SOCKET ?? ''));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const next = lines(socket);
  const tell = (value) => socket.write(line(value));
  const write = (value) =>
    new Promise((done) => {
      if (output.write(line(value))) done();
      else output.once('drain', done);
    });
  const key = generateKeyPairSync('ed25519').privateKey;
  tell({ type: 'hello', session: String(env.KSAI_LINK_SESSION ?? ''), key: rawPublicKey(key).toString('base64') });

  const hello = await next();
  if (hello?.type !== 'link') throw new Error('the host named no link');
  const session = String(env.KSAI_LINK_SESSION ?? '');
  const certificate = verifyLinkCertificate(hello.cert, linkTrust(env.KSAI_CP_ENDPOINT, pinsOf(env)), {
    repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: hello.job, link: hello.link,
  });
  const want = { link: hello.link, job: hello.job, epoch: 0, to: 'plugin', signers: { [keyId(certificate.raw)]: { party: 'engine', key: certificate.key } } };
  let last = 0;
  let seq = 0;
  const say = (kind, id, body) => {
    seq += 1;
    tell({ type: 'frame', frame: sign(key, { v: VERSION, link: hello.link, job: hello.job, epoch: 0, from: 'plugin', to: 'engine', seq, ack: 0, id, kind, body }) });
  };
  const heard = async () => {
    for (;;) {
      const said = await next();
      if (said === null) return null;
      if (said.type !== 'frame') continue;
      const message = open(said.frame, want);
      if (message.body.session !== session || message.seq <= last) continue;
      last = message.seq;
      return message;
    }
  };

  const first = await heard();
  if (first?.kind !== 'plan') throw new Error(`the engine sent ${first?.kind ?? 'nothing'} before a plan`);
  const plan = first.body;
  try {
    sessionPlanPolicy(env, plan);
  } catch (error) {
    socket.end();
    throw error;
  }
  const dir = String(env.KSAI_LINK_DIR ?? '');
  const refusedResume = async (error) => {
    const said = resumeError(error);
    writeFileSync(join(dir, RESUME_ERROR), said, { mode: 0o600 });
    await write({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.resume', message: said } } });
    return 1;
  };
  let carrying = null;
  if (plan.resume) {
    try {
      carrying = carriedSession(env, plan, hello, dir);
    } catch (error) {
      socket.end();
      return refusedResume(error);
    }
  }
  try {
    laidPlugin(String(env.KSAI_GOVERNED_PLUGIN ?? ''), plan);
  } catch (error) {
    socket.end();
    throw error;
  }
  const notes = join(dir, LINK_ASKS.notes);
  mkdirSync(notes, { recursive: true, mode: 0o700 });
  const retry = questions(join(dir, LINK_ASKS.retry), 'retry', (id, asked) => say('retry.ask', id, { ...asked, session }), retryReply);
  const context = questions(join(dir, LINK_ASKS.context), 'context', (id, asked) => say('context.ask', id, { session, ...contextAsked(asked) }), contextReply);
  await Promise.all([retry.listening, context.listening]);

  const opened = await openRelays(env);
  const connection = await connectModel({ ...env, ...opened.extra });
  const { client, server } = connection;
  const controller = new AbortController();
  let code = 1;
  let signalled = null;
  const stop = new Promise((resolve) => {
    signalled = resolve;
  });
  signals.once('SIGTERM', () => signalled('signal'));
  let opencodeSession = null;
  try {
    const directory = process.cwd();
    const config = JSON.parse(readFileSync(String(env.OPENCODE_CONFIG ?? ''), 'utf8'));
    const expected = expectedPlugins(config);
    const listed = await settledInventory(() => client.plugin.list({ location: { directory } }), expected);
    const problem = inventoryProblem(listed, expected);
    if (problem) {
      await write({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.plugins', message: problem } } });
      return 1;
    }
    if (carrying) {
      try {
        const id = await importedSession(connection, carrying.exported, directory);
        if (id !== carrying.permit.modelSession) throw new Error('the import named another OpenCode session');
        opencodeSession = { id };
      } catch (error) {
        return await refusedResume(error);
      }
    } else {
      opencodeSession = await client.session.create({ location: { directory }, model: modelRef(plan.model.id, plan.variant) });
    }
    await client.session.update({ sessionID: opencodeSession.id, title: plan.title });
    say('ready', '', { session, inventory: listed.map((one) => String(one?.id ?? '')).filter(Boolean).slice(0, 64) });
    const record = recorder(opencodeSession.id, '', Boolean(carrying));
    for (const one of record.opening()) await write(one);
    const feed = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    await feed.next();
    const finished = (async () => {
      for (;;) {
        const step = await feed.next().catch((error) => ({ done: true, error }));
        if (step.done) {
          if (!controller.signal.aborted) await write(feedEnded(step.error));
          return 1;
        }
        const event = step.value;
        if (event?.type === 'permission.asked' && record.tree.has(String(event.data?.sessionID ?? ''))) {
          await client.permission.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: 'reject' }).catch(() => {});
        }
        for (const one of record.accept(event)) await write(one);
        const ended = record.ended(event);
        if (ended !== null) return ended;
      }
    })();
    const directed = (async () => {
      for (;;) {
        const message = await Promise.race([heard(), stop.then(() => ({ kind: 'interrupt' }))]);
        if (message === null || message.kind === 'interrupt') {
          await client.session.interrupt({ sessionID: opencodeSession.id }).catch(() => {});
          return STOPPED;
        }
        if (DIRECTIVES.has(message.kind)) writeDirective(notes, message);
        if (message.kind === 'retry.answer') retry.answer(message.id, message.body);
        if (message.kind === 'context.answer') context.answer(message.id, message.body);
      }
    })();
    await client.session.prompt({ sessionID: opencodeSession.id, text: plan.prompt.text, files: [], delivery: 'steer' });
    code = await Promise.race([finished, directed]);
    if (code === STOPPED) {
      await Promise.race([finished, new Promise((resolve) => {
        setTimeout(resolve, GRACE_MS);
      })]);
    }
    const replayed = carrying && code !== 0 && code !== STOPPED ? carryRefusedIn(dir) : '';
    if (replayed) {
      opencodeSession = null;
      return await refusedResume(`the governor refused the carried history: ${replayed}`);
    }
    return code;
  } catch (error) {
    await write(driverError(error));
    return 1;
  } finally {
    const ending = opencodeSession;
    await closedDown({
      abort: () => controller.abort(),
      asking: () => Promise.all([retry.close(), context.close()]),
      exporting: () => (ending ? exported(client, ending.id, dir) : undefined),
      stopping: () => server.stop(),
      relaying: () => opened.close(),
      linking: () => new Promise((resolve) => {
        socket.end(() => resolve(undefined));
      }),
    });
  }
}

export function bounded(closing, within = CLOSE_MS) {
  let timer = null;
  const given = new Promise((resolve) => {
    timer = setTimeout(resolve, within);
  });
  return Promise.race([closing, given]).finally(() => clearTimeout(timer));
}

const survived = (step) => Promise.resolve().then(step).catch(() => {});

export async function closedDown({ abort, asking, exporting, stopping, relaying, linking }, within = CLOSE_MS) {
  await survived(abort);
  await bounded(survived(asking), within);
  await survived(exporting);
  await survived(stopping);
  await bounded(survived(relaying), within);
  await bounded(survived(linking), within);
}

export async function exported(client, id, dir) {
  try {
    const stalled = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('the export stalled')), EXPORT_MS).unref();
    });
    const held = await Promise.race([client.session.export({ sessionID: id }), stalled]);
    writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(held), { mode: 0o600 });
  } catch {}
  writeFileSync(join(dir, SESSION_FILE), id, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await linked();
  } catch (error) {
    console.error(`opencode link: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
  process.exit();
}
