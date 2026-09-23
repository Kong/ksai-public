'use strict';

const { writerFor } = require('../lib/cp-effects.cjs');
const { usingControlPlane } = require('../lib/control-plane.cjs');
const { marked } = require('./marker.cjs');
const { LOGIN_SHAPE, scrub } = require('./plan.cjs');

function renderReady({ requester = null, issueNumber = null, stillDraft = false, triggerPhrase = null } = {}) {
  const login = LOGIN_SHAPE.test(String(requester ?? '')) ? String(requester) : null;
  const issue = Number(issueNumber);
  const lines = [];
  const opening = stillDraft
    ? 'every step in the plan is done, but this could not be taken out of draft - the run log says why. Marking it ready by hand is all that is left.'
    : 'every step in the plan is done and this is ready for review.';
  lines.push(login ? `@${login} ${opening}` : opening, '');
  const reference = Number.isInteger(issue) && issue > 0 ? `Implements #${issue}, which this pull request body closes. ` : '';
  lines.push(`${reference}Each commit here completes one task from the plan, so the log reads in plan order`);
  return scrub(lines.join('\n'), { triggerPhrase });
}

async function markReady({ github = null, core = null, owner = null, repo = null, prNumber = null, pull = null,
  env = {}, fetch = globalThis.fetch } = {}) {
  let nodeId;
  try {
    const data = pull ?? (await github.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
    if (data?.draft !== true) {
      core?.info?.(`#${prNumber} is already out of draft.`);
      return { ready: true, changed: false };
    }
    nodeId = data?.node_id;
  } catch (error) {
    return { ready: false, reason: `could not read pull request #${prNumber}: ${error.message}` };
  }
  if (typeof nodeId !== 'string' || nodeId === '') {
    return { ready: false, reason: `pull request #${prNumber} reported no node id to mark ready` };
  }
  try {
    const result = await writerFor({ github, owner, repo, env, fetch }).markReady({ node: nodeId });
    const isDraft = result.ready === null ? null : !result.ready;
    if (isDraft === true) {
      return { ready: false, reason: `#${prNumber} is still a draft after the mutation reported no error` };
    }
    if (isDraft !== false) {
      return { ready: false, reason: `#${prNumber} returned no draft state, so it cannot be reported ready` };
    }
    return { ready: true, changed: true };
  } catch (error) {
    return { ready: false, reason: `could not mark #${prNumber} ready: ${error.message}` };
  }
}

async function finish({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  issueNumber = null,
  requester = null,
  runId = null,
  pull = null,
  triggerPhrase = null,
  command = null,
  ask = null,
  dryRun = false,
  env = {},
  fetch = globalThis.fetch,
} = {}) {
  if (!github?.rest) return { error: 'no authenticated GitHub client was passed' };
  if (!Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    return { error: `\`${String(prNumber)}\` is not a pull request number` };
  }
  if (dryRun) {
    const body = renderReady({ requester, issueNumber, stillDraft: false, triggerPhrase });
    core?.info?.(`dry run, so #${prNumber} was left as it is and no comment posted. It would have said:\n${body}`);
    return { ready: null, notified: null, body };
  }

  const readied = await markReady({ github, core, owner, repo, prNumber, pull, env, fetch });
  if (!readied.ready) core?.warning?.(readied.reason);
  else core?.info?.(readied.changed ? `#${prNumber} is now ready for review.` : `#${prNumber} was already ready.`);
  const localBody = () => marked(renderReady({ requester, issueNumber, stillDraft: !readied.ready, triggerPhrase }), {
    kind: 'run-finished', flow: 'implement', command, issue: issueNumber,
    pr: prNumber, run: runId, triggerPhrase, ask,
  });
  const cp = usingControlPlane(env);
  let body = '';
  try {
    const writer = writerFor({ github, owner, repo, env, fetch });
    if (cp) {
      await writer.surfaceComment({ number: Number(prNumber), surface: { ready: {
        requester, issue: String(issueNumber ?? ''), pull: String(prNumber), run: String(runId ?? ''),
        command: String(command ?? ''), trigger: String(triggerPhrase ?? ''), ask: String(ask ?? ''),
        still_draft: !readied.ready,
      } } });
    } else {
      body = localBody();
      await writer.comment({ number: Number(prNumber), body });
    }
  } catch (error) {
    if (cp && error.cpUnavailable === true) {
      core?.warning?.(`the control plane could not post the completion notice: ${error.message}`);
      try {
        body = localBody();
        await writerFor({ github, owner, repo, env: { ...env, KSAI_GITHUB_CALLS: 'local' }, fetch })
          .comment({ number: Number(prNumber), body });
      } catch (fallbackError) {
        core?.warning?.(`could not comment on #${prNumber}: ${fallbackError.message}`);
        return { ready: readied.ready, reason: readied.reason ?? null, notified: null, body };
      }
    } else {
      core?.warning?.(`could not comment on #${prNumber}: ${error.message}`);
      return { ready: readied.ready, reason: readied.reason ?? null, notified: null, body };
    }
  }
  const login = LOGIN_SHAPE.test(String(requester ?? '')) ? String(requester) : null;
  return { ready: readied.ready, reason: readied.reason ?? null, notified: login, body };
}

module.exports = { renderReady, markReady, finish };
