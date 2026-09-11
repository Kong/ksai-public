import { pathToFileURL } from 'node:url';

import { verifyVerdict } from './staging.mjs';

export function main(env = process.env) {
  verifyVerdict(env.VERDICT, env.SHA256);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
