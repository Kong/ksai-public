import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONTROL_PLANE_KEEPS = 'the runtime holds no push credential and commits nothing itself, since the control plane makes every commit';

export function preserved(env) {
  const stopped = env.PRESERVE_STOPPED === 'true';
  const killed = env.PRESERVE_KILLED === 'true';
  if (!stopped && !killed) return { preserved: '', reason: 'this run was not asked to stop and was not killed', tree: '' };
  if (stopped && env.PRESERVE_HARD === 'true') return { preserved: '', reason: 'a hard stop preserves nothing by design', tree: '' };
  return { preserved: '', reason: CONTROL_PLANE_KEEPS, tree: '' };
}

export function main(env = process.env, { write = (said) => writeFileSync(String(env.PRESERVE_OUT ?? ''), said, { mode: 0o600 }) } = {}) {
  write(`${JSON.stringify(preserved(env))}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
