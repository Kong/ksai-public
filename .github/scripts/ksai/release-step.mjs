import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { runCommand } from './run.mjs';

const require = createRequire(import.meta.url);
const { withRelease } = require('./plan.cjs');
const { NUMBER_SHAPE } = require('./context.cjs');

export function main(env = process.env, { run = runCommand } = {}) {
  const ref = String(env.RELEASE_REF ?? '').trim();
  if (ref === '') return { recorded: false };

  const prNumber = String(env.PR_NUMBER ?? '').trim();
  if (!NUMBER_SHAPE.test(prNumber)) {
    return { error: 'this run has no pull request number, so the release cannot be recorded' };
  }
  const repo = String(env.REPO ?? '');

  const view = run('gh', ['pr', 'view', prNumber, '--repo', repo, '--json', 'body', '--jq', '.body']);
  if (!view.ok) return { error: 'the pull request body could not be read, so the release cannot be recorded' };

  const next = withRelease(view.stdout, ref, { url: env.APPROVAL_URL });
  if (next === null) return { error: 'the reference the approval gate resolved is not one this may write' };
  if (next.changed === false) return { recorded: true };

  const file = path.join(env.RUNNER_TEMP || '/tmp', 'ksai-release-body.md');
  writeFileSync(file, next.body);
  if (!run('gh', ['pr', 'edit', prNumber, '--repo', repo, '--body-file', file]).ok) {
    return { error: 'the pull request body could not be updated, so the release cannot be recorded' };
  }
  return { recorded: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = main();
  if (out.error) {
    process.stderr.write(
      `${out.error}. The plan stays unreleased and no code is written; the next run reads the approval again.\n`,
    );
    process.exitCode = 1;
  }
}
