import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../../lib/outputs.mjs';
import { resolveRunDir } from './staging.mjs';

export function main(env = process.env) {
  const { dir, verdict } = resolveRunDir(env.GITHUB_WORKSPACE, env.RUN_DIR);
  writeOutputs(env.GITHUB_OUTPUT, {
    dir,
    verdict,
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
