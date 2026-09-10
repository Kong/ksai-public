import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answer as streamAnswer, everything, parsed } from '../lib/opencode.mjs';
import { extractReviewJson, readReviewOutput } from '../lib/review-output.cjs';
import { hypothesesOf } from '../lib/review-hypotheses.mjs';
import { EXPORT_BYTES, exportChildren } from './opencode-children.mjs';
import { auditProblem, LIMITS, runPipeline } from './review-pipeline.cjs';
import { collectSecrets, scrub } from './secrets.cjs';

export { LIMITS };

export function reviewAnswer(events) {
  const last = streamAnswer(events);
  const whole = everything(events);
  return last !== null && !extractReviewJson(last) && extractReviewJson(whole) ? whole : last;
}

const coverageOf = (review) => ['complete', 'incomplete'].includes(review?.coverage) ? review.coverage : undefined;

export async function completeStage({ name, prompt, timeoutMs, candidateIds = null, resumeSession = '', invoke, now = Date.now }) {
  const began = now();
  const calls = [];
  const answer = (code, text = null) => ({ code, text,
    session_id: calls.at(-1)?.session_id, timed_out: calls.at(-1)?.timed_out === true,
    usage: calls.length && calls.every((call) => call.usage) ? calls.reduce((sum, call) => {
      for (const [key, value] of Object.entries(call.usage)) sum[key] = (sum[key] || 0) + value;
      return sum;
    }, {}) : null,
    invocations: calls.map(({ phase, code: exit_code, session_id, usage, completion, coverage, attempts }) => ({ phase, exit_code, session_id, usage, completion, coverage, attempts, thinking: phase === 'research' ? 'selected' : 'enabled', effort: phase === 'research' ? 'selected' : 'low', thinking_budget: phase === 'research' ? undefined : LIMITS.finalizeThinkingTokens })),
  });
  if (timeoutMs < LIMITS.minStageMs) return answer(124);
  const finalizeMs = Math.min(LIMITS.finalizeMs, Math.floor(timeoutMs / 3));
  const research = await invoke({ prompt, timeoutMs: timeoutMs - finalizeMs, resumeSession });
  const researched = typeof research.text === 'string' ? readReviewOutput(research.text).review : null;
  calls.push({ phase: 'research', ...research, coverage: coverageOf(researched) });
  if (research.code !== 0) return answer(research.code);
  if (typeof research.session_id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(research.session_id)) return answer(1);
  if (name.startsWith('discover-') && coverageOf(researched) && research.completion?.status === 'recorded' && research.completion.text_bytes > 0) return answer(0, research.text);
  const remaining = timeoutMs - (now() - began);
  if (remaining <= 0) return answer(124);
  const deadline = now() + Math.min(remaining, finalizeMs);
  let session = research.session_id;
  let problem = '';
  for (let attempt = 0; attempt < 2 && now() < deadline; attempt += 1) {
    const left = deadline - now();
    if (left <= 0) break;
    const final = await invoke({
      prompt: `${attempt ? `The previous response was not the requested JSON: ${problem}. Correct its format now. ` : ''}Finish the ${name} stage using only the evidence already collected. Return exactly one JSON object with coverage (complete or incomplete), summary and findings. Coverage is incomplete if the assigned investigation was interrupted or not performed; an empty findings array does not make it complete. For discovery: findings carry root_cause and full evidence from the original contract. For audit: summary "audit", findings [], and one decision per original candidate ID with id, verdict (keep, remove or insufficient_evidence), a nonempty reason explaining the evidence, and the corrected full finding for every keep. ${candidateIds ? `Original candidate IDs: ${JSON.stringify(candidateIds)}. ` : ''}No new research or tool calls. An unsupported claim is insufficient evidence.`,
      timeoutMs: left, resumeSession: session, finalize: true,
    });
    const review = typeof final.text === 'string' ? readReviewOutput(final.text).review : null;
    calls.push({ phase: attempt ? 'finalize-retry' : 'finalize', ...final, coverage: coverageOf(review) });
    problem = !coverageOf(review) ? 'coverage and review JSON are required' : candidateIds ? auditProblem(review, candidateIds) : '';
    if (final.code !== 0) return answer(final.code);
    if (!problem) return answer(0, researched?.coverage === 'incomplete' ? JSON.stringify({ ...review, coverage: 'incomplete' }) : final.text);
    if (!/^ses_[a-zA-Z0-9]+$/.test(final.session_id ?? '')) return answer(1);
    session = final.session_id;
  }
  return answer(1);
}

