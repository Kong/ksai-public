import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { runMain } from '../../lib/main.mjs';
import { writeOutputs } from '../../lib/outputs.mjs';
import { redacted, secretsOf, tailOf } from '../run-files.mjs';
import { preparedToolchains } from '../stage-steps.mjs';
import {
  FAILURES, MAX_EXPORTS_PATH_BYTES, SESSION_ENV, SETUP_ENV, checkDeadline, factsFileOf, readHarnessInput, relayLogOf, setupLogOf,
  setupTreeOf, stateDirOf, validatePlan, writeHarnessResult,
} from './contract.mjs';
import { ownerSignal } from './owner.mjs';

export { checkDeadline } from './contract.mjs';

export function writeFacts(stateDir, facts) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pending = join(stateDir, `.facts-${randomUUID()}.json`);
  try {
    writeFileSync(pending, JSON.stringify(facts), { flag: 'wx', mode: 0o600 });
    renameSync(pending, factsFileOf(stateDir));
  } finally {
    rmSync(pending, { force: true });
  }
}

export function writeRefusal(stateDir, failure, error) {
  if (error?.exitCode === 124) {
    writeHarnessResult({ ok: false });
    process.exitCode = 124;
    return;
  }
  writeFacts(stateDir, { steps: [], endpoints: [], failure });
  writeHarnessResult({ ok: false, failure });
}

export function checkedPath(root, name) {
  const path = resolve(root, name);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('harness file is outside its root');
  let directory = dirname(path);
  while (directory !== root) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('harness file parent is not a directory');
    directory = dirname(directory);
  }
  return path;
}

function removePaths(root, plan, check) {
  for (const path of plan.paths) {
    check();
    rmSync(checkedPath(root, path), { recursive: true, force: true });
  }
  const names = new Set(plan.names);
  const keep = new Set(plan.keep);
  const walk = (dir) => {
    check();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      check();
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const rootMatch = dir === root && !keep.has(entry.name) && plan.root_prefixes.some((prefix) => entry.name.startsWith(prefix));
      if (rootMatch || names.has(entry.name)) rmSync(path, { force: true, recursive: true });
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
}

export function prepareFiles({ plan, workspace, setup_tree: setupTree, setup_deadline_at: deadlineAt }, {
  env = process.env, now = Date.now,
} = {}) {
  const check = () => checkDeadline(deadlineAt, now);
  check();
  const { remove, files } = validatePlan(plan, env);
  const root = realpathSync(workspace ?? env.GITHUB_WORKSPACE);
  const tree = setupTree ?? setupTreeOf(env.RUNNER_TEMP);
  if (!isAbsolute(tree) || resolve(tree) === root || resolve(tree).startsWith(`${root}${sep}`)) {
    throw new Error('invalid harness setup tree');
  }
  removePaths(root, remove, check);
  mkdirSync(tree, { mode: 0o700 });
  cpSync(root, tree, {
    recursive: true, verbatimSymlinks: true, filter: () => {
      check();
      return true;
    },
  });
  check();
  const directory = checkedPath(root, '_ksai/harness/entry');
  const filesRoot = dirname(directory);
  mkdirSync(filesRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    check();
    const file = checkedPath(filesRoot, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx', mode: 0o444 });
  }
  check();
}

export function setupEnvironment(env, stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    ...Object.fromEntries(SETUP_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])),
    TMPDIR: mkdtempSync(join(stateDir, 'command-')),
  };
}

export function commandOf(step, { tree, toolRoot, toolPath, allowed }) {
  const paths = { setup_tree: tree, tool_root: toolRoot, tool_path: toolPath.join(delimiter) };
  const expand = (value) => value.replace(/\$\{(setup_tree|tool_root|tool_path)\}/gu, (_name, key) => paths[key]);
  const env = { ...allowed, ...Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, expand(value)])) };
  if (step.tools && paths.tool_path) env.PATH = [paths.tool_path, env.PATH].filter(Boolean).join(delimiter);
  return { argv: [...step.argv], env };
}

