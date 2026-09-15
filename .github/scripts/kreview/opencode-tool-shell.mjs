#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { isolatedToolCommand, toolLauncherEnvironment } from './opencode-tool-sandbox.mjs';

let isolated;
try {
  isolated = isolatedToolCommand('/bin/sh', process.argv.slice(2), process.cwd(), true, process.env);
} catch (error) {
  console.error(`tool sandbox refused to start: ${error.message}`);
  process.exit(125);
}
const result = spawnSync(isolated.command, isolated.args, {
  env: toolLauncherEnvironment(process.env),
  stdio: 'inherit',
});
if (result.error) {
  console.error(`tool sandbox failed: ${result.error.message}`);
  process.exit(125);
}
if (result.signal) {
  console.error(`tool sandbox ended on ${result.signal}`);
  process.exit(128);
}
process.exit(result.status ?? 125);
