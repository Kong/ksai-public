import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, promises, readFileSync, readSync, realpathSync, statSync, statfsSync, watch } from 'node:fs';
import { release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import json from '../lib/json.cjs';
import { prepareGovernance } from '../governance/anchors.mjs';
import { assertPrepareResultIdentity, assertSamePrepareTask, parsePreparationProfile, parsePrepareResult, parsePrepareTask, prepareDeadlineMilliseconds } from './link-prepare.mjs';
import { installProfileOpencode } from './opencode-install.mjs';

const { parseIJson } = json;
const { mkdtemp, open, rm, symlink } = promises;
const SCRIPTS = resolve(import.meta.dirname, '..');
const WORKER = import.meta.filename;
const PROFILE = './prepare-contract/runtime-preparation.json';
const SLICE_FIELDS = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'Transient', 'InvocationID', 'Slice', 'ControlGroup', 'Delegate', 'StopWhenUnneeded', 'CollectMode', 'FragmentPath', 'DropInPaths'];
const UNIT_FIELDS = ['Id', 'Description', 'Transient', 'InvocationID', 'MainPID', 'ControlGroup', 'User', 'Group', 'Delegate', 'KillMode', 'KillSignal', 'FinalKillSignal', 'SendSIGKILL', 'TimeoutStopUSec', 'Slice', 'FragmentPath', 'DropInPaths'];
const SYSTEMD_BUILDS = Object.freeze(['255.4-1ubuntu8.17', '255.4-1ubuntu8.18']);
const HEX = /^[0-9a-f]{32}$/;
const OUTPUT_BYTES = 64 * 1024;
const CONTROL_MS = 30_000;
const CGROUP2_MAGIC = 0x63677270n;
const CORE_FILES = Object.freeze({
  open: openSync,
  metadata: (fd) => fstatSync(fd, { bigint: true }),
  filesystem: (fd) => statfsSync(`/proc/self/fd/${fd}`, { bigint: true }),
  namespace: (path) => statSync(path, { bigint: true }),
  pathMetadata: (path) => lstatSync(path, { bigint: true, throwIfNoEntry: false }),
  text: (path) => readFileSync(path, 'utf8'),
  read: readSync,
  watch: (fd, changed, failed) => {
    const watcher = watch(`/proc/self/fd/${fd}`, changed);
    watcher.on('error', failed);
    return () => watcher.close();
  },
  close: closeSync,
});

export const PREPARATION_COMPONENT_PATHS = Object.freeze({
  opencode_installer: './opencode-install.mjs',
  preparation_executor: './runtime-prepare.mjs',
  sandbox_runtime: './opencode-run.mjs',
  sandbox_tools: './opencode-tool-sandbox.mjs',
  sandbox_installer: './sandbox-tools.mjs',
  github_anchors: '../governance/anchors.mjs',
});

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const refused = (status = 'failed') => Object.assign(new Error(`the fixed preparation ${status}`), { preparationStatus: status });
const cleanupUnproved = (cause = refused()) => Object.assign(new Error('the fixed preparation cleanup is unproved', { cause }), { preparationStatus: 'failed', preparationCleanup: 'unproved' });
const scheduleTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, Math.max(0, milliseconds));
  return () => clearTimeout(timer);
};

function bounded(promise, milliseconds, { signal = null, schedule = scheduleTimer, expired = () => refused() } = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let cancel = () => {};
    const finish = (error, ...values) => {
      if (settled) return;
      const [value] = values;
      settled = true;
      cancel();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const abort = () => finish(refused(signal.reason === 'lease-lost' ? 'lease-lost' : 'cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    cancel = schedule(() => finish(expired()), milliseconds);
    if (settled) cancel();
    if (signal?.aborted) abort();
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error)).catch(reject);
  });
}

export function assertPreparationKernel(platform, kernelRelease) {
  if (platform !== 'linux' || typeof kernelRelease !== 'string' || kernelRelease.length > 128 || kernelRelease.trim() !== kernelRelease
    || (!/^6\.(?:8|14|17)\.(?:0|[1-9][0-9]*)(?:[-.+][A-Za-z0-9._+-]+)?$/.test(kernelRelease)
      && kernelRelease !== '7.0.0-1017-azure')) throw refused();
  return kernelRelease;
}

function regularBytes(root, at) {
  const boundary = realpathSync(root);
  const path = resolve(root, at);
  const owned = relative(boundary, realpathSync(path));
  if (!owned || owned === '..' || owned.startsWith(`..${sep}`) || isAbsolute(owned) || !lstatSync(path).isFile()) throw refused();
  return readFileSync(path);
}

