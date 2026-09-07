'use strict';

const { asAlert, scrubTrigger } = require('../lib/select-arm.cjs');
const { FLOW_BRANCH_SHAPE } = require('./verify-chunk.cjs');
const { isOwnLogin } = require('./threads.cjs');

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

async function ownPull({ github = null, core = null, owner = null, repo = null, prNumber = null, botLogin = null } = {}) {
  const number = Number(String(prNumber ?? '').trim());
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  if (!String(botLogin ?? '').trim()) return false;
  let pull;
  try {
    ({ data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
  } catch (error) {
    core?.info?.(`could not read #${number} to tell whether this flow opened it (${error?.message ?? error}).`);
    return false;
  }
  return FLOW_BRANCH_SHAPE.test(String(pull?.head?.ref ?? '')) && isOwnLogin(pull?.user?.login, botLogin);
}

function renderNudge({ triggerPhrase = null } = {}) {
  return asAlert('WARNING', scrubTrigger(NUDGE, triggerPhrase));
}

module.exports = { BARE_MODES, bareMode, ownPull, renderNudge };
