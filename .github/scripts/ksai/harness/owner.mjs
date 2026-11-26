import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { createConnection, isIPv4 } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { FAILURES, groupLeaderMatches } from './contract.mjs';

const exec = promisify(execFile);
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const PROCESS_ID = /^[1-9]\d*$/u;
const TCP_PORT = /^\d+\/tcp$/u;
const ACCEPT_POLL_MS = 25;

const wrongOwner = () => Object.assign(new Error(FAILURES.endpointNotOwned.reason), { ownerRefused: true });
const connectionEnded = () => Object.assign(new Error('the endpoint connection ended'), { connectionFailed: true });
const processID = (value) => Number.isInteger(value) && value >= 2 && value <= 2_147_483_647;

export function ownerSignal(deadlineAt, signal) {
  const left = deadlineAt - Date.now();
  if (!Number.isSafeInteger(left) || left <= 0) return AbortSignal.abort(new DOMException('owner check deadline', 'TimeoutError'));
  const timer = AbortSignal.timeout(left);
  return signal ? AbortSignal.any([timer, signal]) : timer;
}

async function docker(args, signal) {
  signal.throwIfAborted();
  const { stdout } = await exec('docker', args, { signal, killSignal: 'SIGKILL', maxBuffer: 4 << 20 });
  signal.throwIfAborted();
  return stdout;
}

function mapped(instance, labels, address, port) {
  if (!CONTAINER_ID.test(instance?.Id) || instance?.State?.Running !== true
    || !processID(instance.State.Pid) || typeof instance.State.StartedAt !== 'string'
    || instance.State.StartedAt.length < 1 || instance.State.StartedAt.length > 128
    || Object.entries(labels).some(([key, value]) => !Object.hasOwn(instance.Config?.Labels ?? {}, key)
      || instance.Config.Labels[key] !== value)) return false;
  const bindings = Object.entries(instance.NetworkSettings?.Ports ?? {});
  return bindings.some(([key, entries]) => TCP_PORT.test(key) && Array.isArray(entries)
    && entries.some((entry) => (entry?.HostIp === address || entry?.HostIp === '0.0.0.0') && entry.HostPort === String(port)));
}

async function inspect(ids, signal, runDocker = docker) {
  if (!ids.length || ids.some((id) => !CONTAINER_ID.test(id))) throw wrongOwner();
  const response = JSON.parse(await runDocker(['inspect', '--type', 'container', ...ids], signal));
  if (!Array.isArray(response)) throw wrongOwner();
  return response;
}

export async function captureOwner(owner, { address, port, pgid = 0, startedAt = '', deadlineAt, signal = null }) {
  const bounded = ownerSignal(deadlineAt, signal);
  if (bounded.reason?.name === 'TimeoutError') throw Object.assign(bounded.reason, { ownerPrevented: true });
  bounded.throwIfAborted();
  if (owner.kind === 'process_group') {
    if (processID(pgid) && typeof startedAt === 'string' && startedAt.length >= 1 && startedAt.length <= 128) {
      return { pgid, started_at: startedAt };
    }
    throw wrongOwner();
  }
  if (owner.kind !== 'container') throw wrongOwner();
  const filters = Object.entries(owner.labels).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]);
  const ids = (await docker(['ps', '--no-trunc', '--quiet', ...filters], bounded)).split(/\s+/u).filter(Boolean);
  const matches = (await inspect(ids, bounded)).filter((one) => mapped(one, owner.labels, address, port));
  if (matches.length !== 1) throw wrongOwner();
  const [one] = matches;
  return { id: one.Id, started_at: one.State.StartedAt, pid: one.State.Pid };
}

async function verifyContainer(owner, instance, { address, port, signal }, runDocker) {
  const [one] = await inspect([instance?.id], signal, runDocker);
  if (!mapped(one, owner.labels, address, port) || one.Id !== instance.id
    || one.State.StartedAt !== instance.started_at || one.State.Pid !== instance.pid) throw wrongOwner();
}

function procRead(read, missing) {
  try {
    return read();
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EPERM', 'EACCES'].includes(error.code)) return missing;
    throw error;
  }
}

function procAddress(address, port) {
  if (!isIPv4(address) || !Number.isInteger(port) || port < 1) throw connectionEnded();
  const host = Buffer.from(address.split('.').map(Number).toReversed()).toString('hex').toUpperCase();
  const suffix = port.toString(16).toUpperCase().padStart(4, '0');
  return [`${host}:${suffix}`, `0000000000000000FFFF0000${host}:${suffix}`];
}

