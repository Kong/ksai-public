import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { authOf, maskValue, mint, originOf } from '../kreview/federated-token.mjs';
import { headerLines } from '../lib/opencode.mjs';
import { authHeaders } from '../lib/opencode-token.mjs';
import { FAILED, SUCCESS, TRUNCATED, resultRecord } from '../lib/execution-log.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { postMessage, textOf } from './messages.mjs';
import { report } from './otel.mjs';
import { spendOf } from './prices.mjs';

const MAX_ANSWER_TOKENS = 4096;

const STOP_SUBTYPE = Object.assign(Object.create(null), {
  max_tokens: TRUNCATED,
  refusal: FAILED,
});

export function resultLog({
  text = null,
  usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  model = '',
  stopReason = '',
  durationMs = 0,
} = {}) {
  const failed = typeof text !== 'string';
  const stop = STOP_SUBTYPE[String(stopReason)] ?? SUCCESS;
  return resultRecord({
    text,
    usage,
    cost: spendOf(usage, model).cost,
    turns: 1,
    durationMs,
    truncated: !failed && stop === TRUNCATED,
    failed: failed || stop === FAILED,
  });
}

export async function ask({ env = process.env, fetchImpl = fetch, now = Date.now, mask = (_value = '') => {} } = {}) {
  const model = String(env.MODEL ?? '').trim();
  if (!model) throw new Error('MODEL names no model, so there is nothing to ask');
  const prompt = readFileSync(String(env.PROMPT_FILE ?? ''), 'utf8');
  if (prompt.trim() === '') throw new Error(`the prompt at ${env.PROMPT_FILE} is empty, so nothing was asked`);

  const origin = originOf(env);
  authOf(env);
  const { accessToken } = await mint({ env, fetchImpl, mask });
  mask(accessToken);

  const started = now();
  const body = await postMessage({
    origin,
    model,
    prompt,
    maxTokens: MAX_ANSWER_TOKENS,
    effort: String(env.EFFORT ?? '').trim(),
    headers: { ...headerLines(env.ATTRIBUTION_HEADERS), ...authHeaders(accessToken, env) },
    fetchImpl,
  });
  return resultLog({
    text: textOf(body),
    usage: body.usage,
    model,
    stopReason: body.stop_reason,
    durationMs: now() - started,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = String(process.env.EXECUTION_FILE ?? '').trim();
  if (!at) {
    console.log('::error::EXECUTION_FILE names no path, so this call would answer nothing its caller can read');
    process.exit(1);
  }
  const model = String(process.env.MODEL ?? '');
  let log = resultLog({ model });
  let failure = '';
  try {
    log = await ask({ mask: maskValue });
  } catch (error) {
    failure = error?.message ?? String(error);
  }
  writeFileSync(at, JSON.stringify(log, null, 2) + '\n');
  const [result] = log;
  writeOutputs(process.env.GITHUB_OUTPUT, { execution_file: at });
  if (failure) {
    console.log(`::warning::${failure}`);
    process.exit(1);
  }
  const spent = spendOf(result.usage, model).tally;
  await report({ tally: spent, cost: result.total_cost_usd, model });
  console.log(
    `asked ${model}: ${spent.input_tokens} input, ` +
      `${spent.output_tokens} output, stopped on ${result.subtype} -> ${at}`,
  );
  if (result.is_error) process.exit(1);
}
