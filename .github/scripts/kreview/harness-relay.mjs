import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

import { runMain } from '../lib/main.mjs';
import {
  endGroup, factsFileOf, groupLeaderMatches, groupStart, readHarnessInput, recordGroup, RELAY_DIR_ENV, RELAY_LINE, relayLogOf, RELAY_STEP,
  SETUP_STEP_IDS, stateDirOf, stepFailure, writeHarnessResult,
} from '../ksai/harness/contract.mjs';
import { connectOwned } from '../ksai/harness/owner.mjs';

const BUFFER_BYTES = 64 * 1024;
const ALLOW = 'start';
const LISTENING = 'listening';
const deadline = () => Object.assign(new Error('the harness relay start deadline expired'), { exitCode: 124 });

export async function relayConnection(inbound, { owner, instance, address, port }, deadlineAt, connect) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const held = [];
  let bytes = 0;
  const buffer = (chunk) => {
    bytes += chunk.length;
    if (bytes >= BUFFER_BYTES) {
      abort();
      inbound.destroy();
    } else {
      held.push(chunk);
    }
  };
  if (inbound.destroyed) return;
  inbound.once('close', abort);
  inbound.once('error', abort);
  inbound.on('data', buffer);
  inbound.resume();
  let upstream;
  try {
    if (Date.now() >= deadlineAt) return;
    upstream = await connect(owner, instance, { address, port, deadlineAt, signal: controller.signal });
    if (controller.signal.aborted || inbound.destroyed || Date.now() >= deadlineAt) return;
    inbound.off('data', buffer);
    for (const chunk of held) upstream.write(chunk);
    const reply = pipeline(upstream, inbound);
    if (inbound.readableEnded) {
      upstream.end();
      await reply;
    } else {
      await Promise.all([pipeline(inbound, upstream), reply]);
    }
  } catch {
    abort();
  } finally {
    inbound.destroy();
    upstream?.destroy();
  }
}

async function listen(path, receive) {
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, receive);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  return server;
}

async function serveRelay(dir, connect) {
  const channel = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = channel[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  const { endpoints, kill_at: killAt } = JSON.parse(first.value);
  const pending = [];
  const servers = [];
  const startup = { permitted: false };
  const receive = (endpoint) => (socket) => {
    if (startup.permitted) void relayConnection(socket, endpoint, killAt, connect);
    else {
      socket.on('error', () => socket.destroy());
      pending.push({ socket, endpoint });
    }
  };
  try {
    for (const endpoint of endpoints) {
      const server = await listen(join(dir, `${endpoint.sandbox_port}.sock`), receive(endpoint));
      servers.push(server);
    }
    process.stdout.write(`${LISTENING}\n`);
    const permission = await lines.next();
    if (permission.value !== ALLOW) return;
    startup.permitted = true;
    for (const { socket, endpoint } of pending) void relayConnection(socket, endpoint, killAt, connect);
    pending.length = 0;
  } finally {
    channel.close();
    process.stdin.destroy();
    if (!startup.permitted) {
      for (const { socket } of pending) socket.destroy();
      for (const server of servers) server.close();
    }
  }
}

function relayConfig(planned, facts, killAt) {
  const sandboxPorts = new Set();
  const observed = new Map(facts.endpoints.map((fact) => [fact.endpoint, fact]));
  const endpoints = planned.map(({ owner, address, port, sandbox_port }, index) => {
    if (address !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(sandbox_port) || sandbox_port < 1024 || sandbox_port > 65535 || sandboxPorts.has(sandbox_port)) {
      throw new Error('invalid harness relay endpoint');
    }
    sandboxPorts.add(sandbox_port);
    const fact = observed.get(index);
    if (fact?.owned !== true || !fact.instance) throw new Error('a harness endpoint has no recorded owner');
    return { owner, address, port, sandbox_port, instance: fact.instance };
  });
  if (observed.size !== endpoints.length || observed.size !== facts.endpoints.length || facts.failure) {
    throw new Error('invalid harness relay facts');
  }
  return { endpoints, kill_at: killAt };
}

function awaitListening(child, config, due, now) {
  return new Promise((resolve, reject) => {
    const stop = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      if (error) reject(error);
      else resolve(undefined);
    };
    let line = '';
    const onData = (chunk) => {
      line += chunk.toString();
      if (line === `${LISTENING}\n`) stop(now() >= due ? deadline() : null);
      else if (!`${LISTENING}\n`.startsWith(line)) stop(new Error('invalid harness relay startup response'));
    };
    const timer = setTimeout(() => stop(deadline()), Math.max(0, due - now()));
    child.stdout.on('data', onData);
    child.stdout.once('error', stop);
    child.stdin.once('error', stop);
    child.once('error', stop);
    child.once('exit', () => stop(new Error('the harness relay exited before permission')));
    child.stdin.write(`${JSON.stringify(config)}\n`);
  });
}

