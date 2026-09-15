
const { parseOptions, DEFAULT_COMMAND } = require('../lib/select-arm.cjs');
const { nativeApprovalMarker, nativeApprovalOf, readNativeApprovalRef } = require('./native-approval-ref.cjs');
const {
  controlPlaneApprovalMarker,
  controlPlaneApprovalsIn,
  readControlPlaneApprovalRef,
} = require('./control-plane-approval.cjs');
const { triggerAlternation } = require('../lib/text.cjs');
const { markerOf, marked } = require('./marker.cjs');
const { planDocsIn, releasesIn, shapesIn } = require('./plan.cjs');

function requestOf(body, { trigger = null, commandAliases = null } = {}) {
  const text = String(body ?? '');

  const found = text.match(new RegExp(`(^|\\n)[ \\t]*${triggerAlternation(trigger)}(?=\\s|$)`));
  if (!found) return null;

  const parsed = parseOptions(text.slice(found.index + found[0].length).replace(/^[ \t]+/, ''), { commandAliases });
  if (parsed.error) return null;
  return { command: parsed.command ?? DEFAULT_COMMAND, forced: '--force' in (parsed.requested ?? {}) };
}

function commandOf(body, options) {
  return requestOf(body, options)?.command ?? null;
}

const EDITED = 'edited';

const UNEDITED = 'unedited';

const UNKNOWN = 'unknown';

function editState(comment) {
  if (comment && Object.hasOwn(comment, 'last_edited_at')) {
    const edited = comment.last_edited_at;
    if (edited === null) return UNEDITED;
    return typeof edited === 'string' && edited !== '' ? EDITED : UNKNOWN;
  }
  const made = String(comment?.created_at ?? '');
  const changed = String(comment?.updated_at ?? '');
  if (made === '' || changed === '') return UNKNOWN;
  return made === changed ? UNEDITED : EDITED;
}

const wasEdited = (comment) => editState(comment) === EDITED;

const LAST_EDITS_QUERY = 'query ($ids: [ID!]!) { nodes(ids: $ids) { ... on Comment { id lastEditedAt } } }';

const NODES_PER_QUERY = 100;

async function withLastEdits(comments, { graphql }) {
  const listed = comments ?? [];
  const ids = [
    ...new Set(listed.filter((comment) => comment?.node_id && wasEdited(comment)).map((comment) => comment.node_id)),
  ];
  const edits = new Map();
  for (let at = 0; at < ids.length; at += NODES_PER_QUERY) {
    const data = await graphql(LAST_EDITS_QUERY, { ids: ids.slice(at, at + NODES_PER_QUERY) });
    for (const node of data?.nodes ?? []) {
      if (node?.id && (node.lastEditedAt === null || typeof node.lastEditedAt === 'string')) {
        edits.set(node.id, node.lastEditedAt);
      }
    }
  }
  return listed.map((comment) =>
    edits.has(comment?.node_id) ? { ...comment, last_edited_at: edits.get(comment.node_id) } : comment,
  );
}

const FOREIGN = 'foreign';

