
import { writeOutputs } from '../lib/outputs.mjs';
import { prepareGovernance } from './anchors.mjs';
import { runMain } from '../lib/main.mjs';

await runMain(import.meta.url, async () => {
  const root = prepareGovernance(process.env);
  writeOutputs(process.env.GITHUB_OUTPUT, {
    dir: root,
  });
  console.log(`a governed prompt is verified with what ${root} holds`);
});
