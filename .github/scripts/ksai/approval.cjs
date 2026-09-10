
const { parseOptions, DEFAULT_COMMAND } = require('../lib/select-arm.cjs');
const { nativeApprovalOf, readNativeApprovalRef } = require('./native-approval-ref.cjs');
const { triggerAlternation } = require('../lib/text.cjs');
const { markerOf } = require('./marker.cjs');
const { planDocsIn } = require('./plan.cjs');

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
  const made = String(comment?.created_at ?? '');
  const changed = String(comment?.updated_at ?? '');
  if (made === '' || changed === '') return UNKNOWN;
  return made === changed ? UNEDITED : EDITED;
}

const wasEdited = (comment) => editState(comment) === EDITED;

const vouchedUnedited = (comment) => editState(comment) === UNEDITED;

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
  if (readNativeApprovalRef(wanted) === null) {
    return { acknowledged: false, reason: 'the native approval reference is not readable' };
  }

  for (const comment of comments ?? []) {
    if (!ownUnedited(comment, known)) continue;
    if (nativeApprovalOf(String(comment.body ?? '')) !== wanted) continue;
    return { acknowledged: true, url: comment.html_url ?? '', id: comment.id };
  }
  return { acknowledged: false };
}

const ANSWERED_KIND = 'revise-answered';

function offersPlan(comment) {
  if (markerOf(comment?.body)?.kind === ANSWERED_KIND) return true;
  return planDocsIn(comment?.body).length > 0;
}

function lastRework(comments, { botLogin = null } = {}) {
  const known = String(botLogin ?? '').trim();
  if (known === '') return null;
  let newest = null;
  for (const comment of comments ?? []) {
    if (ownState(comment, known) === FOREIGN) continue;
    if (!offersPlan(comment)) continue;
    const at = Date.parse(String(comment.created_at ?? ''));
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

module.exports = {
  commandOf,
  findApprovals,
  findAcknowledgment,
  lastRework,
  offersPlan,
  editState,
  wasEdited,
  vouchedUnedited,
  isOwnLogin,
  ownState,
  ownUnedited,
  vouchedOwn,
  EDITED,
  FOREIGN,
  UNEDITED,
  UNKNOWN,
};
