import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../../lib/outputs.mjs';
import { stageVerdict } from './staging.mjs';

export function main(env = process.env) {
  const outcome = stageVerdict({ run: env.RUN, spend: env.SPEND, dest: env.DEST });
  writeOutputs(env.GITHUB_OUTPUT, {
    sha256: outcome.sha256 || undefined,
    dir: outcome.dir,
    present: outcome.present,
    staged: outcome.staged,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
