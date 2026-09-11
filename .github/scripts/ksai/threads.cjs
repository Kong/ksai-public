'use strict';

const { counted, plural } = require('../lib/text.cjs');

const PER_PAGE = 50;
const MAX_PAGES = 10;

const REPLY_SEARCH_DEPTH = 30;

const MAX_ANSWERABLE = 30;

const MAX_REPLY_CHARS = 1000;

const THREAD_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: ${PER_PAGE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            root: comments(first: 1) {
              nodes { databaseId author { login } body createdAt updatedAt lastEditedAt }
            }
            recent: comments(last: ${REPLY_SEARCH_DEPTH}) {
              totalCount
              nodes { databaseId author { login } body createdAt updatedAt lastEditedAt replyTo { databaseId } }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ($thread: ID!, $cursor: String) {
    node(id: $thread) {
      ... on PullRequestReviewThread {
        comments(first: ${PER_PAGE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { databaseId author { login } body createdAt updatedAt lastEditedAt replyTo { databaseId } }
        }
      }
    }
  }
`;

const { markerOf } = require('./marker.cjs');
const { isOwnLogin, ownUnedited, wasEdited } = require('./approval.cjs');

const LOCK_KIND = 'thread-locked';

const UNLOCK_KIND = 'thread-unlocked';

const AGREED_KIND = 'thread-agreed';

const UNCLEAR_KIND = 'thread-unclear';

const PENDING = 'pending';

const ANSWERED = 'answered';

const DISPUTED = 'disputed';

const LOCKED = 'locked';

const UNLOCKED = 'unlocked';

const UNSEEN = 'unseen';

const WORKABLE = Object.freeze([PENDING, UNLOCKED]);

const { NUMBER_SHAPE } = require('./context.cjs');
const { resolvePullTarget } = require('./pull.cjs');

const shapeComment = (comment) => ({
  login: String(comment?.author?.login ?? ''),
  body: String(comment?.body ?? ''),
  commentId: Number.isInteger(comment?.databaseId) ? comment.databaseId : null,
  created_at: String(comment?.createdAt ?? ''),
  updated_at: String(comment?.updatedAt ?? ''),
  ...(comment && Object.hasOwn(comment, 'lastEditedAt') ? { last_edited_at: comment.lastEditedAt } : {}),
});

async function readThreads({ github = null, owner = null, repo = null, prNumber = null, maxPages = MAX_PAGES } = {}) {
  if (typeof github?.graphql !== 'function') return { error: 'no GraphQL-capable GitHub client was passed' };
  const number = String(prNumber ?? '');
  if (!NUMBER_SHAPE.test(number)) return { error: `\`${number}\` is not a pull request number` };

  const threads = [];
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await github.graphql(THREAD_QUERY, { owner, repo, number: Number(number), cursor });
    } catch (error) {
      return { error: `could not read the review threads on #${number}: ${error.message}` };
    }
    const page_ = data?.repository?.pullRequest?.reviewThreads;
    if (!page_?.nodes) return { error: `${owner}/${repo}#${number} returned no review threads on page ${page}` };

    for (const node of page_.nodes) {
      const root = shapeComment(node?.root?.nodes?.[0]);
      const total = Number.isInteger(node?.recent?.totalCount) ? node.recent.totalCount : null;
      const following = (node?.recent?.nodes ?? [])
        .filter((comment) => comment?.replyTo != null)
        .map((comment) => shapeComment(comment));
      threads.push({
        id: String(node?.id ?? ''),
        resolved: node?.isResolved === true,
        outdated: node?.isOutdated === true,
        path: String(node?.path ?? ''),
        line: Number.isInteger(node?.line) ? node.line : null,
        rootCommentId: root.commentId,
        truncated: total === null || total > REPLY_SEARCH_DEPTH + 1,
        commentCount: total,
        comments: [root, ...following],
      });
    }

    if (!page_.pageInfo?.hasNextPage) return { threads };
    cursor = page_.pageInfo.endCursor;
  }

  return {
    error:
      `${owner}/${repo}#${number} has more than ${maxPages * PER_PAGE} review threads, so this cannot tell ` +
      'which are still open. Answering only the ones it could see would report the review as addressed.',
  };
}

async function readCompleteThread({ github, thread, maxPages = MAX_PAGES }) {
  const following = [];
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      data = await github.graphql(THREAD_COMMENTS_QUERY, { thread: thread.id, cursor });
    } catch (error) {
      return { error: `could not read every reply in review thread ${thread.id}: ${error.message}` };
    }
    const comments = data?.node?.comments;
    if (!comments?.nodes) return { error: `review thread ${thread.id} returned no comments on page ${page}` };
    following.push(
      ...comments.nodes.filter((comment) => comment?.replyTo != null).map((comment) => shapeComment(comment)),
    );
    if (!comments.pageInfo?.hasNextPage) {
      return {
        thread: {
          ...thread,
          truncated: false,
          commentCount: following.length + 1,
          comments: [thread.comments[0], ...following],
        },
      };
    }
    cursor = comments.pageInfo.endCursor;
  }
  return {
    error:
      `review thread ${thread.id} has more than ${maxPages * PER_PAGE} comments, so its complete lifecycle ` +
      'cannot be trusted.',
  };
}

