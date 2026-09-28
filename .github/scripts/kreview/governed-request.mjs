import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { requestReview } from './governed-review.mjs';

const ASKED = { review: requestReview, flow: (env) => ({ request_file: String(env.REQUEST_FILE ?? '').trim() }) };

export function main(argv, env) {
  const asked = ASKED[argv[0]];
  if (!asked) throw new Error(`usage: governed-request.mjs ${Object.keys(ASKED).join('|')}`);
  const { request_file: requestFile } = asked(env);
  if (!requestFile) throw new Error(`a linked ${argv[0]} was asked for with no render request`);
  console.log(`the engine renders this ${argv[0]} through the control plane from ${requestFile}`);
  writeOutputs(env.GITHUB_OUTPUT, {
    request_file: requestFile,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