export function streamFailure(events) {
  const last = events.at(-1);
  const sessions = new Set(events.map((event) => event.sessionID).filter(Boolean));
  if (last?.type !== 'error' || last.error?.name !== 'UnknownError' || last.error?.data?.statusCode !== undefined || sessions.size !== 1 || !/^ses_[a-zA-Z0-9]+$/.test(last.sessionID ?? '')) return null;
  let message = last.error?.data?.message;
  if (typeof message !== 'string') return null;
  if (message.startsWith('"')) {
    try { message = JSON.parse(message); } catch { return null; }
  }
  return typeof message === 'string' && /^text part [0-9]{1,6} not found$/.test(message) ? { kind: 'missing-text-part', session_id: last.sessionID } : null;
}

const QUOTA_HEADERS = new Set(['retry-after', 'retry-after-ms', 'x-ai-ratelimit-reset', 'x-ai-ratelimit-retry-after', 'x-ai-ratelimit-query-cost', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']);

export function gatewayDiagnostics(events) {
  return events.filter((event) => event.type === 'error' && Number.isInteger(event.error?.data?.statusCode) && event.error.data.statusCode >= 400 && event.error.data.statusCode <= 599).slice(-8).map((event) => {
    const headers = Object.create(null);
    const source = event.error.data.responseHeaders;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [rawName, rawValue] of Object.entries(source)) {
        const name = rawName.toLowerCase();
        if (!QUOTA_HEADERS.has(name) || typeof rawValue !== 'string') continue;
        if (/^\d{1,15}(?:\.\d{1,3})?$/.test(rawValue) && Number.isSafeInteger(Math.ceil(Number(rawValue)))) headers[name] = Number(rawValue);
        else if (name === 'retry-after' && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(rawValue) && Number.isFinite(Date.parse(rawValue))) headers.retry_after_at = new Date(rawValue).toISOString();
      }
    }
    return { status: event.error.data.statusCode, headers };
  });
}

export async function recoverReview({ flow, prompt, timeoutMs, invoke, budget = { remaining: 1 }, now = Date.now, ...options }) {
  const deadline = now() + timeoutMs;
  const first = await invoke({ ...options, prompt, timeoutMs });
  const attempt = (result) => ({ exit_code: result.code, session_id: result.session_id, failure: result.failure?.kind ?? null, usage: result.usage ?? null });
  const attempts = [attempt(first)];
  const remaining = deadline - now();
  if (flow !== 'review' || first.code !== 1 || first.failure?.kind !== 'missing-text-part' || first.session_id !== first.failure.session_id || !/^ses_[a-zA-Z0-9]+$/.test(first.session_id ?? '') || budget.remaining < 1 || !Number.isFinite(remaining) || remaining < 5000) return { ...first, attempts };
  budget.remaining -= 1;
  const second = await invoke({ ...options, prompt: 'The previous response ended with a transport stream error. Continue the original assigned review from completed evidence in this history. Discard the unfinished response fragment. Preserve the original scope, permissions, evidence requirements and output contract. Unfinished investigation remains incomplete; do not infer a clean result from the interruption.', timeoutMs: remaining, resumeSession: first.session_id });
  attempts.push(attempt(second));
  const usage = first.usage && second.usage ? Object.fromEntries([...new Set([...Object.keys(first.usage), ...Object.keys(second.usage)])].map((key) => [key, (first.usage[key] ?? 0) + (second.usage[key] ?? 0)])) : null;
  const code = second.code === 0 && (typeof second.text !== 'string' || !second.text.trim()) ? 1 : second.code;
  return { ...second, code, usage, attempts };
}

