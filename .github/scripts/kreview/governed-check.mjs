import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deliveriesAt, governedRoot } from '../governance/anchors.mjs';
import { deliveriesUnder, promptRendering } from '../lib/cp-prompts.mjs';
import { report, verifyAudit } from './governed-review.mjs';

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

const CHECKS = {
  verify: async (env) => {
    verifyAudit(env);
    console.log("the audit reads the diff, the changed-file list and the review prompt it was rendered for");
  },
  governed: async (env) => {
    const kept = delivered(env);
    if (promptRendering(env) === 'cp' && kept === 0) {
      throw new Error('this run answered without the governor seeing one request, so nothing held it to the prompt the control plane signed');
    }
    console.log(`the governor saw ${kept} requests this run`);
  },
  report: async (env) => {
    const { reported } = await report(env);
    console.log(`reported ${reported} deliveries to the control plane`);
    for (const reason of refusals(env)) {
      console.log(`::error::prompt governance refused this run's prompt before a model saw it: ${reason || 'no reason was kept'}`);
    }
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = CHECKS[process.argv[2]];
  try {
    if (!check) throw new Error(`usage: governed-check.mjs ${Object.keys(CHECKS).join('|')}`);
    await check(process.env);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
