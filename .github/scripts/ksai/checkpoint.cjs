'use strict';

const {
  asAlert,
  commandAuthorized,
  commandEnabled,
  writeAccessNames,
  releaserOf,
} = require('../lib/select-arm.cjs');
const {
  LOGIN_SHAPE,
  PHASE_MARKER_PREFIX,
  RELEASE_TOKEN_CORE,
  appended,
  releasesIn,
  scrub,
} = require('./plan.cjs');
const { PAGE_SIZE: RELEASE_PER_PAGE, probeComments } = require('./pages.cjs');
const { isOwnLogin, planRecords, EDITED, UNEDITED } = require('./approval.cjs');
const { counted, plural } = require('../lib/text.cjs');

const RELEASE_TOKEN_SHAPE = new RegExp(`^(?:${RELEASE_TOKEN_CORE})$`);

const MAX_RELEASE_PAGES = 5;

function releaseMarker(token, at = 0) {
  const bound = Number(at) > 0 ? `:${String(Number(at))}` : '';
  return `${PHASE_MARKER_PREFIX}${String(token)}${bound} -->`;
}

function withPhaseRelease(body, token, at = 0) {
  const wanted = String(token ?? '').trim();
  if (!RELEASE_TOKEN_SHAPE.test(wanted)) return null;
  const text = String(body ?? '');
  if (releasesIn(text).some((release) => release.token === wanted)) return { body: text, changed: false };
  return { body: appended(text, releaseMarker(wanted, at)), changed: true };
}

async function releasedTokens({ github = null, owner = null, repo = null, prNumber = null, botLogin = null } = {}) {
  const known = String(botLogin ?? '').trim();
  if (!known) {
    return {
      bound: [],
      shape: null,
      sealed: null,
      editedRelease: false,
      unreadable: 'no bot login was given to gate the marker on',
    };
  }

  const comments = [];
  const { unreadable } = await probeComments({
    github,
    owner,
    repo,
    prNumber,
    maxPages: MAX_RELEASE_PAGES,
    cannot: 'cannot tell whether the checkpoint was already released',
    take: (comment) => {
      comments.push(comment);
    },
  });

  const seen = planRecords(comments, { botLogin: known });
  const answer = { bound: seen.releases, shape: seen.shape, sealed: seen.sealed, editedRelease: seen.editedRelease };
  if (unreadable) return { ...answer, unreadable };
  if (seen.editedShape) {
    return {
      ...answer,
      unreadable:
        `a comment on ${owner}/${repo}#${String(prNumber)} recording this plan's phase boundary count has been ` +
        'edited, so what it published is no longer evidence of how many boundaries were planned',
    };
  }
  return { ...answer, unreadable: null };
}

async function alreadyReleased({
  github = null,
  owner = null,
  repo = null,
  prNumber = null,
  botLogin = null,
  commentId = null,
} = {}) {
  const wanted = String(commentId ?? '').trim();
  if (!RELEASE_TOKEN_SHAPE.test(wanted)) {
    return { released: false, unreadable: `\`${wanted}\` is not a comment id` };
  }
  const known = String(botLogin ?? '').trim();
  if (!known) return { released: false, unreadable: 'no bot login was given to gate the marker on' };

  let body;
  try {
    const response = await github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) });
    body = String(response?.data?.body ?? '');
  } catch (error) {
    return { released: false, unreadable: `could not read #${String(prNumber)}: ${error.message}` };
  }
  if (releasesIn(body).some((release) => release.token === wanted)) return { released: true, unreadable: null };

  const seen = await releasedTokens({ github, owner, repo, prNumber, botLogin });
  if (seen.bound.some((release) => release.token === wanted)) return { released: true, unreadable: null };
  return { released: false, unreadable: seen.unreadable };
}

const isApprove = (command) => String(command ?? '').trim().toLowerCase() === 'approve';

function withoutRelease({
  atCheckpoint = null,
  command = null,
  authorized = null,
  write = null,
  writeAccessCommands = null,
  disabledCommands = null,
  commentEdited = null,
} = {}) {
  if (String(atCheckpoint) !== 'true') return { release: false, waiting: false, reason: 'no-checkpoint' };
  if (!commandEnabled('approve', { flow: 'implement', disabledCommands })) {
    return { release: false, waiting: true, reason: 'approve-disabled' };
  }
  const editedState = String(commentEdited ?? '').trim();
  if (editedState !== '' && editedState !== UNEDITED) {
    return { release: false, waiting: true, reason: editedState === EDITED ? 'edited-request' : 'edit-unreadable' };
  }
  if (isApprove(command)) {
    const bar = commandAuthorized('approve', {
      codeowner: authorized,
      write,
      writeAccessCommands: writeAccessNames(writeAccessCommands),
    });
    if (bar.undecided) return { release: false, waiting: true, reason: 'write-unreadable' };
    if (!bar.authorized) return { release: false, waiting: true, reason: 'unauthorized' };
    return null;
  }
  return { release: false, waiting: true, reason: 'no-approval' };
}

