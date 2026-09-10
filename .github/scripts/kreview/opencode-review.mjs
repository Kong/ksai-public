import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsed } from '../lib/opencode.mjs';
import { readReviewOutput } from '../lib/review-output.cjs';
import { hypothesesOf } from '../lib/review-hypotheses.mjs';
import { EXPORT_BYTES, exportChildren } from './opencode-children.mjs';
import { LIMITS, runPipeline } from './review-pipeline.cjs';
import { collectSecrets, scrub } from './secrets.cjs';

const coverageOf = (review) => ['complete', 'incomplete'].includes(review?.coverage) ? review.coverage : undefined;

export async function completeStage({ name, prompt, timeoutMs, invoke, now = Date.now }) {
  const began = now();
  const calls = [];
  const answer = (code, text = null) => ({ code, text,
    usage: calls.length && calls.every((call) => call.usage) ? calls.reduce((sum, call) => {
      for (const [key, value] of Object.entries(call.usage)) sum[key] = (sum[key] || 0) + value;
      return sum;
    }, {}) : null,
    invocations: calls.map(({ phase, code: exit_code, session_id, usage, completion, coverage }) => ({ phase, exit_code, session_id, usage, completion, coverage, thinking: phase === 'research' ? 'selected' : 'enabled', effort: phase === 'research' ? 'selected' : 'low', thinking_budget: phase === 'research' ? undefined : LIMITS.finalizeThinkingTokens })),
  });
  if (timeoutMs < LIMITS.minStageMs) return answer(124);
  const finalizeMs = Math.min(LIMITS.finalizeMs, Math.floor(timeoutMs / 3));
  const research = await invoke({ prompt, timeoutMs: timeoutMs - finalizeMs });
  const researched = typeof research.text === 'string' ? readReviewOutput(research.text).review : null;
  calls.push({ phase: 'research', ...research, coverage: coverageOf(researched) });
  if (research.code !== 0) return answer(research.code);
  if (typeof research.session_id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(research.session_id)) return answer(1);
  if (name.startsWith('discover-') && coverageOf(researched) && research.completion?.status === 'recorded' && research.completion.text_bytes > 0) return answer(0, research.text);
  const remaining = timeoutMs - (now() - began);
  if (remaining <= 0) return answer(124);
  const deadline = now() + Math.min(remaining, finalizeMs);
  let session = research.session_id;
  for (let attempt = 0; attempt < 2 && now() < deadline; attempt += 1) {
    const left = deadline - now();
    if (left <= 0) break;
    const final = await invoke({
      prompt: `${attempt ? 'The previous response was not the requested JSON. Correct its format now. ' : ''}Finish the ${name} stage using only the evidence already collected. Return exactly one JSON object with coverage (complete or incomplete), summary and findings. Coverage is incomplete if the assigned investigation was interrupted or not performed; an empty findings array does not make it complete. For discovery: findings carry root_cause and full evidence from the original contract. For audit: summary "audit", findings [], and one decision per original candidate ID, with the corrected full finding for every keep. No new research or tool calls. An unsupported claim is insufficient evidence.`,
      timeoutMs: left, resumeSession: session, finalize: true,
    });
    const review = typeof final.text === 'string' ? readReviewOutput(final.text).review : null;
    calls.push({ phase: attempt ? 'finalize-retry' : 'finalize', ...final, coverage: coverageOf(review) });
    if (final.code === 0 && review && researched?.coverage === 'incomplete') return answer(0, JSON.stringify({ ...review, coverage: 'incomplete' }));
    if (final.code !== 0 || ['complete', 'incomplete'].includes(review?.coverage)) return answer(final.code, final.text);
    if (!/^ses_[a-zA-Z0-9]+$/.test(final.session_id ?? '')) return answer(1);
    session = final.session_id;
  }
  return answer(1);
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
