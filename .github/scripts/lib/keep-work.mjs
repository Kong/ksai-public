import { join } from 'node:path';

import text from './text.cjs';

export const KEEP_MARKER = 'ksai-keep-work.json';

export function keepMarker(env) {
  const temp = String(env.RUNNER_TEMP ?? '').trim();
  return temp === '' ? '' : join(temp, KEEP_MARKER);
}

export function unkeptWarning(message, log = console.log) {
  log(text.annotation(message, 'warning'));
}
