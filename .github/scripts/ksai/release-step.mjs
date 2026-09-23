import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { editPullBody, readPullBody, runCommand } from './run.mjs';

const require = createRequire(import.meta.url);
const { usingControlPlane } = require('../lib/control-plane.cjs');
const { writerFor } = require('../lib/cp-effects.cjs');
const { withRelease } = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');

export function main(env = process.env, { run = runCommand,
  record = (facts) => writerFor({ env }).recordRelease(facts) } = {}) {
  const ref = String(env.RELEASE_REF ?? '').trim();
  if (ref === '') return { recorded: false };

  const prNumber = String(env.PR_NUMBER ?? '').trim();
  if (!NUMBER_SHAPE.test(prNumber)) {
    return { error: 'this run has no pull request number, so the release cannot be recorded' };
  }
  const repo = String(env.REPO ?? '');

  if (usingControlPlane(env)) {
    return Promise.resolve().then(() => record({ number: Number(prNumber), ref, url: env.APPROVAL_URL })).then(
      (said) => said.released ? { recorded: true } : { error: 'the control plane did not record the release' },
      () => ({ error: 'the control plane could not record the release' }),
    );
  }

  const body = readPullBody({ repo, number: prNumber, run });
  if (body === null) return { error: 'the pull request body could not be read, so the release cannot be recorded' };

  const next = withRelease(body, ref, { url: env.APPROVAL_URL });
  if (next === null) return { error: 'the reference the approval gate resolved is not one this may write' };
  if (next.changed === false) return { recorded: true };

  const bodyFile = path.join(env.RUNNER_TEMP || '/tmp', 'ksai-release-body.md');
  if (!editPullBody({ repo, number: prNumber, bodyFile, body: next.body, run })) {
    return { error: 'the pull request body could not be updated, so the release cannot be recorded' };
  }
  return { recorded: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await main();
  if (out.error) {
    process.stderr.write(
      `${out.error}. The plan stays unreleased and no code is written; the next run reads the approval again.\n`,
    );
    process.exitCode = 1;
  }
}