export function inspectPreparationTree(scripts = SCRIPTS) {
  const directory = join(scripts, 'kreview');
  const profile = parsePreparationProfile(regularBytes(directory, PROFILE));
  for (const [key, path] of Object.entries(PREPARATION_COMPONENT_PATHS)) {
    if (digest(regularBytes(scripts, relative(scripts, resolve(directory, path)))) !== profile.value.components[key]) throw refused();
  }
  for (const [key, name] of [['manifest_sha256', 'package.json'], ['lock_sha256', 'package-lock.json']]) {
    if (digest(regularBytes(scripts, `vendor/opencode-client/${name}`)) !== profile.value.client[key]) throw refused();
  }
  return profile;
}

function privateDirectory(root, path) {
  const base = realpathSync(root);
  if (!isAbsolute(root) || base === sep || !path.startsWith(`${base}${sep}`)) throw refused();
  let parent = base;
  for (const part of relative(base, path).split(sep)) {
    parent = join(parent, part);
    const before = lstatSync(parent, { throwIfNoEntry: false });
    if (!before) mkdirSync(parent, { mode: 0o700 });
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || realpathSync(parent) !== parent || metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0) throw refused();
  }
  return path;
}

export async function createPreparationNpmrc(directory) {
  const path = join(directory, 'npmrc');
  const file = await open(path, 'wx', 0o600);
  await file.close();
  return path;
}

function current(task, nowMilliseconds, signal) {
  if (nowMilliseconds() >= prepareDeadlineMilliseconds(task)) throw refused('deadline');
  if (signal.aborted) throw refused(signal.reason === 'lease-lost' ? 'lease-lost' : 'cancelled');
}

function command(argv, { env = {}, cwd = '/', maximumMilliseconds = CONTROL_MS, launch = spawn, signal = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(cleanupUnproved()); return; }
    const child = launch(argv[0], argv.slice(1), { env, cwd, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0);
    let count = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdout.removeListener('data', stdout);
      child.stderr.removeListener('data', stderr);
      child.removeListener('error', failed);
      child.removeListener('close', closed);
      if (error) {
        releaseLauncher(child, null);
        reject(error);
      } else resolvePromise(output.toString('utf8'));
    };
    const abort = () => finish(cleanupUnproved());
    const timer = setTimeout(abort, Math.max(1, maximumMilliseconds));
    const stdout = (bytes) => {
      count += bytes.length;
      if (count > OUTPUT_BYTES) finish(refused());
      else output = Buffer.concat([output, bytes]);
    };
    const stderr = (bytes) => { count += bytes.length; if (count > OUTPUT_BYTES) finish(refused()); };
    const failed = (error) => finish(error);
    const closed = (code) => finish(code === 0 ? null : refused());
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.once('error', failed);
    child.once('close', closed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function parseUnitFields(text, expected) {
  const fields = Object.create(null);
  for (const line of String(text).trim().split('\n')) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at < 1 || !expected.includes(key) || Object.hasOwn(fields, key)) throw refused();
    fields[key] = line.slice(at + 1);
  }
  if (Object.keys(fields).length !== expected.length) throw refused();
  return Object.freeze(fields);
}

export function parsePreparationUnit(text) {
  return parseUnitFields(text, UNIT_FIELDS);
}

function assertPreparationSlice(unit, pending) {
  if (unit.Id !== pending.name || unit.Description !== pending.description || unit.LoadState !== 'loaded'
    || unit.ActiveState !== 'active' || unit.SubState !== 'active' || unit.Transient !== 'yes' || !HEX.test(unit.InvocationID)
    || unit.Slice !== '-.slice' || unit.ControlGroup !== `/${pending.name}` || unit.Delegate !== 'no'
    || unit.StopWhenUnneeded !== 'no' || unit.CollectMode !== 'inactive'
    || unit.FragmentPath !== `/run/systemd/transient/${pending.name}` || unit.DropInPaths !== '') throw refused();
  return Object.freeze({ ...pending, invocation: unit.InvocationID, controlGroup: unit.ControlGroup });
}

export function assertPreparationUnit(unit, owner, worker) {
  if (unit.Id !== owner.name || unit.Description !== owner.description || unit.Transient !== 'yes'
    || !HEX.test(unit.InvocationID) || unit.InvocationID !== worker.invocation || Number(unit.MainPID) !== worker.pid
    || unit.User !== String(owner.uid) || unit.Group !== String(owner.gid) || unit.Delegate !== 'no' || unit.KillMode !== 'control-group'
    || unit.KillSignal !== '15' || unit.FinalKillSignal !== '9' || unit.SendSIGKILL !== 'yes'
    || unit.TimeoutStopUSec !== '10s' || unit.Slice !== owner.slice.name
    || unit.ControlGroup !== `${owner.slice.controlGroup}/${owner.name}`
    || unit.FragmentPath !== `/run/systemd/transient/${owner.name}` || unit.DropInPaths !== '') throw refused();
  return Object.freeze({ ...owner, invocation: unit.InvocationID, controlGroup: unit.ControlGroup, pid: worker.pid });
}

