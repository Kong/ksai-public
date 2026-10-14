import { appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

import { npmCacheSpecs } from './npm-cache.mjs';
import { packageTrees } from './egress.mjs';

const require = createRequire(import.meta.url);
const { renderPackageNote, spliceGoNote } = require('./prompt.cjs');

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const LOCKFILE = Object.freeze({ npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'] });
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|KEY)/i;
const PACKAGE_CONFIG_NAME = /^(?:npm_config_|pnpm_|yarn_|corepack_|https?_proxy$|all_proxy$|no_proxy$)/i;
const REGISTRY = 'https://registry.npmjs.org/';
const MAX_PACKAGE_FILES = 256;
const MAX_GIT_OUTPUT = 1024 * 1024;

const warn = (message) => process.stdout.write(`::warning::${message}\n`);

export function packageRoots(workspace) {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/package.json'], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT,
      env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const roots = output.split('\0').filter(Boolean).map((name) => path.posix.dirname(name));
    if (roots.length > MAX_PACKAGE_FILES || roots.some((root) => /[\r\n\\]/.test(root))) return [];
    return [...new Set(roots)].sort();
  } catch {
    return [];
  }
}

function projectAt(workspace, root) {
  try {
    const base = realpathSync(workspace);
    const candidate = path.join(workspace, root);
    const project = realpathSync(candidate);
    const relative = path.relative(base, project);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? candidate : '';
  } catch {
    return '';
  }
}

function tracked(workspace, names) {
  for (const name of names) {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', name], {
        cwd: workspace,
        env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'ignore',
      });
      return name;
    } catch {}
  }
  return '';
}

function present(workspace, name) {
  try {
    lstatSync(path.join(workspace, name));
    return true;
  } catch {
    return false;
  }
}

function ignored(workspace, name) {
  const options = {
    cwd: workspace,
    env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1' },
  };
  try {
    const committed = execFileSync('git', ['ls-files', '--', name], { ...options, encoding: 'utf8' });
    if (committed.trim() !== '') return false;
    execFileSync('git', ['check-ignore', '-q', '--', `${name}/`], { ...options, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function packageOf(workspace, { trackedFile = tracked, projectFile = present, ignoredPath = ignored } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const declared = String(manifest?.packageManager ?? '');
  const found = declared.match(PACKAGE_MANAGER);
  if (manifest?.packageManager !== undefined && !found) return null;
  const manager = found?.[1] ?? 'npm';
  const version = found?.[2] ?? '';
  if (projectFile(workspace, '.npmrc')) return null;
  if (manager === 'yarn' && Number(found[2].split('.')[0]) === 1 && projectFile(workspace, '.yarnrc')) return null;
  if (!ignoredPath(workspace, 'node_modules')) return null;
  const lockfile = trackedFile(workspace, LOCKFILE[manager]);
  return lockfile ? { manager, version, lockfile } : null;
}

export function hasFailingTarget(checksPath) {
  if (!checksPath) return false;
  try {
    const checks = JSON.parse(readFileSync(checksPath, 'utf8'));
    const total = Number(checks?.failingTotal ?? 0) + Number(checks?.statusesTotal ?? 0);
    return Number.isFinite(total) && total > 0;
  } catch {
    return false;
  }
}

function scrubbedEnv(env, userConfig, globalConfig, registry = REGISTRY) {
  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) && !PACKAGE_CONFIG_NAME.test(name)) child[name] = value;
  }
  return {
    ...child,
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_USERCONFIG: userConfig,
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_IGNORE_PATH: '1',
    YARN_INJECT_ENVIRONMENT_FILES: '.ksai-no-environment?',
    YARN_NODE_LINKER: 'node-modules',
    YARN_NPM_REGISTRY_SERVER: registry,
    YARN_RC_FILENAME: `.ksai-${randomUUID()}.yml`,
    YARN_REGISTRY: registry,
  };
}

function execute(file, args, options) {
  execFileSync(file, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60 * 1000 });
}

export function installOf({ manager, version, toolRoot, registry = REGISTRY }) {
  if (manager === 'npm') {
    const install = [
      version === '' ? 'npm' : path.join(toolRoot, 'bin', 'npm'), [
        'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--replace-registry-host=always', `--registry=${registry}`,
      ],
    ];
    return version === '' ? [install] : [
      ['npm', ['install', '--global', '--prefix', toolRoot, `npm@${version}`, '--ignore-scripts', '--no-audit', '--no-fund']],
      install,
    ];
  }
  const immutable = manager === 'pnpm'
    ? ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', `--registry=${registry}`]
    : Number(version.split('.')[0]) === 1
      ? ['install', '--frozen-lockfile', '--ignore-scripts']
      : ['install', '--immutable', '--mode=skip-build'];
  return [
    ['corepack', ['prepare', `${manager}@${version}`, '--activate']],
    ['corepack', [manager, ...immutable]],
  ];
}

