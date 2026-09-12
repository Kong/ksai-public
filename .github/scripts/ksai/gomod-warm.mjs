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

/**
 * NOTHING_PRIVATE is what "no private modules" is written as, because it cannot be written empty.
 *
 * `cmd/go`'s `Getenv` falls through to a config file whenever the process value is the empty string:
 * the `go env -w` user file first, then `$GOROOT/go.env`. So an empty `GOPRIVATE` is not "nothing is
 * private", it is "ask the next layer", and on a toolchain whose `go.env` names owners it answered
 * them. A non-empty value wins outright, before either file is read.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a module host, so this pattern matches no
 * module that exists while still being a value rather than an absence.
 */
const NOTHING_PRIVATE = 'none.invalid';

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
  const privateTo = pairs.length > 0 ? goPrivate(pairs) : NOTHING_PRIVATE;
  /*
   * Whether this run's transcript can be read by anyone, which is what the names below are about.
   * A private repository's artifacts are not public, so there is nothing to disclose there and its
   * own runner configuration is the best answer available.
   */
  const readable = env.IS_PRIVATE !== 'true';

  /*
   * `child` inherits the runner's environment, so a name left out of this object keeps whatever was
   * already there - which for the private-module names is the opposite of what the public branch
   * above just promised. `GOPRIVATE` was added only when there were owners to name, so a runner
   * holding one of its own handed it to a public repository's download, and the transcript that
   * names the modules is uploaded as an artifact anyone can fetch. `gitConfigEnv` had this right
   * all along: it answers `GIT_CONFIG_COUNT: '0'` for the public case rather than answering nothing.
   *
   * **An empty value does not clear a Go setting**, which is why every name below carries one.
   * `cmd/go`'s `Getenv` returns the process value when it is non-empty and otherwise falls through
   * to a config file - the `go env -w` user file, which Go's own private-modules guide prescribes,
   * and then `$GOROOT/go.env`. A value wins over both.
   *
   * **`GOENV: 'off'` is deliberately not set.** It closes the user file, and it was here while these
   * names were written empty. It is not needed once they are not, and it is not free: it also
   * discards a runner's own `GOPROXY` and `GOMODCACHE` from that file, so a host configured for an
   * internal module proxy would silently revert to the public one and fill a cache the build does
   * not read. Closing the other settings in that file is its own issue, where the trade can be measured.
   *
   * **All three names are written, and none is written empty.** Emptying `GONOPROXY` and
   * `GONOSUMDB` to let Go derive them from `GOPRIVATE` failed in both directions: on a toolchain
   * whose `$GOROOT/go.env` names owners, a public run treated them as private, and a private run
   * lost the proxy and checksum bypass its own modules need - those paths went to the public proxy
   * and then failed under `GOPROXY=off` in the sandbox. Derivation is only reached when the value
   * is absent, and absent is exactly what falls through.
   *
   * **The names are gated on whether the transcript is readable, not on whether there are owners.**
   * Writing `none.invalid` for every run without owners broke the private-repository-without-tokens
   * case: `GONOPROXY` forced a proxy fetch for real private modules and `GONOSUMDB` exempted
   * nothing, so they failed on a proxy 404 or a sumdb 410 where before they had used the runner's
   * own configuration. A private run has no disclosure to prevent, so where it names no owners it
   * is left alone.
   *
   * `GOAUTH` defaults to `netrc`, so a **public** run would read `$NETRC` or `~/.netrc` and attach
   * those credentials to module fetches on the branch that just promised it uses none. It is not
   * turned off on a private run: `insteadOf` does not authenticate the `?go-get=1` discovery fetch,
   * which is HTTPS rather than git, so `off` could remove the only credential a private module on a
   * host without a hardcoded VCS rule has. GitHub has one, so Kong's own modules never make that
   * request - which is an argument for leaving a private run's credentials alone, not for removing
   * them on a guess.
   */
  const child = {
    ...process.env,
    GO_MODULE_TOKENS: '',
    ...gitConfigEnv(pairs),
    GOTOOLCHAIN: 'local',
    GOVCS: '*:git',
    ...(pairs.length > 0 || readable
      ? { GOPRIVATE: privateTo, GONOPROXY: privateTo, GONOSUMDB: privateTo }
      : {}),
    ...(readable ? { GOAUTH: 'off' } : {}),
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