function ownAnswer(thread, botLogin) {
  const answers = (thread?.comments ?? []).slice(1);
  let index = -1;
  let marker = null;
  for (const [at, comment] of answers.entries()) {
    if (!ownUnedited(comment, botLogin)) continue;
    const kind = markerOf(comment?.body)?.kind ?? null;
    const response = answers
      .slice(index + 1, at)
      .findLast((candidate) => !isOwnLogin(candidate?.login, botLogin));
    if (response && wasEdited(response) && kind !== LOCK_KIND && kind !== UNCLEAR_KIND) continue;
    index = at;
    marker = kind;
  }
  return { answers, index, marker };
}

function latestResponseWasEdited(thread, botLogin) {
  const { answers, index } = ownAnswer(thread, botLogin);
  const responses = answers.slice(index + 1).filter((comment) => !isOwnLogin(comment?.login, botLogin));
  return responses.length > 0 && wasEdited(responses.at(-1));
}

function threadState(thread, { botLogin = null } = {}) {
  const { answers, index, marker } = ownAnswer(thread, botLogin);
  if (index === -1) return thread?.truncated === true ? UNSEEN : PENDING;
  if (marker === LOCK_KIND) return LOCKED;
  if (index < answers.length - 1) return DISPUTED;
  return marker === UNLOCK_KIND ? UNLOCKED : ANSWERED;
}

const inState = (threads, wanted, botLogin) =>
  (threads ?? []).filter((thread) => !thread?.resolved && wanted.includes(threadState(thread, { botLogin })));

function workableThreads(threads, { botLogin = null } = {}) {
  return inState(threads, WORKABLE, botLogin);
}

function disputedThreads(threads, { botLogin = null } = {}) {
  return inState(threads, [DISPUTED], botLogin);
}

function lockedThreads(threads, { botLogin = null } = {}) {
  return inState(threads, [LOCKED], botLogin);
}

function pendingThreads(threads, { botLogin = null } = {}) {
  return (threads ?? []).filter((thread) => {
    if (thread?.resolved) return false;
    const answers = (thread?.comments ?? []).slice(1);
    return !answers.some((comment) => ownUnedited(comment, botLogin));
  });
}

function threadByRoot(threads, rootCommentId) {
  const wanted = Number(rootCommentId);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  return (threads ?? []).find((thread) => thread?.rootCommentId === wanted) ?? null;
}

async function hydrateScopedThread({ github, threads, threadRootId }) {
  const scoped = threadByRoot(threads, threadRootId);
  if (scoped?.truncated !== true) return { threads };
  const complete = await readCompleteThread({ github, thread: scoped });
  if (complete.error) return { error: complete.error };
  return { threads: threads.map((thread) => (thread === scoped ? complete.thread : thread)) };
}

function selectThread(threads, { threadRootId = null, core = null, botLogin = null, allowLocked = false, counts = { total: 0, resolved: 0, disputed: 0, scope: '' } } = {}) {
  const thread = threadByRoot(threads, threadRootId);
  const state = thread ? threadState(thread, { botLogin }) : null;

  let error = '';
  if (!thread) {
    error =
      `no review thread on this pull request opens with comment ${String(threadRootId ?? '')}. The thread ` +
      'this was written in may have been deleted since.';
  } else if (thread.resolved) {
    error =
      'the review thread this was written in is resolved. Reopen it and ask again, or ask on the pull ' +
      "request's own conversation to have every open thread answered.";
  } else if (state === UNSEEN) {
    error =
      'the review thread this was written in has more replies than this selection could inspect, so its ' +
      'lock state cannot be trusted.';
  } else if (allowLocked === true && state !== LOCKED) {
    error = 'the review thread this was written in is not locked, so there is nothing to release.';
  } else if (state === LOCKED && allowLocked !== true) {
    error = 'the review thread this was written in is locked. Write `unlock` in that thread to release it.';
  } else if (
    (state === DISPUTED || (state === LOCKED && allowLocked === true)) &&
    latestResponseWasEdited(thread, botLogin)
  ) {
    error =
      'the newest human reply in this review thread was edited, so it cannot decide whether work may ' +
      'continue. Leave a new unedited reply and ask again.';
  } else if (thread.truncated === true) {
    core?.warning?.(
      `this thread has more than ${REPLY_SEARCH_DEPTH} replies, so this could not see whether an older reply of ` +
        'its own is already there. It is answered anyway, because it was asked for by name.',
    );
  }

  const others = error === '' ? pendingThreads(threads, { botLogin }).filter((one) => one !== thread).length : 0;
  return {
    ...counts,
    pending: error === '' ? [thread] : [],
    deferred: others,
    lockedScope: thread?.resolved !== true && state === LOCKED,
    disputedScope: thread?.resolved !== true && state === DISPUTED,
    error,
  };
}

