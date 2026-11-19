import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import controlPlane from '../lib/control-plane.cjs';
import { runMain } from '../lib/main.mjs';
import { annotation } from '../lib/text.cjs';
import { DEFAULT_SECRET_VARS, collectSecrets, scrub, withEscaped } from '../kreview/secrets.cjs';

const { answeredRetrying, mask, pausing, reachedFor } = controlPlane;

export const READ_MOST = 16 << 20;
export const SENT_MOST = 8 << 20;
export const UNPACKED_MOST = 32 << 20;
const TIMEOUT_MS = 20_000;
const END_RESERVE_MS = 15_000;
const NOT_KEPT = 404;

export const RUN_FILES = Object.freeze([
  { variable: 'EVENTS_FILE', name: 'opencode-events.jsonl', lines: true },
  { variable: 'EXECUTION_FILE', name: 'opencode-execution.json', lines: false },
]);

export const SECRET_VARS = Object.freeze([...DEFAULT_SECRET_VARS, 'OTEL_EXPORTER_OTLP_HEADERS']);

const SHAPES = Object.freeze([
  ['a GitHub token', /(?:gh[pousr]_[A-Za-z0-9_.-]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['a signed token', /(?<!(?<!\\|%[0-9A-Fa-f]|\\u[0-9A-Fa-f]{3})[A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
]);

export function secretsOf(env) {
  const bearers = [...String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').matchAll(/Bearer\s+([^,\s]+)/gi)]
    .map(([, value]) => ['OTEL_EXPORTER_OTLP_HEADERS', value])
    .filter(([, value]) => value.length > 8);
  return withEscaped([...collectSecrets(env, SECRET_VARS), ...bearers]);
}

export function redacted(text, secrets) {
  return SHAPES.reduce((out, [what, shape]) => out.replace(shape, `***redacted ${what}***`), scrub(text, secrets));
}

export function tailOf(path, most) {
  const size = statSync(path).size;
  if (size <= most) return { text: readFileSync(path, 'utf8'), dropped: 0 };
  const buffer = Buffer.alloc(most + 1);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, most + 1, size - most - 1);
  } finally {
    closeSync(fd);
  }
  const start = buffer.indexOf(0x0a) + 1;
  if (start === 0) return { text: '', dropped: size };
  return { text: buffer.subarray(start).toString('utf8'), dropped: size - most - 1 + start };
}

const truncated = (dropped) => ({ type: 'ksai.truncated', dropped_bytes: dropped });

export function packedFile(path, secrets, { readMost = READ_MOST, sentMost = SENT_MOST, unpackedMost = UNPACKED_MOST, lines = true } = {}) {
  for (let most = readMost; most > 0; most = Math.floor(most / 2)) {
    const { text, dropped } = tailOf(path, most);
    let kept = redacted(text, secrets);
    if (dropped > 0) kept = lines ? `${JSON.stringify(truncated(dropped))}\n${kept}` : JSON.stringify({ ...truncated(dropped), tail: kept });
    if (Buffer.byteLength(kept) > unpackedMost) continue;
    const body = gzipSync(kept);
    if (body.length <= sentMost) return { body, dropped };
  }
  const dropped = statSync(path).size;
  return { body: gzipSync(`${JSON.stringify(truncated(dropped))}\n`), dropped };
}

export function uploadWindow(env, now = Date.now()) {
  const minutes = Number(String(env.JOB_TIMEOUT_MINUTES ?? '').trim());
  if (!Number.isSafeInteger(minutes) || minutes < 1) return Infinity;
  const started = Number(env.KSAI_JOB_STARTED_AT_MS) || now;
  return minutes * 60_000 - Math.max(0, now - started) - END_RESERVE_MS;
}

export async function sendRunFiles({
  env = process.env, fetch = globalThis.fetch, pause = pausing, secret = mask, limits = {}, now = Date.now(),
  reach = (timeout) => reachedFor({ env, fetch, timeout, secret }), deadlineAfter = (ms) => AbortSignal.timeout(ms),
} = {}) {
  const present = RUN_FILES
    .map(({ variable, name, lines }) => ({ path: String(env[variable] ?? '').trim(), name, lines }))
    .filter(({ path }) => path !== '' && existsSync(path));
  if (present.length === 0) return { sent: [], failed: [], unkept: false };
  const window = uploadWindow(env, now);
  const failedAll = (why) => ({ sent: [], failed: present.map(({ name }) => [name, why]), unkept: false });
  if (window <= 0) return failedAll('the job had no time left to send it');
  const deadline = Number.isFinite(window) ? deadlineAfter(window) : undefined;
  const reached = await reach(Math.min(TIMEOUT_MS, window));
  if (reached.why) return failedAll(reached.why);
  const secrets = secretsOf(env);
  const bounded = deadline ? (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, deadline]) }) : fetch;
  const sent = [];
  const failed = [];
  for (const { path, name, lines } of present) {
    let body;
    try {
      ({ body } = packedFile(path, secrets, { ...limits, lines }));
    } catch (error) {
      failed.push([name, `it could not be read (${error.code ?? error.name})`]);
      continue;
    }
    const said = await answeredRetrying(bounded, `${reached.base}/v1/run/files/${name}`, {
      token: reached.token, body, timeout: TIMEOUT_MS, headers: { 'content-type': 'application/gzip' },
    }, (ms) => pause(ms, deadline));
    if (said.status === NOT_KEPT) return { sent, failed, unkept: true };
    if (said.why) failed.push([name, said.why]);
    else sent.push(name);
  }
  return { sent, failed, unkept: false };
}

await runMain(import.meta.url, async () => {
  try {
    const { sent, failed, unkept } = await sendRunFiles();
    if (unkept) console.log('the control plane keeps no run files');
    for (const [name, why] of failed) console.log(annotation(`Sending ${name} to the control plane failed: ${why}`, 'warning'));
    if (sent.length > 0) console.log(`sent ${sent.join(' and ')} to the control plane`);
  } catch (error) {
    console.log(annotation(`Sending the run files to the control plane failed: ${error.message}`, 'warning'));
  }
});
