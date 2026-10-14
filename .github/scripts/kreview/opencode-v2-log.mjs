import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { collectSecrets, parsed, scrub } from '../lib/opencode.mjs';
import { answer, endedOn, everything, executionLog, retries, sessionOf, spending } from '../lib/opencode-v2.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { annotation, counted } from '../lib/text.cjs';
import { childrenMeasured, gatewayDiagnostics, streamFailure } from './opencode-v2-review.mjs';
import { reviewProtocol } from './review-protocol.mjs';

const require = createRequire(import.meta.url);
const { carriesWhole } = require('../lib/review-output.cjs');

const objectOf = (text) => {
  try {
    const value = JSON.parse(text || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const relayRefusal = (events, session) => {
  const failed = (event) => (event?.type === 'session.execution.failed' || event?.type === 'session.step.failed') && sessionOf(event) === session;
  const body = events.findLast((event) => failed(event))?.data?.error?.response?.body;
  const error = objectOf(typeof body === 'string' ? body : '')?.error;
  return error?.type === 'relay_error' ? String(error.message ?? '') : null;
};

export function reduce(env, raw, read = readFileSync) {
  const events = parsed(raw);
  const lines = raw.split('\n').filter((one) => one.trim());
  const complete = lines.length > 0 && lines.length === events.length;
  const secrets = collectSecrets(env);
  const notes = [];
  const said = answer(events);
  const recovered = env.FLOW === 'review' && events.filter((event) => event.type === 'ksai_review_attempt').length > 1;
  const whole = env.FLOW === 'review' && !env.OPENCODE_REVIEW_FILE && !recovered ? everything(events) : null;
  const carries = carriesWhole(said, whole);
  if (carries) notes.push('::warning::the reviewer wrote its findings before its last turn, so the whole run is published');
  const staged = ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
  const runtime = objectOf(env.OPENCODE_RUNTIME_METRICS);
  const log = executionLog({
    events,
    exitCode: Number(env.OPENCODE_EXIT ?? 1),
    secrets,
    said: env.OPENCODE_REVIEW_FILE ? read(env.OPENCODE_REVIEW_FILE, 'utf8') : staged || recovered ? null : carries ? whole : said,
  });
  Object.assign(log[0], { opencode_runtime: runtime, opencode_retries: retries(events), engine_version: String(env.OPENCODE_VERSION ?? '') });
  if (env.KSAI_PTY_METRICS_FILE) {
    try {
      const metrics = JSON.parse(read(env.KSAI_PTY_METRICS_FILE, 'utf8'));
      Object.assign(log[0], { opencode_pty: { ...metrics, tokens: log[0].usage, duration_ms: log[0].duration_ms } });
    } catch (why) {
      notes.push(annotation(`no readable PTY pilot metrics: ${why.message}`, 'warning'));
    }
  }
  if (env.FLOW === 'review') {
    const children = childrenMeasured(events);
    Object.assign(log[0], { review_protocol: reviewProtocol({
      env,
      read,
      events,
      staged,
      runtime,
      measured: children.sessions,
      unmeasured: children.missing,
      clean: !events.some((event) => event.type === 'session.execution.failed' || event.type === 'ksai.error'),
      complete,
      spent: spending(events).length > 0,
      gatewayFailures: gatewayDiagnostics(events),
      lsp: null,
    }) });
  }
  const level = env.OPENCODE_STOPPED === 'true' ? 'notice' : 'warning';
  const failure = endedOn(events);
  if (failure) notes.push(annotation(`the opencode stream recorded ${scrub(failure, secrets)}`, level));
  const stream = streamFailure(events);
  const kind = stream?.kind;
  const relayed = kind === 'gateway-unavailable' ? relayRefusal(events, stream.session_id) : null;
  if (relayed !== null) {
    notes.push(annotation(`the runner's provider relay answered the last server error with its own reason: ${scrub(relayed, secrets)}`, 'warning'));
  } else if (kind === 'gateway-unavailable') {
    notes.push(
      "::warning::the endpoint answered a server error before anything was sent, which is the gateway or what it proxies to rather than the model: no tokens were spent, and the reason is in the gateway's own logs",
    );
  }
  if (kind === 'empty-turn') {
    notes.push('::warning::the last model turn spent output tokens and delivered no text and no tool call, which is the response lost between the model and opencode rather than the model finishing');
  }
  if (said === null) notes.push(`::${level}::${counted(events.length, 'opencode event')} carried no text, so this run posts no review`);
  notes.push(`opencode: ${counted(events.length, 'event')}, ${counted(log[0].num_turns, 'step')}, ${counted(log[0].usage.output_tokens, 'output token')} -> ${env.OPENCODE_EXECUTION_FILE}`);
  return { log, notes };
}

export function main(env = process.env) {
  if (!env.OPENCODE_EXECUTION_FILE) {
    console.log('::error::OPENCODE_EXECUTION_FILE names no path, so this run would report nothing it spent');
    return 1;
  }
  let raw = '';
  try {
    raw = readFileSync(env.OPENCODE_EVENTS_FILE, 'utf8');
  } catch (why) {
    console.log(annotation(`no readable opencode event stream at ${env.OPENCODE_EVENTS_FILE || '(unset)'}: ${why.message}`, 'warning'));
  }
  if (env.OPENCODE_EVENTS_FILE) {
    writeFileSync(env.OPENCODE_EVENTS_FILE, scrub(raw, collectSecrets(env)));
    writeOutputs(env.GITHUB_OUTPUT, { events_file: env.OPENCODE_EVENTS_FILE });
  }
  const { log, notes } = reduce(env, raw);
  writeFileSync(env.OPENCODE_EXECUTION_FILE, `${JSON.stringify(log, null, 2)}\n`);
  for (const one of notes) console.log(one);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