function selectThreads(threads, { botLogin = null, guidance = null, core = null, threadRootId = null, allowLocked = false, answerDisputed = false } = {}) {
  const all = threads ?? [];
  const counts = {
    total: all.length,
    resolved: all.filter((thread) => thread?.resolved).length,
    disputed: disputedThreads(all, { botLogin }).length,
    scope: String(guidance ?? '').trim(),
  };
  if (String(threadRootId ?? '').trim() !== '') {
    return selectThread(all, { threadRootId, core, botLogin, allowLocked, counts });
  }
  const unanswered = answerDisputed === true
    ? inState(all, [...WORKABLE, DISPUTED], botLogin)
    : workableThreads(all, { botLogin });
  const open = unanswered.filter((thread) => Number.isInteger(thread?.rootCommentId) && thread.rootCommentId > 0);
  const unanswerable = unanswered.length - open.length;
  if (unanswerable > 0) {
    core?.warning?.(
      `Left out: ${counted(unanswerable, 'open review thread')} reporting no comment to reply to, so nothing ` +
        'there can be answered. A reply has to address the comment that opened the thread; a loose pull request ' +
        'comment would not mark it answered.',
    );
  }
  const unseen = inState(all, [UNSEEN], botLogin).length;
  if (unseen > 0) {
    core?.warning?.(
      `${unseen} of the open threads ${plural(unseen, 'has', 'have')} more than ${REPLY_SEARCH_DEPTH} replies, so this could not see ` +
        'whether it has already replied there or been asked to hold off. They are left alone; reply in one to ' +
        'have it answered by name.',
    );
  }
  const pending = open.slice(0, MAX_ANSWERABLE);
  return {
    ...counts,
    pending,
    deferred: open.length - pending.length,
    lockedScope: false,
    disputedScope: false,
    error: '',
  };
}

async function resolveFixPhase({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  botLogin = null,
  guidance = null,
  threadRootId = null,
  allowLocked = false,
} = {}) {
  if (!String(botLogin ?? '').trim()) {
    return { error: 'no bot_login was passed, so review thread state cannot be trusted' };
  }
  const target = await resolvePullTarget({ github, core, owner, repo, prNumber, noun: 'review threads to answer' });
  if (target.error) return { error: target.error };
  const { ref, baseRef } = target;
  const number = String(target.prNumber);

  const read = await readThreads({ github, owner, repo, prNumber: number });
  if (read.error) return { error: read.error };

  const hydrated = await hydrateScopedThread({ github, threads: read.threads, threadRootId });
  if (hydrated.error) return { error: hydrated.error };
  const { threads } = hydrated;

  const { error: refused, ...selected } = selectThreads(threads, {
    botLogin,
    guidance,
    core,
    threadRootId,
    allowLocked,
  });
  if (refused) return { error: refused };
  core?.info?.(
    `#${number} on ${ref}: ${selected.pending.length} of ${counted(selected.total, 'review thread')} offered ` +
      `(${selected.resolved} resolved${selected.deferred ? `, ${selected.deferred} deferred past the bound` : ''})` +
      `${threadRootId ? `, scoped to the thread opened by comment ${String(threadRootId)}` : ''}` +
      `${selected.scope ? `, scoped to: ${selected.scope}` : ''}.`,
  );
  return {
    phase: 'fix',
    ref,
    baseRef,
    held: target.held,
    prNumber: target.prNumber,
    pending: selected.pending,
    threads,
    deferred: selected.deferred,
    total: selected.total,
    resolved: selected.resolved,
    disputed: selected.disputed,
    scope: selected.scope,
    target,
  };
}

module.exports = {
  PER_PAGE,
  MAX_ANSWERABLE,
  MAX_REPLY_CHARS,
  THREAD_QUERY,
  THREAD_COMMENTS_QUERY,
  AGREED_KIND,
  ANSWERED,
  DISPUTED,
  LOCKED,
  LOCK_KIND,
  PENDING,
  UNLOCKED,
  UNLOCK_KIND,
  UNCLEAR_KIND,
  readThreads,
  isOwnLogin,
  latestResponseWasEdited,
  disputedThreads,
  lockedThreads,
  hydrateScopedThread,
  pendingThreads,
  threadState,
  workableThreads,
  selectThreads,
  resolveFixPhase,
};
