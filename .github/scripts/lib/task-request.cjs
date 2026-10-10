'use strict';

const { createHash } = require('node:crypto');

const controlPlane = require('./control-plane.cjs');

const ARCHIVE_PATH = '/v1/run/tasks/request';
const ARCHIVE_VERSION = 1;
const NOT_RECORDED = 'not_recorded_legacy';
const UNKEPT = 'this run reads no kept requests';
const TIMEOUT = 10_000;
const TASK_JOB = 'run';
const LEGACY = 'legacy';
const UNSERVED = new Set([404, 405, 501]);
const KINDS = Object.freeze(['issue', 'review', 'submitted_review']);
const REVIEW_STATES = Object.freeze(['approved', 'changes_requested', 'commented']);
const EDIT_STATES = Object.freeze(['unedited', 'edited', 'unknown']);
const ACCOUNT_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{0,8}[1-9])?Z$/;
const HEX32 = /^[0-9a-f]{32}$/;
const COMMENT_ID = /^[1-9][0-9]{0,19}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}|[A-Za-z0-9-]{0,30}\[bot\])$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class TaskRequestRefused extends Error {
  constructor(why) {
    super(`the request this run was accepted for is unavailable: ${why}`);
    this.name = 'TaskRequestRefused';
    this.status = 'archive';
  }
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unsigned = (value) => Number.isSafeInteger(value) && value >= 0;
const named = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

function closed(value, required, optional, where) {
  if (!plain(value)) throw new TaskRequestRefused(`its ${where} is not an object`);
  const extra = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key));
  if (extra.length) throw new TaskRequestRefused(`its ${where} carries fields this runner does not know: ${extra.join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TaskRequestRefused(`its ${where} lacks ${missing.join(', ')}`);
  return value;
}

function exactBytes(encoded, digest, where) {
  if (typeof encoded !== 'string' || !BASE64.test(encoded) || !HEX64.test(String(digest))) {
    throw new TaskRequestRefused(`its ${where} is not kept as bytes and a digest`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || sha256(bytes) !== digest) {
    throw new TaskRequestRefused(`its ${where} does not match the digest it was kept under`);
  }
  return bytes;
}

const before = (at, accepted) => UTC.test(String(at)) && Date.parse(at) <= Date.parse(accepted);

function reviewOf(held, accepted) {
  const review = closed(held, ['state', 'submitted_at', 'commit_id'], [], 'original review');
  if (!REVIEW_STATES.includes(review.state) || !before(review.submitted_at, accepted) || !COMMIT.test(String(review.commit_id))) {
    throw new TaskRequestRefused('its original review names no state, submission or commit this runner reads');
  }
  return { state: review.state, submitted_at: review.submitted_at, commit_id: review.commit_id };
}

const idOf = (value) => (typeof value === 'string' && COMMENT_ID.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null);

function postedOf(comment, id, accepted) {
  if (!before(comment.created_at, accepted) || !EDIT_STATES.includes(comment.edit_state)) {
    throw new TaskRequestRefused('its original comment names no posting time or edit state this runner reads');
  }
  const replyTo = Object.hasOwn(comment, 'in_reply_to_id') ? idOf(comment.in_reply_to_id) : undefined;
  if (replyTo === null || replyTo === id) throw new TaskRequestRefused('its original comment answers no comment this runner reads');
  return { created_at: comment.created_at, edit_state: comment.edit_state, ...(replyTo === undefined ? {} : { in_reply_to_id: replyTo }) };
}

function commentOf(held, accepted) {
  if (held === undefined) return null;
  const kind = held?.kind;
  const shaped = kind === 'submitted_review' ? [['review'], []] : [['created_at', 'edit_state'], kind === 'review' ? ['in_reply_to_id'] : []];
  const comment = closed(held, ['id', 'kind', 'actor', 'actor_id', 'actor_type', 'text', 'text_sha256', 'trust', ...shaped[0]], shaped[1], 'original comment');
  const id = idOf(comment.id);
  if (id === null || !KINDS.includes(kind)) throw new TaskRequestRefused('its original comment names no comment this runner reads');
  if (!LOGIN.test(String(comment.actor)) || !Number.isSafeInteger(comment.actor_id) || comment.actor_id <= 0 || !ACCOUNT_TYPE.test(String(comment.actor_type))) {
    throw new TaskRequestRefused('its original comment names no author');
  }
  if (typeof comment.text !== 'string' || !HEX64.test(String(comment.text_sha256)) || sha256(Buffer.from(comment.text, 'utf8')) !== comment.text_sha256) {
    throw new TaskRequestRefused('its original comment does not match the digest it was kept under');
  }
  if (comment.trust !== 'untrusted') throw new TaskRequestRefused('its original comment is not kept as untrusted');
  return {
    id, kind, user: { login: comment.actor, id: comment.actor_id, type: comment.actor_type }, text: comment.text, digest: comment.text_sha256,
    ...(kind === 'submitted_review' ? { review: reviewOf(comment.review, accepted) } : { posted: postedOf(comment, id, accepted) }),
  };
}

function contentOf(held, where) {
  if (held === undefined) return null;
  const content = closed(held, ['json_base64', 'sha256', 'trust'], [], where);
  if (content.trust !== 'untrusted_content') throw new TaskRequestRefused(`its ${where} is not kept as untrusted content`);
  return exactBytes(content.json_base64, content.sha256, where);
}

function recordOf(dispatched) {
  let record = null;
  try {
    record = JSON.parse(dispatched.toString('utf8'));
  } catch {
    throw new TaskRequestRefused('its dispatch is not the record this run was dispatched with');
  }
  if (!plain(record)) throw new TaskRequestRefused('its dispatch is not the record this run was dispatched with');
  const number = Number(String(record.pr || record.issue_number || '').trim());
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : null,
    commentId: String(record.comment_id ?? ''), commentKind: String(record.comment_kind ?? ''),
  };
}

function readyOf(served) {
  const answer = served;
  closed(answer, ['version', 'status', 'task_id', 'request_id', 'engine', 'flow', 'retry_generation', 'request', 'dispatch'], [], 'answer');
  if (!HEX32.test(String(answer.task_id)) || !named(answer.request_id) || !named(answer.engine) || !named(answer.flow) || !unsigned(answer.retry_generation)) {
    throw new TaskRequestRefused('it names no task, request, engine, flow or generation');
  }
  const request = closed(answer.request, ['digest', 'accepted_at', 'spec', 'spec_sha256'], ['comment', 'workflow', 'source'], 'request');
  const dispatch = closed(answer.dispatch, ['record_id', 'job', 'generation', 'accepted_at', 'digest', 'spec', 'spec_sha256'], [], 'dispatch');
  if (!HEX64.test(String(request.digest)) || !STAMP.test(String(request.accepted_at))) throw new TaskRequestRefused('its request names no digest or acceptance');
  if (!HEX32.test(String(dispatch.record_id)) || !named(dispatch.job) || !unsigned(dispatch.generation) || !HEX64.test(String(dispatch.digest)) || !STAMP.test(String(dispatch.accepted_at))) {
    throw new TaskRequestRefused('its dispatch names no record, job, generation, digest or acceptance');
  }
  exactBytes(request.spec, request.spec_sha256, 'original request');
  const dispatched = exactBytes(dispatch.spec, dispatch.spec_sha256, 'dispatch');
  return {
    task: answer.task_id, request: answer.request_id, engine: answer.engine, flow: answer.flow, generation: answer.retry_generation,
    digest: request.digest, comment: commentOf(request.comment, request.accepted_at),
    workflow: contentOf(request.workflow, 'original workflow'), source: contentOf(request.source, 'original source'),
    dispatch: { record: dispatch.record_id, job: dispatch.job, generation: dispatch.generation, digest: dispatch.digest, ...recordOf(dispatched) },
  };
}

function classified(answer) {
  if (!plain(answer) || answer.version !== ARCHIVE_VERSION) {
    throw new TaskRequestRefused('the control plane answered in a form this runner does not read');
  }
  if (answer.status === 'unavailable') {
    if (answer.reason === NOT_RECORDED && Object.keys(answer).length === 3) return { legacy: 'this run was accepted before its request was kept' };
    throw new TaskRequestRefused('the control plane answered unavailable for a reason this runner does not read');
  }
  if (answer.status !== 'ready') throw new TaskRequestRefused('the control plane named no state this runner reads');
  return { ready: readyOf(answer) };
}

async function readTaskRequest({
  env = process.env, endpoint = env.KSAI_TASK_REQUEST_ENDPOINT, job = TASK_JOB, link = '', fetch = globalThis.fetch, timeout = TIMEOUT, secret = controlPlane.mask,
  retrying = controlPlane.answeredRetrying,
}) {
  const asking = String(endpoint ?? '').trim();
  if (asking === '') return { legacy: '' };
  const reached = await controlPlane.reachedFor({ env, endpoint: asking, fetch, timeout, secret, holds: controlPlane.holdsFor(timeout) });
  if (reached.why) throw new TaskRequestRefused(reached.why);
  const said = await retrying(fetch, `${reached.base}${ARCHIVE_PATH}`, { token: reached.token, body: JSON.stringify(link ? { job, link } : { job }), timeout });
  if (UNSERVED.has(said.status)) return { legacy: 'the control plane keeps no requests yet' };
  if (said.why) throw new TaskRequestRefused(said.why);
  return classified(said.answer);
}

const seenOf = (answer) => (answer.ready ? answer.ready.digest : answer.legacy ? LEGACY : '');

const retriedOf = (answer) => Boolean(answer.ready) && answer.ready.dispatch.generation > 0 && answer.ready.dispatch.generation === answer.ready.generation;

async function heldByLink({ seen, ...asking }) {
  const read = String(seen ?? '').trim();
  if (read === '') return;
  const held = seenOf(await readTaskRequest(asking));
  if (held !== read) {
    throw new TaskRequestRefused(`the run context read ${read === LEGACY ? 'a request accepted before requests were kept' : `request ${read}`} and this link was accepted for ${held === LEGACY ? 'one that was never kept' : held ? `request ${held}` : 'none'}`);
  }
}

const LAST_EDITED = Object.freeze({ unedited: () => null, edited: (at) => at, unknown: () => '' });

function fromArchive(ready, kind, id, repository) {
  const held = ready.comment;
  if (!held) throw new TaskRequestRefused(`this run was dispatched for ${kind} #${id} and accepted for no comment`);
  if (held.kind !== kind || held.id !== id) {
    throw new TaskRequestRefused(`this run was dispatched for ${kind} #${id} and accepted for ${held.kind} #${held.id}`);
  }
  if (ready.dispatch.number === null) throw new TaskRequestRefused(`its dispatch names no thread for ${kind} #${id}`);
  const { commentId, commentKind } = ready.dispatch;
  if ((commentId !== '' && commentId !== String(id)) || (commentKind !== '' && commentKind !== kind)) {
    throw new TaskRequestRefused(`its dispatch names ${commentKind || kind} #${commentId || id} and its request was accepted for ${kind} #${id}`);
  }
  const where = kind === 'issue'
    ? { issue_url: `https://api.github.com/repos/${repository}/issues/${ready.dispatch.number}` }
    : { pull_request_url: `https://api.github.com/repos/${repository}/pulls/${ready.dispatch.number}` };
  const said = { id, body: held.text, user: { ...held.user }, ...where };
  if (held.review) return { ...said, ...held.review };
  const { created_at: at, edit_state: state, ...replying } = held.posted;
  return { ...said, ...replying, created_at: at, updated_at: at, last_edited_at: LAST_EDITED[state](at) };
}

