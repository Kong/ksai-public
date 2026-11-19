import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, createWriteStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { runMain } from '../lib/main.mjs';
import { SYSTEM_PATHS } from './mise-tools.mjs';

const require = createRequire(import.meta.url);
const { gitArgs, gitEnv } = require('./trusted-git.cjs');

export const STEP_ROOT = '/opt/ksai-step';
export const SECRETS = Object.freeze({ npm_token: 'KSAI_SECRET_NPM_TOKEN' });
export const PLATFORMS = Object.freeze(['linux-x64', 'linux-arm64']);

const PHASES = Object.freeze(['before', 'after']);
const NETWORKS = Object.freeze(['none', 'egress']);
const STEP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TREE_PATH = /^(?!\.git(?:\/|$))(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,15}$/;
const FILE_KEY = /^(home|tools)\/(?!(?:.*\/)?\.{1,2}(?:\/|$))([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7})$/;
const TOOLCHAIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOLCHAIN_BIN = /^(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const COMMAND = /^[a-z][a-z0-9._-]{0,63}$/;
const RESERVED_ENV = /^(?:PATH|HOME|TMPDIR|LD_.*|NODE_OPTIONS|BASH_ENV|ENV|KSAI_SECRET_.*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_TEXT = 2 << 20;
const MAX_STEPS = 8;
const MAX_PATHS = 32;
const MAX_COMMANDS = 16;
const MAX_ARGS = 64;
const MAX_VALUE = 4096;
const MAX_FILE_TEXT = 1 << 20;
const MAX_INPUT_BYTES = 64 << 20;
const MAX_SECONDS = 1800;
const MAX_TOOLCHAINS = 4;
const MAX_CREDENTIALS = 4;
const MAX_ARCHIVE_BYTES = 512 << 20;
const MAX_REDIRECTS = 5;
const ARCHIVE_MS = 600_000;

const say = (message) => process.stdout.write(`${message}\n`);
const notice = (message) => say(`::notice::${message}`);
const warn = (message) => say(`::warning::${message}`);

const byBytes = (one, other) => Buffer.compare(Buffer.from(one), Buffer.from(other));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => Object.keys(value).every((name) => names.includes(name));
const text = (value, most = MAX_VALUE) => typeof value === 'string' && value.length <= most && !value.includes('\0');
const paths = (value) => Array.isArray(value) && value.length <= MAX_PATHS && new Set(value).size === value.length
  && value.every((at) => typeof at === 'string' && TREE_PATH.test(at));

function commandOf(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGS || !argv.every((arg) => text(arg))) return false;
  const [file] = argv;
  return COMMAND.test(file) || file.startsWith(`${STEP_ROOT}/tools/`) || file.startsWith('/tmp/');
}

const httpsURL = (value) => {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
};

const archiveOf = ([platform, archive]) => PLATFORMS.includes(platform) && record(archive) && exact(archive, ['url', 'sha256'])
  && httpsURL(archive.url) && typeof archive.sha256 === 'string' && SHA256.test(archive.sha256);

const toolchainOf = (one) => record(one) && exact(one, ['name', 'bin', 'archives'])
  && typeof one.name === 'string' && TOOLCHAIN_NAME.test(one.name) && typeof one.bin === 'string' && TOOLCHAIN_BIN.test(one.bin)
  && record(one.archives) && Object.keys(one.archives).length > 0 && Object.entries(one.archives).every((entry) => archiveOf(entry));

function credentialsOf(step) {
  const named = step.credentials;
  if (!Array.isArray(named) || named.length === 0 || named.length > MAX_CREDENTIALS || new Set(named).size !== named.length) {
    return `credentials must be a list of 1 to ${MAX_CREDENTIALS} distinct names`;
  }
  for (const name of named) {
    if (typeof name !== 'string' || !ENV_NAME.test(name) || RESERVED_ENV.test(name)) return `asks for the credential \`${String(name)}\`, which is not allowed`;
    if (Object.hasOwn(step.env ?? {}, name) || Object.hasOwn(step.secrets ?? {}, name)) return `sets \`${name}\` twice`;
  }
  return '';
}

function stepOf(step) {
  if (!record(step) || !exact(step, [
    'id', 'phase', 'when', 'inputs', 'base_inputs', 'outputs', 'files', 'run', 'env', 'secrets', 'credentials', 'toolchains', 'network', 'timeout_seconds',
  ])) {
    return 'has an unknown or missing field';
  }
  if (step.base_inputs !== undefined && step.phase !== 'after') return 'reads the bound head before the model changed anything';
  if (!STEP_ID.test(String(step.id))) return 'has no id';
  if (!PHASES.includes(step.phase)) return 'has an unknown phase';
  if (step.when !== undefined && (!record(step.when) || !exact(step.when, ['changed']) || !paths(step.when.changed) || step.when.changed.length === 0)) {
    return 'has an invalid condition';
  }
  if (step.when !== undefined && step.phase !== 'after') return 'has a condition but is not an after step';
  for (const name of ['inputs', 'base_inputs', 'outputs']) if (step[name] !== undefined && !paths(step[name])) return `names ${name} outside the tree`;
  if ((step.inputs ?? []).some((at) => (step.base_inputs ?? []).includes(at))) return 'lists a file as both input and base input';
  if (step.files !== undefined) {
    if (!record(step.files) || Object.keys(step.files).length > MAX_PATHS) return 'writes too many files';
    let size = 0;
    for (const [key, content] of Object.entries(step.files)) {
      if (!FILE_KEY.test(key) || !text(content, MAX_FILE_TEXT)) return 'writes a file outside its home and tools';
      size += content.length;
    }
    if (size > MAX_FILE_TEXT) return 'writes more file content than allowed';
  }
  if (!Array.isArray(step.run) || step.run.length < 1 || step.run.length > MAX_COMMANDS || !step.run.every(commandOf)) {
    return 'has a command that is not allowed';
  }
  if (step.env !== undefined) {
    if (!record(step.env) || Object.keys(step.env).length > MAX_PATHS) return `must set env to an object with at most ${MAX_PATHS} entries`;
    for (const [name, value] of Object.entries(step.env)) {
      if (!ENV_NAME.test(name) || RESERVED_ENV.test(name) || !text(value)) return `sets \`${name}\`, which is not allowed`;
    }
  }
  if (step.secrets !== undefined) {
    if (!record(step.secrets)) return 'secrets are not a map';
    for (const [name, secret] of Object.entries(step.secrets)) {
      if (!ENV_NAME.test(name) || RESERVED_ENV.test(name) || !Object.hasOwn(SECRETS, secret)) return `asks for \`${secret}\`, which is not available to steps`;
      if (step.env !== undefined && Object.hasOwn(step.env, name)) return `sets \`${name}\` twice`;
    }
  }
  if (step.credentials !== undefined) {
    const why = credentialsOf(step);
    if (why) return why;
  }
  if (step.toolchains !== undefined && (!Array.isArray(step.toolchains) || step.toolchains.length > MAX_TOOLCHAINS
    || !step.toolchains.every(toolchainOf) || new Set(step.toolchains.map((one) => one.name)).size !== step.toolchains.length)) {
    return 'has an invalid toolchain';
  }
  if (!NETWORKS.includes(step.network)) return 'has a network mode that is not allowed';
  if (!Number.isSafeInteger(step.timeout_seconds) || step.timeout_seconds < 1 || step.timeout_seconds > MAX_SECONDS) return 'has no valid timeout';
  return '';
}

export function stepsOf(served) {
  if (!text(served, MAX_TEXT)) return { steps: [], refused: 'the steps are not text within the size limit' };
  let parsed;
  try {
    parsed = JSON.parse(served);
  } catch {
    return { steps: [], refused: 'the steps are not JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STEPS) return { steps: [], refused: `the steps are not a list of at most ${MAX_STEPS}` };
  if (new Set(parsed.map((step) => step?.id)).size !== parsed.length) return { steps: [], refused: 'two steps share an id' };
  for (const step of parsed) {
    const why = stepOf(step);
    if (why) return { steps: [], refused: `step \`${String(step?.id ?? '')}\` ${why}` };
  }
  return { steps: parsed, refused: '' };
}

export function heldAt(workspace, base, at, { run = execFileSync } = {}) {
  return run('git', gitArgs(workspace, ['cat-file', 'blob', `${base}:${at}`]), { env: gitEnv(), maxBuffer: MAX_INPUT_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function changedSince(workspace, base, at, { run = execFileSync } = {}) {
  try {
    run('git', gitArgs(workspace, ['diff', '--quiet', base, '--', ...at]), { stdio: 'ignore', env: gitEnv() });
  } catch (error) {
    if (error?.status === 1) return true;
    throw error;
  }
  const added = run('git', gitArgs(workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...at]), {
    env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_INPUT_BYTES,
  });
  return added.length > 0;
}

export const toolchainAt = (name) => `${STEP_ROOT}/toolchains/${name}`;

const sealed = (network) => [
  '--dev', '/dev',
  '--proc', '/proc',
  '--tmpfs', '/tmp',
  '--cap-drop', 'ALL',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  ...(network === 'none' ? ['--unshare-net'] : []),
  '--die-with-parent',
  '--new-session',
];

export function extractArgs({ archive, into }) {
  return [
    ...SYSTEM_PATHS.flatMap((at) => ['--ro-bind-try', at, at]),
    '--ro-bind', archive, '/opt/ksai-archive',
    '--bind', into, '/opt/ksai-toolchain',
    ...sealed('none'),
    '--',
    'tar', '-xf', '/opt/ksai-archive', '-C', '/opt/ksai-toolchain', '--no-same-owner', '--no-same-permissions',
  ];
}

export function fenceArgs({ tree, home, tools, node, toolchains = [], network }) {
  return [
    ...SYSTEM_PATHS.flatMap((at) => ['--ro-bind-try', at, at]),
    '--ro-bind-try', node, node,
    ...toolchains.flatMap(({ name, root }) => ['--ro-bind', root, toolchainAt(name)]),
    '--bind', home, `${STEP_ROOT}/home`,
    '--ro-bind', tools, `${STEP_ROOT}/tools`,
    '--bind', tree, `${STEP_ROOT}/tree`,
    '--chdir', `${STEP_ROOT}/tree`,
    ...sealed(network),
    '--',
  ];
}

export function fenceEnv(step, { node, env, credentials = new Map() }) {
  const held = {
    PATH: [
      ...(step.toolchains ?? []).map(({ name, bin }) => `${toolchainAt(name)}/${bin}`), path.join(node, 'bin'), '/usr/local/bin', '/usr/bin', '/bin',
    ].join(':'),
    HOME: `${STEP_ROOT}/home`,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...step.env,
  };
  for (const [name, secret] of Object.entries(step.secrets ?? {})) {
    const value = String(env[SECRETS[secret]] ?? '');
    if (value === '') return { env: held, missing: `secret \`${secret}\` from the caller` };
    held[name] = value;
  }
  for (const name of step.credentials ?? []) held[name] = credentials.get(name) ?? '';
  return { env: held, missing: '' };
}

export const platformOf = (env) => `${String(env.RUNNER_OS ?? '').toLowerCase()}-${String(env.RUNNER_ARCH ?? '').toLowerCase()}`;

async function fetched(url, fetch) {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!httpsURL(at)) throw new Error('archive redirect is not https');
    const answer = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(ARCHIVE_MS) });
    const moved = answer.headers?.get('location') ?? '';
    if (answer.status >= 300 && answer.status < 400 && moved !== '') {
      await Promise.resolve(answer.body?.cancel()).catch(() => {});
      at = new URL(moved, at).href;
      continue;
    }
    if (!answer.ok || !answer.body) throw new Error(`${new URL(at).host} returned status ${answer.status}`);
    return answer.body;
  }
  throw new Error(`archive redirected more than ${MAX_REDIRECTS} times`);
}

export async function downloaded(url, to, { fetch = globalThis.fetch, most = MAX_ARCHIVE_BYTES } = {}) {
  const body = await fetched(url, fetch);
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(Readable.fromWeb(body), async function* counted(source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > most) throw new Error(`archive is larger than ${most} bytes`);
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
  return hash.digest('hex');
}

export async function preparedToolchains(step, { temp, env, run, fetch, held }) {
  const platform = platformOf(env);
  const prepared = [];
  for (const { name, archives } of step.toolchains ?? []) {
    const archive = archives[platform];
    if (!archive) return { prepared, why: `toolchain \`${name}\` has no archive for ${platform}` };
    if (!held.has(archive.sha256)) {
      const root = path.join(temp, 'ksai-toolchains', archive.sha256);
      const file = `${root}.archive`;
      try {
        rmSync(root, { recursive: true, force: true });
        rmSync(file, { force: true });
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const sha256 = await downloaded(archive.url, file, { fetch });
        if (sha256 !== archive.sha256) throw new Error(`sha256 mismatch: got ${sha256}, expected ${archive.sha256}`);
        run(extractArgs({ archive: file, into: root }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, ARCHIVE_MS);
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        return { prepared, why: `preparing toolchain \`${name}\` failed: ${error.message}` };
      } finally {
        rmSync(file, { force: true });
      }
      held.set(archive.sha256, root);
    }
    prepared.push({ name, root: held.get(archive.sha256) });
  }
  return { prepared, why: '' };
}

function regularFile(at) {
  try {
    return lstatSync(at).isFile();
  } catch {
    return false;
  }
}

function treeFile(workspace, at) {
  const joined = path.join(workspace, at);
  try {
    return lstatSync(joined).isFile() && realpathSync(joined) === path.join(realpathSync(workspace), at);
  } catch {
    return false;
  }
}

function absent(at) {
  try {
    lstatSync(at);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function insideTree(workspace, at) {
  try {
    return realpathSync(path.dirname(at)).startsWith(`${realpathSync(workspace)}${path.sep}`)
      || realpathSync(path.dirname(at)) === realpathSync(workspace);
  } catch {
    return false;
  }
}

const fenced = (args, env, timeout) => execFileSync('bwrap', args, { env, stdio: ['ignore', 'inherit', 'inherit'], timeout });

export function runStep(step, {
  workspace, temp, node, env, base = '', read = heldAt, run = fenced, now = Date.now, most = MAX_INPUT_BYTES, attested = [],
  toolchains = [], credentials = new Map(),
}) {
  const missing = (step.inputs ?? []).filter((at) => !treeFile(workspace, at));
  if (missing.length > 0) return `inputs ${missing.join(', ')} are not regular files in the tree`;
  const copied = new Map();
  let size = 0;
  for (const at of step.inputs ?? []) {
    try {
      size += lstatSync(path.join(workspace, at)).size;
      if (size > most) return 'its inputs are larger than a step may copy';
      copied.set(at, readFileSync(path.join(workspace, at)));
    } catch {
      return `its input ${at} cannot be read`;
    }
  }
  for (const at of step.base_inputs ?? []) {
    if (!COMMIT.test(base)) return 'it reads the bound head, but the stage has none';
    try {
      copied.set(at, read(workspace, base, at));
    } catch {
      return `the bound head holds no file at ${at}`;
    }
    size += copied.get(at).length;
  }
  if (size > most) return 'its inputs are larger than a step may copy';
  const { env: child, missing: unserved } = fenceEnv(step, { node, env, credentials });
  if (unserved) return `missing ${unserved}`;

  const fence = mkdtempSync(path.join(temp, 'ksai-step-'));
  try {
    const dirs = { tree: path.join(fence, 'tree'), home: path.join(fence, 'home'), tools: path.join(fence, 'tools') };
    for (const at of Object.values(dirs)) mkdirSync(at, { mode: 0o700 });
    for (const [at, bytes] of copied) {
      mkdirSync(path.dirname(path.join(dirs.tree, at)), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dirs.tree, at), bytes, { mode: 0o600 });
    }
    for (const [key, content] of Object.entries(step.files ?? {})) {
      const [, dir, at] = key.match(FILE_KEY);
      mkdirSync(path.dirname(path.join(dirs[dir], at)), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dirs[dir], at), content, { mode: 0o600 });
    }
    const args = fenceArgs({ ...dirs, node, toolchains, network: step.network });
    const deadline = now() + step.timeout_seconds * 1000;
    for (const argv of step.run) {
      const left = deadline - now();
      if (left <= 0) return 'it ran out of time';
      try {
        run([...args, ...argv], child, left);
      } catch (error) {
        return `\`${argv[0]}\` failed: ${error.message}`;
      }
    }
    const written = [];
    const outputs = [];
    for (const at of step.outputs ?? []) {
      const made = path.join(dirs.tree, at);
      const target = path.join(workspace, at);
      if (!regularFile(made)) return `it left no file at ${at}`;
      if (!(regularFile(target) || absent(target)) || !insideTree(workspace, target)) return `${at} cannot be written. Its parent directory must exist inside the workspace, and an existing file there must be a regular file`;
      const bytes = readFileSync(made);
      if (!(step.inputs ?? []).includes(at) || !copied.get(at).equals(bytes)) {
        outputs.push({ step: step.id, path: at, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      if (regularFile(target) && readFileSync(target).equals(bytes)) continue;
      written.push([target, bytes, at]);
    }
    for (const [target, bytes] of written) writeFileSync(target, bytes);
    attested.push(...outputs);
    return written.length === 0 ? 'ok: it changed nothing' : `ok: it wrote ${written.map(([, , at]) => at).join(', ')}`;
  } finally {
    rmSync(fence, { recursive: true, force: true });
  }
}

export const runToken = () => import(new URL('../run-token/token.mjs', import.meta.url).href);

async function servedToken(asked, env) {
  const { mintRun } = await runToken();
  const { token } = await mintRun({
    grant: 'step', ...asked, endpoint: String(env.KSAI_CP_ENDPOINT ?? ''), env,
    secret: (held) => say(`::add-mask::${held}`),
  });
  return token;
}

async function revokedToken(token) {
  const { revoke } = await runToken();
  await revoke({ token });
}

async function servedCredentials(step, env, mint, served) {
  const credentials = new Map();
  for (const credential of step.credentials ?? []) {
    let token = '';
    try {
      token = await mint({ step: step.id, credential }, env);
    } catch (error) {
      warn(`minting credential \`${credential}\` for step \`${step.id}\` failed: ${error.message}`);
    }
    if (token !== '') served.push(token);
    credentials.set(credential, token);
  }
  return credentials;
}

export async function main(env = process.env, phase = process.argv[2], {
  run = fenced, changed = changedSince, read = heldAt, node = path.dirname(path.dirname(realpathSync(process.execPath))), now = Date.now,
  most = MAX_INPUT_BYTES, mint = servedToken, revoke = revokedToken, fetch = globalThis.fetch,
} = {}) {
  const workspace = String(env.WORKSPACE ?? '').trim();
  const temp = String(env.RUNNER_TEMP ?? '').trim();
  const base = String(env.BOUND_HEAD_SHA ?? '').trim();
  const file = String(env.STAGE_STEPS_FILE ?? '').trim();
  if (!PHASES.includes(phase) || !path.isAbsolute(workspace) || !path.isAbsolute(temp) || !path.isAbsolute(file)) {
    say('phase, workspace, runner temp or steps file is not set, no control-plane step ran');
    return 0;
  }
  const { steps, refused } = stepsOf(readFileSync(file, 'utf8'));
  if (refused) {
    warn(`control-plane steps were refused, none ran: ${refused}`);
    return 0;
  }
  const attested = [];
  const served = [];
  const toolchains = new Map();
  try {
    for (const step of steps.filter((held) => held.phase === phase)) {
      if (step.when) {
        if (!COMMIT.test(base)) {
          warn(`step \`${step.id}\` waits for a change but the stage has no bound head, skipping it`);
          continue;
        }
        let moved;
        try {
          moved = changed(workspace, base, step.when.changed);
        } catch (error) {
          warn(`step \`${step.id}\` skipped, reading changes to ${step.when.changed.join(', ')} failed: ${error.message}`);
          continue;
        }
        if (!moved) {
          say(`step \`${step.id}\` skipped: ${step.when.changed.join(', ')} did not change`);
          continue;
        }
      }
      const { prepared, why } = await preparedToolchains(step, { temp, env, run, fetch, held: toolchains });
      if (why) {
        warn(`step \`${step.id}\` skipped: ${why}`);
        continue;
      }
      const credentials = await servedCredentials(step, env, mint, served);
      const said = runStep(step, { workspace, temp, node, env, base, read, run, now, most, attested, toolchains: prepared, credentials });
      if (said.startsWith('ok: ')) notice(`step \`${step.id}\` ran, and ${said.slice(4)}`);
      else warn(`step \`${step.id}\` failed and did not apply changes to the worktree: ${said}`);
    }
  } finally {
    for (const token of served) {
      try {
        await revoke(token);
      } catch (error) {
        warn(`revoking a step token failed, it expires on its own: ${error.message}`);
      }
    }
  }
  if (phase === 'after' && attested.length > 0 && path.isAbsolute(String(env.GITHUB_OUTPUT ?? ''))) {
    const landed = [...new Map(attested.map((one) => [one.path, one])).values()];
    landed.sort((one, other) => byBytes(one.path, other.path));
    appendFileSync(String(env.GITHUB_OUTPUT), `step_outputs=${JSON.stringify(landed)}\n`);
  }
  return 0;
}

await runMain(import.meta.url, async () => {
  process.exitCode = await main();
});
