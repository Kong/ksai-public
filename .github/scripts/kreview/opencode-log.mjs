import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { answer, collectSecrets, endedOn, everything, executionLog, parsed, scrub } from '../lib/opencode.mjs';

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
if (eventsFile) writeFileSync(eventsFile, scrub(raw, secrets));

const events = parsed(raw);

/*
 * A review's structured output is a contract, and the turn it lands in is the model's choice. `answer`
 * returns the last turn that spoke, so a reviewer that wrote its findings and then said one more thing
 * would publish the sentence and lose the review - the same failure as a fragment, on a run that ended
 * cleanly. Only the review flow has that contract, and only a run whose last turn does not carry it
 * falls back to every turn joined.
 */
const said = answer(events);
const whole = process.env.FLOW === 'review' ? everything(events) : null;
const carries = whole !== null && said !== null && !extractReviewJson(said) && extractReviewJson(whole);
if (carries) {
  console.log('::warning::the reviewer wrote its findings before its last turn, so the whole run is published');
}
const log = executionLog({
  events,
  exitCode: Number(process.env.OPENCODE_EXIT ?? 1),
  secrets,
  said: carries ? whole : said,
});

writeFileSync(executionFile, JSON.stringify(log, null, 2) + '\n');

const [result] = log;
const failure = endedOn(events);
if (failure) {
  console.log(`::warning::the opencode run ended on ${scrub(failure, secrets)}`);
}
if (answer(events) === null) {
  console.log(`::warning::${events.length} opencode events carried no text, so this run posts no review`);
}
console.log(
  `opencode: ${events.length} events, ${result.num_turns} steps, ` +
    `${result.usage.output_tokens} output tokens -> ${executionFile}`,
);
