'use strict';


const { createHash } = require('node:crypto');

const { DEFAULT_TIMEOUT, answered, mask, reachedFor, usingControlPlane } = require('./control-plane.cjs');

const API_VERSION = 'effects/v1';
const EFFECTS = '/v1/run/effects';
const EFFECT_ATTEMPTS = 3;

const backoffFor = (tries) => 2 ** tries * 1000;

const holdsFor = (timeout) => Array.from({ length: EFFECT_ATTEMPTS }, (_, tries) => timeout + (tries > 0 ? backoffFor(tries) : 0))
  .reduce((all, one) => all + one, 0);

const held = (ms) => new Promise((done) => { setTimeout(done, ms); });

const text = (value) => String(value ?? '').trim();

async function askControlPlane(effects, { env, fetch, timeout, secret, pause = held }) {
  const reached = await reachedFor({ env, fetch, timeout, secret, holds: holdsFor(timeout) });
  if (reached.why) return reached;
  const body = JSON.stringify({ api_version: API_VERSION, effects });
  let last = { why: 'the control plane was asked nothing' };
  for (let tries = 0; tries < EFFECT_ATTEMPTS; tries += 1) {
    if (tries > 0) await pause(backoffFor(tries));
    const said = await answered(fetch, `${reached.base}${EFFECTS}`, { token: reached.token, body, timeout });
    if (said.why) {
      last = { why: said.why, unavailable: said.status === undefined || said.status >= 500 || said.status === 429 };
      if (said.status !== undefined && said.status < 500 && said.status !== 429) return last;
      continue;
    }
    const done = Array.isArray(said.answer?.done) ? said.answer.done : [];
    if (done.length < effects.length) {
      return { why: `the control plane did ${done.length} of ${effects.length} effects`, unavailable: false, done };
    }
    return { done };
  }
  return last;
}

const seen = new Map();

const name = (effect) => {
  const { id, ...what } = effect;
  if (text(id) !== '') return text(id);
  const digest = createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 24);
  const at = seen.get(digest) ?? 0;
  seen.set(digest, at + 1);
  return `${digest}-${at}`;
};

function controlPlaneWriter({ env, fetch, timeout, secret, pause = held }) {
  const rawCopy = async () => {
    throw new Error('the control plane needs structured facts to publish user-facing copy');
  };
  const sendRaw = async (effect) => {
    const asked = { ...effect, id: name(effect) };
    const said = await askControlPlane([asked], { env, fetch, timeout, secret, pause });
    if (said.why) {
      throw Object.assign(new Error(said.why), { cpUnavailable: said.unavailable !== false });
    }
    const [done] = said.done;
    if (text(done?.refused) !== '') throw new Error(done.refused);
    return done ?? {};
  };
  const send = async (effect) => {
    const done = await sendRaw(effect);
    return { id: Number(done.comment ?? 0) || null, review: Number(done.review ?? 0) || null,
      ...(done.updated === true ? { updated: true } : {}) };
  };
  return {
    comment: rawCopy,
    surfaceComment: ({ number, surface }) => send({ kind: 'surface_comment', number: Number(number), surface }),
    noticeComment: ({ number, notice }) => send({ kind: 'notice_comment', number: Number(number), notice }),
    noticeEdit: ({ comment, notice }) => send({ kind: 'notice_edit', comment: Number(comment), notice }),
    editComment: rawCopy,
    deleteComment: ({ comment }) => send({ kind: 'delete_comment', comment: Number(comment) }),
    react: ({ comment, on, content }) =>
      send({ kind: 'react', comment: Number(comment), on: String(on), content: String(content) }),
    review: rawCopy,
    reviewFromFacts: ({ number, review, mode }) => send({
      kind: 'review_publish', number: Number(number), review_facts: review, mode,
    }),
    replyInThread: rawCopy,
    noticeReplyInThread: ({ number, comment, notice }) =>
      send({ kind: 'notice_reply_thread', number: Number(number), comment: Number(comment), notice }),
    runStart: ({ number, start }) => send({ kind: 'run_start_comment', number: Number(number), start }),
    runProgress: ({ number, start }) => send({ kind: 'run_progress_edit', number: Number(number), start }),
    runReportEdit: ({ comment, report }) => send({ kind: 'run_report_edit', comment: Number(comment), report }),
    runReportComment: ({ number, report }) => send({ kind: 'run_report_comment', number: Number(number), report }),
    runResult: ({ number, notice, report, mode }) => send({ kind: 'run_result', number: Number(number),
      ...(notice ? { notice } : { report }), ...(mode ? { mode } : {}) }),
    async runStartCleanup({ number, run }) {
      const said = await sendRaw({ kind: 'run_start_cleanup', number: Number(number), run: String(run) });
      return { changed: said.changed === true };
    },
    reviewNoticeComment: ({ number, report }) => send({ kind: 'review_notice_comment', number: Number(number), report }),
    resolveThread: ({ thread }) => send({ kind: 'resolve_thread', thread: String(thread) }),
    setDescription: rawCopy,
    holdPlan: ({ number, run }) => send({ kind: 'hold_plan', number: Number(number), run: String(run) }),
    async releaseHold({ number }) {
      const said = await sendRaw({ kind: 'release_hold', number: Number(number) });
      return { released: said.released === true };
    },
    async tickStep({ number, title, head }) {
      const said = await sendRaw({ kind: 'tick_step', number: Number(number), step: String(title), commit: String(head) });
      return { changed: said.changed === true, remaining: Number(said.remaining) };
    },
    async openPull(facts) {
      const said = await sendRaw({ kind: 'open_pull', open_pull: facts });
      const prNumber = Number(said.pull ?? 0);
      const prUrl = String(said.pull_url ?? '');
      if (!Number.isInteger(prNumber) || prNumber <= 0 || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(prUrl)) {
        throw new Error('the control plane returned no pull request');
      }
      return { prNumber, prUrl };
    },
    async publishPlan({ number, facts }) {
      const said = await sendRaw({ kind: 'publish_plan', number: Number(number), plan_publish: facts });
      const id = Number(said.comment ?? 0);
      if (!Number.isInteger(id) || id <= 0) throw new Error('the control plane returned no plan offer');
      return { id };
    },
    async releasePlan({ number, facts }) {
      const said = await sendRaw({ kind: 'release_plan', number: Number(number), plan_release: facts });
      if (said.released !== true) throw new Error('the control plane did not release the plan');
      return { released: true, remaining: Number(said.remaining ?? 0) };
    },
    async recordRelease({ number, ref, url }) {
      const said = await sendRaw({ kind: 'record_release', number: Number(number),
        release: { ref: String(ref), url: String(url ?? '') } });
      return { released: said.released === true, changed: said.changed === true };
    },
    async releaseCheckpoint({ number, title, token, notice }) {
      const said = await sendRaw({ kind: 'release_checkpoint', number: Number(number), checkpoint: {
        title: String(title), token: String(token),
      }, notice });
      return { released: said.released === true, remaining: Number(said.remaining ?? 0), at: Number(said.at ?? 0) };
    },
    async acquireReportLock({ number, owner, kind, nonce, recoverLive = false }) {
      const said = await sendRaw({ kind: 'report_lock_acquire', number: Number(number), lock: {
        owner: String(owner), kind: String(kind), nonce: String(nonce), recover_live: recoverLive,
      } });
      return said.acquired === true;
    },
    async releaseReportLock({ number, owner, kind, nonce }) {
      const said = await sendRaw({ kind: 'report_lock_release', number: Number(number), lock: {
        owner: String(owner), kind: String(kind), nonce: String(nonce),
      } });
      return said.released === true;
    },
    async publishTestReview({ number, testReview }) {
      const said = await sendRaw({ kind: 'test_review_publish', number: Number(number), test_review: testReview });
      return { id: Number(said.comment ?? 0) || null, outcome: String(said.outcome ?? 'rejected') };
    },
    async markReady({ node }) {
      const said = await sendRaw({ kind: 'mark_ready', node: String(node) });
      return { id: null, review: null, ready: typeof said.ready === 'boolean' ? said.ready : null };
    },
  };
}

