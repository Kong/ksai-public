'use strict';

const { readCount, MAX_ATTEMPTS } = require('./continue.cjs');
const { JIRA_KEY_SHAPE, anyCommandOpen } = require('../lib/select-arm.cjs');
const { editState, UNEDITED } = require('./approval.cjs');

const editRefusal = (comment, where) => {
  const state = editState(comment);
  if (state === UNEDITED) return null;
  return {
    error:
      `the ${where} this run answers ${state === 'edited' ? 'has been edited since it was posted' : 'carries no edit state to read'}, ` +
      'so nothing ran. GitHub keeps the original author on an edited comment while the words become somebody ' +
      "else's, and authorization here reads that author - so a command is only ever taken from a comment nobody " +
      'has touched. Post a new comment asking for it',
  };
};

const NUMBER_SHAPE = /^[1-9][0-9]{0,9}$/;

const WORK_REF_PREFIX = 'jira/';

const AUTHZ_LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const CONTINUATION_EVENT = 'workflow_dispatch';
const COMMENT_EVENT = 'issue_comment';
const REVIEW_COMMENT_EVENT = 'pull_request_review_comment';

const REVIEW_EVENT = 'pull_request_review';

function readNumber(value) {
  const text = String(value ?? '').trim();
  return NUMBER_SHAPE.test(text) ? Number(text) : null;
}

function commenterOf(comment) {
  const login = String(comment?.user?.login ?? '');
  return AUTHZ_LOGIN_SHAPE.test(login) ? login : null;
}

function threadRootOf({ eventName = null, payload = null } = {}) {
  if (String(eventName ?? '') !== REVIEW_COMMENT_EVENT) return null;
  const comment = payload?.comment ?? null;
  return readNumber(comment?.in_reply_to_id) ?? readNumber(comment?.id);
}

function workRefFor(key) {
  const said = String(key ?? '').trim().toUpperCase();
  return JIRA_KEY_SHAPE.test(said) ? `${WORK_REF_PREFIX}${said}` : '';
}

function readWorkRef(value) {
  const text = String(value ?? '').trim();
  if (text === '') return { key: null };
  if (!text.startsWith(WORK_REF_PREFIX)) {
    return { error: `\`work_ref\` names no source this action knows. It expects \`${WORK_REF_PREFIX}<KEY>\`.` };
  }
  const key = text.slice(WORK_REF_PREFIX.length).toUpperCase();
  if (!JIRA_KEY_SHAPE.test(key)) {
    return { error: `\`work_ref\` carries no Jira issue key. It expects \`${WORK_REF_PREFIX}KONG-1234\`.` };
  }
  return { key };
}

