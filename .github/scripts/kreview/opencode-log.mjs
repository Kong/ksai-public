import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { answer, collectSecrets, endedOn, everything, executionLog, parsed, scrub, spending } from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { gatewayDiagnostics, streamFailure } from './opencode-review.mjs';

const require = createRequire(import.meta.url);
const { extractReviewJson } = require('../lib/review-output.cjs');

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
const carries = whole !== null && said !== null && !extractReviewJson(said) && extractReviewJson(whole);
if (carries) {
  console.log('::warning::the reviewer wrote its findings before its last turn, so the whole run is published');
}
const children = process.env.OPENCODE_CHILDREN_FILE ? JSON.parse(readFileSync(process.env.OPENCODE_CHILDREN_FILE, 'utf8')) : null;
const staged = ['evidence', 'dual'].includes(process.env.REVIEW_STRATEGY);
const log = executionLog({
  events: [...events, ...(children?.events ?? [])],
  exitCode: Number(process.env.OPENCODE_EXIT ?? 1),
  secrets,
  said: process.env.OPENCODE_REVIEW_FILE ? readFileSync(process.env.OPENCODE_REVIEW_FILE, 'utf8') : staged || recovered ? null : carries ? whole : said,
});
if (process.env.FLOW === 'review') {
  const held = process.env.REVIEW_PIPELINE_FILE ? JSON.parse(readFileSync(process.env.REVIEW_PIPELINE_FILE, 'utf8')) : null;
  const completedCalls = held?.stages?.length > 0 && held.stages.every((stage) => stage.invocations?.length > 0 && stage.invocations.every((call) => call.exit_code === 0 && call.usage));
  const measuredExit = Number(process.env.OPENCODE_EXIT) === 0 || (staged && Number(process.env.OPENCODE_EXIT) === 1 && completedCalls);
  const { candidates = [], decisions = [], scope_plan: scopePlan, ...protocol } = held ?? {};
  const coverage = scopePlan ? { scope_plan: {
    version: scopePlan.version,
    digest: scopePlan.digest,
    total_files: scopePlan.total_files,
    total_units: scopePlan.total_units,
    omitted_units: scopePlan.omitted.length,
    scopes: scopePlan.scopes.map((scope) => ({
      id: scope.id, files: scope.files.length, units: scope.units.length,
      bytes: scope.bytes, lines: scope.lines, coverage: scope.coverage,
      completed_focuses: scope.completed_focuses,
    })),
  } } : {};
  const metadata = process.env.PROMPT_FILE ? JSON.parse(readFileSync(`${process.env.PROMPT_FILE}.pipeline.json`, 'utf8')) : {};
  Object.assign(log[0], { review_protocol: {
    ...metadata.identity,
    strategy: process.env.REVIEW_STRATEGY || 'baseline',
    submission_status: process.env.OPENCODE_REVIEW_SUBMISSION_STATUS || null,
    ...protocol,
    ...coverage,
    candidates_count: held ? candidates.length : null,
    rejected_count: held ? decisions.filter((d) => d.verdict !== 'keep').length : null,
    measured_children: children?.sessions.length ?? null,
    unmeasured_children: children?.missing ?? null,
    cost_complete: measuredExit && spending(events).length > 0 && !events.some((event) => event.type === 'error' || (event.type === 'ksai_review_attempt' && event.exit_code !== 0)) && children !== null && children.missing === 0 && (held?.missing_usage ?? 0) === 0,
    stream_attempts: events.filter((event) => event.type === 'ksai_review_attempt').map(({ exit_code, session_id, failure }) => ({ exit_code, session_id, failure })),
    gateway_failures: gatewayDiagnostics(events),
    configured_effort: process.env.VARIANT || null,
    thinking_wire_verified: false,
  } });
}

writeFileSync(executionFile, JSON.stringify(log, null, 2) + '\n');

const [result] = log;
const failure = endedOn(events);
if (failure) {
  console.log(`::warning::the opencode stream recorded ${scrub(failure, secrets)}`);
}
/*
 * Said separately because the line above reads as the model having failed. A
 * gateway that cannot reach what it proxies to answers a server error carrying
 * no status and no body, and the run ends with nothing sent and nothing billed -
 * so whoever reads this is looking for a fault in the wrong place.
 */
if (streamFailure(events)?.kind === 'gateway-unavailable') {
  console.log(
    '::warning::the endpoint answered a server error before anything was sent, which is the gateway ' +
      'or what it proxies to rather than the model: no tokens were spent, and the reason is in the ' +
      "gateway's own logs",
  );
}
if (answer(events) === null) {
  console.log(`::warning::${events.length} opencode events carried no text, so this run posts no review`);
}
console.log(
  `opencode: ${events.length} events, ${result.num_turns} steps, ` +
    `${result.usage.output_tokens} output tokens -> ${executionFile}`,
);
