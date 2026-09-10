'use strict';

const { findApprovals, findAcknowledgment, lastRework } = require('./approval.cjs');
const { AUTHZ_LOGIN_SHAPE } = require('./context.cjs');
const { scrub, readRelease, releaseRef } = require('./plan.cjs');

const { openPlanThreads } = require('./revise.cjs');
const { latestNativeApprovals } = require('./native-approval.cjs');
const { isOwnLogin } = require('./threads.cjs');
const {
  asAlert,
  commandAuthorized,
  commandEnabled,
  opensApprove,
  releaserOf,
  undecidedWriteAccess,
  NO_WRITE_ACCESS,
} = require('../lib/select-arm.cjs');
const { counted, plural } = require('../lib/text.cjs');

const MAX_CANDIDATES = 10;

const APPROVABLE = Object.freeze(['plan-review', 'step']);

const ALWAYS_APPROVED = 'plan-review';

function approvalApplies({ required = null, phase = null } = {}) {
  return isTrue(required) || String(phase ?? '').trim() === ALWAYS_APPROVED;
}

function isTrue(value) {
  return value === true || String(value) === 'true';
}

function threadsToScan({ issueNumber, prNumber }) {
  const threads = [];
  for (const candidate of [issueNumber, prNumber]) {
    const number = Number(candidate);
    if (Number.isSafeInteger(number) && number > 0 && !threads.includes(number)) threads.push(number);
  }
  return threads;
}

function mergeByArrival(...lists) {
  const at = (comment) => Date.parse(String(comment?.created_at ?? '')) || 0;
  return lists
    .flat()
    .map((comment, index) => ({ comment, index }))
    .sort((left, right) => at(left.comment) - at(right.comment) || left.index - right.index)
    .map((entry) => entry.comment);
}

async function readNativeApprovals({
  github,
  owner,
  repo,
  prNumber,
  botLogin,
  eventReview,
  already,
  acknowledgments,
}) {
  const pulls = github?.rest?.pulls;
  if (typeof pulls?.get !== 'function' || typeof pulls?.listReviews !== 'function' || typeof github?.paginate !== 'function') {
    return { approvals: [], unreadable: null };
  }
  try {
    const [{ data: pull }, listed] = await Promise.all([
      pulls.get({ owner, repo, pull_number: Number(prNumber) }),
      github.paginate(pulls.listReviews, { owner, repo, pull_number: Number(prNumber), per_page: 100 }),
    ]);
    if (pull?.draft !== true || !isOwnLogin(pull?.user?.login, botLogin)) {
      return { approvals: [], unreadable: null };
    }
    const reviews = [...(Array.isArray(listed) ? listed : [])];
    if (eventReview?.id) reviews.push(eventReview);
    const head = String(pull?.head?.sha ?? '').trim().toLowerCase();
    const approvals = latestNativeApprovals(reviews).filter((candidate) => {
      if (candidate.commitId === head) return true;
      if (already?.kind !== 'github' || candidate.login !== already.login) return false;
      return findAcknowledgment(acknowledgments, {
        botLogin,
        approvalRef: candidate.approvalRef,
      }).acknowledged === true;
    });
    return { approvals, unreadable: null };
  } catch (error) {
    return {
      approvals: [],
      unreadable:
        `could not read native reviews on #${String(prNumber)}: ${error.message}. ` +
        'The approval gate reads them with `authorization_github_token`, which needs pull-requests:read.',
    };
  }
}

async function mayRelease({ github, core, owner, repo, login, authorize, writeAccess, writeAccessCommands, cache }) {
  const owns = (await authorize({ github, core, owner, repo, username: login, cache })) === true;
  const asks = !owns && opensApprove(writeAccessCommands);
  const holds = asks ? await writeAccess({ github, core, owner, repo, username: login, cache }) : '';
  const bar = commandAuthorized('approve', {
    codeowner: owns ? 'true' : 'false',
    write: holds,
    writeAccessCommands,
  });
  return { allowed: bar.authorized, refusal: bar.undecided ? undecidedWriteAccess('approve', { subject: login }) : null };
}