function tellPrompt(at, note) {
  try {
    const prompt = readFileSync(at, 'utf8');
    const spliced = spliceGoNote(prompt, note);
    if (spliced === null) return warn('the prompt carries no trusted toolchain seam for the Node dependency note');
    writeFileSync(at, spliced);
  } catch (error) {
    warn(`the prompt could not record the Node dependency state: ${error.message}`);
  }
}

function tellFacts(env, facts) {
  if (!env.PACKAGE_FACTS_FILE) return;
  try {
    writeFileSync(env.PACKAGE_FACTS_FILE, JSON.stringify(facts), { mode: 0o600 });
  } catch (error) {
    warn(`the Node dependency state could not be recorded: ${error.message}`);
  }
}

export function main(env = process.env, { run = execute, detect = packageOf, discover = packageRoots } = {}) {
  const absent = { present: false, manager: '', version: '', failed: false };
  if (!hasFailingTarget(env.CHECKS_FILE)) {
    tellFacts(env, absent);
    return 0;
  }
  const workspace = env.WORKSPACE || process.cwd();
  const configured = packageTrees(env.KSAI_EGRESS_PACKAGES);
  const wanted = configured === null
    ? [{ manager: 'npm', root: '.', registry: REGISTRY }]
    : configured.filter((one) => one.manager === 'npm');
  const selected = wanted.flatMap((one) => one.root === '*'
    ? discover(workspace).map((root) => ({ ...one, root }))
    : [one]);
  const found = selected.flatMap((one) => {
    const project = projectAt(workspace, one.root);
    const detected = project === '' ? null : detect(project);
    return detected ? [{ ...detected, root: one.root, registry: one.registry, project }] : [];
  });
  if (found.length === 0) {
    tellFacts(env, absent);
    return 0;
  }

  const temp = env.RUNNER_TEMP || '/tmp';
  const toolRoot = path.join(temp, 'ksai-package-manager');
  const userConfig = path.join(temp, 'ksai-empty-user-npmrc');
  const globalConfig = path.join(temp, 'ksai-empty-global-npmrc');
  writeFileSync(userConfig, '', { mode: 0o600 });
  writeFileSync(globalConfig, '', { mode: 0o600 });
  let failed = false;
  for (const tree of found) {
    const child = scrubbedEnv(env, userConfig, globalConfig, tree.registry);
    try {
      for (const [file, args] of installOf({ ...tree, toolRoot })) run(file, args, { cwd: tree.project, env: child });
    } catch (error) {
      failed = true;
      warn(`locked Node dependencies did not finish installing in ${tree.root}: ${error.message}`);
    }

    if (tree.manager === 'npm') {
      const specs = npmCacheSpecs(tree.project, tree.lockfile);
      if (specs?.length) {
        const directory = mkdtempSync(path.join(temp, 'ksai-npm-prefetch-'));
        try {
          const npm = tree.version === '' ? 'npm' : path.join(toolRoot, 'bin', 'npm');
          run(npm, ['cache', 'add', ...specs, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${tree.registry}`], {
            cwd: directory, env: child,
          });
        } catch (error) {
          warn(`npm cache preparation did not finish for ${tree.root}: ${error.message}`);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }

  if (env.GITHUB_ENV) {
    appendFileSync(
      env.GITHUB_ENV,
      'COREPACK_ENABLE_NETWORK=0\nnpm_config_offline=true\nYARN_ENABLE_NETWORK=0\nYARN_NODE_LINKER=node-modules\n',
    );
    const home = String(env.HOME || homedir());
    if (found.some((one) => one.manager === 'npm') && path.isAbsolute(home) && !/[\r\n]/.test(home)) {
      appendFileSync(env.GITHUB_ENV, `KSAI_NPM_CACHE=${path.join(home, '.npm')}\n`);
    }
  }
  if (env.PROMPT_FILE) tellPrompt(env.PROMPT_FILE, renderPackageNote({ ...found[0], count: found.length, failed }));
  tellFacts(env, {
    present: true,
    manager: String(found[0].manager ?? ''),
    version: String(found[0].version ?? ''),
    failed,
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
