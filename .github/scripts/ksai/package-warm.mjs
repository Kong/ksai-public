import { appendFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import { runMain } from '../lib/main.mjs';
import { npmCacheSpecs } from './npm-cache.mjs';

const require = createRequire(import.meta.url);
const { gitArgs, gitEnv } = require('./trusted-git.cjs');

const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const LOCKFILE = Object.freeze({ npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'] });
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|KEY)/i;
const PACKAGE_CONFIG_NAME = /^(?:npm_config_|pnpm_|yarn_|corepack_|https?_proxy$|all_proxy$|no_proxy$)/i;
const REGISTRY = 'https://registry.npmjs.org/';
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const warn = (message) => process.stdout.write(`::warning::${message}\n`);

const git = (workspace, args, options = {}) => execFileSync('git', gitArgs(workspace, args), { ...options, env: gitEnv() });

function tracked(workspace, names) {
  for (const name of names) {
    try {
      git(workspace, ['ls-files', '--error-unmatch', '--', name], { stdio: 'ignore' });
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
  try {
    if (String(git(workspace, ['ls-files', '--', name], { encoding: 'utf8' })).trim() !== '') return false;
    git(workspace, ['check-ignore', '-q', '--', `${name}/`], { stdio: 'ignore' });
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
  if (manager === 'yarn' && Number(version.split('.')[0]) === 1 && projectFile(workspace, '.yarnrc')) return null;
  if (!ignoredPath(workspace, 'node_modules')) return null;
  const lockfile = trackedFile(workspace, LOCKFILE[manager]);
  return lockfile ? { manager, version, lockfile } : null;
}

export const withoutCredentials = (env) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));

function scrubbedEnv(env, userConfig, globalConfig) {
  return {
    ...Object.fromEntries(Object.entries(withoutCredentials(env)).filter(([name]) => !PACKAGE_CONFIG_NAME.test(name))),
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_USERCONFIG: userConfig,
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_IGNORE_PATH: '1',
    YARN_INJECT_ENVIRONMENT_FILES: '.ksai-no-environment?',
    YARN_NODE_LINKER: 'node-modules',
    YARN_NPM_REGISTRY_SERVER: REGISTRY,
    YARN_RC_FILENAME: `.ksai-${randomUUID()}.yml`,
    YARN_REGISTRY: REGISTRY,
  };
}

function execute(file, args, options) {
  execFileSync(file, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'], timeout: INSTALL_TIMEOUT_MS });
}

export function installOf({ manager, version, toolRoot }) {
  if (manager === 'npm') {
    const install = [
      version === '' ? 'npm' : path.join(toolRoot, 'bin', 'npm'), [
        'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--replace-registry-host=always', `--registry=${REGISTRY}`,
      ],
    ];
    return version === '' ? [install] : [
      ['npm', ['install', '--global', '--prefix', toolRoot, `npm@${version}`, '--ignore-scripts', '--no-audit', '--no-fund']],
      install,
    ];
  }
  const immutable = manager === 'pnpm'
    ? ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', `--registry=${REGISTRY}`]
    : Number(version.split('.')[0]) === 1
      ? ['install', '--frozen-lockfile', '--ignore-scripts']
      : ['install', '--immutable', '--mode=skip-build'];
  return [
    ['corepack', ['prepare', `${manager}@${version}`, '--activate']],
    ['corepack', [manager, ...immutable]],
  ];
}

export function main(env = process.env, { run = execute, detect = packageOf } = {}) {
  const workspace = env.WORKSPACE || process.cwd();
  const found = detect(workspace);
  if (!found) {
    console.log('the tree holds no root package.json with a tracked lockfile and an ignored node_modules, so no Node dependencies were warmed');
    return 0;
  }

  const temp = env.RUNNER_TEMP || '/tmp';
  const toolRoot = path.join(temp, 'ksai-package-manager');
  const userConfig = path.join(temp, 'ksai-empty-user-npmrc');
  const globalConfig = path.join(temp, 'ksai-empty-global-npmrc');
  writeFileSync(userConfig, '', { mode: 0o600 });
  writeFileSync(globalConfig, '', { mode: 0o600 });
  const child = scrubbedEnv(env, userConfig, globalConfig);
  try {
    for (const [file, args] of installOf({ ...found, toolRoot })) run(file, args, { cwd: workspace, env: child });
    console.log(`installed the locked ${found.manager} dependencies of the tree for the model`);
  } catch (error) {
    warn(`locked Node dependencies did not finish installing: ${error.message}`);
  }

  const specs = found.manager === 'npm' ? npmCacheSpecs(workspace, found.lockfile) : null;
  if (specs?.length) {
    const directory = mkdtempSync(path.join(temp, 'ksai-npm-prefetch-'));
    try {
      const npm = found.version === '' ? 'npm' : path.join(toolRoot, 'bin', 'npm');
      run(npm, ['cache', 'add', ...specs, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`], {
        cwd: directory, env: child,
      });
    } catch (error) {
      warn(`npm cache preparation did not finish: ${error.message}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  if (env.GITHUB_ENV) {
    appendFileSync(
      env.GITHUB_ENV,
      'COREPACK_ENABLE_NETWORK=0\nnpm_config_offline=true\nYARN_ENABLE_NETWORK=0\nYARN_NODE_LINKER=node-modules\n',
    );
    const home = String(env.HOME || homedir());
    if (found.manager === 'npm' && path.isAbsolute(home) && !/[\r\n]/.test(home)) {
      appendFileSync(env.GITHUB_ENV, `KSAI_NPM_CACHE=${path.join(home, '.npm')}\n`);
    }
  }
  return 0;
}

await runMain(import.meta.url, async () => {
  process.exitCode = main();
});
