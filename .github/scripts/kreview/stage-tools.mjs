import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
const CONTROL_MS = 10_000;
const LAUNCH_MS = 3000;
const TERM_MS = 5000;
const DRAIN_MS = 1000;
const UNIT_RESERVE_MS = 12_000;
const SUDO = ['/usr/bin/sudo', '-n', '--'];
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = ['/usr/bin/systemctl', '--system', '--no-ask-password'];
const UNIT_FIELDS = ['LoadState', 'ActiveState', 'Result', 'ExecMainCode', 'ExecMainStatus', 'ControlGroup'];
const CONTROL_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' };
const CGROUP_ROOT = '/sys/fs/cgroup';

export const stageToolsFiles = (runnerTemp) => Object.freeze({
  result: join(runnerTemp, 'ksai-stage-tools.json'),
  log: join(runnerTemp, 'ksai-stage-tools.log'),
  pid: join(runnerTemp, 'ksai-stage-tools.pid'),
});

function commandResult(argv, maximumMilliseconds, { env, launch, onExit = false, control = false, schedule = setTimeout, unschedule = clearTimeout }) {
  return new Promise((done) => {
    const child = launch(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    let ended = false;
    let timerFired = false;
    const finish = (code, signal, error = null) => {
      if (ended) return;
      ended = true;
      unschedule(timer);
      done({ code, signal, error, timerFired, stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim().slice(-2000) });
    };
    const release = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const timer = schedule(() => {
      timerFired = true;
      child.kill('SIGKILL');
      if (control) {
        release();
        finish(null, 'SIGKILL', new Error('the unit control command did not close'));
      }
    }, maximumMilliseconds);
    const keep = (into) => (bytes) => {
      size += bytes.length;
      if (size <= OUTPUT_BYTES) into.push(bytes);
      else if (control && !ended) {
        child.kill('SIGKILL');
        release();
        finish(null, 'SIGKILL', new Error('the unit control reply was too large'));
      }
    };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    child.once('error', (error) => {
      if (onExit || control) release();
      finish(null, null, error);
    });
    if (onExit) child.once('exit', (code, signal) => {
      if (code !== 0 || signal || timerFired) {
        release();
        finish(code, signal);
      }
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

export async function unitControl(argv, options = {}) {
  const result = await commandResult(argv, CONTROL_MS, { launch: spawn, ...options, env: CONTROL_ENV, control: true });
  if (result.error || result.code !== 0) throw result.error ?? new Error('the unit control command failed');
  return result.stdout;
}

function parseUnitFields(text) {
  const fields = Object.create(null);
  for (const line of String(text).trim().split('\n')) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at < 1 || !UNIT_FIELDS.includes(key) || Object.hasOwn(fields, key)) throw new Error('invalid unit control reply');
    fields[key] = line.slice(at + 1);
  }
  if (Object.keys(fields).length !== UNIT_FIELDS.length) throw new Error('incomplete unit control reply');
  return fields;
}

function emptyGroup(group, read = readFileSync) {
  if (group === '') return true;
  if (!group.startsWith('/') || group.split('/').includes('..')) return false;
  try {
    return /^populated 0$/m.test(read(join(CGROUP_ROOT, group, 'cgroup.events'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function checkedUnit(unit, lost, options, read) {
  const show = async () => parseUnitFields(await unitControl([
    ...SYSTEMCTL, 'show', '--all', `--property=${UNIT_FIELDS.join(',')}`, unit,
  ], options));
  const before = await show();
  let after = before;
  let stopError;
  if (['active', 'activating', 'deactivating'].includes(before.ActiveState)) {
    try {
      await unitControl([...SUDO, ...SYSTEMCTL, 'stop', unit], options);
    } catch (error) {
      stopError = error;
    }
    after = await show();
  }
  if ((before.LoadState === 'not-found' && lost) || !['inactive', 'failed'].includes(after.ActiveState)
    || !emptyGroup(after.ControlGroup, read)) throw stopError ?? new Error('the privileged command did not settle');
  if (after.ActiveState === 'failed') {
    try {
      await unitControl([...SUDO, ...SYSTEMCTL, 'reset-failed', unit], options);
    } catch (error) {
      if ((await show()).LoadState !== 'not-found') throw error;
    }
  }
  return after;
}

const deadlineError = () => Object.assign(new Error('the stage tools deadline ended'), { deadline: true });

function validEpoch(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function privilegedCommand(command, unit, startBy, endBy, span, supportsExpansionOption) {
  return [
    ...SUDO, SYSTEMD_RUN, '--system', '--no-ask-password', '--service-type=exec', '--wait',
    '--quiet', ...(supportsExpansionOption ? ['--expand-environment=no'] : []),
    '--setenv=NODE_OPTIONS=--jitless', '--working-directory=/', `--unit=${unit}`,
    `--property=RuntimeMaxSec=${(span + UNIT_RESERVE_MS) / 1000}s`,
    '--property=KillMode=control-group', '--property=TimeoutStopSec=5s', '--property=SendSIGKILL=yes', '--property=Delegate=yes',
    '--', process.execPath, import.meta.filename, 'gate', String(startBy), String(endBy), '--', ...command,
  ];
}

export async function runCommand(argv, maximumMilliseconds = 120_000, {
  env = process.env, launch = spawn, now = Date.now, nonce = () => randomBytes(8).toString('hex'), state = { privilegedBlocked: false },
  read = readFileSync, schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  const raw = env.KSAI_STEP_DEADLINE_AT;
  const bounded = raw !== '' && raw !== undefined;
  if (bounded && !validEpoch(raw)) throw new Error('invalid stage tools deadline');
  const prefixed = bounded && SUDO.every((word, at) => argv[at] === word);
  if (prefixed && state.privilegedBlocked) throw new Error('a prior privileged command did not settle');
  const started = now();
  const available = bounded ? Number(raw) - started - (prefixed ? UNIT_RESERVE_MS : 0) : Infinity;
  const capped = available < maximumMilliseconds;
  const span = Math.min(maximumMilliseconds, available);
  if (bounded && (available < (prefixed ? LAUNCH_MS + 1000 : 1000) || span < 1)) throw deadlineError();
  if (prefixed && span < LAUNCH_MS + 1000) throw new Error('the privileged command limit is too short');

  const options = { launch, schedule, unschedule };
  let timeout = span;
  let unit = '';
  let command = argv;
  if (prefixed) {
    const id = nonce();
    if (!/^[0-9a-f]{16}$/.test(id) || argv.some((arg) => /[$%]/.test(arg))) throw new Error('invalid privileged command arguments');
    const help = await commandResult([SYSTEMD_RUN, '--help'], LAUNCH_MS, { ...options, env: CONTROL_ENV, control: true });
    if (help.timerFired && capped) throw deadlineError();
    if (help.error || help.code !== 0) throw help.error ?? new Error('could not read systemd-run options');
    const supportsExpansionOption = help.stdout.includes('--expand-environment=');
    if (!supportsExpansionOption && [process.execPath, import.meta.filename].some(arg => /[$%]/.test(arg))) {
      throw new Error('invalid privileged gate path');
    }
    const elapsed = Math.max(0, now() - started);
    if (elapsed > LAUNCH_MS) {
      if (capped) throw deadlineError();
      throw new Error('the privileged command missed its launch deadline');
    }
    if (state.privilegedBlocked) throw new Error('a prior privileged command did not settle');
    timeout = span + UNIT_RESERVE_MS - elapsed;
    unit = `ksai-step-${id}.service`;
    command = privilegedCommand(argv.slice(SUDO.length), unit, started + LAUNCH_MS, started + span, span, supportsExpansionOption);
  }

  const result = await commandResult(command, timeout, { ...options, env, onExit: Boolean(unit) });
  if (result.code === 0 && !result.timerFired) return result.stdout;
  let expired = capped && result.timerFired && result.signal === 'SIGKILL';
  if (unit) {
    try {
      const readback = await checkedUnit(unit, result.timerFired || Boolean(result.signal), options, read);
      expired ||= capped && readback.ExecMainCode === '1' && ['124', '125'].includes(readback.ExecMainStatus);
    } catch {
      state.privilegedBlocked = true;
    }
  }
  if (expired) throw deadlineError();
  throw result.error ?? new Error(`${argv.join(' ')} ended with ${result.signal ?? result.code}${unit ? ` (${unit})` : ''}: ${result.stderr}`);
}

function enterUnit(read, make, write, exists) {
  const group = /^0::(\/[^\n]+)$/m.exec(read('/proc/self/cgroup', 'utf8'))?.[1];
  if (!group || group.split('/').includes('..')) throw new Error('the privileged command has no unit control group');
  const gate = join(CGROUP_ROOT, group, 'gate');
  const command = join(CGROUP_ROOT, group, 'cmd');
  make(gate);
  make(command);
  write(join(gate, 'cgroup.procs'), '0');
  if (!exists(join(command, 'cgroup.kill'))) throw new Error('the privileged command control group cannot be stopped');
  return command;
}

export async function runGate(startBy, endBy, argv, {
  now = Date.now, launch = spawn, read = readFileSync, make = mkdirSync, write = writeFileSync, exists = existsSync,
  pause = sleep, schedule = setTimeout, unschedule = clearTimeout, signals = process,
  kill = process.kill,
} = {}) {
  if (!validEpoch(startBy) || !validEpoch(endBy) || Number(endBy) <= Number(startBy) || !argv[0]) throw new Error('invalid privileged command gate');
  if (now() > Number(startBy)) return 125;
  const { constants } = await import('node:os');
  const group = enterUnit(read, make, write, exists);
  if (now() > Number(startBy)) return 125;
  const child = launch('/bin/sh', ['-c', 'echo 0 > "$1" && shift && exec "$@"', 'sh', join(group, 'cgroup.procs'), ...argv], {
    detached: true, stdio: 'inherit',
  });
  let terminate;
  const stopped = new Promise((done) => { terminate = done; });
  let grace;
  let expired = false;
  const stop = () => {
    if (grace !== undefined) return;
    grace = schedule(() => terminate(1), TERM_MS);
    try {
      kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signals.once('SIGTERM', stop);
  const deadline = schedule(() => {
    expired = true;
    stop();
  }, Math.max(0, Number(endBy) - now()));
  const exited = new Promise((done, failed) => {
    child.once('error', failed);
    child.once('exit', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
  let code;
  try {
    code = await Promise.race([exited, stopped]);
  } finally {
    unschedule(deadline);
    if (grace !== undefined) unschedule(grace);
    signals.removeListener('SIGTERM', stop);
    write(join(group, 'cgroup.kill'), '1');
    const until = now() + DRAIN_MS;
    while (!/^populated 0$/m.test(read(join(group, 'cgroup.events'), 'utf8')) && now() < until) {
      await pause(Math.min(25, until - now()));
    }
  }
  return expired ? 124 : code;
}

const reportedVersion = (text) => stripVTControlCharacters(String(text)).trim().replace(/^opencode v/, '');

export async function installStageOpencode({ version, runnerTemp, run = runCommand, install = installOpencode, log = console.error }) {
  const toolBin = join(runnerTemp, 'ksai-opencode', 'bin');
  let selected = '';
  try {
    selected = (await install({ version, distDir: join(runnerTemp, 'ksai-opencode-dist'), toolDir: toolBin }))?.binary ?? '';
    if (selected) log(`Installed OpenCode ${version} from its verified registry package`);
    else log('runner is not Linux x64 or arm64 with glibc, installing OpenCode from npm');
  } catch (error) {
    log(annotation(`OpenCode registry install failed (${error.message}), installing from npm`, 'warning'));
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
  if (actual !== version) throw new Error(`opencode reports ${actual}, but this run pinned ${version}`);
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

export async function runStageTools({ env = process.env, prepare = prepareStageTools, command = runCommand } = {}) {
  const files = stageToolsFiles(env.RUNNER_TEMP);
  let deadline = false;
  const state = { privilegedBlocked: false };
  const run = (argv, maximumMilliseconds) => command(argv, maximumMilliseconds, { env, state }).catch((error) => {
    deadline ||= error.deadline === true;
    throw error;
  });
  try {
    const { version, toolBin } = await prepare({ version: String(env.OPENCODE_VERSION ?? ''), runnerTemp: env.RUNNER_TEMP, run });
    writeStageToolsResult(files.result, { ok: true, version, toolBin });
  } catch (error) {
    writeStageToolsResult(files.result, { ok: false, error: String(error.message).slice(0, 4000), ...(deadline ? { deadline } : {}) });
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
  if (!result.ok) {
    throw Object.assign(new Error(`the stage tools could not be installed: ${result.error}`), { exitCode: result.deadline ? 124 : 1 });
  }
  if (env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, `${result.toolBin}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\n`);
  return result;
}

await runMain(import.meta.url, async () => {
  const mode = process.argv[2];
  if (mode === 'start') startStageTools();
  else if (mode === 'run') await runStageTools();
  else if (mode === 'wait') await waitStageTools();
  else if (mode === 'gate') {
    const [, , , startBy, endBy, separator, ...argv] = process.argv;
    if (separator !== '--') throw new Error('the privileged command gate requires --');
    const exitCode = await runGate(startBy, endBy, argv);
    if (exitCode !== 0) throw Object.assign(new Error('the privileged command gate stopped'), { exitCode });
  } else throw new Error(`stage-tools takes start, run, wait or gate, not ${mode}`);
});
