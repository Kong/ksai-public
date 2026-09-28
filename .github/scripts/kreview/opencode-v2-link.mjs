import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { deliveriesAt, governanceOptions } from '../governance/anchors.mjs';
import { digest } from '../governance/artifacts.mjs';
import { linkTrust, verifyLinkCertificate } from '../governance/link-certificate.mjs';
import { NOTES_ID, TOOL_PREFIX_V2 } from '../governance/release.mjs';
import { VERSION, keyId, open, rawPublicKey, sign } from '../lib/link-protocol.mjs';
import { connected, expectedPlugins, inventoryProblem, modelRef, recorder, relays, settledInventory } from './opencode-v2-driver.mjs';

const REMINDER_ID = 'static.runtime.opencode-max-steps';
const DIRECTIVES = new Set(['note', 'stop', 'stop.enforce']);
const STOPPED = 143;
const EXPORT_MS = 15_000;
export const EXPORT_FILE = 'session.export.json';
export const SESSION_FILE = 'opencode-session';
const GRACE_MS = 10_000;

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

export function laidDown(dir, plan) {
  const artifacts = join(dir, 'artifacts');
  mkdirSync(join(artifacts, 'tools'), { recursive: true, mode: 0o700 });
  const statics = new Map(plan.statics.map((one) => [one.id, one.body]));
  writeFileSync(join(artifacts, 'prompt.md'), plan.prompt.text, { mode: 0o600 });
  writeFileSync(join(artifacts, 'render.sigstore.json'), JSON.stringify(plan.prompt.bundle), { mode: 0o600 });
  writeFileSync(join(artifacts, 'catalog.lock.json'), Buffer.from(plan.prompt.catalog.lock, 'base64'), { mode: 0o600 });
  writeFileSync(join(artifacts, 'catalog.sigstore.json'), Buffer.from(plan.prompt.catalog.attestation, 'base64'), { mode: 0o600 });
  for (const name of plan.tools) {
    const body = statics.get(`${TOOL_PREFIX_V2}${name}`);
    if (body === undefined) throw new Error(`the plan governs the ${name} tool and carries no definition of it`);
    writeFileSync(join(artifacts, 'tools', `${name}.json`), body, { mode: 0o600 });
  }
  if (plan.steps > 0) {
    const reminder = statics.get(REMINDER_ID);
    if (reminder === undefined) throw new Error('the plan limits the steps and carries no reminder');
    writeFileSync(join(artifacts, 'max-steps.json'), reminder, { mode: 0o600 });
  }
  const notes = statics.get(NOTES_ID);
  if (notes === undefined) throw new Error('the plan carries no run notes to say its directives in');
  writeFileSync(join(artifacts, 'link-notes.json'), notes, { mode: 0o600 });
  return artifacts;
}

export function writeDirective(dir, message) {
  const at = join(dir, `${message.seq}.json`);
  writeFileSync(`${at}.part`, JSON.stringify({ kind: message.kind, template: message.body.template, values: message.body.values }), { mode: 0o600 });
  renameSync(`${at}.part`, at);
}

export const contextAsked = (asked) => (Number.isSafeInteger(asked?.job_log_id) && asked.job_log_id > 0 ? { job_log_id: asked.job_log_id } : {});

const pinsOf = (env) => (env.KSAI_TRUST_PINS ? JSON.parse(env.KSAI_TRUST_PINS) : undefined);

export const retryReply = (body) => ({ retry: body.retry, delay_ms: body.delay_ms });
export const contextReply = (body) => (body.error === undefined ? { manifest: body.manifest } : { error: body.error });

export function questions(path, name, ask, reply) {
  const waiting = new Map();
  let asks = 0;
  const server = createServer((socket) => {
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
      for (const socket of waiting.values()) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

export function governed(env, dir, plan, artifacts, { retry = '', context = '', directory = process.cwd() } = {}) {
  if (!Number.isSafeInteger(plan.shell_timeout_ms) || plan.shell_timeout_ms <= 0) throw new Error('the plan bounds no shell call, so one could hold the run until the job is cancelled');
  const notes = join(dir, 'notes');
  mkdirSync(notes, { recursive: true, mode: 0o700 });
  const options = governanceOptions({
    endpoint: env.KSAI_CP_ENDPOINT,
    artifacts,
    report: deliveriesAt(String(env.KSAI_GOVERNED_DIR ?? '')),
    trustedRoot: String(env.KSAI_TRUSTED_ROOT ?? ''),
    expect: {
      promptId: String(env.KSAI_RENDER_PROMPT_ID ?? ''),
      sink: String(env.KSAI_RENDER_SINK ?? ''),
      model: plan.model.id,
      finalDigest: digest(Buffer.from(plan.prompt.text, 'utf8')),
      ...(plan.steps > 0 ? { steps: plan.steps } : {}),
    },
    tools: plan.tools,
    arm: '',
  }, pinsOf(env));
  writeFileSync(join(dir, 'governance.json'), JSON.stringify({ ...options, notes, nonce: plan.nonce, flow: String(env.FLOW ?? ''), directory, ...(retry ? { retry } : {}), ...(context ? { context } : {}) }), { mode: 0o600 });
  writeFileSync(join(dir, 'model.json'), JSON.stringify(plan.model), { mode: 0o600 });
  writeFileSync(join(dir, 'shell.json'), JSON.stringify({ timeout_ms: plan.shell_timeout_ms }), { mode: 0o600 });
  return notes;
}

export async function linked(env = process.env, { connect = createConnection, output = process.stdout, signals = process } = {}) {
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
  const dir = String(env.KSAI_LINK_DIR ?? '');
  const retrySocket = join(dir, 'retry.sock');
  const retry = questions(retrySocket, 'retry', (id, asked) => say('retry.ask', id, { ...asked, session }), retryReply);
  const contextSocket = join(dir, 'context.sock');
  const context = questions(contextSocket, 'context', (id, asked) => say('context.ask', id, { session, ...contextAsked(asked) }), contextReply);
  await Promise.all([retry.listening, context.listening]);
  const notes = governed(env, dir, plan, laidDown(dir, plan), { retry: retrySocket, context: contextSocket });

  const opened = await relays(env);
  const { client, server } = await connected({ ...env, ...opened.extra });
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
    opencodeSession = await client.session.create({ location: { directory }, model: modelRef(plan.model.id, plan.variant) });
    await client.session.update({ sessionID: opencodeSession.id, title: plan.title });
    say('ready', '', { session, inventory: listed.map((one) => String(one?.id ?? '')).filter(Boolean).slice(0, 64) });
    const record = recorder(opencodeSession.id);
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
    return code;
  } catch (error) {
    await write({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.driver', message: String(error?.message ?? error).slice(0, 500) } } });
    return 1;
  } finally {
    controller.abort();
    await Promise.all([retry.close(), context.close()]);
    if (opencodeSession) await exported(client, opencodeSession.id, dir);
    await server.stop();
    await opened.close();
    socket.end();
  }
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
}
