import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

export const MISE_CONFIGS = Object.freeze([
  'mise.toml', '.mise.toml', 'mise/config.toml', '.mise/config.toml',
  '.config/mise.toml', '.config/mise/config.toml', '.tool-versions',
]);

const MISE_LOCKS = Object.freeze(['mise.lock', '.mise.lock']);
const SYSTEM_PATHS = Object.freeze([
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32',
  '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf',
  '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf',
  '/etc/ld.so.conf.d', '/run/systemd/resolve',
]);
const PINNED_GO = /\/installs\/go\/[^/]+\/bin$/;
const FENCED_MISE = '/opt/ksai-mise/bin/mise';
const FENCED_TREE = '/opt/ksai-mise/tree';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 60 * 1000;

const treeFile = (workspace) => (at) => {
  try {
    return lstatSync(at).isFile() && realpathSync(at).startsWith(`${realpathSync(workspace)}/`);
  } catch {
    return false;
  }
};

export function miseOn(path, exists = existsSync, real = realpathSync) {
  for (const dir of String(path ?? '').split(':')) {
    const at = join(dir, 'mise');
    if (isAbsolute(dir) && exists(at)) return real(at);
  }
  return '';
}

export function fenceArgs({ workspace, files, data, cache, mise }) {
  return [
    ...SYSTEM_PATHS.flatMap((at) => ['--ro-bind-try', at, at]),
    '--ro-bind', mise, FENCED_MISE,
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...files.flatMap((name) => ['--ro-bind', join(workspace, name), join(FENCED_TREE, name)]),
    '--bind', data, data,
    '--bind', cache, cache,
    '--clearenv',
    '--setenv', 'PATH', `${dirname(FENCED_MISE)}:/usr/local/bin:/usr/bin:/bin`,
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'MISE_DATA_DIR', data,
    '--setenv', 'MISE_CACHE_DIR', cache,
    '--setenv', 'MISE_TRUSTED_CONFIG_PATHS', FENCED_TREE,
    '--setenv', 'MISE_YES', '1',
    '--chdir', FENCED_TREE,
    '--cap-drop', 'ALL',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--',
  ];
}

export function toolPath(listed, data) {
  const paths = String(listed ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const held = paths.every((at) => isAbsolute(at) && !at.includes(':') && !relative(data, at).startsWith('..'));
  return held ? paths.join(':') : '';
}

const fenced = (args, timeout) => execFileSync('bwrap', args, {
  encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'inherit'],
});

export function pinnedConfigs(workspace, exists = treeFile(workspace)) {
  return MISE_CONFIGS.filter((name) => exists(join(workspace, name)));
}

const regularFile = (at) => {
  try {
    return statSync(at).isFile();
  } catch {
    return false;
  }
};

export function find(env = process.env, exists = null) {
  const workspace = String(env.WORKSPACE ?? '').trim();
  const [config] = isAbsolute(workspace) ? pinnedConfigs(workspace, exists ?? regularFile) : [];
  console.log(config ? `the tree pins tools in ${config}` : 'the tree pins no tools, so its commands get what the runner carries');
  writeOutputs(env.GITHUB_OUTPUT, {
    present: config ? 'true' : 'false',
  });
  return 0;
}

export function main(env = process.env, { run = fenced, exists = null, makeDir = mkdirSync, findMise = miseOn } = {}) {
  const workspace = String(env.WORKSPACE ?? '').trim();
  const temp = String(env.RUNNER_TEMP ?? '').trim();
  if (!isAbsolute(workspace) || !isAbsolute(temp) || !env.GITHUB_ENV) {
    console.log('no workspace, runner temp or job environment was named, so no pinned tools were installed');
    return 0;
  }
  const inTree = exists ?? treeFile(workspace);
  const configs = pinnedConfigs(workspace, inTree);
  const [config] = configs;
  if (!config) {
    console.log('the tree under work pins no tools, so the model gets what the runner carries');
    return 0;
  }

  const mise = findMise(env.PATH);
  if (!mise) {
    console.log('::warning::no mise is on the path, so the model gets what the runner carries');
    return 0;
  }
  const data = join(temp, 'ksai-mise', 'data');
  const cache = join(temp, 'ksai-mise', 'cache');
  for (const at of [data, cache]) makeDir(at, { recursive: true });
  const files = [...configs, ...MISE_LOCKS.filter((name) => inTree(join(workspace, name)))];
  const args = fenceArgs({ workspace, files, data, cache, mise });

  try {
    run([...args, 'mise', 'install'], INSTALL_TIMEOUT_MS);
  } catch (error) {
    console.log(`::warning::not every tool ${config} pins could be installed, so the model gets the ones that were: ${error.message}`);
  }
  let listed;
  try {
    listed = run([...args, 'mise', 'bin-paths'], LIST_TIMEOUT_MS);
  } catch (error) {
    console.log(`::warning::mise could not list what it installed, so the model gets what the runner carries: ${error.message}`);
    return 0;
  }
  const path = toolPath(listed, data);
  if (path === '') {
    console.log('::warning::mise named no tool directory, or one outside the one it installed into, so none is handed to the model');
    return 0;
  }
  const pinnedGo = path.split(':').find((at) => PINNED_GO.test(at));
  const goRoot = !env.KSAI_GOROOT && pinnedGo ? `KSAI_GOROOT=${dirname(pinnedGo)}\n` : '';
  appendFileSync(env.GITHUB_ENV, `KSAI_TOOL_ROOT=${data}\nKSAI_TOOL_PATH=${path}\n${goRoot}`);
  console.log(`installed the tools ${config} pins for the model: ${path}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv[2] === '--find' ? find() : main();
}