function fileIdentity(metadata) {
  const fields = ['dev', 'ino', 'mode', 'uid', 'gid'];
  if (fields.some((field) => typeof metadata[field] !== 'bigint' || metadata[field] < 0n)) throw cleanupUnproved();
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, metadata[field].toString()])));
}

function sameIdentity(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

function descriptorMount(fd, metadata, files) {
  const info = Object.create(null);
  for (const line of files.text(`/proc/self/fdinfo/${fd}`).trim().split('\n')) {
    const matched = /^([a-z_]+):\s+([^\s]+)$/.exec(line);
    if (!matched || Object.hasOwn(info, matched[1])) throw cleanupUnproved();
    info[matched[1]] = matched[2];
  }
  if (!/^[1-9][0-9]*$/.test(info.mnt_id) || !/^[1-9][0-9]*$/.test(info.ino)
    || BigInt(info.ino) !== metadata.ino || !/^[0-7]+$/.test(info.flags) || (BigInt(`0o${info.flags}`) & 3n) !== 0n) throw cleanupUnproved();
  const records = files.text('/proc/self/mountinfo').trim().split('\n').filter((line) => line.split(' ')[0] === info.mnt_id);
  if (records.length !== 1) throw cleanupUnproved();
  const [before, after, extra] = records[0].split(' - ');
  const head = before.split(' ');
  const tail = after?.split(' ') ?? [];
  if (extra !== undefined || head.length < 6 || head[3] !== '/' || head[4] !== '/sys/fs/cgroup' || tail.length !== 3 || tail[0] !== 'cgroup2') throw cleanupUnproved();
  return Object.freeze({ mountId: info.mnt_id, mountRecord: records[0] });
}

function coreSnapshot(directory, events, files) {
  const group = files.metadata(directory);
  const core = files.metadata(events);
  if ((group.mode & 0o170000n) !== 0o040000n || (core.mode & 0o170000n) !== 0o100000n
    || group.uid !== 0n || group.gid !== 0n || core.uid !== 0n || core.gid !== 0n
    || (group.mode & 0o022n) !== 0n || (core.mode & 0o222n) !== 0n || group.dev !== core.dev
    || files.filesystem(directory).type !== CGROUP2_MAGIC || files.filesystem(events).type !== CGROUP2_MAGIC) throw cleanupUnproved();
  const groupMount = descriptorMount(directory, group, files);
  const coreMount = descriptorMount(events, core, files);
  if (!sameIdentity(groupMount, coreMount)) throw cleanupUnproved();
  return Object.freeze({ group: fileIdentity(group), events: fileIdentity(core), ...groupMount,
    mountNamespace: fileIdentity(files.namespace('/proc/self/ns/mnt')),
    cgroupNamespace: fileIdentity(files.namespace('/proc/self/ns/cgroup')) });
}

function readCore(events, files) {
  const bytes = Buffer.alloc(1024);
  const size = files.read(events, bytes, 0, bytes.length, 0);
  if (!Number.isInteger(size) || size < 1 || size >= bytes.length) throw cleanupUnproved();
  if (bytes.subarray(0, size).some((byte) => byte > 0x7F)) throw cleanupUnproved();
  const text = bytes.subarray(0, size).toString('ascii');
  const matched = /^populated ([01])\nfrozen [01]\n$/.exec(text);
  if (!matched) throw cleanupUnproved();
  return matched[1];
}

export function cgroupWitness(sliceOwner, fileSource = null) {
  const files = fileSource ?? CORE_FILES;
  assertPreparationKernel('linux', sliceOwner.kernelRelease);
  if (!/^ksaiprepare[0-9a-f]{32}\.slice$/.test(sliceOwner.name) || sliceOwner.controlGroup !== '/' + sliceOwner.name || !HEX.test(sliceOwner.invocation)) throw cleanupUnproved();
  const path = '/sys/fs/cgroup' + sliceOwner.controlGroup;
  const hostGroups = files.text('/proc/self/cgroup').trim().split('\n').map((line) => line.slice(line.indexOf('::') + 2));
  if (hostGroups.some((group) => group === sliceOwner.controlGroup || group.startsWith(sliceOwner.controlGroup + '/'))) throw cleanupUnproved();
  let directory = null;
  let events = null;
  let closed = false;
  let bound = false;
  let drained = false;
  let generation = 0;
  let wake = () => {};
  let fault = null;
  let releaseWatch = () => {};
  const waitForChange = (observedGeneration) => new Promise((resolvePromise) => {
    const releaseWaiter = () => {
      wake = () => {};
      resolvePromise(undefined);
    };
    wake = releaseWaiter;
    if (closed || fault || generation !== observedGeneration) releaseWaiter();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    wake();
    try { releaseWatch(); }
    finally {
      try { if (events !== null) files.close(events); }
      finally { if (directory !== null) files.close(directory); }
    }
  };
  try {
    directory = files.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    events = files.open('/proc/self/fd/' + directory + '/cgroup.events', constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = coreSnapshot(directory, events, files);
    const check = () => {
      if (closed || fault) throw cleanupUnproved(fault ?? refused());
      const actual = coreSnapshot(directory, events, files);
      if (!sameIdentity(identity.group, actual.group) || !sameIdentity(identity.events, actual.events)
        || !sameIdentity(identity.mountNamespace, actual.mountNamespace) || !sameIdentity(identity.cgroupNamespace, actual.cgroupNamespace)
        || identity.mountId !== actual.mountId || identity.mountRecord !== actual.mountRecord
        || !sameIdentity(identity.group, fileIdentity(files.pathMetadata(path)))) throw cleanupUnproved();
    };
    releaseWatch = files.watch(events, () => { generation += 1; wake(); }, (error) => { fault = error; wake(); });
    check();
    if (readCore(events, files) !== '0') throw cleanupUnproved();
    return Object.freeze({
      identity,
      assertEmpty() {
        check();
        if (!bound || !drained || readCore(events, files) !== '0') throw cleanupUnproved();
      },
      bindWorker(worker, workerPid, originalMonitorExit) {
        if (bound || worker.slice.invocation !== sliceOwner.invocation || worker.slice.controlGroup !== sliceOwner.controlGroup
          || worker.controlGroup !== sliceOwner.controlGroup + '/' + worker.name || !HEX.test(worker.invocation)
          || !(originalMonitorExit instanceof Promise)) throw cleanupUnproved();
        bound = true;
        const membership = files.text('/proc/' + workerPid + '/cgroup').split('\n');
        if (!membership.includes('0::' + worker.controlGroup)) throw cleanupUnproved();
        check();
        if (readCore(events, files) !== '1') throw cleanupUnproved();
        let completed = null;
        return Object.freeze({
          identity,
          finish() {
            completed ??= (async () => {
              const monitorCode = await originalMonitorExit;
              if (!Number.isInteger(monitorCode)) throw cleanupUnproved();
              for (;;) {
                const observed = generation;
                check();
                if (readCore(events, files) === '0') {
                  drained = true;
                  return Object.freeze({ kind: 'owned-ancestor-populated-zero', unitName: worker.name, invocationId: worker.invocation,
                    controlGroup: worker.controlGroup, sliceName: sliceOwner.name, sliceInvocationId: sliceOwner.invocation,
                    ancestorControlGroup: sliceOwner.controlGroup, kernelRelease: sliceOwner.kernelRelease,
                    managerBuild: sliceOwner.managerBuild, busctlBuild: sliceOwner.busctlBuild, ...identity, monitorCode });
                }
                await waitForChange(observed);
              }
            })().catch((error) => { throw cleanupUnproved(error); });
            return completed;
          },
          close,
        });
      },
      close,
    });
  } catch (error) {
    close();
    throw cleanupUnproved(error);
  }
}

function workerMailbox(child) {
  const queued = [];
  let wake = () => {};
  let buffer = Buffer.alloc(0);
  let fault = null;
  let closed = false;
  let disposed = false;
  let outputBytes = 0;
  const output = (bytes) => {
    outputBytes += bytes.length;
    buffer = Buffer.concat([buffer, bytes]);
    if (outputBytes > OUTPUT_BYTES) { fault = refused(); buffer = Buffer.alloc(0); wake(); return; }
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      try { queued.push(parseIJson(buffer.subarray(0, end), 'the private preparation worker')); }
      catch { fault = refused(); }
      buffer = buffer.subarray(end + 1);
      wake();
    }
  };
  let errors = 0;
  const stderr = (bytes) => { errors += bytes.length; if (errors > OUTPUT_BYTES) { fault = refused(); wake(); } };
  const error = () => { fault = refused(); wake(); };
  let rejectExit = (_error) => {};
  let close = (_code) => {};
  const exit = new Promise((resolvePromise, reject) => {
    rejectExit = reject;
    close = (code) => { closed = true; wake(); resolvePromise(code); };
  });
  exit.catch(() => {});
  child.stdout.on('data', output);
  child.stderr.on('data', stderr);
  child.on('error', error);
  child.stdout.on('error', error);
  child.stderr.on('error', error);
  child.once('close', close);
  const wait = () => new Promise((resolvePromise) => { wake = () => resolvePromise(undefined); });
  return {
    exit,
    get completed() { return closed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      fault ??= cleanupUnproved();
      queued.length = 0;
      wake();
      child.stdout.removeListener('data', output);
      child.stderr.removeListener('data', stderr);
      child.stdout.removeListener('error', error);
      child.stderr.removeListener('error', error);
      child.removeListener('error', error);
      child.removeListener('close', close);
      if (!closed) rejectExit(fault);
    },
    async next(kind) {
      for (;;) {
        if (fault) throw fault;
        const message = queued.shift();
        if (message) {
          if (message.kind !== kind) throw refused();
          return message;
        }
        if (fault || closed) throw fault ?? refused();
        await wait();
      }
    },
  };
}

function releaseLauncher(child, mailbox) {
  if (!child) return;
  const ignore = () => {};
  if (!mailbox?.completed) {
    child.on('error', ignore);
    child.once('close', () => child.removeListener('error', ignore));
  }
  mailbox?.dispose();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream || stream.closed) continue;
    stream.on('error', ignore);
    stream.once('close', () => stream.removeListener('error', ignore));
    stream.destroy();
  }
  child.unref?.();
}

