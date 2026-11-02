
import { spawnSync } from 'node:child_process';

import { writeOutputs } from '../lib/outputs.mjs';
import { recordGovernance } from './anchors.mjs';
import { runMain } from '../lib/main.mjs';

await runMain(import.meta.url, async () => {
  const answered = spawnSync('gh', ['attestation', 'trusted-root'], { encoding: 'utf8', timeout: 60_000 });
  const root = recordGovernance(process.env, answered);
  writeOutputs(process.env.GITHUB_OUTPUT, {
    dir: root,
  });
  console.log(`a governed prompt is verified with what ${root} holds`);
});
