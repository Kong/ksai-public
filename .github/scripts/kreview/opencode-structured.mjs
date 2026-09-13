import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_OPENCODE_MODEL } from '../lib/opencode.mjs';

const require = createRequire(import.meta.url);
const { STRUCTURED_EVENT, schemaFor, structuredSubmission } = require('./review-result.cjs');

export { STRUCTURED_EVENT, structuredSubmission };

const canonical = (value) => JSON.stringify(value) ?? '';

function idsOf(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function errorName(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.slice(0, 200);
  return String(error.name ?? error._tag ?? error.data?.name ?? error.message ?? 'unknown').slice(0, 200);
}

function failureText(error) {
  if (!error || typeof error === 'string') return String(error ?? '');
  const cause = error.cause?.body;
  return [
    error.name,
    error._tag,
    error.message,
    error.data?.name,
    error.data?.message,
    cause?.name,
    cause?._tag,
    cause?.message,
    cause?.data?.name,
    cause?.data?.message,
  ].filter((value) => typeof value === 'string').join(' ');
}

function failureStatus(error) {
  const named = failureText(error);
  if (/model.*(?:not found|unsupported)|(?:not found|unsupported).*model|ProviderModelNotFound/i.test(named)) return 'unsupported-model';
  if (/StructuredOutput/i.test(named)) return 'missing';
  return 'failed';
}

const EVENT_TYPE = Object.freeze({
  'step-start': 'step_start',
  'step-finish': 'step_finish',
  tool: 'tool_use',
  text: 'text',
});

export function sdkEvents(messages, seen = new Set()) {
  const events = [];
  for (const message of messages ?? []) {
    const info = message?.info ?? {};
    for (const part of message?.parts ?? []) {
      if (!part?.id || seen.has(part.id) || !EVENT_TYPE[part.type]) continue;
      events.push({
        type: EVENT_TYPE[part.type],
        timestamp: part.type === 'step-finish'
          ? part.time?.end ?? info.time?.completed ?? info.time?.created ?? Date.now()
          : part.time?.start ?? info.time?.created ?? Date.now(),
        sessionID: part.sessionID ?? info.sessionID,
        part,
      });
    }
    if (info.error && !seen.has(`${info.id}:error`)) events.push({ type: 'error', timestamp: info.time?.completed ?? Date.now(), sessionID: info.sessionID, error: info.error });
  }
  return events;
}

function agentFor(env) {
  const staged = ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
  if (env.OPENCODE_REVIEW_FINALIZE === 'true') return staged ? 'ksai-review-finish' : 'ksai-review-structured-finish';
  return staged ? 'ksai-review-stage' : 'ksai-review-submit';
}

async function stdin(stream) {
  let value = '';
  for await (const chunk of stream) value += chunk;
  return value;
}

async function loadSdk(env) {
  const root = String(env.OPENCODE_SDK_ROOT ?? '');
  if (!root) throw new Error('OPENCODE_SDK_ROOT names no pinned SDK');
  return import(pathToFileURL(join(root, 'node_modules/@opencode-ai/sdk/dist/v2/index.js')).href);
}

async function response(call) {
  const result = await call;
  if (result?.error) throw result.error;
  if (!result?.data) throw new Error('OpenCode SDK response carried no data');
  return result.data;
}

export async function runStructured({ env = process.env, create = null, input = process.stdin, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const prompt = env.PROMPT_TEXT ?? await stdin(input);
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const kind = String(env.KSAI_REVIEW_RESULT_KIND ?? 'final');
  const candidateIds = idsOf(env.KSAI_REVIEW_CANDIDATE_IDS);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('structured output run cancelled'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let server;
  let sessionID = '';
  try {
    const sdk = create ? { createOpencode: create } : await loadSdk(env);
    const opened = await sdk.createOpencode({ hostname: '127.0.0.1', port: 4096, timeout: 5000, signal: controller.signal });
    server = opened.server;
    const client = opened.client;
    const resume = String(env.OPENCODE_RESUME_SESSION ?? '').trim();
    const session = resume
      ? await response(client.session.fork({ sessionID: resume, directory: workspace }, { throwOnError: true, signal: controller.signal }))
      : await response(client.session.create({ directory: workspace }, { throwOnError: true, signal: controller.signal }));
    sessionID = session.id;
    const before = await response(client.session.messages({ sessionID, directory: workspace }, { throwOnError: true, signal: controller.signal }));
    const seen = new Set(before.flatMap((message) => [
      ...(message.parts ?? []).map((part) => part.id),
      ...(message.info?.error ? [`${message.info.id}:error`] : []),
    ]).filter(Boolean));
    const named = String(env.MODEL ?? '').trim() || DEFAULT_OPENCODE_MODEL;
    const variant = String(env.VARIANT ?? '').trim();
    const result = await response(client.session.prompt({
      sessionID,
      directory: workspace,
      model: { providerID: 'anthropic', modelID: named },
      agent: agentFor(env),
      ...(variant && env.OPENCODE_REVIEW_FINALIZE !== 'true' ? { variant } : {}),
      format: { type: 'json_schema', schema: schemaFor(kind, candidateIds), retryCount: 2 },
      parts: [{ type: 'text', text: prompt }],
    }, { throwOnError: true, signal: controller.signal }));
    const after = await response(client.session.messages({ sessionID, directory: workspace }, { throwOnError: true, signal: controller.signal }));
    for (const event of sdkEvents(after, seen)) write(canonical(event));
    write(canonical({ type: STRUCTURED_EVENT, sessionID, result: result.info?.structured, failure: result.info?.structured === undefined ? (result.info?.error ? failureStatus(result.info.error) : 'missing') : null }));
    return 0;
  } catch (error) {
    write(canonical({ type: STRUCTURED_EVENT, sessionID: sessionID || null, failure: failureStatus(error), error_name: errorName(error) }));
    return sessionID ? 0 : 1;
  } finally {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    server?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStructured();
}