function unitArguments(owner, executable, worker) {
  return ['-n', '--', '/usr/bin/systemd-run', '--system', '--no-ask-password', '--service-type=exec', '--wait', '--pipe', '--collect', '--quiet', '--expand-environment=no',
    '--unit=' + owner.name, '--description=' + owner.description, '--slice=' + owner.slice.name, '--uid=' + owner.uid, '--gid=' + owner.gid,
    '--property=Restart=no', '--property=Delegate=no', '--property=KillMode=control-group', '--property=KillSignal=SIGTERM', '--property=FinalKillSignal=SIGKILL',
    '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=10s', '--setenv=NODE_DISABLE_COMPILE_CACHE=1', executable, worker, '--fixed-install-worker'];
}

export async function runOwnedPreparationWorker(task, context, {
  signal = new AbortController().signal, nowMilliseconds = Date.now, launch = spawn, control = command, witness = cgroupWitness,
  nonce = () => randomBytes(16).toString('hex'), uid = process.getuid?.() ?? -1, gid = process.getgid?.() ?? -1,
  platform = process.platform, kernelRelease = release(), executable = process.execPath, worker = WORKER, schedule = scheduleTimer,
} = {}) {
  current(task, nowMilliseconds, signal);
  assertPreparationKernel(platform, kernelRelease);
  if (uid < 1 || gid < 0 || !isAbsolute(executable) || worker !== WORKER) throw refused();
  const token = nonce();
  if (!HEX.test(token)) throw refused();
  const pending = Object.freeze({ name: 'ksai-prepare-' + token + '.service', description: 'ksai-prepare:' + token, uid, gid, kernelRelease });
  const pendingSlice = Object.freeze({ name: 'ksaiprepare' + token + '.slice', description: 'ksai-prepare-slice:' + token,
    kernelRelease });
  const controlEnv = { PATH: '/usr/bin:/bin', LANG: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' };
  const controlAbort = new AbortController();
  const options = { env: controlEnv, launch, signal: controlAbort.signal };
  const show = async () => parsePreparationUnit(await control(['/usr/bin/systemctl', '--system', '--no-ask-password', 'show', '--all',
    '--property=' + UNIT_FIELDS.join(','), pending.name], options));
  const showSlice = async () => parseUnitFields(await control(['/usr/bin/systemctl', '--system', '--no-ask-password', 'show', '--all',
    '--property=' + SLICE_FIELDS.join(','), pendingSlice.name], options), SLICE_FIELDS);
  let child = null;
  let mailbox = null;
  let slice = null;
  let sliceProof = null;
  let owner = null;
  let workerIdentity = null;
  let evidence = null;
  let stopping = null;
  let retiring = null;
  let sliceRequested = false;
  let terminal = false;
  const resources = () => ({ child, mailbox, evidence, slice, sliceProof });
  const inputError = () => {};
  const activeControl = async (argv) => {
    if (terminal) throw cleanupUnproved();
    current(task, nowMilliseconds, signal);
    const maximumMilliseconds = Math.min(CONTROL_MS, prepareDeadlineMilliseconds(task) - nowMilliseconds());
    if (maximumMilliseconds < 1) throw refused('deadline');
    const value = await control(argv, { ...options, maximumMilliseconds });
    if (terminal) throw cleanupUnproved();
    return value;
  };
  const stop = () => {
    child?.stdin.end();
    if (!owner || !mailbox || mailbox.completed) return;
    const originalOwner = owner;
    const originalWorker = workerIdentity;
    const originalMailbox = mailbox;
    stopping ??= (async () => {
      let unit;
      try { unit = await show(); } catch (error) { if (originalMailbox.completed) return; throw error; }
      if (originalMailbox.completed) return;
      if (unit.MainPID !== '0' && unit.MainPID !== String(originalOwner.pid)) throw refused();
      const checked = assertPreparationUnit({ ...unit, MainPID: String(originalOwner.pid) }, originalOwner, originalWorker);
      if (checked.invocation !== originalOwner.invocation || checked.controlGroup !== originalOwner.controlGroup) throw refused();
      await control(['/usr/bin/sudo', '-n', '--', '/usr/bin/systemctl', '--system', '--no-ask-password', 'stop', originalOwner.name], options);
    })();
    stopping.catch(() => {});
  };
  const retireSlice = () => {
    const { slice: originalSlice, sliceProof: originalProof } = resources();
    if (!originalSlice || !originalProof) return Promise.reject(cleanupUnproved());
    retiring ??= (async () => {
      originalProof.assertEmpty();
      const checked = assertPreparationSlice(await showSlice(), originalSlice);
      if (checked.invocation !== originalSlice.invocation || checked.controlGroup !== originalSlice.controlGroup) throw cleanupUnproved();
      originalProof.assertEmpty();
      await control(['/usr/bin/sudo', '-n', '--', '/usr/bin/systemctl', '--system', '--no-ask-password', 'stop', originalSlice.name], options);
      const ended = await showSlice();
      if (ended.Id !== originalSlice.name || ended.ActiveState !== 'inactive' || ended.SubState !== 'dead'
        || !['loaded', 'not-found'].includes(ended.LoadState)
        || (ended.ControlGroup !== '' && ended.ControlGroup !== originalSlice.controlGroup)
        || (ended.InvocationID !== '' && ended.InvocationID !== originalSlice.invocation)
        || (ended.InvocationID !== '' && (ended.Description !== originalSlice.description || ended.Transient !== 'yes'
          || ended.Slice !== '-.slice' || ended.Delegate !== 'no' || ended.StopWhenUnneeded !== 'no' || ended.CollectMode !== 'inactive'
          || ended.FragmentPath !== '/run/systemd/transient/' + originalSlice.name || ended.DropInPaths !== ''))
        || (ended.InvocationID === '' && (ended.Transient !== 'no' || ended.ControlGroup !== '' || ended.FragmentPath !== '' || ended.DropInPaths !== ''))) throw cleanupUnproved();
    })();
    return retiring;
  };
  const startup = async () => {
    const busctlBuild = (await activeControl(['/usr/bin/busctl', '--version'])).split('\n')[0];
    const manager = await activeControl(['/usr/bin/busctl', '--system', '--allow-interactive-authorization=no', '--auto-start=no',
      'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'Version']);
    const managerBuild = SYSTEMD_BUILDS.find((value) => busctlBuild === 'systemd 255 (' + value + ')' && manager === 's "' + value + '"\n');
    if (!managerBuild) {
      throw Object.assign(refused(), { message: 'the fixed preparation manager or busctl build is unsupported' });
    }
    if ((await activeControl(['/usr/bin/systemctl', '--system', '--no-ask-password', 'list-units', '--all', '--no-pager', '--no-legend',
      pendingSlice.name, pending.name])).trim()) throw refused();
    const budget = Math.min(CONTROL_MS, prepareDeadlineMilliseconds(task) - nowMilliseconds());
    if (budget < 1) throw refused('deadline');
    sliceRequested = true;
    const reply = await activeControl(['/usr/bin/sudo', '-n', '--', '/usr/bin/busctl', '--system', '--allow-interactive-authorization=no',
      '--expect-reply=yes', '--auto-start=no', '--timeout=' + budget + 'ms', 'call', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
      pendingSlice.name, 'fail', '3', 'Description', 's', pendingSlice.description, 'StopWhenUnneeded', 'b', 'false', 'CollectMode', 's', 'inactive', '0']);
    if (!/^o "\/org\/freedesktop\/systemd1\/job\/[1-9][0-9]*"\n$/.test(reply)) throw cleanupUnproved();
    await activeControl(['/usr/bin/sudo', '-n', '--', '/usr/bin/systemctl', '--system', '--no-ask-password', '--job-mode=fail', 'start', pendingSlice.name]);
    const unit = await showSlice();
    if (terminal) throw cleanupUnproved();
    slice = assertPreparationSlice(unit, { ...pendingSlice, managerBuild, busctlBuild });
    sliceProof = witness(slice);
    current(task, nowMilliseconds, signal);
    child = launch('/usr/bin/sudo', unitArguments({ ...pending, slice }, executable, worker), { env: controlEnv, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', inputError);
    mailbox = workerMailbox(child);
    child.stdin.write(JSON.stringify({ kind: 'challenge', nonce: token, taskId: task.taskId, argument: task.text, ...context }) + '\n');
    const ready = await mailbox.next('ready');
    if (terminal) throw cleanupUnproved();
    if (ready.nonce !== token || ready.uid !== uid || ready.gid !== gid || !Number.isSafeInteger(ready.pid) || ready.pid < 1
      || !Array.isArray(ready.groups) || ready.groups.some((group) => !Number.isSafeInteger(group) || group < 0) || ready.groups.includes(0)) throw refused();
    const service = await show();
    if (terminal) throw cleanupUnproved();
    workerIdentity = ready;
    owner = assertPreparationUnit(service, { ...pending, slice }, ready);
    evidence = sliceProof.bindWorker(owner, owner.pid, mailbox.exit);
  };
  try {
    await bounded(startup(), Math.min(CONTROL_MS, prepareDeadlineMilliseconds(task) - nowMilliseconds()), {
      signal, schedule, expired: () => nowMilliseconds() >= prepareDeadlineMilliseconds(task) ? refused('deadline') : cleanupUnproved(),
    });
    current(task, nowMilliseconds, signal);
    const { child: activeChild, mailbox: activeMailbox, evidence: activeEvidence } = resources();
    if (!activeChild || !activeMailbox || !activeEvidence) throw cleanupUnproved();
    signal.addEventListener('abort', stop, { once: true });
    await bounded((async () => {
      current(task, nowMilliseconds, signal);
      activeChild.stdin.write(JSON.stringify({ kind: 'execute', nonce: token }) + '\n');
      const complete = await activeMailbox.next('complete');
      if (complete.nonce !== token) throw refused();
      const monitorCode = await activeMailbox.exit;
      await activeEvidence.finish();
      if (monitorCode !== 0) throw refused();
      await retireSlice();
    })(), prepareDeadlineMilliseconds(task) - nowMilliseconds(), { signal, schedule, expired: () => refused('deadline') });
    current(task, nowMilliseconds, signal);
  } catch (error) {
    terminal = true;
    stop();
    if (!sliceRequested) throw error;
    const { child: closingChild, mailbox: closingMailbox, evidence: closingEvidence, sliceProof: closingSliceProof } = resources();
    try {
      await bounded((async () => {
        if (stopping) await stopping;
        if (closingMailbox) {
          await closingMailbox.exit;
          if (!closingEvidence) throw cleanupUnproved();
          await closingEvidence.finish();
        } else if (closingChild || !closingSliceProof) throw cleanupUnproved();
        await retireSlice();
      })(), CONTROL_MS, { schedule, expired: cleanupUnproved });
    } catch (fault) { throw cleanupUnproved(fault); }
    throw error;
  } finally {
    terminal = true;
    controlAbort.abort();
    signal.removeEventListener('abort', stop);
    const { child: finalChild, mailbox: finalMailbox, evidence: finalEvidence, sliceProof: finalSliceProof } = resources();
    try { finalEvidence?.close(); }
    finally {
      try { finalSliceProof?.close(); }
      finally {
        releaseLauncher(finalChild, finalMailbox);
        finalChild?.stdin.removeListener('error', inputError);
      }
    }
  }
}

function outputFor(task, status) {
  const output = `${JSON.stringify({ api_version: 'ksai.konghq.com/stage-prepare-result/v1alpha1', task_id: task.taskId, body_digest: task.digest,
    binding_digest: task.value.binding_digest, runtime_commit: task.value.runtime_commit, profile_digest: task.value.profile_digest, status })}\n`;
  assertPrepareResultIdentity(parsePrepareResult(output), task);
  return output;
}

export function createRuntimePreparation({ runtimeCommit, runnerTemp, actionOpencodeVersion }, {
  nowMilliseconds = Date.now, runWorker = runOwnedPreparationWorker, anchors = prepareGovernance,
  inspect = inspectPreparationTree,
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(runtimeCommit) || !isAbsolute(runnerTemp) || realpathSync(runnerTemp) === sep) throw refused();
  let retained = null;
  let active = null;
  const runSignedTask = (given, { signal = new AbortController().signal } = {}) => {
    const task = parsePrepareTask(given.taskId, given.text);
    assertSamePrepareTask(given, task);
    if (retained) { assertSamePrepareTask(retained, task); return active; }
    retained = task;
    active = (async () => {
      let ready = null;
      let status = 'failed';
      try {
        current(task, nowMilliseconds, signal);
        const profile = inspect();
        if (task.value.runtime_commit !== runtimeCommit || task.value.profile_digest !== profile.digest
          || actionOpencodeVersion !== profile.value.opencode.version) throw refused();
        const temp = realpathSync(runnerTemp);
        const context = { runtimeCommit, runnerTemp: temp, actionOpencodeVersion };
        await runWorker(task, context, { signal, nowMilliseconds });
        current(task, nowMilliseconds, signal);
        const governedRoot = await anchors({ RUNNER_TEMP: temp, PATH: process.env.PATH ?? '' }, { signal, deadlineAt: prepareDeadlineMilliseconds(task), now: nowMilliseconds });
        current(task, nowMilliseconds, signal);
        ready = Object.freeze({ binary: join(temp, 'ksai-opencode/bin/opencode'), clientRoot: join(SCRIPTS, 'vendor/opencode-client'), governedRoot });
        status = 'ready';
      } catch (error) {
        status = nowMilliseconds() >= prepareDeadlineMilliseconds(task) ? 'deadline'
          : signal.aborted ? signal.reason === 'lease-lost' ? 'lease-lost' : 'cancelled' : error.preparationStatus ?? 'failed';
      }
      return Object.freeze({ output: outputFor(task, status), ready });
    })();
    return active;
  };
  return Object.freeze({ runSignedTask });
}

async function installWorker(task, context) {
  const signal = new AbortController().signal;
  const check = () => current(task, Date.now, signal);
  check();
  assertPreparationKernel(process.platform, release());
  const profile = inspectPreparationTree();
  if (profile.digest !== task.value.profile_digest || context.runtimeCommit !== task.value.runtime_commit
    || context.actionOpencodeVersion !== profile.value.opencode.version) throw refused();
  const temp = realpathSync(context.runnerTemp);
  const root = privateDirectory(temp, join(temp, 'ksai-runtime-preparation'));
  const distDir = privateDirectory(temp, join(temp, 'ksai-opencode-dist'));
  const toolDir = privateDirectory(temp, join(temp, 'ksai-opencode/bin'));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', RUNNER_TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1', LANG: 'C' };
  const run = async (argv, maximumMilliseconds = CONTROL_MS) => {
    check();
    return command(argv, { env, cwd: root, maximumMilliseconds: Math.max(1, Math.min(maximumMilliseconds, prepareDeadlineMilliseconds(task) - Date.now())) });
  };
  const clientRoot = join(SCRIPTS, 'vendor/opencode-client');
  const installBinary = async () => {
    const installed = await installProfileOpencode({ artifacts: profile.value.opencode.artifacts, distDir, toolDir, signal, deadlineAtMilliseconds: prepareDeadlineMilliseconds(task) });
    check();
    await rm(join(toolDir, 'opencode'), { force: true });
    await symlink(installed.binary, join(toolDir, 'opencode'));
    return installed;
  };
  const installClient = async () => {
    const npmDirectory = await mkdtemp(join(root, 'npm-'));
    try {
      check();
      const npmrc = await createPreparationNpmrc(npmDirectory);
      await run(['/usr/bin/env', 'npm', 'ci', '--prefix', clientRoot, '--omit=dev', '--ignore-scripts', '--audit=false', '--fund=false', '--registry=https://registry.npmjs.org', `--userconfig=${npmrc}`, `--globalconfig=${npmrc}`], 300_000);
    } finally {
      await rm(npmDirectory, { recursive: true, force: true });
    }
  };
  const { prepareSandboxTools } = await import('./sandbox-tools.mjs');
  const sandboxDirectory = await mkdtemp(join(root, 'sandbox-'));
  let installed;
  let search;
  try {
    [installed, , search] = await Promise.all([installBinary(), installClient(), prepareSandboxTools({ run, workDir: sandboxDirectory, signal })]);
  } finally {
    await rm(sandboxDirectory, { recursive: true, force: true });
  }
  const version = (await run([installed.binary, '--version'])).trim().replace(/^opencode v/, '');
  if (version !== '2.0.29') throw refused();
  check();
  const driver = await import('./opencode-v2-driver.mjs');
  if (driver.clientProblem()) throw refused();
  await import(driver.CLIENT.href);
  for (const argv of [[search.path, '--version'], ['/usr/bin/bwrap', '--version']]) await run(argv);
  check();
}

async function workerMain() {
  process.stdin.once('end', () => process.exit(130));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queue = lines[Symbol.asyncIterator]();
  const first = await queue.next();
  if (first.done || Buffer.byteLength(first.value) >= OUTPUT_BYTES) throw refused();
  const context = parseIJson(first.value, 'the private preparation context');
  if (Object.keys(context).sort().join(',') !== 'actionOpencodeVersion,argument,kind,nonce,runnerTemp,runtimeCommit,taskId'
    || context.kind !== 'challenge' || !HEX.test(context.nonce) || process.getuid() < 1) throw refused();
  const task = parsePrepareTask(context.taskId, context.argument);
  current(task, Date.now, new AbortController().signal);
  process.stdout.write(`${JSON.stringify({ kind: 'ready', nonce: context.nonce, pid: process.pid, uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), invocation: process.env.INVOCATION_ID ?? '' })}\n`);
  const next = await queue.next();
  if (next.done || Buffer.byteLength(next.value) >= 1024) throw refused();
  const permission = parseIJson(next.value, 'the private preparation permission');
  if (Object.keys(permission).sort().join(',') !== 'kind,nonce' || permission.kind !== 'execute' || permission.nonce !== context.nonce) throw refused();
  await installWorker(task, context);
  process.stdout.write(`${JSON.stringify({ kind: 'complete', nonce: context.nonce })}\n`, () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === WORKER) {
  if (process.argv.length !== 3 || process.argv[2] !== '--fixed-install-worker') process.exitCode = 1;
  else {
    try { await workerMain(); }
    catch { process.exit(1); }
  }
}