function peerInode(socket) {
  const local = procAddress(socket.localAddress, socket.localPort);
  const remote = procAddress(socket.remoteAddress, socket.remotePort);
  for (const [index, file] of ['/proc/net/tcp', '/proc/net/tcp6'].entries()) {
    const table = procRead(() => readFileSync(file, 'utf8'), '');
    for (const line of table.split('\n')) {
      const [, bound, peer, , , , , , , inode] = line.trim().split(/\s+/u);
      if (bound === remote[index] && peer === local[index] && inode && inode !== '0') return inode;
    }
  }
  return '';
}

function peerGroup(inode) {
  if (!inode) return null;
  for (const pid of readdirSync('/proc')) {
    if (!PROCESS_ID.test(pid)) continue;
    const dir = `/proc/${pid}/fd`;
    const files = procRead(() => readdirSync(dir), []);
    if (files.some((fd) => procRead(() => readlinkSync(`${dir}/${fd}`), '') === `socket:[${inode}]`)) {
      const stat = procRead(() => readFileSync(`/proc/${pid}/stat`, 'utf8'), '');
      const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      if (Number.isSafeInteger(group) && group > 0) return group;
    }
  }
  return null;
}

function validGroupInstance(instance) {
  return processID(instance?.pgid) && typeof instance?.started_at === 'string'
    && instance.started_at.length >= 1 && instance.started_at.length <= 128;
}

async function verifyGroup(socket, instance, signal, readGroup, retry, checkLeader, platform) {
  if (platform !== 'linux' || !validGroupInstance(instance)) throw wrongOwner();
  for (;;) {
    signal.throwIfAborted();
    if (!checkLeader(instance.pgid, instance.started_at)) throw wrongOwner();
    const group = readGroup(() => peerGroup(peerInode(socket)));
    signal.throwIfAborted();
    if (group === instance.pgid) {
      if (!checkLeader(instance.pgid, instance.started_at)) throw wrongOwner();
      return;
    }
    if (group !== null) throw wrongOwner();
    await retry(ACCEPT_POLL_MS, undefined, { signal });
  }
}

export async function connectOwned(owner, instance, { address, port, deadlineAt, signal = null }, {
  readGroup = (read) => read(), checkLeader = groupLeaderMatches, platform = process.platform,
  retry = delay, bound = ownerSignal, runDocker = docker,
} = {}) {
  if (owner.kind !== 'container' && owner.kind !== 'process_group') throw wrongOwner();
  if (address !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) throw wrongOwner();
  const socketEnded = new AbortController();
  const bounded = bound(deadlineAt, signal ? AbortSignal.any([signal, socketEnded.signal]) : socketEnded.signal);
  const target = { address, port, signal: bounded };
  const end = () => socketEnded.abort(connectionEnded());
  let socket;
  let checkingOwner = false;
  try {
    bounded.throwIfAborted();
    checkingOwner = true;
    if (owner.kind === 'container') {
      await verifyContainer(owner, instance, target, runDocker);
    } else if (platform !== 'linux' || !validGroupInstance(instance) || !checkLeader(instance.pgid, instance.started_at)) {
      throw wrongOwner();
    }
    bounded.throwIfAborted();
    checkingOwner = false;
    socket = createConnection({ host: address, port, family: 4, allowHalfOpen: true });
    socket.once('error', end);
    socket.once('close', end);
    await once(socket, 'connect', { signal: bounded });
    checkingOwner = true;
    if (owner.kind === 'container') await verifyContainer(owner, instance, target, runDocker);
    else await verifyGroup(socket, instance, bounded, readGroup, retry, checkLeader, platform);
    bounded.throwIfAborted();
    return socket;
  } catch (error) {
    socket?.destroy();
    if (socketEnded.signal.aborted) throw socketEnded.signal.reason;
    if (checkingOwner && bounded.reason?.name === 'TimeoutError') {
      throw Object.assign(error, { ownerUnverified: true });
    }
    if (socket && !checkingOwner) throw Object.assign(error, { connectionFailed: true });
    throw error;
  } finally {
    socket?.off('error', end);
    socket?.off('close', end);
  }
}
