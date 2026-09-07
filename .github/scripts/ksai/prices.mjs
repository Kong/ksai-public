import { createRequire } from 'node:module';

import { tallyOf } from './progress.mjs';

const require = createRequire(import.meta.url);
const MODEL_CATALOG = require('../lib/model-catalog.json');

/** RATES holds list prices in dollars per million tokens, read from Anthropic's table on 2026-08-28. */
const RATES = Object.freeze(
  Object.assign(Object.create(null), MODEL_CATALOG.rates),
);

/** CACHE holds what a cached token costs as a multiple of the same model's input rate. */
const CACHE = Object.freeze({ read: 0.1, write5m: 1.25, write1h: 2 });

const PER_MILLION = 1e6;

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** rateFor answers the input/output rates for a model id, or null when this table has never heard of it. */
export function rateFor(model) {
  const id = String(model ?? '');
  const rate = RATES[id];
  return rate && typeof rate === 'object' ? rate : null;
}

/** estimate answers what a token tally costs at list price, or null when the model is not in the table. */
export function estimate(usage, model) {
  const rate = rateFor(model);
  if (!rate) return null;
  const written = count(usage?.cache_creation_tokens);
  const hour = count(usage?.cache_write_1h_tokens);
  const short = count(usage?.cache_write_5m_tokens);
  const split = hour + short;
  const unsplit = Math.max(0, written - split);
  const dollars =
    (count(usage?.input_tokens) * rate.input +
      count(usage?.output_tokens) * rate.output +
      count(usage?.cache_read_tokens) * rate.input * CACHE.read +
      (short * CACHE.write5m + hour * CACHE.write1h + unsplit * CACHE.write5m) * rate.input) /
    PER_MILLION;
  return Number.isFinite(dollars) ? dollars : null;
}

/** money renders a dollar figure at the precision a small number needs, or nothing when there is none. */
export function money(dollars) {
  if (!Number.isFinite(dollars) || dollars < 0) return '';
  if (dollars === 0) return '$0.00';
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

export function spendOf(usage, model) {
  const tally = tallyOf(usage);
  const counted = Object.values(tally).some((value) => Number(value) > 0);
  return { tally, cost: counted ? estimate(tally, model) : null };
}

export { CACHE, RATES };
