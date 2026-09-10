import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { resolveModel } from '../lib/select-arm.cjs';

const ENGINES = new Set(['claude', 'opencode']);

/**
 * shouldShadow answers whether this review is one of the sampled few that runs twice.
 *
 * Hashed rather than random, and hashed over the head sha rather than the pull request number. A
 * random draw cannot be reproduced when a record looks wrong, and a hash of the number alone would
 * shadow the same pull requests for ever - a fixed subset is a biased sample, however large it gets.
 * Keying on the head sha moves the subset every push while keeping one run's decision stable if it
 * is retried.
 *
 * The comparison reads one byte of the digest against `rate * 256 / 100`: 0-255 is finer resolution
 * than any rate worth setting, and it keeps the arithmetic in integers.
 *
 * @param {{key?: string, percent?: number|string}} options
 */
export function shouldShadow({ key, percent } = {}) {
  const rate = Number(percent);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 100) return true;
  const text = String(key ?? '');
  if (text === '') return false;
  return createHash('sha256').update(text).digest()[0] * 100 < rate * 256;
}

/**
 * shadowEngine answers the arm to shadow with, or null when there is none to run.
 *
 * A shadow on the arm that already ran would pay twice for one measurement.
 */
export function shadowEngine(engine, live) {
  const asked = String(engine ?? '').trim();
  if (!ENGINES.has(asked)) return null;
  return asked === String(live ?? '').trim() ? null : asked;
}

/** decide answers the whole question one step asks: whether to run a shadow, and on which engine. */
export function decide(env) {
  const different = (env.SHADOW_MODEL && resolveModel(env.SHADOW_MODEL).toLowerCase() !== resolveModel(env.LIVE_MODEL || 'flagship').toLowerCase()) || (env.SHADOW_STRATEGY && env.SHADOW_STRATEGY !== (env.LIVE_STRATEGY || 'baseline'));
  const engine = different && ENGINES.has(env.SHADOW_ENGINE) ? env.SHADOW_ENGINE : shadowEngine(env.SHADOW_ENGINE, env.LIVE_ENGINE || 'opencode');
  if (!engine) return { shadow: 'false', engine: '', why: 'no shadow engine, or it is the arm that already ran' };
  if (!shouldShadow({ key: `${env.REPOSITORY}#${env.PR_NUMBER}@${env.HEAD_SHA}`, percent: env.SHADOW_PERCENT })) {
    return { shadow: 'false', engine: '', why: `not in the sampled ${String(env.SHADOW_PERCENT ?? 0)}%` };
  }
  return { shadow: 'true', engine, why: `sampled at ${String(env.SHADOW_PERCENT)}%` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const answer = decide(process.env);
  writeOutputs(process.env.GITHUB_OUTPUT, { shadow: answer.shadow, engine: answer.engine });
  console.log(`shadow review: ${answer.shadow} (${answer.why})`);
}
