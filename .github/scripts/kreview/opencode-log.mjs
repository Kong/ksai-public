import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { answer, collectSecrets, endedOn, everything, executionLog, parsed, scrub, spending } from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { sessionEvents } from './opencode-children.mjs';
import { lspToolMetrics } from './opencode-lsp.mjs';
import { gatewayDiagnostics, streamFailure } from './opencode-review.mjs';
import { reviewProtocol } from './review-protocol.mjs';

const require = createRequire(import.meta.url);
const { carriesWhole } = require('../lib/review-output.cjs');

const eventsFile = process.env.OPENCODE_EVENTS_FILE;
const executionFile = process.env.OPENCODE_EXECUTION_FILE;

if (!executionFile) {
  console.log('::error::OPENCODE_EXECUTION_FILE names no path, so this run would report nothing it spent');
  process.exit(1);
}

let raw = '';
try {
  raw = readFileSync(eventsFile, 'utf8');
} catch (why) {
  console.log(`::warning::no readable opencode event stream at ${eventsFile || '(unset)'}: ${why.message}`);
}

const secrets = collectSecrets(process.env);

// The stream is scrubbed first, before anything that can throw. It was rewritten last, so a full
// RUNNER_TEMP answering ENOSPC on the execution file left the raw stream on disk - and the upload
// step publishes it on `always()`, so the failure that lost the log also published the secrets.
if (eventsFile) {
  writeFileSync(eventsFile, scrub(raw, secrets));
  writeOutputs(process.env.GITHUB_OUTPUT, {
    events_file: eventsFile,
  });
}

const events = parsed(raw);
const eventLines = raw.split('\n').filter((line) => line.trim());
const completeEventStream = eventLines.length > 0 && eventLines.length === events.length;

/*
 * A review's structured output is a contract, and the turn it lands in is the model's choice. `answer`
 * returns the last turn that spoke, so a reviewer that wrote its findings and then said one more thing
 * would publish the sentence and lose the review - the same failure as a fragment, on a run that ended
 * cleanly. Only the review flow has that contract, and only a run whose last turn does not carry it
 * falls back to every turn joined.
 */
const said = answer(events);
const recovered = process.env.FLOW === 'review' && events.filter((event) => event.type === 'ksai_review_attempt').length > 1;
const whole = process.env.FLOW === 'review' && !process.env.OPENCODE_REVIEW_FILE && !recovered ? everything(events) : null;
const carries = carriesWhole(said, whole);
if (carries) {
  console.log('::warning::the reviewer wrote its findings before its last turn, so the whole run is published');
}
const children = process.env.OPENCODE_CHILDREN_FILE ? JSON.parse(readFileSync(process.env.OPENCODE_CHILDREN_FILE, 'utf8')) : null;
const staged = ['evidence', 'dual'].includes(process.env.REVIEW_STRATEGY);
const allEvents = [...events, ...(children?.events ?? [])];
const childToolEvents = (children?.sessions ?? []).flatMap((session) => sessionEvents(session)).filter((event) => event.type === 'tool_use');
const completeToolTelemetry = completeEventStream && children !== null && children.missing === 0;
const runtime = (() => {
  try {
    const value = JSON.parse(process.env.OPENCODE_RUNTIME_METRICS || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
})();
const log = executionLog({
  events: allEvents,
  exitCode: Number(process.env.OPENCODE_EXIT ?? 1),
  secrets,
  said: process.env.OPENCODE_REVIEW_FILE ? readFileSync(process.env.OPENCODE_REVIEW_FILE, 'utf8') : staged || recovered ? null : carries ? whole : said,
});
Object.assign(log[0], { opencode_runtime: runtime });
if (process.env.KSAI_PTY_METRICS_FILE) {
  try {
    const metrics = JSON.parse(readFileSync(process.env.KSAI_PTY_METRICS_FILE, 'utf8'));
    Object.assign(metrics, { tokens: log[0].usage, duration_ms: log[0].duration_ms });
    Object.assign(log[0], { opencode_pty: metrics });
  } catch (why) {
    console.log(`::warning::no readable PTY pilot metrics: ${why.message}`);
  }
}
if (process.env.FLOW === 'review') {
  Object.assign(log[0], { review_protocol: reviewProtocol({
    env: process.env,
    read: readFileSync,
    events,
    staged,
    runtime,
    measured: children?.sessions.length ?? null,
    unmeasured: children?.missing ?? null,
    clean: !events.some((event) => event.type === 'error'),
    complete: completeEventStream,
    spent: spending(events).length > 0,
    gatewayFailures: gatewayDiagnostics(events),
    lsp: completeToolTelemetry ? {
      ...lspToolMetrics([...allEvents, ...childToolEvents]),
      peak_rss_kb: runtime?.peak_rss_kb ?? null,
      lingering_processes: runtime?.lingering_processes ?? null,
      invocations: runtime?.invocations ?? [],
    } : null,
  }) });
}

writeFileSync(executionFile, JSON.stringify(log, null, 2) + '\n');

const [result] = log;
const failure = endedOn(events);
if (failure) {
  console.log(`::warning::the opencode stream recorded ${scrub(failure, secrets)}`);
}
/*
 * A gateway failure to reach its upstream is not a model failure: the run ends with a server error, nothing sent and nothing billed.
 */
if (streamFailure(events)?.kind === 'gateway-unavailable') {
  console.log(
    '::warning::the endpoint answered a server error before anything was sent, which is the gateway ' +
      'or what it proxies to rather than the model: no tokens were spent, and the reason is in the ' +
      "gateway's own logs",
  );
}
if (streamFailure(events)?.kind === 'empty-turn') {
  console.log(
    '::warning::the last model turn spent output tokens and delivered no text and no tool call, which is ' +
      'the response lost between the model and opencode rather than the model finishing',
  );
}
if (answer(events) === null) {
  console.log(`::warning::${events.length} opencode events carried no text, so this run posts no review`);
}
console.log(
  `opencode: ${events.length} events, ${result.num_turns} steps, ` +
    `${result.usage.output_tokens} output tokens -> ${executionFile}`,
);
