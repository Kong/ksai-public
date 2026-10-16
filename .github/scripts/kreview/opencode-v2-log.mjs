import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { collectSecrets, parsed, scrub } from './opencode.mjs';
import { answer, endedOn, executionLog, retries, sessionOf } from './opencode-v2.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { annotation, counted } from '../lib/text.cjs';
import { streamFailure } from './opencode-v2-review.mjs';

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
  const secrets = collectSecrets(env);
  const notes = [];
  const said = answer(events);
  const result = env.OPENCODE_ANSWER_FILE ? read(env.OPENCODE_ANSWER_FILE, 'utf8') : said;
  const runtime = objectOf(env.OPENCODE_RUNTIME_METRICS);
  const log = executionLog({
    events,
    exitCode: Number(env.OPENCODE_EXIT ?? 1),
    secrets,
    said: result,
  });
  Object.assign(log[0], { opencode_runtime: runtime, opencode_retries: retries(events), engine_version: String(env.OPENCODE_VERSION ?? '') });
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
  if (result === null || result === '') notes.push(`::${level}::${counted(events.length, 'opencode event')} carried no text, so this stage returns no result`);
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
