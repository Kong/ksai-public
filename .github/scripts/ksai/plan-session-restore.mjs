import { pathToFileURL } from 'node:url';

import { restore } from './plan-session.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function main(env = process.env) {
  const out = restore(env);
  writeOutputs(env.GITHUB_OUTPUT, {
    resumed: out.resumed,
    resume_args: out.resume_args,
    session_id: out.session_id,
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
