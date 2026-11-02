import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runMain } from '../lib/main.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { withoutCredentials } from './package-warm.mjs';

const require = createRequire(import.meta.url);
const { gitArgs, gitEnv } = require('./trusted-git.cjs');

const MODULE_FILE = 'go.mod';
const NULL_DEVICE = '/dev/null';
const NOTHING_PRIVATE = 'none.invalid';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const WARM_BUDGET_MS = 15 * 60 * 1000;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const LOCAL_ORIGINAL = 'local ';
const GRAPH_FORMAT = '{{if not .Main}}{{with .Replace}}{{if .Version}}{{$.Path}}@{{$.Version}}\n{{.Path}}@{{.Version}}'
  + `{{else}}${LOCAL_ORIGINAL}{{$.Path}}@{{$.Version}}{{end}}{{else}}{{.Path}}@{{.Version}}{{end}}{{end}}`;

const NO_AMBIENT_GIT = Object.freeze({
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'false',
  SSH_ASKPASS: 'false',
  GIT_SSH_COMMAND: 'false',
});

const PUBLIC_FETCH = Object.freeze({
  GOTOOLCHAIN: 'local',
  GOVCS: '*:git',
  GOPRIVATE: NOTHING_PRIVATE,
  GONOPROXY: NOTHING_PRIVATE,
  GONOSUMDB: NOTHING_PRIVATE,
  GOAUTH: 'off',
  GOSUMDB: 'sum.golang.org',
  GOINSECURE: NOTHING_PRIVATE,
  GIT_CONFIG_COUNT: '0',
  ...NO_AMBIENT_GIT,
});

const warn = (message) => process.stdout.write(`::warning::${message}\n`);

const depth = (dir) => (dir === '.' ? 0 : dir.split('/').length);

