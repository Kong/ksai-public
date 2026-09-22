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
      last = { why: said.why };
      if (said.status !== undefined && said.status < 500 && said.status !== 429) return last;
      continue;
    }
    const done = Array.isArray(said.answer?.done) ? said.answer.done : [];
    if (done.length < effects.length) {
      return { why: `the control plane did ${done.length} of ${effects.length} effects`, done };
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
  const sendRaw = async (effect) => {
    const asked = { ...effect, id: name(effect) };
    const said = await askControlPlane([asked], { env, fetch, timeout, secret, pause });
    if (said.why) throw new Error(said.why);
    const [done] = said.done;
    if (text(done?.refused) !== '') throw new Error(done.refused);
    return done ?? {};
  };
  const send = async (effect) => {
    const done = await sendRaw(effect);
    return { id: Number(done.comment ?? 0) || null, review: Number(done.review ?? 0) || null };
  };
  return {
    comment: ({ number, body }) => send({ kind: 'comment', number: Number(number), body: String(body) }),
    editComment: ({ comment, body }) => send({ kind: 'edit_comment', comment: Number(comment), body: String(body) }),
    deleteComment: ({ comment }) => send({ kind: 'delete_comment', comment: Number(comment) }),
    react: ({ comment, on, content }) =>
      send({ kind: 'react', comment: Number(comment), on: String(on), content: String(content) }),
    review: ({ number, body, event, commit = '', comments = [] }) => send({
      kind: 'review',
      number: Number(number),
      body: String(body),
      event: String(event),
      ...(text(commit) === '' ? {} : { commit: text(commit) }),
      ...(comments.length === 0 ? {} : { comments }),
    }),
    replyInThread: ({ number, comment, body }) =>
      send({ kind: 'reply_thread', number: Number(number), comment: Number(comment), body: String(body) }),
    resolveThread: ({ thread }) => send({ kind: 'resolve_thread', thread: String(thread) }),
    setDescription: ({ number, body }) =>
      send({ kind: 'set_description', number: Number(number), body: String(body) }),
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
