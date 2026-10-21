import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deliveriesAt, governedRoot } from '../governance/anchors.mjs';
import { deliveriesUnder } from './cp-prompts.mjs';
import { annotation, counted } from '../lib/text.cjs';

function delivered(env) {
  const root = governedRoot(env);
  try {
    const { deliveries } = deliveriesUnder({ files: [deliveriesAt(root)], root });
    return deliveries.filter((one) => String(one.prompt_id ?? '') !== '').length;
  } catch {
    return 0;
  }
}

export function refusals(env) {
  const root = governedRoot(env);
  try {
    const { deliveries } = deliveriesUnder({ files: [deliveriesAt(root)], root });
    return [...new Set(deliveries.filter((one) => one.outcome === 'refused').map((one) => String(one.reason ?? '').trim()))];
  } catch {
    return [];
  }
}

export function governed(env, kept = delivered(env)) {
  if (kept === 0 && env.STOPPED === 'true' && env.MODEL_NEVER_ASKED === 'true') {
    return 'the run was stopped before its model asked the provider anything, so it answered nothing';
  }
  if (kept === 0) {
    throw new Error('this run answered without the governor seeing one request, so nothing held it to the prompt the control plane signed');
  }
  return `the governor saw ${counted(kept, 'request')} this run`;
}

const CHECKS = {
  governed: async (env) => {
    console.log(governed(env));
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = CHECKS[process.argv[2]];
  try {
    if (!check) throw new Error(`usage: governed-check.mjs ${Object.keys(CHECKS).join('|')}`);
    await check(process.env);
  } catch (error) {
    console.log(annotation(error.message));
    process.exitCode = 1;
  }
}
