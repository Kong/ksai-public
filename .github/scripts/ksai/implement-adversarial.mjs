import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { adversarialRequest, manifestIfAny } = require('./implement-passes.cjs');
const { toolPolicy } = require('../lib/claude-args.cjs');
import { writeRenderRequest } from '../lib/render-request.cjs';
import { runMain } from '../lib/main.mjs';

const GIT_TIMEOUT_MS = 120_000;

function recorded(env, args, at, run = spawnSync) {
  const out = openSync(at, 'w', 0o600);
  try {
    const done = run('git', ['-C', String(env.GITHUB_WORKSPACE ?? ''), ...args], { stdio: ['ignore', out, 'inherit'], timeout: GIT_TIMEOUT_MS });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} answered ${done.status ?? done.signal}`);
  } finally {
    closeSync(out);
  }
  return at;
}

export function adversarial(env = process.env, run = spawnSync) {
  const temp = String(env.RUNNER_TEMP ?? '');
  const range = `${String(env.BASE_SHA ?? '')}..HEAD`;
  const reading = toolPolicy('review');
  if (manifestIfAny(env) === null) {
    return { request_file: '', diff_file: '', changed_files_file: '', allowed_tools: reading.allowed, disallowed_tools: reading.disallowed };
  }
  const asked = {
    ...env,
    DIFF_FILE: recorded(env, ['diff', '--patch', range], join(temp, 'ksai-implement-pass.diff'), run),
    CHANGED_FILES_FILE: recorded(env, ['diff', '--name-status', range], join(temp, 'ksai-implement-pass-files.txt'), run),
  };
  const at = join(temp, 'ksai-implement-adversarial.request.json');
  writeRenderRequest(at, adversarialRequest(asked));
  return {
    request_file: at, diff_file: asked.DIFF_FILE, changed_files_file: asked.CHANGED_FILES_FILE,
    allowed_tools: reading.allowed, disallowed_tools: reading.disallowed,
  };
}

await runMain(import.meta.url, async () => {
  const said = adversarial();
  writeOutputs(process.env.GITHUB_OUTPUT, {
    request_file: said.request_file,
    diff_file: said.diff_file,
    changed_files_file: said.changed_files_file,
    allowed_tools: said.allowed_tools,
    disallowed_tools: said.disallowed_tools,
  });
  console.log(said.request_file === ''
    ? 'the pass wrote no manifest, so it finished nothing an independent run could be asked about'
    : `an independent run is asked about this pass through the request at ${said.request_file}`);
});