function resolveContext({ eventName = null, payload = null, inputs = null } = {}) {
  const { issue = null, comment = null, pull_request: pullRequest = null } = payload ?? {};
  const {
    issue_number: issueNumberInput = null,
    work_ref: workRefInput = null,
    comment_body: commentBodyInput = null,
    triggering_actor: triggeringActorInput = null,
    on_issue: onIssueInput = null,
    comment_id: commentIdInput = null,
    attempt: attemptInput = null,
    stall: stallInput = null,
    prev_remaining: prevRemainingInput = null,
  } = inputs ?? {};
  const event = String(eventName ?? '');

  if (event === CONTINUATION_EVENT) {
    const work = readWorkRef(workRefInput);
    if (work.error) return { error: work.error };
    const issueNumber = readNumber(issueNumberInput);
    if (issueNumber === null && work.key === null) {
      return {
        error:
          'a continuation run carries no issue, so `issue_number` or `work_ref` has to be dispatched with ' +
          `it. Got \`${String(issueNumberInput ?? '')}\` and \`${String(workRefInput ?? '')}\`.`,
      };
    }
    if (issueNumber !== null && work.key !== null) {
      return {
        error:
          'a run is addressed by an issue or by a ticket, never both: the branch this flow names is built ' +
          'from one of them, and the phase is discovered from the other, so a run carrying the pair plans ' +
          `again on every trigger. Got \`${issueNumber}\` and \`${work.key}\`.`,
      };
    }
    const asked = String(commentBodyInput ?? '');
    if (asked.trim() !== '') {
      const actor = String(triggeringActorInput ?? '');
      return {
        issueNumber,
        jiraKey: work.key,
        isContinuation: false,
        onIssue: String(onIssueInput ?? 'true') !== 'false',
        commenter: AUTHZ_LOGIN_SHAPE.test(actor) ? actor : null,
        commentId: readNumber(commentIdInput),
        commentBody: asked,
        dispatched: true,
        threadRootId: null,
        attempt: 0,
        stall: 0,
        prevRemaining: null,
      };
    }
    return {
      issueNumber,
      jiraKey: work.key,
      isContinuation: true,
      onIssue: true,
      commenter: null,
      commentId: null,
      commentBody: '',
      threadRootId: null,
      attempt: readCount(attemptInput, { max: MAX_ATTEMPTS }) ?? 0,
      stall: readCount(stallInput, { max: MAX_ATTEMPTS }) ?? 0,
      prevRemaining: readCount(prevRemainingInput),
    };
  }

  if (event === COMMENT_EVENT) {
    const issueNumber = readNumber(issue?.number);
    if (issueNumber === null) {
      return { error: `the comment event carried no issue number (got \`${String(issue?.number ?? '')}\`)` };
    }
    const refused = editRefusal(comment, 'comment');
    if (refused) return refused;
    return {
      issueNumber,
      jiraKey: null,
      isContinuation: false,
      onIssue: issue?.pull_request == null,
      commenter: commenterOf(comment),
      commentId: readNumber(comment?.id),
      commentBody: String(comment?.body ?? ''),
      commentEdited: editState(comment),
      threadRootId: null,
      attempt: 0,
      stall: 0,
      prevRemaining: null,
    };
  }

  if (event === REVIEW_EVENT) {
    const issueNumber = readNumber(pullRequest?.number);
    if (issueNumber === null) {
      return {
        error: `the review event carried no pull request number (got \`${String(pullRequest?.number ?? '')}\`)`,
      };
    }
    return {
      issueNumber,
      jiraKey: null,
      isContinuation: false,
      onIssue: false,
      onReview: true,
      reviewState: String(payload?.review?.state ?? '').trim().toLowerCase(),
      reviewId: readNumber(payload?.review?.id),
      reviewSubmittedAt: String(payload?.review?.submitted_at ?? '').trim(),
      reviewCommitId: String(payload?.review?.commit_id ?? '').trim().toLowerCase(),
      reviewUrl: String(payload?.review?.html_url ?? '').trim(),
      reviewAssociation: String(payload?.review?.author_association ?? '').trim(),
      reviewActorType: String(payload?.review?.user?.type ?? '').trim(),
      commenter: commenterOf(payload?.review),
      commentId: null,
      commentBody: String(payload?.review?.body ?? ''),
      threadRootId: null,
      attempt: 0,
      stall: 0,
      prevRemaining: null,
    };
  }

  if (event === REVIEW_COMMENT_EVENT) {
    const issueNumber = readNumber(pullRequest?.number);
    if (issueNumber === null) {
      return {
        error: `the review comment event carried no pull request number (got \`${String(pullRequest?.number ?? '')}\`)`,
      };
    }
    const threadRootId = threadRootOf({ eventName: event, payload });
    if (threadRootId === null) {
      return {
        error:
          'the review comment event named no review thread to answer: it carries neither `in_reply_to_id` nor ' +
          `an \`id\` of its own (got \`${String(comment?.in_reply_to_id ?? '')}\` and \`${String(comment?.id ?? '')}\`)`,
      };
    }
    const refused = editRefusal(comment, 'review comment');
    if (refused) return refused;
    return {
      issueNumber,
      jiraKey: null,
      isContinuation: false,
      onIssue: false,
      commenter: commenterOf(comment),
      commentId: readNumber(comment?.id),
      commentBody: String(comment?.body ?? ''),
      commentEdited: editState(comment),
      threadRootId,
      attempt: 0,
      stall: 0,
      prevRemaining: null,
    };
  }

  return {
    error:
      `this action does not know what to do with a \`${event || '(none)'}\` event. ` +
      `It expects \`${COMMENT_EVENT}\`, \`${REVIEW_COMMENT_EVENT}\` or \`${REVIEW_EVENT}\` for a request, or ` +
      `\`${CONTINUATION_EVENT}\` for a continuation.`,
  };
}

