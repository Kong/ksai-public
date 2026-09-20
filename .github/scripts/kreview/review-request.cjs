const { usableNonce } = require('../lib/prompt-text.cjs');
const { SALVAGE_MARGIN_MINUTES } = require('../lib/watchdog.cjs');
const { SINKS, renderRequest } = require('../lib/render-request.cjs');

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_MINUTES = 1440;

function text(value) {
  return String(value ?? '');
}

function fieldsOf(fields) {
  return (fields ?? []).map((field) => ({
    name: text(field.name),
    path: text(field.path),
    tag: text(field.name).replaceAll('_', '-'),
    body: text(field.body),
    injected: field.body !== null && field.body !== undefined,
  }));
}

function reviewersOf(reviewers, injected) {
  return (reviewers ?? []).map((reviewer) => ({
    skill: text(reviewer.skill),
    agent: text(reviewer.agent),
    agent_path: text(reviewer.agentPath),
    body: injected ? text(reviewer.body) : '',
    fields: fieldsOf(reviewer.fields),
  }));
}

function scopeOf(reviewers) {
  if (reviewers.length < 2) return 'none';
  return reviewers.some((reviewer) => reviewer.agent === 'default-code-reviewer') ? 'with-default' : 'languages';
}

function budgetOf(value) {
  const minutes = Number(value);
  const enabled = Number.isInteger(minutes) && minutes > SALVAGE_MARGIN_MINUTES;
  return {
    enabled,
    minutes: Number.isInteger(minutes) ? minutes : 0,
    stop_after_minutes: enabled ? Math.min(minutes - SALVAGE_MARGIN_MINUTES, MAX_MINUTES) : 0,
  };
}

function reviewOf(options) {
  const baseSha = text(options.baseSha);
  if (!COMMIT_SHA.test(baseSha)) throw new Error('a governed review names the base commit its diff was taken against');
  const reviewers = reviewersOf(options.reviewers, true);
  const told = usableNonce(options.channelNonce);
  const shortstat = text(options.shortstat).trim();
  return {
    available: reviewersOf(options.available, false),
    base_sha: baseSha,
    budget: budgetOf(options.budgetMinutes),
    changed_files_path: text(options.changedFilesPath),
    channel: { enabled: told, nonce: told ? text(options.channelNonce) : '' },
    common: fieldsOf(options.common),
    conventions_dir: text(options.conventionsDir),
    diff_path: text(options.diffPath),
    has_rules: text(options.rules).trim() !== '',
    has_shortstat: shortstat !== '',
    pipeline: Boolean(options.pipeline),
    reviewers,
    route: reviewers.length > 0 ? 'routed' : 'open',
    scope: scopeOf(reviewers),
    shortstat,
    workspace: text(options.workspace),
  };
}

function reviewRenderRequest(options = {}) {
  return renderRequest({
    promptId: 'runtime.review',
    sink: SINKS.review,
    model: text(options.model),
    inputs: [
      { name: 'additional_prompt', value: text(options.additionalPrompt) },
      { name: 'prior_findings', value: text(options.priorFindings) },
      { name: 'repo_rules', value: text(options.rules) },
      { name: 'request', value: text(options.request) },
      { name: 'review', value: reviewOf(options) },
    ],
  });
}

module.exports = { reviewRenderRequest };