function githubWriter({ github, owner, repo }) {
  const said = (response) => ({ id: Number(response?.data?.id) || null, review: null });
  return {
    async comment({ number, body }) {
      return said(await github.rest.issues.createComment({ owner, repo, issue_number: Number(number), body }));
    },
    async editComment({ comment, body }) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: Number(comment), body });
      return { id: Number(comment), review: null };
    },
    async deleteComment({ comment }) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: Number(comment) });
      return { id: null, review: null };
    },
    async react({ comment, on, content }) {
      const id = Number(comment);
      if (on === 'review_comment') {
        await github.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: id, content });
      } else {
        await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: id, content });
      }
      return { id: null, review: null };
    },
    async review({ number, body, event, commit = '', comments = [] }) {
      const out = await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number: Number(number),
        body,
        event,
        ...(text(commit) === '' ? {} : { commit_id: text(commit) }),
        ...(comments.length === 0 ? {} : { comments }),
      });
      return { id: null, review: Number(out?.data?.id) || null };
    },
    async replyInThread({ number, comment, body }) {
      return said(await github.rest.pulls.createReplyForReviewComment({
        owner, repo, pull_number: Number(number), comment_id: Number(comment), body,
      }));
    },
    async resolveThread({ thread }) {
      await github.graphql(
        'mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }',
        { threadId: String(thread) },
      );
      return { id: null, review: null };
    },
    async setDescription({ number, body }) {
      await github.rest.pulls.update({ owner, repo, pull_number: Number(number), body });
      return { id: null, review: null };
    },
    async markReady({ node }) {
      const out = await github.graphql(
        'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
        { id: String(node) },
      );
      const draft = out?.markPullRequestReadyForReview?.pullRequest?.isDraft;
      return { id: null, review: null, ready: typeof draft === 'boolean' ? !draft : null };
    },
  };
}

/**
 * @param {{
 *   github?: *,
 *   owner?: string,
 *   repo?: string,
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 *   secret?: (token: string) => void,
 *   pause?: (ms: number) => Promise<void>,
 * }} [asked]
 */
function writerFor({ github, owner, repo, env = process.env, fetch = globalThis.fetch,
  timeout = DEFAULT_TIMEOUT, secret = mask, pause = held } = {}) {
  if (usingControlPlane(env)) return controlPlaneWriter({ env, fetch, timeout, secret, pause });
  return githubWriter({ github, owner, repo });
}

module.exports = { API_VERSION, controlPlaneWriter, githubWriter, writerFor };
