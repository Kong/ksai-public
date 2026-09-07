import { pathToFileURL } from 'node:url';

import { artifactName, retentionDays, save } from './plan-session.mjs';
import { writeOutputs } from '../lib/outputs.mjs';

export function main(env = process.env) {
  const out = save(env);
  writeOutputs(env.GITHUB_OUTPUT, {
    file: out.file,
    saved: out.saved,
    name: artifactName(env.PR_NUMBER),
    retention_days: String(retentionDays(env.ARTIFACT_RETENTION_DAYS)),
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
