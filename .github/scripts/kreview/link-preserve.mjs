import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { preserveWork } from '../ksai/preserve.mjs';

export function preserveEnv(env) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  return {
    ...env,
    WORKSPACE: workspace,
    REPO: String(env.GITHUB_REPOSITORY ?? ''),
    MANIFEST: workspace ? join(workspace, '.ksai-manifest.json') : '',
    PHASE: String(env.PHASE || env.OPENCODE_PHASE || ''),
    PR_NUMBER: String(env.PR_NUMBER || env.REPORT_NUM || ''),
    PUSH_URL: '',
  };
}

export function main(env = process.env, { write = (said) => writeFileSync(String(env.PRESERVE_OUT ?? ''), said), preserve = preserveWork } = {}) {
  const kept = preserve({
    env: preserveEnv(env),
    stopped: env.PRESERVE_STOPPED === 'true',
    hard: env.PRESERVE_HARD === 'true',
    killed: env.PRESERVE_KILLED === 'true',
    controlPlaneOnly: true,
  });
  write(`${JSON.stringify(kept)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
