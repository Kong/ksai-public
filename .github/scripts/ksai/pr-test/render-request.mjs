import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { bounded } from '../../lib/evidence.cjs';
import { writeOutputs } from '../../lib/outputs.mjs';
import { SINKS, renderRequest, writeRenderRequest } from '../../lib/render-request.cjs';
import { runMain } from '../../lib/main.mjs';

const GIT_TIMEOUT_MS = 120_000;
const MAX = Object.freeze({ criteria: 65_536, environment: 65_536, changedFiles: 524_288, additionalPrompt: 32_768 });
const COMMIT = /^[0-9A-Fa-f]{40}$/;

function said(args, env, run) {
  const done = run('git', ['-C', String(env.GITHUB_WORKSPACE ?? ''), ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} answered ${done.status ?? done.signal}`);
  return String(done.stdout ?? '');
}

function commit(value, name) {
  const sha = String(value ?? '').trim();
  if (!COMMIT.test(sha)) throw new Error(`${name} is not a commit: ${sha || '(empty)'}`);
  return sha;
}

export function testRequest(env = process.env, run = spawnSync) {
  const dir = String(env.RUN_DIR ?? '');
  const base = String(env.BASE ?? '').trim();
  if (base === '') throw new Error('the base branch this change is tested against is unnamed');
  const changed = said(['diff', '--name-status', `origin/${base}...HEAD`], env, run);
  if (Buffer.byteLength(changed) > MAX.changedFiles) throw new Error(`the changed-file list is larger than ${MAX.changedFiles} bytes`);
  const prompt = String(env.ADDITIONAL_PROMPT ?? '');
  if (Buffer.byteLength(prompt) > MAX.additionalPrompt) throw new Error(`the caller's additional prompt is larger than ${MAX.additionalPrompt} bytes`);
  return renderRequest({
    promptId: 'runtime.pr-test',
    sink: SINKS.test,
    model: String(env.MODEL ?? ''),
    inputs: [
      { name: 'additional_prompt', value: prompt },
      { name: 'base_ref', value: base },
      { name: 'base_sha', value: commit(said(['rev-parse', `origin/${base}`], env, run), 'the base commit') },
      { name: 'changed_files', value: changed },
      { name: 'criteria', value: bounded(join(dir, 'CRITERIA.md'), "this run's acceptance criteria", MAX.criteria) },
      { name: 'environment', value: bounded(join(dir, 'ENVIRONMENT.md'), "this run's environment notes", MAX.environment) },
      { name: 'head_sha', value: commit(said(['rev-parse', 'HEAD'], env, run), 'the head commit') },
      { name: 'test_run', value: { run_dir: dir, verdict_path: String(env.STAGE_RESULT ?? '') } },
    ],
  });
}

export function main(env = process.env, run = spawnSync) {
  const at = join(String(env.RUNNER_TEMP ?? ''), 'ksai-pr-test.request.json');
  writeRenderRequest(at, testRequest(env, run));
  writeOutputs(env.GITHUB_OUTPUT, {
    request_file: at,
  });
  return at;
}

await runMain(import.meta.url, async () => {
  console.log(`this tester asks the control plane for the prompt its request at ${main()} names`);
});
