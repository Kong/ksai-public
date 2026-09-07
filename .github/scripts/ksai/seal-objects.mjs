import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sealObjectStore } = require('./trusted-git.cjs');

const sealed = sealObjectStore(process.env.WORKSPACE);
if (!sealed.ok) {
  console.error(sealed.reason);
  process.exitCode = 1;
} else {
  appendFileSync(process.env.GITHUB_ENV, `KSAI_GIT_OBJECTS=${sealed.path}\n`);
  console.log('The pre-model Git object store is sealed outside the writable workspace');
}