function spaceOf({ threadRootId, dispatched }) {
  if (String(dispatched ?? '') === 'true') return 'dispatch';
  return String(threadRootId ?? '').trim() === '' ? 'issue' : 'thread';
}

function releaseTokenFor({
  command = null,
  commentId = null,
  threadRootId = null,
  dispatched = null,
  reviewId = null,
} = {}) {
  if (!isApprove(command)) return '';
  const said = String(commentId ?? '').trim();
  if (said !== '') return `${spaceOf({ threadRootId, dispatched })}/${said}`;
  const submitted = String(reviewId ?? '').trim();
  return submitted === '' ? '' : `review/${submitted}`;
}

function needsReleaseRead(env) {
  return withoutRelease(env) === null;
}

const EDIT_PAGE = 100;

const BODY_EDITS_QUERY =
  'query ($owner: String!, $repo: String!, $number: Int!, $page: Int!) { ' +
  'repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ' +
  'userContentEdits(first: $page) { nodes { editedAt editor { login } } } } } }';

async function pendingSince({ github = null, owner = null, repo = null, prNumber = null, botLogin = null } = {}) {
  const known = String(botLogin ?? '').trim();
  if (!known) return { at: null, unreadable: "No bot login was given to tell this flow's own edits apart." };
  let edits;
  try {
    const data = await github.graphql(BODY_EDITS_QUERY, { owner, repo, number: Number(prNumber), page: EDIT_PAGE });
    edits = data?.repository?.pullRequest?.userContentEdits?.nodes;
  } catch (error) {
    return { at: null, unreadable: `Could not read the edit history of #${String(prNumber)}: ${error?.message}.` };
  }
  const at = (Array.isArray(edits) ? edits : []).find((edit) => isOwnLogin(edit?.editor?.login, known))?.editedAt;
  if (typeof at === 'string' && Number.isFinite(Date.parse(at))) return { at, unreadable: null };
  return {
    at: null,
    unreadable: `None of the newest ${EDIT_PAGE} edits to the description of #${String(prNumber)} was made by this flow.`,
  };
}

function decideCheckpoint({ released = null, unreadable = null, requestedAt = null, pendingSince: since = null, ...asked } = {}) {
  const settled = withoutRelease(asked);
  if (settled) return settled;
  if (unreadable) return { release: false, waiting: true, reason: 'unreadable' };
  if (released === true) return { release: false, waiting: true, reason: 'already-released' };
  const requested = Date.parse(String(requestedAt ?? ''));
  const pending = Date.parse(String(since ?? ''));
  if (!Number.isFinite(requested) || !Number.isFinite(pending)) {
    return { release: false, waiting: true, reason: 'undated-request' };
  }
  if (requested <= pending) return { release: false, waiting: true, reason: 'stale-request' };
  return { release: true, waiting: false, reason: 'released' };
}

