import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { prepareBuildScratch, toolSandboxArgs } from './opencode-tool-sandbox.mjs';
import { maskedHomeArgs } from './opencode-v2.mjs';
import { PREPARE, cacheDir, cacheHeld, keptCache, stepsOf } from '../ksai/stage-steps.mjs';
import { runMain } from '../lib/main.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { CACHE_ROOT, MANIFEST, SANDBOX_ENV, publishedSandbox } from '../lib/step-sandbox.mjs';

const say = (message) => process.stdout.write(`${message}\n`);
const notice = (message) => say(`::notice::${message}`);
const warn = (message) => say(`::warning::${message}`);

const fenced = (args, timeout) => spawnSync('bwrap', args, { stdio: ['ignore', 'inherit', 'inherit'], timeout, killSignal: 'SIGKILL' });

export function prepareArgs(env, binds, carried) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const args = toolSandboxArgs({ ...env, [SANDBOX_ENV]: JSON.stringify(carried) }, workspace);
  const end = args.lastIndexOf('--');
  return [
    ...args.slice(0, end),
    ...binds.flatMap(([from, to, writable]) => [writable ? '--bind' : '--ro-bind', from, to]),
    '--ro-bind', workspace, workspace,
    ...maskedHomeArgs(String(env.HOME ?? '')),
    ...args.slice(end),
  ];
}

function drop(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function emptied(dir, restored) {
  const why = restored ? cacheHeld(dir) : '';
  if (!restored || why) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return why;
}

function ranWithin(step, args, { run, now }) {
  const deadline = now() + step.timeout_seconds * 1000;
  let ran = false;
  for (const argv of step.run) {
    const left = deadline - now();
    if (left <= 0) {
      warn(`step \`${step.id}\` used its ${step.timeout_seconds} s before \`${argv[0]}\`, so the model builds what it left out`);
      break;
    }
    const done = run([...args, ...argv], left);
    if (done.error && done.error.code !== 'ETIMEDOUT') {
      warn(`step \`${step.id}\` could not start \`${argv[0]}\`: ${done.error.message}`);
      break;
    }
    ran = true;
    if (done.error) {
      warn(`step \`${step.id}\` used its ${step.timeout_seconds} s in \`${argv[0]}\`, so the model builds what it left out`);
      break;
    }
    if (done.status !== 0) notice(`step \`${step.id}\` ran \`${argv[0]}\`, which exited ${done.status}, and the model keeps what it prepared`);
  }
  return ran;
}

function written(manifest, held) {
  const staged = `${manifest}.${process.pid}`;
  try {
    writeFileSync(staged, JSON.stringify(held), { mode: 0o600 });
    renameSync(staged, manifest);
    return '';
  } catch (error) {
    rmSync(staged, { force: true });
    return error.message;
  }
}

const UNBOUNDED = Object.freeze({ most: Infinity, entries: Infinity });
const SAVED = Object.freeze({});

export function main(env = process.env, { run = fenced, now = Date.now, bound = SAVED } = {}) {
  const temp = String(env.RUNNER_TEMP ?? '').trim();
  const file = String(env.STAGE_STEPS_FILE ?? '').trim();
  if (!path.isAbsolute(temp) || !path.isAbsolute(file) || !path.isAbsolute(String(env.GITHUB_WORKSPACE ?? ''))) {
    say('runner temp, workspace or steps file is not set, no step prepared the model sandbox');
    return 0;
  }
  const { steps, refused } = stepsOf(readFileSync(file, 'utf8'));
  const preparing = refused ? [] : steps.filter((step) => step.phase === PREPARE);
  if (preparing.length === 0) return 0;
  const manifest = path.join(temp, MANIFEST);
  const published = publishedSandbox(temp);
  if (published.refused) {
    warn(`${published.refused}, so no step prepared the model sandbox`);
    return 0;
  }
  if (!prepareBuildScratch(env)) warn('the build directory could not be made, so the prepare steps build in the in-memory /tmp');
  const held = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { caches: {}, toolchains: {}, env: {} };
  const keeping = keptCache(steps, temp);
  let { binds, carried } = published;
  let kept = false;
  for (const step of preparing) {
    const caches = step.caches.map(({ name }) => [name, cacheDir(temp, name)]);
    const dirs = caches.map(([, dir]) => dir);
    for (const [name, dir] of caches) {
      const why = emptied(dir, keeping?.name === name && existsSync(dir));
      if (why) warn(`the cache \`${name}\` an earlier run kept is dropped: ${why}`);
    }
    const names = caches.map(([name]) => name);
    const next = {
      caches: [...carried.caches, ...names],
      toolchains: carried.toolchains,
      env: { ...carried.env, ...step.sandbox?.env },
      writable: [...('writable' in carried ? carried.writable : []), ...names],
    };
    const nextBinds = [...binds, ...caches.map(([name, dir]) => [dir, `${CACHE_ROOT}/${name}`, true])];
    let args;
    try {
      args = prepareArgs(env, nextBinds, next);
    } catch (error) {
      drop(dirs);
      warn(`step \`${step.id}\` prepared nothing, the model's sandbox could not be laid out: ${error.message}`);
      continue;
    }
    if (!ranWithin(step, args, { run, now })) {
      drop(dirs);
      warn(`step \`${step.id}\` prepared nothing`);
      continue;
    }
    const full = caches.map(([name, dir]) => [name, cacheHeld(dir, UNBOUNDED)]).find(([, why]) => why);
    if (full) {
      drop(dirs);
      warn(`step \`${step.id}\` hands the model nothing: cache \`${full[0]}\` ${full[1]}`);
      continue;
    }
    const after = {
      ...held,
      caches: { ...held.caches, ...Object.fromEntries(caches) },
      env: { ...held.env, ...step.sandbox?.env },
      writable: [...(held.writable ?? []), ...names],
    };
    const failed = written(manifest, after);
    if (failed) {
      drop(dirs);
      warn(`step \`${step.id}\` hands the model nothing, the sandbox manifest could not be written: ${failed}`);
      continue;
    }
    Object.assign(held, after);
    binds = nextBinds;
    carried = next;
    kept ||= names.includes(keeping?.name);
    notice(`step \`${step.id}\` prepared the model's sandbox`);
  }
  const changed = kept ? cacheHeld(keeping.path, bound) : '';
  if (changed) warn(`the cache \`${keeping.name}\` is not kept for a later run: ${changed}`);
  const ready = kept && !changed && readdirSync(keeping.path).length > 0;
  writeOutputs(env.GITHUB_OUTPUT, { keep_ready: ready ? 'true' : '', sandbox_manifest: existsSync(manifest) ? manifest : '' });
  return 0;
}

await runMain(import.meta.url, async () => {
  process.exitCode = main();
});
