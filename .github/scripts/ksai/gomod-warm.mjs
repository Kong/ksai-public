import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MODULE_FILE, SUM_FILE, gitConfigEnv, goPrivate, parseTokens, recase, warn } = require('./gomod.cjs');
const { renderGoNote, spliceGoNote } = require('./prompt.cjs');

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const WARM_BUDGET_MS = 15 * 60 * 1000;

const MODULE_READ_BUDGET = 4 * 1024 * 1024;

function tellThePrompt(at, note) {
  let prompt;
  try {
    prompt = readFileSync(at, 'utf8');
  } catch (error) {
    warn(`the prompt could not be read, so it says nothing about the Go toolchain: ${error.message}`);
    return;
  }

  const spliced = spliceGoNote(prompt, note);
  if (spliced === null) {
    warn('the prompt carries no toolchain paragraph to correct, so nothing was said about Go');
    return;
  }
  writeFileSync(at, spliced);
}

function toolchainOf(workspace) {
  try {
    return execFileSync('go', ['version'], { cwd: workspace, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function modulesIn(workspace, dirs) {
  const read = [];
  let left = MODULE_READ_BUDGET;
  for (const dir of dirs) {
    for (const name of [MODULE_FILE, SUM_FILE]) {
      if (left <= 0) return read.join('\n');
      const at = `${dir === '.' ? workspace : `${workspace}/${dir}`}/${name}`;
      try {
        const found = lstatSync(at);
        if (!found.isFile() || found.size > left) continue;
        read.push(readFileSync(at, 'utf8'));
        left -= found.size;
      } catch {
        continue;
      }
    }
  }
  return read.join('\n');
}

function downloadIn(cwd, child, timeout) {
  execFileSync('go', ['mod', 'download'], { cwd, env: child, stdio: ['ignore', 'inherit', 'inherit'], timeout });
}

export function main(
  env = process.env,
  { clock = () => Date.now(), toolchain = toolchainOf, download = downloadIn } = {},
) {
  const workspace = env.WORKSPACE || process.cwd();
  /*
   * The implement flow builds inside a sandbox with no network, so what warmed here is all a build
   * can ever read and the proxy is closed behind it. The test flow's environments keep their
   * network: closing the proxy there would fail a pull request that legitimately adds a public
   * dependency, which is a build the base branch's modules were never going to cover.
   */
  const lockBuild = env.LOCK_BUILD !== 'false';

  const done = ({ failed = [], version = '' }) => {
    if (lockBuild && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, 'GOPROXY=off\nGOTOOLCHAIN=local\n');
    if (version !== '' && env.PROMPT_FILE) tellThePrompt(env.PROMPT_FILE, renderGoNote({ version, failed }));
    return 0;
  };

  const version = toolchain(workspace);
  if (version === '') {
    warn('no `go` is on the path after setting one up, so nothing warmed the module cache');
    return done({});
  }

  let dirs = [];
  try {
    dirs = readFileSync(env.LIST, 'utf8').split('\n').filter((one) => one !== '');
  } catch (error) {
    warn(`the Go module list could not be read, so nothing warmed the module cache: ${error.message}`);
    return done({});
  }
  if (dirs.length === 0) {
    warn('the Go module list named no directory, so nothing warmed the module cache');
    return done({});
  }

  const read = parseTokens(env.GO_MODULE_TOKENS);
  if (read.refused.length > 0) {
    warn(
      `go_module_tokens ${read.refused.join(', ')} names no owner this run could mint a token for, so ` +
        'those modules stay unreachable',
    );
  }
  const open = env.IS_PRIVATE !== 'true' && read.pairs.length > 0;
  if (open) {
    warn(
      'this repository is public and the run transcript is uploaded as a workflow artifact anyone can ' +
        'download, so no private-module credential is used here. A module under those owners will not ' +
        'download, and the note in the prompt says which',
    );
  }
  const named = open ? [] : read.pairs;
  const pairs = named.length > 0 ? recase(named, modulesIn(workspace, dirs)) : named;

  const child = {
    ...process.env,
    GO_MODULE_TOKENS: '',
    ...gitConfigEnv(pairs),
    GOTOOLCHAIN: 'local',
    GOVCS: '*:git',
    ...(pairs.length > 0 ? { GOPRIVATE: goPrivate(pairs) } : {}),
  };

  const failed = [];
  const deadline = clock() + WARM_BUDGET_MS;
  for (const dir of dirs) {
    const left = deadline - clock();
    if (left <= 0) {
      failed.push(dir);
      continue;
    }
    try {
      download(dir === '.' ? workspace : `${workspace}/${dir}`, child, Math.min(DOWNLOAD_TIMEOUT_MS, left));
    } catch {
      failed.push(dir);
    }
  }

  if (failed.length > 0) {
    warn(
      `the module cache is incomplete for ${failed.join(', ')}. The sandbox has no network, so a build reading a module that did not download here fails inside it`,
    );
  }
  return done({ failed, version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
