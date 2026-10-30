import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { keepMarker } from '../lib/keep-work.mjs';

export const CONTROL_PLANE_KEEPS = 'the stage hands its unfinished change back to the control plane, which keeps it in a commit, since this runtime commits nothing itself';

export function preserved(env) {
  const stopped = env.PRESERVE_STOPPED === 'true';
  const killed = env.PRESERVE_KILLED === 'true';
  if (!stopped && !killed) return { preserved: '', reason: 'this run was not asked to stop and was not killed', tree: '' };
  if (stopped && env.PRESERVE_HARD === 'true') return { preserved: '', reason: 'a hard stop preserves nothing by design', tree: '' };
  return { preserved: '', reason: CONTROL_PLANE_KEEPS, tree: '' };
}

export function main(env = process.env, {
  write = (said) => writeFileSync(String(env.PRESERVE_OUT ?? ''), said, { mode: 0o600 }),
  mark = (at) => writeFileSync(at, '{"keep":true}\n', { mode: 0o600 }),
} = {}) {
  const said = preserved(env);
  const marker = keepMarker(env);
  if (said.reason === CONTROL_PLANE_KEEPS && marker !== '') {
    try {
      mark(marker);
    } catch (error) {
      said.reason = `the stage's unfinished change is not handed back: ${error?.message ?? error}`;
    }
  }
  write(`${JSON.stringify(said)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
