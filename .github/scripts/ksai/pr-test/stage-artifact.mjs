import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../../lib/outputs.mjs';
import { stageFile } from './staging.mjs';

export function main(env = process.env) {
  const file = String(env.FILE ?? '');
  const { dir } = stageFile(`${env.RUN}/${file}`, env.DEST, file, `${env.PRODUCER} produced no regular ${file}`);
  writeOutputs(env.GITHUB_OUTPUT, {
    dir,
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
