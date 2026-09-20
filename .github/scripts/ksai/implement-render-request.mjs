import { createRequire } from 'node:module';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { implementRequest } = require('./prepare.cjs');
import { writeRenderRequest } from '../lib/render-request.cjs';
import { runMain } from '../lib/main.mjs';

export function main(env = process.env) {
  const at = `${String(env.PROMPT_FILE ?? '')}.request.json`;
  writeRenderRequest(at, implementRequest({ env }));
  writeOutputs(env.GITHUB_OUTPUT, {
    request_file: at,
  });
  return at;
}

await runMain(import.meta.url, async () => {
  console.log(`this phase asks the control plane for the prompt its request at ${main()} names`);
});
