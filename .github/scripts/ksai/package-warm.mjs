import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { renderPackageNote, spliceGoNote } = require('./prompt.cjs');

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const LOCKFILE = Object.freeze({ npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'] });
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|KEY)/i;
const PACKAGE_CONFIG_NAME = /^(?:npm_config_|pnpm_|yarn_|corepack_|https?_proxy$|all_proxy$|no_proxy$)/i;
const REGISTRY = 'https://registry.npmjs.org/';

const warn = (message) => process.stdout.write(`::warning::${message}\n`);

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
  const found = String(manifest?.packageManager ?? '').match(PACKAGE_MANAGER);
  if (!found) return null;
  const manager = found[1];
  if (projectFile(workspace, '.npmrc')) return null;
  if (manager === 'yarn' && Number(found[2].split('.')[0]) === 1 && projectFile(workspace, '.yarnrc')) return null;
  if (!ignoredPath(workspace, 'node_modules')) return null;
  const lockfile = trackedFile(workspace, LOCKFILE[manager]);
  return lockfile ? { manager, version: found[2], lockfile } : null;
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

function scrubbedEnv(env, config) {
  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) && !PACKAGE_CONFIG_NAME.test(name)) child[name] = value;
  }
  return {
    ...child,
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: config,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_USERCONFIG: config,
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
  execFileSync(file, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60 * 1000 });
}

export function installOf({ manager, version, toolRoot }) {
  if (manager === 'npm') {
    return [
      ['npm', ['install', '--global', '--prefix', toolRoot, `npm@${version}`, '--ignore-scripts', '--no-audit', '--no-fund']],
      [path.join(toolRoot, 'bin', 'npm'), [
        'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--replace-registry-host=always', `--registry=${REGISTRY}`,
      ]],
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

export function main(env = process.env, { run = execute, detect = packageOf } = {}) {
  if (!hasFailingTarget(env.CHECKS_FILE)) return 0;
  const workspace = env.WORKSPACE || process.cwd();
  const found = detect(workspace);
  if (!found) return 0;

  const temp = env.RUNNER_TEMP || '/tmp';
  const toolRoot = path.join(temp, 'ksai-package-manager');
  const config = path.join(temp, 'ksai-empty-npmrc');
  writeFileSync(config, '', { mode: 0o600 });
  const child = scrubbedEnv(env, config);
  let failed = false;
  try {
    for (const [file, args] of installOf({ ...found, toolRoot })) run(file, args, { cwd: workspace, env: child });
  } catch (error) {
    failed = true;
    warn(`locked Node dependencies did not finish installing: ${error.message}`);
  }

  if (env.GITHUB_ENV) {
    appendFileSync(
      env.GITHUB_ENV,
      'COREPACK_ENABLE_NETWORK=0\nnpm_config_offline=true\nYARN_ENABLE_NETWORK=0\nYARN_NODE_LINKER=node-modules\n',
    );
  }
  if (env.PROMPT_FILE) tellPrompt(env.PROMPT_FILE, renderPackageNote({ ...found, failed }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
