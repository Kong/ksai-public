'use strict';

const { randomBytes } = require('node:crypto');
const { writerFor } = require('../lib/cp-effects.cjs');
const { LOCK_TIMEOUT_MS, MUTATION_PAUSE_MS } = require('./write-lock.cjs');

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function withControlPlaneLock({ env, fetch, issueNumber, lockOwner, lockKind, recoverKinds = [],
  task, sleep = pause, now = Date.now, timeoutMs = LOCK_TIMEOUT_MS, writer = writerFor({ env, fetch }) }) {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(String(lockOwner ?? ''))) {
    return { error: 'the write-report mutation lock owner is invalid' };
  }
  if (!['live', 'report'].includes(lockKind)) return { error: 'the write-report mutation lock kind is invalid' };
  const nonce = randomBytes(8).toString('hex');
  const lock = { number: issueNumber, owner: lockOwner, kind: lockKind, nonce,
    recoverLive: lockKind === 'report' && recoverKinds.includes('live') };
  const deadline = now() + timeoutMs;
  let acquired = false;
  while (now() < deadline) {
    try {
      acquired = await writer.acquireReportLock(lock);
    } catch (error) {
      return { error: `the write-report mutation lock could not be acquired (${error.message})` };
    }
    if (acquired) break;
    await sleep(MUTATION_PAUSE_MS);
  }
  if (!acquired) return { error: 'the write-report mutation lock did not become available' };

  let value;
  let thrown;
  try {
    value = await task();
  } catch (error) {
    thrown = error;
  }
  let releaseError = '';
  try {
    if (!await writer.releaseReportLock(lock)) releaseError = 'the lease was not held';
  } catch (error) {
    releaseError = error.message;
  }
  if (thrown) throw thrown;
  return { value, releaseError };
}

module.exports = { withControlPlaneLock };
