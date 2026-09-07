'use strict';

const { scrub } = require('./plan.cjs');
const { asAlert } = require('../lib/select-arm.cjs');
const { counted, plural } = require('../lib/text.cjs');
const { MAX_ATTEMPTS } = require('../lib/write-record.cjs');

const MAX_STALL = 3;

const WORKFLOW_FILE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;

const MAX_INPUTS = 25;

const MAX_INPUT_CHARS = 200;

function readCount(value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d{1,15}$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

function progress({ remaining = null, prevRemaining = null, prevStall = null } = {}) {
  const now = readCount(remaining);
  const before = readCount(prevRemaining);
  const stalled = readCount(prevStall, { max: MAX_ATTEMPTS }) ?? 0;
  if (now === null) return { moved: false, stall: stalled + 1 };
  if (before === null) return { moved: true, stall: 0 };
  const moved = now !== before;
  return { moved, stall: moved ? 0 : stalled + 1 };
}

function shouldContinue({ remaining = null, stall = null, attempt = null } = {}) {
  const left = readCount(remaining);
  const stalls = readCount(stall, { max: MAX_ATTEMPTS }) ?? 0;
  const tries = readCount(attempt, { max: MAX_ATTEMPTS }) ?? 0;
  const state = { stall: stalls, attempt: tries };
  if (left === 0) return { go: false, reason: 'finished', ...state };
  if (stalls >= MAX_STALL) return { go: false, reason: 'stalled', ...state };
  if (tries >= MAX_ATTEMPTS) return { go: false, reason: 'attempts', ...state };
  return { go: true, reason: null, ...state };
}

function decideContinuation({
  phase = null,
  remaining = null,
  prevRemaining = null,
  prevStall = null,
  attempt = null,
  handsOff = null,
} = {}) {
  const tries = readCount(attempt, { max: MAX_ATTEMPTS }) ?? 0;

  if (String(phase) === 'plan' || String(phase) === 'plan-review') {
    if (tries > 0) {
      return { go: false, reason: 'plan-not-retried', stall: tries, attempt: tries, remainingForSuccessor: '' };
    }
    return { go: true, reason: null, stall: 0, attempt: tries, remainingForSuccessor: '' };
  }

  const moved = progress({ remaining, prevRemaining, prevStall });
  const verdict = shouldContinue({ remaining, stall: moved.stall, attempt: tries });
  const seen = readCount(remaining);
  const idle = String(handsOff) === 'true';
  return { ...verdict, remainingForSuccessor: idle || seen === null ? '' : String(seen) };
}

function renderStop({ reason = null, stall = null, attempt = null, remaining = null, triggerPhrase = null } = {}) {
  const out = (text) => asAlert('WARNING', scrub(text, { triggerPhrase }));
  const left = readCount(remaining);
  const boxes = left === null ? 'unfinished steps' : counted(left, 'unfinished step');
  if (reason === 'stalled') {
    return out(
      `Stopped after ${readCount(stall) ?? MAX_STALL} consecutive runs that completed no step, with ${boxes} left. ` +
      'Something is failing the same way each time; the run logs for those attempts say which step and why. ' +
      'Re-triggering the bot on this issue resumes from the first unchecked box once it is fixed'
    );
  }
  if (reason === 'plan-not-retried') {
    return out(
      'Stopped: the previous run produced no plan, and a plan is not retried automatically. ' +
      'Each attempt runs the model again, and a dispatched run may continue work somebody asked for but may ' +
      'not start any - it skips the CODEOWNERS check on exactly that argument. The run log for the previous ' +
      'attempt says what the plan was rejected for; re-triggering the bot on this issue starts a fresh chain'
    );
  }
  if (reason === 'attempts') {
    return out(
      `Stopped after ${readCount(attempt) ?? MAX_ATTEMPTS} runs, with ${boxes} left. ` +
      'That is the hard ceiling on one chain rather than a failure of any single step. ' +
      'Re-triggering the bot on this issue starts a fresh chain from the first unchecked box'
    );
  }
  return null;
}

function renderUndispatched({ reason = null, remaining = null, triggerPhrase = null } = {}) {
  const left = readCount(remaining);
  const boxes = left === null ? 'unfinished steps' : counted(left, 'unfinished step');
  return asAlert(
    'WARNING',
    scrub(
      `This run finished its work and GitHub would not start the next one, so nothing is running now and ` +
        `there ${plural(left, 'is', 'are')} ${boxes} left: ${reason}. ` +
        'Re-triggering the bot resumes from the first unchecked box',
      { triggerPhrase },
    ),
  );
}

const DISPATCH_REF_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]|\/(?=[A-Za-z0-9]))*$/;

function dispatchableRef(ref) {
  const said = String(ref ?? '').trim();
  if (said.length === 0 || said.length > 200) return '';
  if (said.includes('..') || said.endsWith('.lock')) return '';
  if (/\/(merge|head)$/.test(said)) return '';
  return DISPATCH_REF_SHAPE.test(said) ? said : '';
}

