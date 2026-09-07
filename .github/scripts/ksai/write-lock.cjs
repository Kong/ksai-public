'use strict';

const { randomBytes } = require('node:crypto');
const { positive } = require('./marker.cjs');
const { pagedProbe } = require('./pages.cjs');
const { asAlert } = require('../lib/select-arm.cjs');
const { scrub } = require('./plan.cjs');

const LOCK_PREFIX = '<!-- ksai-write-lock:';
const LOCK_SHAPE = /^<!-- ksai-write-lock:([A-Za-z0-9_.:-]{1,200}):(live|report):(held|done):([a-f0-9]{16}) -->$/m;
const LOCK_PROSE =
  'Updating the implementation report. This comment is here only to stop two runs writing that report at once, and it is removed as soon as the update lands.';

const lockNote = (triggerPhrase) => asAlert('NOTE', scrub(LOCK_PROSE, { triggerPhrase }));
const LOCK_TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const MUTATION_PAUSE_MS = 1_000;
const PER_PAGE = 100;
const STALE_LOCK_MS = 361 * 60_000;

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function tickets({ issues, owner, repo, issueNumber, accept }) {
  const found = [];
  const probe = await pagedProbe({
    perPage: PER_PAGE,
    maxPages: MAX_PAGES,
    fetchPage: async (page) => {
      const response = await issues.listComments({ owner, repo, issue_number: issueNumber, per_page: PER_PAGE, page });
      return response?.data;
    },
    take: (comment) => {
      const matched = LOCK_SHAPE.exec(String(comment?.body ?? ''));
      if (matched && accept(comment)) {
        found.push({ ...comment, lock_owner: matched[1], lock_kind: matched[2], lock_state: matched[3] });
      }
    },
  });
  if (probe.threw) return { error: `the write-report mutation lock lookup failed (${probe.failed})` };
  if (!probe.listed || !probe.complete) return { error: 'the write-report mutation lock lookup was incomplete' };
  return { found };
}

async function discard({ issues, owner, repo, commentId, sleep }) {
  let failure = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await issues.deleteComment({ owner, repo, comment_id: commentId });
      return '';
    } catch (error) {
      if (Number(error?.status) === 404) return '';
      failure = error.message;
    }
    await sleep(MUTATION_PAUSE_MS);
  }
  return failure;
}

async function withIssueLock({
  github,
  owner,
  repo,
  issueNumber,
  lockOwner,
  lockKind,
  recoverKinds = [],
  accept,
  task,
  sleep = pause,
  now = Date.now,
  timeoutMs = LOCK_TIMEOUT_MS,
  triggerPhrase = null,
}) {
  const issues = github?.rest?.issues;
  if (!issues?.createComment || !issues?.listComments || !issues?.updateComment || !issues?.deleteComment) {
    return { error: 'the write-report mutation lock API is unavailable' };
  }
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(String(lockOwner ?? ''))) {
    return { error: 'the write-report mutation lock owner is invalid' };
  }
  if (!['live', 'report'].includes(lockKind)) return { error: 'the write-report mutation lock kind is invalid' };
  const nonce = randomBytes(8).toString('hex');
  const note = lockNote(triggerPhrase);
  const lockBody = `${note}\n\n${LOCK_PREFIX}${lockOwner}:${lockKind}:held:${nonce} -->`;
  const doneBody = `${note}\n\n${LOCK_PREFIX}${lockOwner}:${lockKind}:done:${nonce} -->`;
  let ticket;
  try {
    ticket = (await issues.createComment({ owner, repo, issue_number: issueNumber, body: lockBody })).data;
  } catch (error) {
    return { error: `the write-report mutation lock could not be created (${error.message})` };
  }
  const ticketId = positive(ticket?.id);
  if (ticketId === null || ticket?.body !== lockBody || !accept(ticket)) {
    if (ticketId !== null) await discard({ issues, owner, repo, commentId: ticketId, sleep });
    return { error: 'the write-report mutation lock could not be verified' };
  }
  await sleep(MUTATION_PAUSE_MS);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const listed = await tickets({ issues, owner, repo, issueNumber, accept });
    if (listed.error) {
      await discard({ issues, owner, repo, commentId: ticketId, sleep });
      return listed;
    }
    const ordered = listed.found.sort((left, right) => Number(left.id) - Number(right.id));
    const winner = ordered[0];
    if (positive(winner?.id) === ticketId) {
      let value;
      let thrown;
      try {
        value = await task();
      } catch (error) {
        thrown = error;
      }
      await sleep(MUTATION_PAUSE_MS);
      let completed = false;
      try {
        const marked = await issues.updateComment({ owner, repo, comment_id: ticketId, body: doneBody });
        completed = marked?.data?.body === doneBody;
      } catch {
        completed = false;
      }
      await sleep(MUTATION_PAUSE_MS);
      const releaseError = await discard({ issues, owner, repo, commentId: ticketId, sleep });
      if (thrown) throw thrown;
      return { value, releaseError: completed ? '' : releaseError, releasePending: completed && releaseError !== '' };
    }
    if (winner?.lock_state === 'done') {
      await discard({ issues, owner, repo, commentId: winner.id, sleep });
      await sleep(MUTATION_PAUSE_MS);
      continue;
    }
    if (winner?.lock_owner === lockOwner && recoverKinds.includes(winner?.lock_kind)) {
      await discard({ issues, owner, repo, commentId: winner.id, sleep });
      await sleep(MUTATION_PAUSE_MS);
      continue;
    }
    const createdAt = Date.parse(String(winner?.created_at ?? ''));
    if (Number.isFinite(createdAt) && now() - createdAt > STALE_LOCK_MS) {
      await discard({ issues, owner, repo, commentId: winner.id, sleep });
    }
    await sleep(MUTATION_PAUSE_MS);
  }
  await discard({ issues, owner, repo, commentId: ticketId, sleep });
  return { error: 'the write-report mutation lock did not become available' };
}

module.exports = {
  lockNote,
  LOCK_PREFIX,
  LOCK_SHAPE,
  LOCK_TIMEOUT_MS,
  MUTATION_PAUSE_MS,
  STALE_LOCK_MS,
  withIssueLock,
};
