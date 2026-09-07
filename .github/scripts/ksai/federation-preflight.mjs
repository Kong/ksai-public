import { fileURLToPath } from 'node:url';

import { authOf, maskValue, mint } from '../kreview/federated-token.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export const REFUSED = Object.freeze([401, 403]);

export async function preflight({ env, fetchImpl = fetch, mask = (_value = '') => {} }) {
  try {
    if (authOf(env) !== 'federation') {
      return { refused: false, reason: 'this run carries its own identity, so it resolves no federation rule to ask about' };
    }
    await mint({ env, fetchImpl, mask });
  } catch (error) {
    if (error.status !== undefined && REFUSED.includes(error.status)) {
      return { refused: true, reason: `the token exchange refused this run with HTTP ${error.status}: ${error.message}` };
    }
    return { refused: false, reason: `could not tell whether this repository is federated: ${error.message}` };
  }
  return { refused: false, reason: 'the token exchange answered a token, so the rule covers this repository' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const answer = await preflight({ env: process.env, mask: maskValue }).catch((error) => ({
    refused: false,
    reason: `the check itself failed, so it says nothing: ${error.message}`,
  }));
  console.error(`ksai: federation preflight - ${answer.reason}`);
  writeOutputs(process.env.GITHUB_OUTPUT, { refused: String(answer.refused) });
}
