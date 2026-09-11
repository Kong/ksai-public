'use strict';

const { asAlert, scrubTrigger } = require('../lib/select-arm.cjs');
const { FLOW_BRANCH_SHAPE } = require('./verify-chunk.cjs');
const { isOwnLogin } = require('./threads.cjs');
const { MARKER: FINDING_MARKER } = require('../lib/folded-findings.cjs');

const BARE_MODES = Object.freeze(['auto', 'off']);

const NUDGE =
  'That reads as agreeing to the plan, and consent to release it is named rather than read out of prose, so ' +
  'nothing ran. Comment this repository\'s trigger phrase followed by `approve` and the next phase starts';

function bareMode({ input = null, fromFile = null } = {}) {
  const asked = String(input ?? '').trim().toLowerCase() || 'auto';
  if (!BARE_MODES.includes(asked)) {
    return {
      error:
        `bare_comments must be one of ${BARE_MODES.join(', ')}, got '${String(input)}'. A third value would ` +
        'leave a repository believing comments without the trigger phrase were ignored while they steered ' +
        'runs, or the reverse.',
    };
  }
  const narrowed = String(fromFile ?? '').trim().toLowerCase();
  if (narrowed === '') return { mode: asked };
  if (!BARE_MODES.includes(narrowed)) {
    return { error: `the \`bare_comments\` value in this repository's config must be one of ${BARE_MODES.join(', ')}` };
  }
  return { mode: asked === 'off' || narrowed === 'off' ? 'off' : 'auto' };
}

async function ownedBy({ core, botLogin, id, named, read, holds }) {
  const number = Number(String(id ?? '').trim());
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  if (!String(botLogin ?? '').trim()) return false;
  let data;
  try {
    ({ data } = await read(number));
  } catch (error) {
    core?.info?.(`could not read ${named(number)} (${error?.message ?? error}).`);
    return false;
  }
  return holds(data);
}

const ownPull = ({ github = null, core = null, owner = null, repo = null, prNumber = null, botLogin = null } = {}) =>
  ownedBy({
    core,
    botLogin,
    id: prNumber,
    named: (number) => `#${number} to tell whether this flow opened it`,
    read: (number) => github.rest.pulls.get({ owner, repo, pull_number: number }),
    holds: (pull) => FLOW_BRANCH_SHAPE.test(String(pull?.head?.ref ?? '')) && isOwnLogin(pull?.user?.login, botLogin),
  });

const ownThread = ({ github = null, core = null, owner = null, repo = null, rootId = null, botLogin = null } = {}) =>
  ownedBy({
    core,
    botLogin,
    id: rootId,
    named: (number) => `review comment ${number} to tell whether this flow's review opened it`,
    read: (number) => github.rest.pulls.getReviewComment({ owner, repo, comment_id: number }),
    holds: (root) => isOwnLogin(root?.user?.login, botLogin) && String(root?.body ?? '').includes(FINDING_MARKER),
  });

function ownSurface({ github = null, core = null, owner = null, repo = null, botLogin = null, rootId = null, prNumber = null } = {}) {
  const where = { github, core, owner, repo, botLogin };
  return String(rootId ?? '').trim() === '' ? ownPull({ ...where, prNumber }) : ownThread({ ...where, rootId });
}

function renderNudge({ triggerPhrase = null } = {}) {
  return asAlert('WARNING', scrubTrigger(NUDGE, triggerPhrase));
}

function renderUnaddressed(command, { triggerPhrase = null } = {}) {
  const said =
    `That reads as a request to \`${command}\`, and a comment naming no command only steers the implement flow, ` +
    `so nothing ran. Comment this repository's trigger phrase followed by \`${command}\` to start it`;
  return asAlert('NOTE', scrubTrigger(said, triggerPhrase));
}

module.exports = { BARE_MODES, bareMode, ownPull, ownSurface, ownThread, renderNudge, renderUnaddressed };