const WAITING = Object.freeze(
  Object.assign(Object.create(null), {
    unreadable: Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ detail }) =>
        'This phase of the plan is done and this run could not tell whether the next one has already been ' +
        'released, so it released nothing rather than releasing a phase twice.' +
        (detail === '' ? '' : ` ${detail}`) +
        ' That is GitHub not answering rather than a refusal of anybody, and approving again re-runs this check',
    }),
    'write-unreadable': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: () =>
        'This phase of the plan is done and `approve` is released here by anyone with write access, which ' +
        'GitHub could not be asked about, so this released nothing rather than guessing. That is a grant to ' +
        'fix rather than a refusal of anybody: the authorization token needs metadata:read on this repository',
    }),
    'edited-request': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ outstanding }) =>
        'This phase of the plan is done and the comment asking to release it has been edited since it was ' +
        'posted, so it released nothing.' +
        outstanding +
        ' Anybody with write access can edit anybody else\'s comment, so a release is only ever read off one ' +
        'nobody has touched: post a new comment asking for it',
    }),
    'edit-unreadable': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ outstanding }) =>
        'This phase of the plan is done and this run could not tell whether the comment asking to release it ' +
        'had been edited, so it released nothing rather than guessing.' +
        outstanding +
        ' A release is only ever read off a comment nobody has touched, and that could not be established here: ' +
        'post a new comment asking for it',
    }),
    'stale-request': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ outstanding }) =>
        'This phase of the plan is done and the request asking to release it is older than the last change this ' +
        "flow made to this pull request's description, so it released nothing." +
        outstanding +
        ' A step lands by ticking its box there, so an older request was given before the commits it would ' +
        'release: read the commits above, then post a new comment asking for it',
    }),
    'undated-request': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ outstanding, detail }) =>
        'This phase of the plan is done and this run could not tell whether the request asking to release it ' +
        "came after the last change this flow made to this pull request's description, so it released nothing " +
        'rather than guessing.' +
        (detail === '' ? '' : ` ${detail}`) +
        outstanding +
        ' A release is only ever read off a request newer than the step it covers: post a new comment asking for it',
    }),
    'approve-disabled': Object.freeze({
      kind: 'phase-waiting',
      level: 'WARNING',
      say: ({ outstanding, releaser }) =>
        `This phase of the plan is done and the next one waits for ${releaser} to release it, which this ` +
        'repository has turned off - so no comment here can release it and nothing further will run.' +
        outstanding +
        ' That is a configuration to change rather than something to wait for: either stop turning the ' +
        "approval command off in this repository's workflow file, or turn the plan-approval requirement off " +
        'beside it',
    }),
    last: Object.freeze({
      kind: 'plan-complete',
      level: 'IMPORTANT',
      say: ({ releaser }) =>
        `Every step in the plan is done and this pull request is waiting for ${releaser} before it is marked ` +
        'ready for review. Nothing further will run until one looks at it. Read the commits above, leave ' +
        'whatever review comments you want addressed, then release this last checkpoint with one comment here',
    }),
    more: Object.freeze({
      kind: 'phase-waiting',
      level: 'IMPORTANT',
      say: ({ outstanding, releaser }) =>
        `This phase of the plan is done and the next one is waiting for ${releaser} to look at it. Nothing further ` +
        'will run until one does.' +
        outstanding +
        ' Read the commits above, leave whatever review comments you want addressed, then release the next phase ' +
        'with one comment here',
    }),
  }),
);

function waitingCase({ remaining = null, reason = null } = {}) {
  if (Object.prototype.hasOwnProperty.call(WAITING, String(reason ?? '')) && reason !== 'last' && reason !== 'more') {
    return reason;
  }
  return Number(remaining) === 1 ? 'last' : 'more';
}

function renderWaiting({ remaining = null, triggerPhrase = null, reason = null, detail = null, writeAccessCommands = null } = {}) {
  const left = Number(remaining);
  const outstanding =
    Number.isInteger(left) && left > 1
      ? ` ${counted(left - 1, 'step')} ${plural(left - 1, 'remains', 'remain')} after this one.`
      : '';
  const notice = WAITING[waitingCase({ remaining, reason })];
  const said = notice.say({
    outstanding,
    detail: String(detail ?? '').trim(),
    releaser: releaserOf(writeAccessCommands),
  });
  return { kind: notice.kind, body: asAlert(notice.level, scrub(said, { triggerPhrase })) };
}

const lastCheckpoint = (remaining) => Number(remaining) === 1;

const releaseKind = (remaining) => (lastCheckpoint(remaining) ? 'last-phase-released' : 'phase-released');

function renderReleased({ approvedBy = null, commentId = null, triggerPhrase = null, remaining = null, at = 0 } = {}) {
  const who = String(approvedBy ?? '').trim();
  const named = LOGIN_SHAPE.test(who) ? `@${who}` : 'an approver';
  const lines =
    lastCheckpoint(remaining)
      ? [
          `**Last checkpoint released by ${named}**`,
          '',
          'Every box in the plan is ticked',
        ]
      : [
          `**Next phase released by ${named}**`,
          '',
          'Carrying on down the tasks in this body, one at a time',
        ];
  return `${scrub(lines.join('\n'), { triggerPhrase })}\n\n${releaseMarker(commentId, at)}\n`;
}

module.exports = {
  MAX_RELEASE_PAGES,
  RELEASE_PER_PAGE,
  releaseMarker,
  releasesIn,
  releasedTokens,
  withPhaseRelease,
  alreadyReleased,
  pendingSince,
  needsReleaseRead,
  releaseTokenFor,
  decideCheckpoint,
  renderWaiting,
  renderReleased,
  releaseKind,
};