function toolDirectory(root, directory) {
  if (!isAbsolute(directory) || directory.includes(delimiter) || /[\r\n]/u.test(directory)) {
    throw Object.assign(new Error('invalid harness tool directory'), { code: 'invalid_tool_directory' });
  }
  const resolved = realpathSync(directory);
  if (!resolved.startsWith(`${root}${sep}`) || resolved.includes(delimiter) || /[\r\n]/u.test(resolved) || !statSync(resolved).isDirectory()) {
    throw Object.assign(new Error('harness tool directory is outside the tool root'), { code: 'outside_tool_root' });
  }
  return resolved;
}

export function exportedPaths(file, root) {
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(MAX_EXPORTS_PATH_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = readSync(fd, bytes, used, bytes.length - used, null);
      if (read === 0) break;
      used += read;
    }
    if (used > MAX_EXPORTS_PATH_BYTES || fstatSync(fd).size > MAX_EXPORTS_PATH_BYTES) throw Object.assign(new Error('harness tool path output exceeds its limit'), { code: 'exports_too_large' });
    const lines = bytes.subarray(0, used).toString('utf8').split(/\r?\n/u);
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line) => toolDirectory(root, line));
  } finally {
    closeSync(fd);
  }
}

export function untar(argv, env, timeout, cwd) {
  const ended = spawnSync('bwrap', argv, { cwd, env, timeout, stdio: 'ignore', killSignal: 'SIGKILL' });
  if (ended.status !== 0) throw new Error('cannot extract the harness toolchain');
}

export async function fetchTools(plan, { toolRoot, env, deadlineAt, signal, fetch, extract = untar, now = Date.now }) {
  const bounded = ownerSignal(deadlineAt, signal);
  const archive = (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, bounded]) });
  const run = (argv, childEnv, timeout, cwd) => {
    bounded.throwIfAborted();
    const at = now();
    checkDeadline(deadlineAt, () => at);
    extract(argv, childEnv, Math.min(timeout, deadlineAt - at), cwd);
  };
  const { prepared, why } = await preparedToolchains(plan, { temp: toolRoot, env, run, fetch: archive, held: new Map() });
  bounded.throwIfAborted();
  if (why) throw new Error('cannot prepare the harness toolchain');
  return prepared.map(({ name, root }) => toolDirectory(toolRoot, join(root, plan.toolchains.find((item) => item.name === name).bin)));
}

export function exportTools(env, context) {
  const path = [...new Set(context.toolPath)].join(delimiter);
  writeOutputs(env.GITHUB_ENV, {
    KSAI_TOOL_ROOT: context.toolRoot, KSAI_TOOL_PATH: path, KSAI_MODEL_PATH: path,
    [SESSION_ENV]: JSON.stringify(context.plan.session_env),
  });
}

export function readToolPath(toolRoot, env) {
  const path = env.KSAI_TOOL_PATH;
  if (!path) return [];
  let root;
  try {
    root = realpathSync(toolRoot);
  } catch {
    return [];
  }
  return path.split(delimiter).flatMap((entry) => {
    try {
      return [toolDirectory(root, entry)];
    } catch {
      return [];
    }
  });
}

export function printSetupLogs(plan, stateDir, env, print, reapError) {
  const secrets = secretsOf(env);
  const errors = Array.isArray(reapError) ? reapError.filter(Boolean) : reapError ? [reapError] : [];
  for (const error of errors) {
    print(`harness reap: ${redacted(String(error.message), secrets).replace(/[\r\n]+/gu, ' ')}\n`);
  }
  if (!plan) return;
  const tails = plan.steps.flatMap((step, index) => step.phase === 'teardown' ? [] : [setupLogOf(stateDir, index)]);
  tails.push(relayLogOf(stateDir));
  for (const file of tails) {
    let text = '';
    try {
      if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) ({ text } = tailOf(file, 8192));
    } catch {
      continue;
    }
    if (!text) continue;
    const log = `${redacted(text, secrets).trimEnd()}\n`;
    if (env.GITHUB_ACTIONS === 'true') {
      const marker = randomUUID();
      print(`::stop-commands::${marker}\n${log}::${marker}::\n`);
    } else print(log);
  }
}

await runMain(import.meta.url, async () => {
  try {
    prepareFiles(readHarnessInput());
    writeHarnessResult({ ok: true });
  } catch (error) {
    writeRefusal(stateDirOf(process.env.RUNNER_TEMP), FAILURES.filesRefused, error);
  }
});
