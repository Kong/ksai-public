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
              nodes { databaseId author { login __typename } body createdAt updatedAt lastEditedAt pullRequestReview { databaseId } }
            }
            recent: comments(last: ${REPLY_SEARCH_DEPTH}) {
              totalCount
              nodes { databaseId author { login __typename } body createdAt updatedAt lastEditedAt replyTo { databaseId } pullRequestReview { databaseId } }
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
          nodes { databaseId author { login __typename } body createdAt updatedAt lastEditedAt replyTo { databaseId } pullRequestReview { databaseId } }
        }
      }
    }
  }
`;

const { markerOf } = require('./marker.cjs');
const { commandOf, editState, isOwnLogin, ownUnedited, wasEdited, UNEDITED } = require('./approval.cjs');
const { commandAuthorized, writeAccessNames } = require('../lib/select-arm.cjs');

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

const { AUTHZ_LOGIN_SHAPE, NUMBER_SHAPE } = require('./context.cjs');
const { resolvePullTarget } = require('./pull.cjs');

const shapeComment = (comment) => ({
  login: String(comment?.author?.login ?? ''),
  actorType: String(comment?.author?.__typename ?? ''),
  body: String(comment?.body ?? ''),
  commentId: Number.isInteger(comment?.databaseId) ? comment.databaseId : null,
  created_at: String(comment?.createdAt ?? ''),
  updated_at: String(comment?.updatedAt ?? ''),
  reviewId: String(comment?.pullRequestReview?.databaseId ?? ''),
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
        reviewId: root.reviewId,
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
      .findLast((candidate) => !isOwnLogin(candidate?.login, botLogin, candidate?.actorType));
    if (response && wasEdited(response) && kind !== LOCK_KIND && kind !== UNCLEAR_KIND) continue;
    index = at;
    marker = kind;
  }
  return { answers, index, marker };
}

function latestResponseWasEdited(thread, botLogin) {
  const { answers, index } = ownAnswer(thread, botLogin);
  const responses = answers.slice(index + 1).filter((comment) => !isOwnLogin(comment?.login, botLogin, comment?.actorType));
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

const REVIEW_ID_SHAPE = /^[1-9][0-9]{0,18}$/;

function reviewScope(threads, reviewId) {
  const wanted = String(reviewId ?? '').trim();
  if (wanted === '') return { threads };
  if (!REVIEW_ID_SHAPE.test(wanted)) return { error: `\`${wanted}\` is not a submitted review id` };
  return { threads: (threads ?? []).filter((thread) => thread?.reviewId === wanted) };
}

function authorizerCore(core) {
  let failure = '';
  return {
    core: {
      debug: (...args) => core?.debug?.(...args),
      error: (...args) => core?.error?.(...args),
      info: (...args) => core?.info?.(...args),
      setFailed: (message) => {
        failure = String(message ?? 'authorization failed');
      },
      setOutput: () => {},
      warning: (...args) => core?.warning?.(...args),
    },
    failure: () => failure,
  };
}

function countComments(threads) {
  return (threads ?? []).reduce(
    (sum, thread) => sum + (Number.isInteger(thread?.commentCount) ? thread.commentCount : (thread?.comments ?? []).length),
    0,
  );
}

