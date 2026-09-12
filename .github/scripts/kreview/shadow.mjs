import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { resolveModel } from '../lib/select-arm.cjs';

/**
 * SHADOWABLE names the engines a shadow may run on, which is fewer than this repository can spell.
 *
 * The Claude engine is refused here rather than at the caller, because the sampler is what decides
 * whether a second paid review starts. `shadow_engine` keeps its published default of `claude`, so
 * a consumer that never repins names an engine this answers `null` for and pays for nothing.
 */
const SHADOWABLE = new Set(['opencode']);

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
 * A shadow on the arm that already ran would pay twice for one measurement, and an engine outside
 * `SHADOWABLE` is refused rather than started.
 */
export function shadowEngine(engine, live) {
  const asked = String(engine ?? '').trim();
  if (!SHADOWABLE.has(asked)) return null;
  return asked === String(live ?? '').trim() ? null : asked;
}

/**
 * whyNone names the reason a run shadows nothing, so a missing row can be traced to a cause.
 *
 * **The dials are read before the engine.** A caller who set `shadow_model` and happened to match
 * the live arm was told "the Claude engine no longer runs here" - naming an input they never set,
 * on exactly the runs where triage picked their shadow model, and nothing they could act on.
 *
 * **The live arm and the engine input get different sentences**, because they need different
 * answers: one is the caller's `engine`, which they can change, and the other is `shadow_engine`,
 * where the published default is already the only value most callers will ever have. Sharing one
 * message printed the same `claude` for both.
 */
function whyNone({ engine, live, different, dialled }) {
  if (different) return `the live arm runs on ${live}, which a shadow may not`;
  if (dialled) return 'the shadow dials name what the live arm already runs';
  const asked = String(engine ?? '').trim();
  if (asked === 'claude') return 'the Claude engine no longer runs here, so it shadows nothing';
  if (asked === '') return 'no shadow engine was named';
  if (!SHADOWABLE.has(asked)) return `${asked} names no engine a shadow may run`;
  return `${asked} is the arm that already ran`;
}

/**
 * decide answers the whole question one step asks: whether to run a shadow, and on which engine.
 *
 * A dial shadow runs on the **live** engine rather than on `shadow_engine`. The two shadows share
 * one sampler, and reading the engine for both meant a dial comparison only ran while the engine
 * input happened to name an arm this could start - so narrowing `SHADOWABLE` would have taken the
 * model and strategy comparisons down with the Claude arm.
 */
export function decide(env) {
  const live = String(env.LIVE_ENGINE ?? '').trim() || 'opencode';
  const dialled = Boolean(env.SHADOW_MODEL || env.SHADOW_STRATEGY);
  const different = (env.SHADOW_MODEL && resolveModel(env.SHADOW_MODEL).toLowerCase() !== resolveModel(env.LIVE_MODEL || 'flagship').toLowerCase()) || (env.SHADOW_STRATEGY && env.SHADOW_STRATEGY !== (env.LIVE_STRATEGY || 'baseline'));
  const engine = different ? (SHADOWABLE.has(live) ? live : null) : shadowEngine(env.SHADOW_ENGINE, live);
  if (!engine) {
    return { shadow: 'false', engine: '', why: whyNone({ engine: env.SHADOW_ENGINE, live, different, dialled }) };
  }
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