const readFromArchive = (seen) => HEX64.test(String(seen ?? '').trim());

const noticed = (said) => console.log(`::notice title=ksai::${said}, so the comment is read as it stands now`);

function requestedReaders({ live, read, repository, note = noticed, keptOnly = false }) {
  let asked = null;
  const archive = () => {
    asked ??= read();
    return asked;
  };
  const through = (kind, liveRead) => async (...args) => {
    const answer = await archive();
    if (Object.hasOwn(answer, 'legacy')) {
      if (keptOnly) throw new TaskRequestRefused(`a retry repeats the request the control plane kept, and ${answer.legacy || UNKEPT}`);
      if (answer.legacy) note(answer.legacy);
      return liveRead(...args);
    }
    return fromArchive(answer.ready, kind, Number(args.at(-1)), repository);
  };
  return {
    getIssueComment: through('issue', live.getIssueComment),
    getReviewComment: through('review', live.getReviewComment),
    getSubmittedReview: through('submitted_review', live.getSubmittedReview),
    seen: async () => (asked ? seenOf(await asked) : ''),
    retried: async () => (asked ? retriedOf(await asked) : false),
    initialPending: async () => {
      const ready = asked ? (await asked).ready : null;
      return Boolean(ready) && ready.flow === 'pending' && ready.workflow === null && ready.generation === 0 &&
        ready.dispatch.job === 'run' && ready.dispatch.generation === 0;
    },
  };
}

module.exports = {
  ARCHIVE_PATH, ARCHIVE_VERSION, LEGACY, NOT_RECORDED, TaskRequestRefused, classified, heldByLink, readFromArchive, readTaskRequest, requestedReaders,
};