async function authorizeThreadContext({
  threads,
  github,
  core,
  owner,
  repo,
  botLogin,
  authorize,
  writeAccess,
  writeAccessCommands,
  triggerPhrase,
  source = 'review-feedback',
  omitted = 0,
}) {
  if ((threads ?? []).length === 0) {
    core?.info?.(
      `Autofix context: source=${source} decision=filter kept=0 ` +
        `omitted=${Number.isInteger(omitted) && omitted > 0 ? omitted : 0}.`,
    );
    return { threads: [] };
  }
  if (typeof authorize !== 'function') {
    return { error: 'no comment authorizer was passed, so review feedback cannot be trusted' };
  }

  const decisions = new Map();
  const cache = Object.create(null);
  const opened = writeAccessNames(writeAccessCommands);
  const decide = async (rawLogin, actorType = null) => {
    const login = String(rawLogin ?? '').trim();
    const author = login === '' ? '(missing)' : JSON.stringify(login);
    const decided = (allowed, reason) => {
      core?.info?.(
        `Autofix context author: source=${source} author=${author} ` +
          `decision=${allowed ? 'allow' : 'omit'} reason=${reason}.`,
      );
      return { allowed };
    };
    const refused = (reason) => {
      core?.warning?.(
        `Autofix context author: source=${source} author=${author} decision=refuse reason=${reason}.`,
      );
    };
    if (login === '') return decided(false, 'missing-login');
    if (isOwnLogin(login, botLogin, actorType)) return decided(true, 'publisher');
    const authorizationLogin = login.endsWith('[bot]') ? login.slice(0, -5) : login;
    if (!AUTHZ_LOGIN_SHAPE.test(authorizationLogin)) return decided(false, 'invalid-login');
    const key = login.toLowerCase();
    if (decisions.has(key)) return decisions.get(key);

    const pending = (async () => {
      const auth = authorizerCore(core);
      let owns;
      try {
        owns = await authorize({ github, core: auth.core, owner, repo, username: login, cache });
      } catch (error) {
        refused('codeowners-unreadable');
        return { error: `could not authorize @${login} for review feedback: ${error?.message ?? error}` };
      }
      if (auth.failure() !== '') {
        refused('codeowners-unreadable');
        return { error: `could not authorize @${login} for review feedback: ${auth.failure()}` };
      }
      if (owns !== true && owns !== false) {
        refused('codeowners-indeterminate');
        return { error: `the authorizer returned no definite ownership answer for @${login}` };
      }

      let write = '';
      let bar = commandAuthorized('fix', {
        codeowner: owns ? 'true' : 'false',
        write,
        writeAccessCommands: opened,
      });
      if (bar.authorized) return decided(true, 'codeowner');
      if (!bar.undecided) return decided(false, 'authorization-bar');
      if (typeof writeAccess !== 'function') {
        refused('write-access-reader-missing');
        return { error: '`fix` is open to write access, but no write-access reader was passed' };
      }
      try {
        write = await writeAccess({ github, core: auth.core, owner, repo, username: login, cache });
      } catch (error) {
        refused('write-access-unreadable');
        return { error: `could not read @${login}'s write access for review feedback: ${error?.message ?? error}` };
      }
      if (auth.failure() !== '') {
        refused('write-access-unreadable');
        return { error: `could not authorize @${login} for review feedback: ${auth.failure()}` };
      }
      if (write !== 'true' && write !== 'false') {
        refused('write-access-indeterminate');
        return { error: `GitHub returned no definite write-access answer for @${login}` };
      }
      bar = commandAuthorized('fix', {
        codeowner: 'false',
        write,
        writeAccessCommands: opened,
      });
      return decided(bar.authorized, bar.authorized ? 'write-access' : 'authorization-bar');
    })();
    decisions.set(key, pending);
    return pending;
  };

  const accepted = [];
  const warnEdited = (comment, state, effect) => {
    core?.warning?.(
      `Review comment ${String(comment?.commentId ?? '(unknown)')} by @${String(comment?.login ?? '')} ` +
        `${state === 'edited' ? 'was edited' : 'has no readable edit state'}; ${effect}.`,
    );
  };
  for (const thread of threads ?? []) {
    const [root, ...replies] = thread?.comments ?? [];
    const rootVerdict = await decide(root?.login, root?.actorType);
    if (rootVerdict.error) return rootVerdict;
    const rootState = editState(root);

    const keptReplies = [];
    let replyWasEdited = false;
    for (const reply of replies) {
      const verdict = await decide(reply?.login, reply?.actorType);
      if (verdict.error) return verdict;
      if (!verdict.allowed) continue;
      const state = editState(reply);
      if (state !== UNEDITED) {
        warnEdited(reply, state, 'the thread was excluded from trusted feedback');
        replyWasEdited = true;
        continue;
      }
      keptReplies.push({ ...reply, authorized: true });
    }

    if (replyWasEdited) continue;

    const endorser = keptReplies.find(
      (reply) => !isOwnLogin(reply?.login, botLogin, reply?.actorType) && commandOf(reply?.body, { trigger: triggerPhrase }) === 'fix',
    );
    if (!rootVerdict.allowed && !endorser) continue;
    if (rootState !== UNEDITED) {
      warnEdited(root, rootState, 'the thread was excluded from trusted feedback');
      continue;
    }
    const keptRoot = rootVerdict.allowed
      ? { ...root, authorized: true }
      : {
          ...root,
          authorized: false,
          endorsedBy: { commentId: endorser.commentId, login: endorser.login },
        };
    const comments = [keptRoot, ...keptReplies];
    accepted.push({ ...thread, commentCount: comments.length, comments });
  }
  const inputCount = countComments(threads);
  const keptCount = accepted.reduce((sum, thread) => sum + (thread?.comments ?? []).length, 0);
  const omittedCount = Math.max(0, inputCount - keptCount) + (Number.isInteger(omitted) && omitted > 0 ? omitted : 0);
  core?.info?.(
    `Autofix context: source=${source} decision=filter kept=${keptCount} omitted=${omittedCount}.`,
  );
  return { threads: accepted };
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

const REVIEW_NOUNS = Object.freeze(
  new Set(['comment', 'comments', 'feedback', 'review', 'reviews', 'reviewer', 'reviewers', 'thread', 'threads']),
);

const REVIEW_FILLER = Object.freeze(
  new Set([
    'a', 'all', 'an', 'and', 'any', 'every', 'from', 'here', 'in', 'left', 'my', 'of', 'on',
    'open', 'our', 'outstanding', 'pending', 'please', 'pr', 'remaining', 'still', 'that', 'the',
    'their', 'these', 'this', 'those', 'unresolved', 'your',
  ]),
);

function namesTheReview(guidance) {
  const words = String(guidance ?? '')
    .toLowerCase()
    .replace(/&[a-z0-9]+;/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  if (!words.every((word) => REVIEW_NOUNS.has(word) || REVIEW_FILLER.has(word))) return false;
  return words.some((word) => REVIEW_NOUNS.has(word));
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
  reviewId = null,
  authorize = null,
  writeAccess = null,
  writeAccessCommands = null,
  triggerPhrase = null,
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

  const scopedToReview = reviewScope(read.threads, reviewId);
  if (scopedToReview.error) return { error: scopedToReview.error };
  const omittedByReview = Math.max(0, countComments(read.threads) - countComments(scopedToReview.threads));

  const hydrated = await hydrateScopedThread({ github, threads: scopedToReview.threads, threadRootId });
  if (hydrated.error) return { error: hydrated.error };
  let contextThreads = hydrated.threads;
  let scopedCounts = null;
  let omittedByThread = 0;
  if (String(threadRootId ?? '').trim() !== '') {
    const scoped = threadByRoot(contextThreads, threadRootId);
    if (!scoped) {
      const selected = selectThreads(contextThreads, { botLogin, threadRootId });
      return { error: selected.error };
    }
    const fullSelection = selectThreads(contextThreads, {
      botLogin,
      guidance,
      core,
      threadRootId,
      allowLocked,
    });
    scopedCounts = {
      total: fullSelection.total,
      resolved: fullSelection.resolved,
      deferred:
        fullSelection.deferred + disputedThreads(contextThreads.filter((one) => one !== scoped), { botLogin }).length,
    };
    omittedByThread = Math.max(0, countComments(contextThreads) - countComments([scoped]));
    contextThreads = [scoped];
  }
  const trusted = await authorizeThreadContext({
    threads: contextThreads,
    github,
    core,
    owner,
    repo,
    botLogin,
    authorize,
    writeAccess,
    writeAccessCommands,
    triggerPhrase,
    source: reviewId ? 'submitted-review' : threadRootId ? 'review-thread' : 'pull-request-review-threads',
    omitted: omittedByReview + omittedByThread,
  });
  if (trusted.error) return { error: trusted.error };
  const { threads } = trusted;

  const { error: refused, ...selected } = selectThreads(threads, {
    botLogin,
    guidance,
    core,
    threadRootId,
    allowLocked,
  });
  if (refused) return { error: refused };
  if (scopedCounts) {
    selected.total = scopedCounts.total;
    selected.resolved = scopedCounts.resolved;
    selected.deferred = scopedCounts.deferred;
  }
  core?.info?.(
    `#${number} on ${ref}: ${selected.pending.length} of ${counted(selected.total, 'review thread')} offered ` +
      `(${selected.resolved} resolved${selected.deferred ? `, ${selected.deferred} deferred past the bound` : ''})` +
      `${threadRootId ? `, scoped to the thread opened by comment ${String(threadRootId)}` : ''}` +
      `${reviewId ? `, scoped to submitted review ${String(reviewId)}` : ''}` +
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
  namesTheReview,
  authorizeThreadContext,
  resolveFixPhase,
};