async function withoutScan({
  github = null,
  required = null,
  phase = null,
  prNumber = null,
  authorize = null,
  writeAccess = null,
  writeAccessCommands = NO_WRITE_ACCESS,
  disabledCommands = null,
  releasedRef = null,
  jiraApprover = null,
  jiraApproverBlock = null,
} = {}) {
  if (!approvalApplies({ required, phase })) {
    return { required: false, blocked: false };
  }
  if (!commandEnabled('approve', { flow: 'implement', disabledCommands })) {
    return { required: true, blocked: true, reason: 'approve-disabled', candidates: 0 };
  }
  if (!github?.rest) {
    return { required: true, blocked: true, reason: 'no authenticated GitHub client was passed' };
  }
  if (typeof authorize !== 'function') {
    return { required: true, blocked: true, reason: 'no authorization function was passed to check approvers with' };
  }
  if (opensApprove(writeAccessCommands) && typeof writeAccess !== 'function') {
    return {
      required: true,
      blocked: true,
      reason:
        '`approve` is released here by anyone with write access, and no function was passed to read write ' +
        'access with, so this gate cannot tell who may release the plan',
    };
  }

  if (!APPROVABLE.includes(String(phase ?? '').trim())) {
    return { required: true, blocked: true, reason: 'awaiting-approval', candidates: 0 };
  }
  if (!Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    return { required: true, blocked: true, reason: 'awaiting-approval', candidates: 0 };
  }

  const already = readRelease(releasedRef);

  const jiraBlock = String(jiraApproverBlock ?? '').trim();
  if (jiraBlock) {
    return { required: true, blocked: true, reason: jiraBlock, candidates: 0 };
  }

  const fromJira = String(jiraApprover ?? '').trim();
  if (fromJira) {
    const ref = releaseRef({ accountId: fromJira });
    if (ref === null) {
      return { required: true, blocked: true, reason: `\`${fromJira}\` is not an Atlassian account id` };
    }
    return {
      required: true,
      blocked: false,
      released: already?.kind === 'jira',
      release: { kind: 'jira', accountId: fromJira },
      releaseRef: ref,
    };
  }

  if (already?.kind === 'jira') {
    return {
      required: true,
      blocked: true,
      reason:
        'the plan records a release from Jira, and this run could not confirm it. Check that the approval ' +
        'label is still on the ticket and that `jira_approver_group` is still set.',
      candidates: 0,
    };
  }

  return null;
}

async function heldByPlanThreads({
  github = null,
  core = null,
  owner = null,
  repo = null,
  phase = null,
  prNumber = null,
  planFile = null,
  botLogin = null,
  forced = false,
  by = null,
  candidates = 0,
} = {}) {
  const clear = { refusal: null, overrode: false };
  if (String(phase ?? '').trim() !== ALWAYS_APPROVED) return clear;
  const open = await openPlanThreads({ github, owner, repo, prNumber, planFile, botLogin });
  const refused = (reason, extra) => ({ refusal: { required: true, blocked: true, reason, ...extra, candidates }, overrode: false });
  if (open.error) return refused(open.error, {});
  if (open.threads.length === 0) return clear;
  if (forced !== true) return refused('unresolved-threads', { openThreads: open.threads.length });
  core?.warning?.(
    `${String(by)} released this plan over ${counted(open.threads.length, 'thread')} on ${String(planFile)} that nobody ` +
      'has answered; each one gets a reply and is resolved.',
  );
  return { refusal: null, overrode: true };
}

