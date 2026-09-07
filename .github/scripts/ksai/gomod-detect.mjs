import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { MODULE_FILE, moduleDirs, warn } = require('./gomod.cjs');
const { gitVia } = require('./verify-chunk.cjs');

const MAX_BUFFER = 32 * 1024 * 1024;

function tracked(workspace) {
  const run = (file, args, options) => execFileSync(file, args, { ...options, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  try {
    return gitVia(run, workspace)(['ls-files', '-z', '--', MODULE_FILE, `*/${MODULE_FILE}`]);
  } catch (error) {
    warn(`the working tree could not be listed, so no Go module was looked for: ${error.message}`);
    return '';
  }
}

export function main(env = process.env) {
  const workspace = env.WORKSPACE || process.cwd();
  const found = moduleDirs(tracked(workspace));
  const dirs = found.filter((one) => !/[\r\n]/.test(one));

  if (dirs.length !== found.length) {
    warn(
      `${found.length - dirs.length} Go module path holds a line break and is left out: no step output can carry one, and nothing here may fail a run over a directory name`,
    );
  }

  if (dirs.length === 0) {
    writeOutputs(env.GITHUB_OUTPUT, {
      mod: '',
      list: '',
    });
    return 0;
  }

  const list = `${env.RUNNER_TEMP}/ksai-go-modules.txt`;
  let written = list;
  try {
    writeFileSync(list, `${dirs.join('\n')}\n`);
  } catch (error) {
    written = '';
    warn(`the Go module list could not be written, so no cache is warmed: ${error.message}`);
  }
  const root = dirs[0];
  writeOutputs(env.GITHUB_OUTPUT, {
    mod: root === '.' ? MODULE_FILE : `${root}/${MODULE_FILE}`,
    list: written,
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
