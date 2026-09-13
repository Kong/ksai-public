import { fileURLToPath } from 'node:url';

import { annotation } from '../lib/text.cjs';

export async function runMain(url = '', main = async () => {}) {
  if (process.argv[1] !== fileURLToPath(url)) return;
  try {
    await main();
  } catch (error) {
    console.error(annotation(error.message));
    process.exitCode = 1;
  }
}
