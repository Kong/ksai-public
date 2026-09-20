import { createRequire } from 'node:module';
import { join } from 'node:path';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { repairRequest } = require('./implement-passes.cjs');
import { writeRenderRequest } from '../lib/render-request.cjs';
import { runMain } from '../lib/main.mjs';

export function repair(env = process.env) {
  const at = join(String(env.RUNNER_TEMP ?? ''), 'ksai-implement-repair.request.json');
  const { request, needed } = repairRequest(env);
  writeRenderRequest(at, request);
  return { request_file: needed ? at : '', needed: String(needed) };
}

await runMain(import.meta.url, async () => {
  const said = repair();
  writeOutputs(process.env.GITHUB_OUTPUT, {
    request_file: said.request_file,
    needed: said.needed,
  });
  console.log(said.request_file === ''
    ? 'the independent run found nothing to answer, so this pass keeps what it committed'
    : `the repair asks the control plane for the prompt its request at ${said.request_file} names`);
});