export function moduleDirs(text) {
  const dirs = [];
  for (const raw of String(text ?? '').split('\0')) {
    const line = raw.trim();
    if (line === '') continue;
    const cut = line.lastIndexOf('/');
    if (line.slice(cut + 1) !== MODULE_FILE) continue;
    const dir = cut === -1 ? '.' : line.slice(0, cut);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
}

const trackedModules = (workspace) => execFileSync('git', gitArgs(workspace, ['ls-files', '-z', '--', MODULE_FILE, `*/${MODULE_FILE}`]), {
  encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, env: gitEnv(),
});

export function detect(env = process.env, { list = trackedModules } = {}) {
  const workspace = env.WORKSPACE || process.cwd();
  let found = [];
  try {
    found = moduleDirs(list(workspace));
  } catch (error) {
    warn(`the working tree could not be listed, so no Go module was looked for: ${error.message}`);
  }
  const dirs = found.filter((one) => !/[\r\n]/.test(one));
  if (dirs.length !== found.length) {
    warn(`${found.length - dirs.length} Go module path holds a line break and is left out, since no step output can carry one`);
  }
  if (dirs.length === 0) {
    writeOutputs(env.GITHUB_OUTPUT, { mod: '', list: '' });
    return 0;
  }
  const written = path.join(String(env.RUNNER_TEMP ?? ''), 'ksai-go-modules.txt');
  writeFileSync(written, `${dirs.join('\n')}\n`);
  const [root] = dirs;
  writeOutputs(env.GITHUB_OUTPUT, { mod: root === '.' ? MODULE_FILE : `${root}/${MODULE_FILE}`, list: written });
  return 0;
}

function toolchainOf(workspace) {
  try {
    return execFileSync('go', ['version'], { cwd: workspace, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const goEnvOf = (name) => (workspace) => {
  try {
    return execFileSync('go', ['env', name], { cwd: workspace, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

function downloadIn(cwd, child, timeout) {
  execFileSync('go', ['mod', 'download'], { cwd, env: child, stdio: ['ignore', 'inherit', 'inherit'], timeout });
}

function tidyIn(cwd, child, timeout) {
  return !spawnSync('go', ['mod', 'tidy', '-diff'], { cwd, env: child, stdio: ['ignore', 'ignore', 'inherit'], timeout }).error;
}

export function graphIn(cwd, child, timeout, run = spawnSync) {
  const deadline = Date.now() + timeout;
  const listed = run('go', ['list', '-mod=readonly', '-m', '-f', GRAPH_FORMAT, 'all'], {
    cwd, env: child, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, stdio: ['ignore', 'pipe', 'inherit'], timeout,
  });
  if (listed.error || listed.status !== 0) return false;
  const lines = listed.stdout.split('\n').filter((one) => one !== '');
  const modules = lines.filter((one) => !one.startsWith(LOCAL_ORIGINAL));
  const locals = lines.filter((one) => one.startsWith(LOCAL_ORIGINAL)).map((one) => one.slice(LOCAL_ORIGINAL.length));
  if (lines.length === 0) return true;
  const outside = mkdtempSync(path.join(tmpdir(), 'ksai-go-graph-'));
  const download = (wanted) => {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const fetched = run('go', ['mod', 'download', ...wanted], {
      cwd: outside, env: { ...child, GOWORK: 'off' }, stdio: ['ignore', 'ignore', 'inherit'], timeout: left,
    });
    return !fetched.error && fetched.status === 0;
  };
  try {
    const fetched = modules.length === 0 || download(modules);
    if (locals.length > 0) download(locals);
    return fetched;
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

export function main(
  env = process.env,
  {
    clock = () => Date.now(),
    toolchain = toolchainOf,
    download = downloadIn,
    tidy = tidyIn,
    graph = graphIn,
    moduleCache = goEnvOf('GOMODCACHE'),
    goRoot = goEnvOf('GOROOT'),
    cacheExists = existsSync,
    say = warn,
  } = {},
) {
  const workspace = env.WORKSPACE || process.cwd();
  const done = (version = '') => {
    if (!env.GITHUB_ENV) return 0;
    appendFileSync(env.GITHUB_ENV, 'GOPROXY=off\nGOTOOLCHAIN=local\n');
    if (version === '') return 0;
    for (const [name, at] of [['KSAI_GO_MODULE_CACHE', moduleCache(workspace)], ['KSAI_GOROOT', goRoot(workspace)]]) {
      if (at !== '' && !at.includes('\n') && cacheExists(at)) appendFileSync(env.GITHUB_ENV, `${name}=${at}\n`);
    }
    return 0;
  };

  const version = toolchain(workspace);
  if (version === '') {
    say('no `go` is on the path after setting one up, so nothing warmed the module cache');
    return done();
  }
  let dirs = [];
  try {
    dirs = readFileSync(String(env.LIST ?? ''), 'utf8').split('\n').filter((one) => one !== '');
  } catch (error) {
    say(`the Go module list could not be read, so nothing warmed the module cache: ${error.message}`);
    return done();
  }
  if (dirs.length === 0) {
    say('the Go module list named no directory, so nothing warmed the module cache');
    return done();
  }

  const child = { ...withoutCredentials(env), ...PUBLIC_FETCH };
  const deadline = clock() + WARM_BUDGET_MS;
  const moduleDir = (dir) => (dir === '.' ? workspace : `${workspace}/${dir}`);
  const failed = [];
  for (const dir of dirs) {
    const left = deadline - clock();
    try {
      if (left <= 0) throw new Error('the warm budget ran out');
      download(moduleDir(dir), child, Math.min(DOWNLOAD_TIMEOUT_MS, left));
    } catch {
      failed.push(dir);
    }
  }
  const downloaded = dirs.filter((dir) => !failed.includes(dir));
  const unfinished = (step) => downloaded.filter((dir) => {
    const left = deadline - clock();
    try {
      return left <= 0 || !step(moduleDir(dir), child, Math.min(DOWNLOAD_TIMEOUT_MS, left));
    } catch {
      return true;
    }
  });
  const untidied = unfinished(tidy);
  const ungraphed = unfinished(graph);
  if (untidied.length > 0) {
    say(`go mod tidy did not finish for ${untidied.join(', ')}. Their builds have what they read, but a tidy inside the sandbox can fail on a module only tidy loads`);
  }
  if (ungraphed.length > 0) {
    say(`the module graph did not finish downloading for ${ungraphed.join(', ')}. Their builds have what they read, but a check reading every module, such as go list -m all, can fail inside the sandbox`);
  }
  if (failed.length > 0) {
    say(`the module cache is incomplete for ${failed.join(', ')}. The sandbox has no network, so a build reading a module that did not download here fails inside it`);
  } else {
    console.log(`warmed the module cache of ${version} for ${dirs.join(', ')}`);
  }
  return done(version);
}

await runMain(import.meta.url, async () => {
  process.exitCode = process.argv[2] === 'detect' ? detect() : main();
});
