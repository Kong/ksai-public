import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

import { runMain } from '../lib/main.mjs';
import { annotation } from '../lib/text.cjs';
import { installOpencode } from './opencode-install.mjs';
import { prepareSandboxTools } from './sandbox-tools.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..');
const OUTPUT_BYTES = 64 * 1024;
const WAIT_MS = 15 * 60_000;

export const stageToolsFiles = (runnerTemp) => Object.freeze({
  result: join(runnerTemp, 'ksai-stage-tools.json'),
  log: join(runnerTemp, 'ksai-stage-tools.log'),
  pid: join(runnerTemp, 'ksai-stage-tools.pid'),
});

export function runCommand(argv, maximumMilliseconds = 120_000, { env = process.env, launch = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = launch(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const keep = (into) => (bytes) => {
      size += bytes.length;
      if (size <= OUTPUT_BYTES) into.push(bytes);
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), maximumMilliseconds);
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${argv.join(' ')} ended with ${signal ?? code}: ${Buffer.concat(err).toString('utf8').trim().slice(-2000)}`));
    });
  });
}

const reportedVersion = (text) => stripVTControlCharacters(String(text)).trim().replace(/^opencode v/, '');

export async function installStageOpencode({ version, runnerTemp, run = runCommand, install = installOpencode, log = console.error }) {
  const toolBin = join(runnerTemp, 'ksai-opencode', 'bin');
  let selected = '';
  try {
    selected = (await install({ version, distDir: join(runnerTemp, 'ksai-opencode-dist'), toolDir: toolBin }))?.binary ?? '';
    if (selected) log(`Installed OpenCode ${version} from its verified registry package`);
    else log('this runner is not Linux x64 or arm64 with glibc, so OpenCode is installed from npm');
  } catch (error) {
    log(annotation(`OpenCode could not be installed from its verified registry package (${error.message}), so it is installed from npm`, 'warning'));
  }
  if (!selected) {
    await run(['npm', 'install', '--global', '--allow-scripts=@opencode/cli', `@opencode/cli@${version}`], 300_000);
    selected = join((await run(['npm', 'prefix', '--global'])).trim(), 'bin', 'opencode');
  }
  mkdirSync(toolBin, { recursive: true });
  const link = join(toolBin, 'opencode');
  rmSync(link, { force: true });
  symlinkSync(selected, link);
  const actual = reportedVersion(await run([link, '--version']));
  if (actual !== version) throw new Error(`opencode reports ${actual}, and this run pinned ${version} - two builds of one reviewer are not one reviewer`);
  return Object.freeze({ version: actual, toolBin });
}

export async function prepareStageTools({
  version, runnerTemp, scripts = SCRIPTS, run = runCommand, installOpencodeImpl = installStageOpencode,
  sandbox = prepareSandboxTools, log = console.error,
}) {
  const workDir = mkdtempSync(join(runnerTemp, 'ksai-stage-tools-'));
  try {
    const [opencode] = await Promise.all([
      installOpencodeImpl({ version, runnerTemp, run, log }),
      run(['npm', 'ci', '--prefix', join(scripts, 'vendor', 'opencode-client'), '--omit=dev', '--ignore-scripts', '--audit=false', '--fund=false'], 300_000),
      sandbox({ run, workDir }),
    ]);
    return opencode;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function writeStageToolsResult(path, result) {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  renameSync(partial, path);
}

export async function runStageTools({ env = process.env, prepare = prepareStageTools } = {}) {
  const files = stageToolsFiles(env.RUNNER_TEMP);
  try {
    const { version, toolBin } = await prepare({ version: String(env.OPENCODE_VERSION ?? ''), runnerTemp: env.RUNNER_TEMP });
    writeStageToolsResult(files.result, { ok: true, version, toolBin });
  } catch (error) {
    writeStageToolsResult(files.result, { ok: false, error: String(error.message).slice(0, 4000) });
    throw error;
  }
}

export function startStageTools({ env = process.env, launch = spawn } = {}) {
  const files = stageToolsFiles(env.RUNNER_TEMP);
  for (const path of Object.values(files)) rmSync(path, { force: true });
  const log = openSync(files.log, 'a', 0o600);
  try {
    const child = launch(process.execPath, [join(SCRIPTS, 'ksai', 'deadline-command.mjs'), '--', process.execPath, import.meta.filename, 'run'], {
      env, detached: true, stdio: ['ignore', log, log],
    });
    child.unref();
    writeFileSync(files.pid, `${child.pid}\n`, { mode: 0o600 });
  } finally {
    closeSync(log);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export async function waitStageTools({ env = process.env, now = Date.now, pause = sleep, inline = runStageTools, maximumMilliseconds = WAIT_MS } = {}) {
  const files = stageToolsFiles(env.RUNNER_TEMP);
  if (!existsSync(files.pid)) await inline({ env }).catch(() => {});
  else {
    const pid = Number(readFileSync(files.pid, 'utf8'));
    const until = now() + maximumMilliseconds;
    while (!existsSync(files.result) && alive(pid) && now() < until) await pause(200);
  }
  if (existsSync(files.log)) process.stderr.write(readFileSync(files.log));
  if (!existsSync(files.result)) throw new Error('the stage tools install ended without a result');
  const result = JSON.parse(readFileSync(files.result, 'utf8'));
  if (!result.ok) throw new Error(`the stage tools could not be installed: ${result.error}`);
  if (env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, `${result.toolBin}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\n`);
  return result;
}

await runMain(import.meta.url, async () => {
  const mode = process.argv[2];
  if (mode === 'start') startStageTools();
  else if (mode === 'run') await runStageTools();
  else if (mode === 'wait') await waitStageTools();
  else throw new Error(`stage-tools takes start, run or wait, not ${mode}`);
});
