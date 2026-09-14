import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../../lib/outputs.mjs';
import { annotation } from '../../lib/text.cjs';
import { acceptStage } from './runner.mjs';

export function main(env = process.env) {
  const accepted = acceptStage({ descriptor: env.WORKFLOW_DESCRIPTOR });
  writeOutputs(env.GITHUB_OUTPUT, {
    output: accepted.output,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.log(annotation(error.message));
    process.exitCode = 1;
  }
}