async function resolveRef({
  github = null,
  core = null,
  owner = null,
  repo = null,
  defaultBranch = null,
  ref = null,
  checkProtection = true,
} = {}) {
  let branch = dispatchableRef(ref);
  if (branch) return checkProtection ? warnUnprotected({ github, core, owner, repo, branch }) : { ref: branch };
  branch = typeof defaultBranch === 'string' ? defaultBranch.trim() : '';
  if (!branch) {
    try {
      const { data } = await github.rest.repos.get({ owner, repo });
      branch = String(data?.default_branch ?? '').trim();
    } catch (error) {
      return { error: `could not read the default branch of ${owner}/${repo}: ${error.message}` };
    }
  }
  if (!branch) return { error: `${owner}/${repo} reported no default branch` };
  if (!checkProtection) return { ref: branch };
  return warnUnprotected({ github, core, owner, repo, branch });
}

async function warnUnprotected({ github, core, owner, repo, branch }) {
  try {
    const { data } = await github.rest.repos.getBranch({ owner, repo, branch });
    if (data?.protected !== true) {
      core?.warning?.(
        `${owner}/${repo}'s \`${branch}\` does not report branch protection. ` +
          'A ruleset is not reported here, so this may be nothing. If the successor run fails to ' +
          'mint a federated token, an unprotected ref is why: the federation rule ' +
          'requires ref_protected.',
      );
    }
  } catch (error) {
    core?.warning?.(`could not check branch protection on \`${branch}\`: ${error.message}`);
  }
  return { ref: branch };
}

function normalizeInputs(inputs) {
  if (inputs === null || inputs === undefined) return { inputs: {} };
  if (typeof inputs !== 'object' || Array.isArray(inputs)) return { error: 'dispatch inputs must be an object' };
  const entries = Object.entries(inputs).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length > MAX_INPUTS) {
    return { error: `a workflow_dispatch takes at most ${MAX_INPUTS} inputs, got ${entries.length}` };
  }
  const out = Object.create(null);
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) return { error: `dispatch input name \`${key}\` is not a plain identifier` };
    const text = String(value);
    if (text.length > MAX_INPUT_CHARS) {
      return { error: `dispatch input \`${key}\` is ${text.length} characters, over the ${MAX_INPUT_CHARS} cap` };
    }
    out[key] = text;
  }
  return { inputs: out };
}

async function dispatchSuccessor({
  github = null,
  core = null,
  owner = null,
  repo = null,
  workflowFile = null,
  defaultBranch = null,
  ref = null,
  inputs = null,
  checkProtection = true,
} = {}) {
  if (!github?.rest) return { ok: false, reason: 'no authenticated GitHub client was passed' };
  if (typeof workflowFile !== 'string' || !WORKFLOW_FILE_SHAPE.test(workflowFile)) {
    return { ok: false, reason: `\`${String(workflowFile)}\` is not a workflow filename` };
  }
  const normalized = normalizeInputs(inputs);
  if (normalized.error) return { ok: false, reason: normalized.error };
  const resolved = await resolveRef({ github, core, owner, repo, defaultBranch, ref, checkProtection });
  if (resolved.error) return { ok: false, reason: resolved.error };
  try {
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowFile,
      ref: resolved.ref,
      inputs: { ...normalized.inputs },
    });
  } catch (error) {
    const status = error?.status;
    if (status === 404) {
      return {
        ok: false,
        reason:
          `GitHub has no dispatchable \`${workflowFile}\` on \`${resolved.ref}\` in ${owner}/${repo}. ` +
          'A workflow is dispatchable only from the default branch and only with a `workflow_dispatch` ' +
          'trigger, so a workflow added on a branch, or one without that trigger, reports 404 here.',
      };
    }
    if (status === 403) {
      return {
        ok: false,
        reason:
          `the token was refused permission to dispatch \`${workflowFile}\`. ` +
          'Dispatching needs `actions: write`. Declaring that in the job\'s `permissions:` block grants ' +
          'it to GITHUB_TOKEN and to nothing else, so this only works if the dispatch is made with ' +
          'GITHUB_TOKEN - an App installation token carries only the scopes it was minted with. ' +
          'Naming just the permission sent a reader to a block they had already filled in correctly.',
      };
    }
    return { ok: false, reason: `dispatching \`${workflowFile}\` failed: ${error.message}` };
  }
  core?.info?.(`dispatched ${workflowFile} on ${resolved.ref}`);
  return { ok: true, ref: resolved.ref };
}

function stopsHere({ handsOff = null, started = null } = {}) {
  return String(handsOff) === 'true' && started === true ? 'true' : '';
}

module.exports = {
  MAX_STALL,
  MAX_ATTEMPTS,
  WORKFLOW_FILE_SHAPE,
  MAX_INPUTS,
  MAX_INPUT_CHARS,
  readCount,
  progress,
  shouldContinue,
  decideContinuation,
  stopsHere,
  renderStop,
  renderUndispatched,
  resolveRef,
  normalizeInputs,
  dispatchSuccessor,
};