export async function reviewSession({ env, events, prompt, run }) {
  const metadata = JSON.parse(readFileSync(`${env.PROMPT_FILE}.pipeline.json`, 'utf8'));
  const ledgerFile = `${events}.pipeline.json`;
  const reviewFile = `${events}.review.json`;
  const secrets = collectSecrets(env);
  const result = await runPipeline({ strategy: env.REVIEW_STRATEGY, context: prompt, ...metadata, run,
    checkpoint: (ledger) => writeFileSync(ledgerFile, scrub(JSON.stringify(ledger), secrets)),
  });
  writeFileSync(reviewFile, scrub(JSON.stringify(result.review), secrets));
  const hypotheses = hypothesesOf(result.ledger);
  let hypothesesFile = '';
  if (hypotheses) {
    hypothesesFile = `${events}.hypotheses.json`;
    writeFileSync(hypothesesFile, scrub(JSON.stringify(hypotheses), secrets));
  }
  return { OPENCODE_REVIEW_EXIT: String(result.code), OPENCODE_REVIEW_FILE: reviewFile, REVIEW_PIPELINE_FILE: ledgerFile, REVIEW_HYPOTHESES_FILE: hypothesesFile };
}

export function readExport({ env, sandbox, id, timeoutMs = 15_000 }) {
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'review-export-'));
  const path = join(dir, 'export.json');
  let output;
  try {
    output = openSync(path, 'wx', 0o600);
    const result = spawnSync('bwrap', [...sandbox, 'opencode', 'export', id], { stdio: ['ignore', output, 'pipe'], timeout: timeoutMs, maxBuffer: EXPORT_BYTES });
    if (result.status !== 0) throw new Error('session export failed');
    if (statSync(path).size > EXPORT_BYTES) throw new Error('session export exceeds its bound');
    return readFileSync(path, 'utf8');
  } finally {
    if (output !== undefined) closeSync(output);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function recordedCompletion(events, read) {
  const finish = events.findLast((event) => event.type === 'step_finish');
  const session = finish?.sessionID;
  const message = finish?.part?.messageID;
  if (!/^ses_[a-zA-Z0-9]+$/.test(session ?? '') || !/^msg_[a-zA-Z0-9]+$/.test(message ?? '')) return { completion: { status: 'unavailable' } };
  try {
    const exported = JSON.parse(read(session));
    if (exported.info?.id !== session) throw new Error('wrong session');
    const matches = exported.messages?.filter((entry) => entry.info?.id === message);
    if (matches?.length !== 1) throw new Error('missing or duplicate message');
    const { info, parts } = matches[0];
    if (info.role !== 'assistant' || info.sessionID !== session || !Number.isFinite(info.time?.completed) || !Array.isArray(parts)) throw new Error('incomplete assistant');
    const text = parts.filter((part) => part.type === 'text' && !part.ignored && !part.synthetic && part.sessionID === session && part.messageID === message && typeof part.text === 'string' && Number.isFinite(part.time?.end)).map((part) => part.text).join('\n');
    const counts = Object.create(null);
    for (const part of parts) if (['text', 'reasoning', 'tool', 'step-start', 'step-finish'].includes(part.type)) counts[part.type] = (counts[part.type] || 0) + 1;
    return { text: text || null, completion: { status: 'recorded', message_id: message, parts: counts, text_bytes: Buffer.byteLength(text) } };
  } catch {
    return { completion: { status: 'unavailable', message_id: message } };
  }
}

export function recordChildren({ env, events, sandbox }) {
  const children = exportChildren(parsed(readFileSync(events, 'utf8')), (id) => readExport({ env, sandbox, id }));
  const file = `${events}.children.json`;
  writeFileSync(file, scrub(JSON.stringify(children), collectSecrets(env)));
  return { OPENCODE_CHILDREN_FILE: file };
}