async function resolveOnIssue({ eventName, commentBody, issueNumber, pullsGet }) {
  const asksSurface =
    String(eventName ?? '') === CONTINUATION_EVENT &&
    String(commentBody ?? '').trim() !== '' &&
    NUMBER_SHAPE.test(String(issueNumber ?? '').trim());
  if (!asksSurface) return { onIssue: true };

  try {
    await pullsGet(Number(issueNumber));
    return { onIssue: false };
  } catch (error) {
    if (error?.status === 404) return { onIssue: true };
    return {
      error:
        `could not tell whether #${issueNumber} is a pull request (status ${error?.status}): ${error?.message}. ` +
        'Does the token passed as `github-token` have pull-requests:read?',
    };
  }
}

function resolveAuthorization({
  isContinuation = null,
  ownerCheck = null,
  writeCheck = null,
  writeAccessCommands = null,
  flow = null,
  threadless = null,
  requirePlanApproval = null,
} = {}) {
  const continued = isContinuation === true || String(isContinuation) === 'true';
  const fromJira = threadless === true || String(threadless) === 'true';
  if (continued && String(flow ?? 'implement') !== 'implement') {
    return { ok: false, why: 'no-continuation-for-this-flow' };
  }
  if (fromJira && String(requirePlanApproval ?? '') !== 'true') {
    return { ok: false, why: 'jira-needs-approval' };
  }
  if (continued) {
    return { ok: true, why: fromJira ? 'jira-trigger' : 'continuation' };
  }
  if (String(ownerCheck ?? '') === 'true') {
    return { ok: true, why: 'codeowner' };
  }
  if (String(ownerCheck ?? '') === '') return { ok: false, why: 'no-answer' };
  const opens = anyCommandOpen(writeAccessCommands);
  if (!opens) return { ok: false, why: 'not-a-codeowner' };
  const holds = String(writeCheck ?? '').trim();
  if (holds === 'true') return { ok: true, why: 'write-access' };
  if (holds !== 'false') return { ok: false, why: 'write-unreadable' };
  return { ok: false, why: 'no-bar-cleared' };
}

const AUTHZ_REASONS = Object.freeze(
  Object.assign(Object.create(null), {
    'no-answer': 'the CODEOWNERS check could not answer, so nothing ran. Check the token it was given.',
    'not-a-codeowner': 'you are not a code owner of this repository with write access, so nothing ran.',
    'no-bar-cleared':
      'you neither own a path in this repository\'s CODEOWNERS with write access nor hold write access ' +
      'on it, and one of those is the bar for every command here, so nothing ran.',
    'write-unreadable':
      'a command here runs for anyone with write access, and GitHub could not be asked whether you hold ' +
      'it, so this refused rather than guessing. The authorization token needs metadata:read on this ' +
      'repository.',
    'jira-needs-approval':
      'a run triggered from Jira may only plan behind a human release, so this repository must set ' +
      '`require_plan_approval: "true"` before a Jira ticket can start one. Nothing ran.',
  }),
);

module.exports = {
  NUMBER_SHAPE,
  AUTHZ_LOGIN_SHAPE,
  AUTHZ_REASONS,
  CONTINUATION_EVENT,
  COMMENT_EVENT,
  REVIEW_COMMENT_EVENT,
  REVIEW_EVENT,
  threadRootOf,
  readWorkRef,
  workRefFor,
  resolveContext,
  resolveOnIssue,
  resolveAuthorization,
};