export async function startRelay({ endpoints, facts_file: factsFile, start_deadline_at: due, kill_at: killAt }, {
  env, launch, now, nonce, record, entry, readStart = groupStart, checkLeader = groupLeaderMatches, kill = process.kill,
}) {
  if (!Number.isSafeInteger(due) || due <= 0 || !Number.isSafeInteger(killAt) || killAt < due) {
    throw new Error('invalid harness relay deadlines');
  }
  if (now() >= due) throw deadline();
  const temp = env.RUNNER_TEMP;
  const run = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const suffix = nonce();
  if (!isAbsolute(temp ?? '') || !/^\d+$/.test(run) || !/^\d+$/.test(attempt) || !/^[a-f0-9]{16}$/.test(suffix)) {
    throw new Error('invalid harness relay directory inputs');
  }
  const state = stateDirOf(temp);
  const root = `/tmp/ksai-relay-${run}-${attempt}-${suffix}`;
  const dir = join(root, 'harness-ports');
  if (Buffer.byteLength(join(dir, '65535.sock')) >= 90) throw new Error('the harness relay socket path is too long');
  if (factsFile !== factsFileOf(state) || !Array.isArray(endpoints)) throw new Error('invalid harness relay input');
  const config = relayConfig(endpoints, JSON.parse(readFileSync(factsFile, 'utf8')), killAt);
  let child;
  let started = null;
  let created = false;
  try {
    record(state, { step: RELAY_STEP, dir: root });
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      record(state, { step: RELAY_STEP, dir: null });
      throw error;
    }
    created = true;
    mkdirSync(dir, { mode: 0o700 });
    const log = openSync(relayLogOf(state), 'wx', 0o600);
    try {
      if (now() >= due) throw deadline();
      const { PATH, HOME, DOCKER_HOST, DOCKER_CONFIG } = env;
      child = launch(process.execPath, [entry, 'start', '--serve', dir], {
        env: { PATH, HOME, DOCKER_HOST, DOCKER_CONFIG }, detached: true, stdio: ['pipe', 'pipe', log],
      });
      child.on('error', () => {});
    } finally {
      closeSync(log);
    }
    if (!child.pid) throw new Error('the harness relay did not start');
    started = readStart(child.pid);
    if (!started) throw new Error('the harness relay exited before start');
    record(state, { step: RELAY_STEP, pgid: child.pid, started });
    await awaitListening(child, config, due, now);
    if (now() >= due) throw deadline();
    await new Promise((resolve, reject) => {
      child.stdin.end(`${ALLOW}\n`, (error) => { if (error) reject(error); else resolve(undefined); });
    });
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${RELAY_DIR_ENV}=${dir}\n`);
    child.stdin.destroy();
    child.stdout.destroy();
    child.unref();
    return { ok: true, [RELAY_DIR_ENV]: dir };
  } catch (error) {
    try {
      try {
        if (child?.pid && started && child.exitCode === null && child.signalCode === null && checkLeader(child.pid, started)) {
          endGroup(child.pid, kill);
        }
      } catch {}
    } finally {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.unref();
      if (created) rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function runRelay({ connectOwned: connect, argv = process.argv.slice(2), entry = import.meta.filename,
  env = process.env, launch = spawn, now = Date.now, nonce = () => randomBytes(8).toString('hex'), record = recordGroup,
  readStart = groupStart, checkLeader = groupLeaderMatches, kill = process.kill,
}) {
  if (typeof connect !== 'function') throw new Error('a relay requires an endpoint owner check');
  if (argv[0] !== 'start') throw new Error('unknown harness relay mode');
  if (argv[1] === '--serve' && argv.length === 3) return serveRelay(argv[2], connect);
  if (argv.length !== 1) throw new Error('invalid harness relay arguments');
  let result;
  let code = 0;
  try {
    result = await startRelay(readHarnessInput(), { env, launch, now, nonce, record, entry, readStart, checkLeader, kill });
    process.stdout.write(`${RELAY_LINE}${result[RELAY_DIR_ENV]}\n`);
  } catch (error) {
    code = error.exitCode === 124 ? 124 : 1;
    result = { ok: false, failure: stepFailure(SETUP_STEP_IDS.relay, code) };
  }
  writeHarnessResult(result);
  process.exitCode = code;
  return result;
}

await runMain(import.meta.url, async () => { await runRelay({ connectOwned }); });
