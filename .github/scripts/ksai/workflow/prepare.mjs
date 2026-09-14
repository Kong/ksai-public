import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../../lib/outputs.mjs';
import { builtInTestRecord, prepareStage } from './runner.mjs';

export function main(env = process.env) {
  const prepared = prepareStage({
    record: builtInTestRecord(env, env.WORKFLOW_REGISTRY),
    registryRoot: env.WORKFLOW_REGISTRY,
    runtimeRoot: env.WORKFLOW_RUNTIME,
  });
  writeOutputs(env.GITHUB_OUTPUT, {
    package: prepared.package,
    request: prepared.request,
    result: prepared.result,
    artifacts: prepared.artifacts,
    inputs: prepared.inputs,
    entrypoint: prepared.entrypoint,
    profile: prepared.profile,
    descriptor: prepared.descriptor,
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
