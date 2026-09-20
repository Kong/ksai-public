
import { writeOutputs } from '../lib/outputs.mjs';
import { combine, passes } from './governed-review.mjs';
import { runMain } from '../lib/main.mjs';

const COMBINES = { review: combine, passes };

await runMain(import.meta.url, async () => {
  const combining = COMBINES[process.argv[2]];
  if (!combining) throw new Error(`usage: governed-combine.mjs ${Object.keys(COMBINES).join('|')}`);
  const { execution_file: executionFile, conclusion } = combining(process.env);
  writeOutputs(process.env.GITHUB_OUTPUT, {
    execution_file: executionFile,
    conclusion,
  });
});