async function resolveApproval({
  github = null,
  core = null,
  owner = null,
  repo = null,
  required = null,
  phase = null,
  issueNumber = null,
  prNumber = null,
  botLogin = null,
  planFile = null,
  trigger = null,
  commandAliases = null,
  authorize = null,
  writeAccess = null,
  writeAccessCommands = NO_WRITE_ACCESS,
  knownOwner = null,
  disabledCommands = null,
  releasedRef = null,
  jiraApprover = null,
  jiraApproverBlock = null,
  nativeReview = null,
} = {}) {
  const settled = await withoutScan({
    github,
    required,
    phase,
    prNumber,
    authorize,
    writeAccess,
    writeAccessCommands,
    disabledCommands,
    releasedRef,
    jiraApprover,
    jiraApproverBlock,
  });
  if (settled !== null) {
    if (settled.required !== true || settled.blocked !== false) return settled;
    const { refusal } = await heldByPlanThreads({ github, core, owner, repo, phase, prNumber, planFile, botLogin });
    return refusal ?? { ...settled, overrode: false };
  }

  const already = readRelease(releasedRef);
  const threads = threadsToScan({ issueNumber, prNumber });

  const found = [];
  const byThread = new Map();
  const unreadable = [];
  const read = threads.map((thread) => {
    const failures = { comments: null, review: null };
    const asked = Promise.resolve().then(() => github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: thread,
      per_page: 100,
    })).catch((error) => {
      failures.comments =
        `could not read comments on #${thread}: ${error.message}. ` +
        'The approval gate reads the conversation with `authorization_github_token`, so that token needs ' +
        'issues:read AND pull-requests:read as well as contents:read.';
      return null;
    });

    const askedReview =
      Number(thread) === Number(prNumber)
        ? Promise.resolve().then(() => github.paginate(github.rest.pulls.listReviewComments, {
            owner,
            repo,
            pull_number: Number(thread),
            per_page: 100,
          })).catch((error) => {
            failures.review =
              `could not read the review comments on #${thread}: ${error.message}. ` +
              'An approval left as a reply in a review thread counts, so the approval gate reads them with ' +
              '`authorization_github_token`, which needs pull-requests:read.';
            return null;
          })
        : Promise.resolve(null);

    return { thread, asked, askedReview, failures };
  });

  let ownReplies = null;
  let ownComments = null;
  for (const { thread, asked, askedReview, failures } of read) {
    const comments = await asked;
    const reviewComments = await askedReview;
    if (failures.comments !== null) unreadable.push(failures.comments);
    if (failures.review !== null) unreadable.push(failures.review);

    if (comments === null && reviewComments === null) continue;
    if (Number(thread) === Number(prNumber)) {
      if (reviewComments !== null) ownReplies = reviewComments;
      if (comments !== null) ownComments = comments;
    }
    const conversation = mergeByArrival(comments ?? [], (reviewComments ?? []).filter((one) => one?.user?.type !== 'Bot'));
    byThread.set(thread, comments ?? []);
    const batch = findApprovals(conversation, { trigger, commandAliases });
    for (const approval of batch) {
      const held = found.find((seen) => seen.login === approval.login);
      if (!held) {
        found.push({ ...approval, thread });
        continue;
      }
      const forced = held.forced || approval.forced;
      if (approval.at > held.at) Object.assign(held, approval, { thread });
      held.forced = forced;
    }
  }

  const acknowledgments = byThread.get(Number(prNumber)) ?? [];

  const native = await readNativeApprovals({
    github,
    owner,
    repo,
    prNumber,
    botLogin,
    eventReview: nativeReview,
    already,
    acknowledgments,
  });
  if (native.unreadable !== null) unreadable.push(native.unreadable);
  for (const approval of native.approvals) {
    const held = found.find((seen) => seen.login === approval.login);
    if (!held) {
      found.push({ ...approval, thread: Number(prNumber) });
      continue;
    }
    if (approval.at > held.at) Object.assign(held, approval, { thread: Number(prNumber), forced: held.forced });
  }

  const ownScanned = threads.includes(Number(prNumber));
  const reworked = lastRework([...(ownReplies ?? []), ...(ownComments ?? [])], { botLogin });
  const confirmed = already?.kind === 'github' ? found.filter((one) => one.login === already.login) : found;

  if (confirmed.length === 0) {
    if (unreadable.length > 0) return { required: true, blocked: true, reason: unreadable[0] };
    if (already?.kind === 'github') {
      return {
        required: true,
        blocked: true,
        reason:
          `the plan records a release by @${already.login}, and this run could not find the approval ` +
          'it was recorded from. The marker in the pull request body is a record of an approval and not the ' +
          'approval itself, so it releases nothing on its own - approve again to release this plan.',
        candidates: 0,
      };
    }
    return { required: true, blocked: true, reason: 'awaiting-approval', candidates: 0 };
  }
  if (unreadable.length > 0) {
    core?.warning?.(
      `${unreadable.length} of ${counted(threads.length, 'conversation')} could not be read, so an approval in ` +
        `one of them is not counted: ${unreadable[0]}`,
    );
  }

  const RANK = Object.assign(Object.create(null), { OWNER: 0, MEMBER: 1, COLLABORATOR: 2 });
  const knownFirst = AUTHZ_LOGIN_SHAPE.test(String(knownOwner ?? '')) ? String(knownOwner) : null;
  const rankOf = (candidate) => {
    if (knownFirst !== null && candidate.login === knownFirst) return -1;
    const rank = RANK[String(candidate.association ?? '').toUpperCase()];
    return rank === undefined ? 3 : rank;
  };
  const ordered = confirmed
    .map((candidate, index) => ({ candidate, index, rank: rankOf(candidate) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.candidate);

  const considered = ordered.slice(0, MAX_CANDIDATES);
  if (confirmed.length > considered.length) {
    core?.warning?.(
      `${confirmed.length} distinct logins have approved; only ${MAX_CANDIDATES} are checked ` +
        'against CODEOWNERS, closest to a code owner first. If the real approver is not among them, they can ' +
        'approve again - an org member or collaborator is checked ahead of a stranger.',
    );
  }

  const codeownersCache = Object.create(null);
  const alreadyKnown = knownFirst;
  let stale = false;
  for (const candidate of considered) {
    if (!AUTHZ_LOGIN_SHAPE.test(candidate.login)) continue;
    let allowed;
    if (alreadyKnown !== null && candidate.login === alreadyKnown) {
      core?.info?.(`@${candidate.login} was authorized earlier in this run, so not re-checked.`);
      allowed = true;
    } else {
      try {
        const answer = await mayRelease({
          github,
          core,
          owner,
          repo,
          login: candidate.login,
          authorize,
          writeAccess,
          writeAccessCommands,
          cache: codeownersCache,
        });
        if (answer.refusal) unreadable.push(answer.refusal);
        allowed = answer.allowed;
      } catch (error) {
        return { required: true, blocked: true, reason: `could not authorize @${candidate.login}: ${error.message}` };
      }
    }
    if (allowed !== true) continue;
    if (reworked !== null && candidate.at <= reworked) {
      stale = true;
      continue;
    }

    const ack = candidate.approvalRef
      ? findAcknowledgment(byThread.get(candidate.thread), { botLogin, approvalRef: candidate.approvalRef })
      : { acknowledged: true };
    if (ack.reason) core?.warning?.(`cannot tell whether this approval was already recorded: ${ack.reason}`);

    const { refusal, overrode } = await heldByPlanThreads({
      github,
      core,
      owner,
      repo,
      phase,
      prNumber,
      planFile,
      botLogin,
      forced: candidate.forced,
      by: `@${candidate.login}`,
      candidates: considered.length,
    });
    if (refusal) return refusal;

    if (ownScanned && (ownReplies === null || ownComments === null)) {
      return {
        required: true,
        blocked: true,
        reason:
          unreadable[0] ??
          `the conversation on #${prNumber} could not be read, and that is where this flow records that ` +
            'the plan was reworked - an approval given before a rework releases a document nobody approved, ' +
            'so this run cannot tell whether that is what it is looking at',
        candidates: considered.length,
      };
    }

    return {
      required: true,
      blocked: false,
      approval: {
        login: candidate.login,
        url: candidate.url,
        thread: candidate.thread,
        approvalRef: candidate.approvalRef ?? '',
      },
      release: { kind: 'github', login: candidate.login },
      releaseRef: releaseRef({ login: candidate.login }),
      released: already?.kind === 'github',
      acknowledged: ack.acknowledged === true || already?.kind === 'github',
      overrode,
    };
  }

  if (unreadable.length > 0) {
    return { required: true, blocked: true, reason: unreadable[0], candidates: considered.length };
  }
  if (stale) {
    return { required: true, blocked: true, reason: 'reworked-since-approval', candidates: considered.length };
  }
  return {
    required: true,
    blocked: true,
    reason: 'unauthorized-approver',
    candidates: considered.length,
  };
}

function describeApproval({ required = null, blocked = null, reason = null, approval = null, candidates = null } = {}) {
  if (!required) return 'approval is not required, so nothing is blocking';
  if (blocked) {
    const tried = typeof candidates === 'number' ? ` (${counted(candidates, 'approval')} considered)` : '';
    return `blocked: ${reason ?? 'no reason given'}${tried}`;
  }
  return approval?.login ? `approved by @${approval.login}` : 'approved';
}

const AWAITING = Object.freeze(
  Object.assign(Object.create(null), {
    'approve-disabled': Object.freeze({
      kind: 'plan-blocked',
      level: 'WARNING',
      said: () =>
        'A plan has to be approved before any of it is written, and this repository has the ' +
        '`approve` command turned off - so no review or comment can release this one and nothing will run. A code owner ' +
        'has to take `approve` out of `disabled_commands` in the workflow file',
    }),
    'unauthorized-approver': Object.freeze({
      kind: 'plan-waiting',
      level: 'IMPORTANT',
      said: ({ releaser }) =>
        'Someone approved this plan, but not anybody who may release it here, so nothing has started. ' +
        `${releaser[0].toUpperCase()}${releaser.slice(1)} can approve the draft pull request in GitHub or leave ` +
        'an explicit approval request in its conversation',
    }),
    'reworked-since-approval': Object.freeze({
      kind: 'plan-waiting',
      level: 'IMPORTANT',
      said: () =>
        'This plan was approved and the plan document has been reworked since, so nothing has ' +
        'started. The approval released the document that was there when it was given, not this one - read ' +
        'the plan again and approve the draft pull request, or leave an explicit approval request in its ' +
        'conversation',
    }),
    'unresolved-threads': Object.freeze({
      kind: 'plan-waiting',
      level: 'IMPORTANT',
      said: ({ openThreads }) => {
        const many = Number(openThreads);
        const named = Number.isFinite(many) && many > 0 ? counted(many, 'review thread') : 'review threads';
        return (
          `This plan was approved, and ${named} on the plan document ${plural(many, 'is', 'are')} waiting for an answer, so ` +
          'nothing has started. Submit a review and the plan is reworked in answer, or resolve each thread ' +
          'yourself, and then approve the draft pull request again. To approve over the wait instead, add `--force` ' +
          'to an explicit approval request: each waiting thread gets a reply and is resolved'
        );
      },
    }),
    'awaiting-approval': Object.freeze({
      kind: 'plan-waiting',
      level: 'IMPORTANT',
      said: ({ releaser }) =>
        `The plan is ready and waiting for ${releaser} to approve it. Nothing will run until one does, and ` +
        'the plan is on this draft pull request. Approve the pull request in GitHub or leave an explicit approval ' +
        'request in its conversation',
    }),
  }),
);

const AWAITING_UNNAMED = Object.freeze({
  kind: 'plan-blocked',
  level: 'WARNING',
  said: ({ reason }) => `This plan has not been released, and it is not simply waiting: ${reason}`,
});

function awaitingCase(reason) {
  const named = String(reason ?? '').trim();
  if (named === '') return AWAITING['awaiting-approval'];
  return AWAITING[named] ?? AWAITING_UNNAMED;
}

function awaitingKind(reason) {
  return awaitingCase(reason).kind;
}

function renderAwaiting({ reason = null, triggerPhrase = null, openThreads = null, writeAccessCommands = null } = {}) {
  const held = awaitingCase(reason);
  const releaser = releaserOf(writeAccessCommands);
  return asAlert(held.level, scrub(held.said({ releaser, openThreads, reason }), { triggerPhrase }));
}

module.exports = {
  APPROVABLE,
  awaitingKind,
  MAX_CANDIDATES,
  approvalApplies,
  isTrue,
  threadsToScan,
  withoutScan,
  resolveApproval,
  describeApproval,
  renderAwaiting,
};
