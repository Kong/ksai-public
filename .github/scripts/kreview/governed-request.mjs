import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { annotation } from '../lib/text.cjs';

export function main(argv, env) {
  if (argv[0] !== 'flow') throw new Error('usage: governed-request.mjs flow');
  const requestFile = String(env.REQUEST_FILE ?? '').trim();
  if (!requestFile) throw new Error('a linked flow was asked for with no render request');
  console.log(`the engine renders this flow through the control plane from ${requestFile}`);
  writeOutputs(env.GITHUB_OUTPUT, { request_file: requestFile });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    writeOutputs(process.env.GITHUB_OUTPUT, { error: error.message });
    console.log(annotation(error.message));
    process.exitCode = 1;
  }
}
