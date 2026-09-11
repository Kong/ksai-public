import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

export const LAYOUT = Object.freeze(['inbox', 'run/ticks', 'run/consumed']);

const NONCE_SHAPE = /^[0-9a-f]{16}$/;

export function openChannel(stateDir = '', { draw = () => randomBytes(8), log = console.log } = {}) {
  if (!stateDir) throw new Error('STATE_DIR names no directory, so the run channel has nowhere to open');
  rmSync(stateDir, { recursive: true, force: true });
  for (const at of LAYOUT) mkdirSync(join(stateDir, at), { recursive: true });

  const nonce = Buffer.from(draw()).toString('hex');
  if (NONCE_SHAPE.test(nonce)) return { stateDir, nonce };
  log('::warning::The run channel could not draw a nonce, so no notes will reach this run');
  return { stateDir, nonce: '' };
}

export function main(env = process.env) {
  const { stateDir, nonce } = openChannel(env.STATE_DIR);
  writeOutputs(env.GITHUB_OUTPUT, {
    state_dir: stateDir,
    nonce,
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