function isOwnLogin(login, botLogin) {
  const bare = (value) => String(value ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
  const mine = bare(botLogin);
  return mine !== '' && bare(login) === mine;
}

const loginOf = (comment) => comment?.user?.login ?? comment?.login;

function ownState(comment, botLogin) {
  return isOwnLogin(loginOf(comment), botLogin) ? editState(comment) : FOREIGN;
}

const ownUnedited = (comment, botLogin) => {
  const state = ownState(comment, botLogin);
  return state === UNEDITED || state === UNKNOWN;
};

const vouchedOwn = (comment, botLogin) => ownState(comment, botLogin) === UNEDITED;

function findApprovals(comments, { trigger = null, commandAliases = null } = {}) {
  const byLogin = new Map();
  for (const comment of comments ?? []) {
    const login = comment?.user?.login;
    if (!login) continue;
    if (wasEdited(comment)) continue;
    const asked = requestOf(comment.body, { trigger, commandAliases });
    if (asked?.command !== 'approve') continue;
    const at = Date.parse(String(comment.created_at ?? '')) || 0;
    const held = byLogin.get(login);
    if (held && at <= held.at) {
      if (asked.forced) held.forced = true;
      continue;
    }
    byLogin.set(login, {
      login,
      url: comment.html_url ?? '',
      id: comment.id,
      forced: asked.forced || held?.forced === true,
      association: String(comment.author_association ?? ''),
      at,
    });
  }
  return [...byLogin.values()];
}

function findAcknowledgment(comments, { botLogin = null, approvalRef = null } = {}) {
  const known = String(botLogin ?? '').trim();
  if (!known) return { acknowledged: false, reason: 'no bot login was given to gate the marker on' };
  const wanted = String(approvalRef ?? '').trim();
  const fromControlPlane = readControlPlaneApprovalRef(wanted) !== null;
  if (!fromControlPlane && readNativeApprovalRef(wanted) === null) {
    return { acknowledged: false, reason: 'the native approval reference is not readable' };
  }

  for (const comment of comments ?? []) {
    if (!ownUnedited(comment, known)) continue;
    const body = String(comment.body ?? '');
    const receipted = fromControlPlane
      ? controlPlaneApprovalsIn(body).some((one) => one.approvalRef === wanted)
      : nativeApprovalOf(body) === wanted;
    if (!receipted) continue;
    return { acknowledged: true, url: comment.html_url ?? '', id: comment.id };
  }
  return { acknowledged: false };
}

const ANSWERED_KIND = 'revise-answered';

function offersPlan(comment) {
  if (markerOf(comment?.body)?.kind === ANSWERED_KIND) return true;
  return planDocsIn(comment?.body).length > 0;
}

function planRecords(comments, { botLogin = null } = {}) {
  const known = String(botLogin ?? '').trim();
  const seen = {
    offeredAt: null,
    offeredDocs: [],
    reworkedAt: null,
    shape: null,
    sealed: null,
    requester: null,
    releases: [],
    editedShape: false,
    editedRelease: false,
  };
  if (known === '') return seen;
  for (const comment of comments ?? []) {
    const state = ownState(comment, known);
    if (state === FOREIGN) continue;
    const offered = planDocsIn(comment?.body);
    if (offered.length > 0) {
      seen.offeredDocs = [];
      seen.offeredAt = comment.created_at;
    }
    if (offersPlan(comment)) {
      seen.sealed = null;
      const at = Date.parse(String(comment.created_at ?? ''));
      if (Number.isFinite(at) && (seen.reworkedAt === null || at > seen.reworkedAt)) seen.reworkedAt = at;
    }
    if (state !== UNEDITED) {
      if (shapesIn(comment?.body).length > 0) seen.editedShape = true;
      if (releasesIn(comment?.body).length > 0) seen.editedRelease = true;
      continue;
    }
    const release = releasesIn(comment.body).at(-1);
    if (release !== undefined) seen.releases.push(release);
    const shape = shapesIn(comment.body).at(-1);
    if (shape !== undefined) {
      seen.shape = shape;
      if (shape.requestedBy) seen.requester = shape.requestedBy;
      if (shape.digest !== '') seen.sealed = shape;
    }
    seen.offeredDocs.push(...offered);
  }
  return seen;
}

function lastRework(comments, { botLogin = null } = {}) {
  return planRecords(comments, { botLogin }).reworkedAt;
}

function renderApprovalReceipt({
  triggerPhrase = null,
  issueNumber = null,
  prNumber = null,
  runId = null,
  approvalRef = null,
  approver = null,
  ask = null,
} = {}) {
  const inJira = String(approvalRef ?? '').startsWith('cp/');
  const recorded = inJira ? controlPlaneApprovalMarker(approvalRef, approver) : nativeApprovalMarker(approvalRef);
  if (recorded === null) {
    throw new Error(
      inJira
        ? 'a readable control plane approval reference and approver are required'
        : 'a readable native approval reference is required',
    );
  }
  const said = inJira
    ? `Recorded the plan approval \`${String(approver).trim()}\` gave in Jira before changing the pull request head`
    : 'Recorded this GitHub approval before changing the pull request head';
  return marked(`${said}\n\n${recorded}`, {
    kind: 'plan-approved',
    flow: 'implement',
    command: 'approve',
    issue: issueNumber,
    pr: prNumber,
    run: runId,
    triggerPhrase,
    ask,
  });
}

module.exports = {
  commandOf,
  renderApprovalReceipt,
  findApprovals,
  findAcknowledgment,
  lastRework,
  offersPlan,
  planRecords,
  editState,
  wasEdited,
  withLastEdits,
  isOwnLogin,
  ownState,
  ownUnedited,
  vouchedOwn,
  EDITED,
  FOREIGN,
  UNEDITED,
  UNKNOWN,
};
