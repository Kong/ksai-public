import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';
import { stageOf } from './workflow/stage.mjs';

const required = (env, name) => {
  const value = String(env[name] ?? '');
  if (!value) throw new Error(`${name.toLowerCase()}: the control-plane stage plan omits this value`);
  return value;
};

export function runPlan(env = {}) {
  if (!String(env.WORKFLOW_JOB ?? '').trim()) {
    throw new Error('workflow_job: flow: run requires a dispatched package stage');
  }

  return {
    file: '',
    model: required(env, 'MODEL'),
    effort: required(env, 'EFFORT'),
    prompt_id: required(env, 'PROMPT_ID'),
    prompt_sink: required(env, 'PROMPT_SINK'),
    profile: required(env, 'STAGE_PROFILE'),
    phase: required(env, 'STAGE_PHASE'),
    allowed_tools: required(env, 'OPENCODE_ALLOWED'),
    disallowed_tools: required(env, 'OPENCODE_DISALLOWED'),
  };
}

export function runRequest(plan, env = {}) {
  const { job, instance } = stageOf(env);
  return {
    contract_version: 'v1',
    prompt_id: plan.prompt_id,
    sink: plan.prompt_sink,
    model: plan.model,
    metadata: { workflow_job: job, workflow_instance: instance },
    inputs: [{ name: 'workspace', value: String(env.GITHUB_WORKSPACE ?? '') }],
  };
}

export function main(env = process.env) {
  if (!String(env.GITHUB_OUTPUT ?? '')) throw new Error('GITHUB_OUTPUT names no file, so the plan would reach no step');
  const plan = runPlan(env);
  const requestFile = join(String(env.RUNNER_TEMP ?? ''), 'ksai-run.request.json');
  writeFileSync(requestFile, JSON.stringify(runRequest(plan, env)), { mode: 0o600 });
  writeOutputs(env.GITHUB_OUTPUT, {
    file: plan.file,
    model: plan.model,
    effort: plan.effort,
    profile: plan.profile,
    phase: plan.phase,
    allowed_tools: plan.allowed_tools,
    disallowed_tools: plan.disallowed_tools,
    request_file: requestFile,
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
