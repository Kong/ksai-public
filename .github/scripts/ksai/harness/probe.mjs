import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { checkServerIdentity, connect } from 'node:tls';

import { FAILURES } from './contract.mjs';
import { connectOwned, ownerSignal } from './owner.mjs';

async function responseStatus(socket, probe, signal) {
  let transport = socket;
  const agent = new Agent();
  try {
    if (probe.scheme === 'https') {
      const hostname = new URL(`https://${probe.authority}`).hostname.replace(/^\[|\]$/gu, '');
      transport = connect({
        socket, servername: isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
      });
      transport.on('error', () => transport.destroy());
      await once(transport, 'secureConnect', { signal });
    }
    signal.throwIfAborted();
    Object.assign(agent, { createConnection: () => transport });
    const req = request({ agent, path: probe.target, headers: { Host: probe.authority }, signal });
    const answered = new Promise((resolve, reject) => {
      req.once('response', (response) => resolve(response.statusCode));
      req.once('upgrade', (response) => resolve(response.statusCode));
      req.once('error', reject);
      req.once('close', () => reject(new Error('the probe request closed without an answer')));
    });
    req.end();
    return await answered;
  } finally {
    agent.destroy();
    transport.destroy();
  }
}

export async function probeEndpoint(endpoint, instance, { deadlineAt, signal = null }, {
  now = Date.now, sleep = delay, timeout = ownerSignal, dial = connectOwned, statusOf = responseStatus,
} = {}) {
  const { address, port, owner, probe } = endpoint;
  const stopAt = Math.min(deadlineAt, now() + (probe ? probe.timeout_seconds * 1000 : Infinity));
  const transport = probe ? { ready: false } : undefined;
  let owned = false;
  let unverified = false;
  let status;
  while (now() < stopAt) {
    if (signal?.aborted) break;
    const due = Math.min(stopAt, now() + (probe ? probe.try_seconds * 1000 : Infinity));
    const attempt = timeout(due, signal);
    let socket;
    try {
      socket = await dial(owner, instance, { address, port, deadlineAt: due, signal: attempt });
      owned = true;
      if (!probe) return { owned, failure: null };
      const reply = await statusOf(socket, probe, attempt);
      if (Number.isInteger(reply) && reply >= 100 && reply <= 599 && now() < due) {
        status = reply;
        if (status >= probe.status_min && status <= probe.status_max) return { owned, probe: { ready: true, status }, failure: null };
      }
    } catch (error) {
      if (error.ownerRefused) return { owned: false, ...(probe && { probe: transport }), failure: FAILURES.endpointNotOwned };
      if (error.ownerUnverified) unverified = true;
      else if (!socket && !error.connectionFailed && !attempt.aborted && now() < due) {
        if (owned) break;
        return { owned: false, ...(probe && { probe: transport }), failure: FAILURES.ownerUnreadable };
      }
    } finally {
      socket?.destroy();
    }
    if (!probe || signal?.aborted || now() >= stopAt) break;
    await sleep(Math.min(stopAt - now(), probe.interval_seconds * 1000), undefined, signal ? { signal } : {}).catch((error) => {
      if (!signal?.aborted) throw error;
    });
  }
  const failure = !owned && unverified ? FAILURES.ownerUnreadable
    : now() >= deadlineAt ? FAILURES.probeDeadline : FAILURES.probeFailed;
  return { owned, ...(probe && { probe: Number.isInteger(status) ? { ready: false, status } : transport }), failure };
}
