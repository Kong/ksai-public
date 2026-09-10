const fs = require('node:fs');
const { CLARIFY_VERDICT, NO_VERDICT, actOnVerdict, renderClarification, renderStandDown, verdictOf } =
  require('../ksai/classify.cjs');
const loadKsaiConfig = require('../ksai/config.cjs');
const { EXTRA_ARGS_REFUSAL, toolPolicy, validateExtraArgs } = require('../lib/claude-args.cjs');
const {
  HELP_COMMAND,
  commandAuthorized,
  commandEnabled,
  ownsCommand,
  renderConfigRejection,
  renderHelp,
  renderRejection,
  renderUnauthorized,
  selectArm,
  surfaceOfEvent,
  MODEL_SHAPE,
} = require('../lib/select-arm.cjs');
const { receiptOf, sourceOf } = require('../lib/request-intent.cjs');
const { ceilingMinutes } = require('../lib/watchdog.cjs');
const { skipsAuthor, triage } = require('../triage/policy.cjs');
const { renderReviewPrompt, renderPipelineContext } = require('./prompt.cjs');
const { STRATEGIES, experimentOf, promptDigest } = require('./review-pipeline.cjs');
const { availableReviewers, bodyOf, resolveReviewers, sharedFields } = require('./reviewers.cjs');

const PLUGIN_DIR = '_ksai/plugins/kreview';

const NO_TRIAGE_DEFAULTS = { tier: null, effort: null, skills: [], skip: null, apiSurface: false, facts: null };
const NO_TRIAGE = Object.freeze(NO_TRIAGE_DEFAULTS);

function telemetryTag(value) {
  return String(value ?? '').replace(/[, =]/g, '_');
}

/**
 * The logins that wrote the commits on the head, for the author skip alone.
 *
 * A commit GitHub resolved to no account answers an empty string rather than being dropped, and a
 * failed call answers an empty list, which the policy reads as a truncated one.
 */
async function commitAuthorsOf({ github, core, owner, repo, pull_number }) {
  try {
    const commits = await github.paginate(github.rest.pulls.listCommits, {
      owner, repo, pull_number, per_page: 100,
    });
    return commits.map((commit) => commit.author?.login ?? '');
  } catch (error) {
    core?.warning?.(`Could not read who wrote the commits, so the review runs: ${error.message}`);
    return [];
  }
}

async function runTriage({ github, core, owner, repo, prNumber }) {
  let result = NO_TRIAGE;
  try {
    const pull_number = Number(prNumber);
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
    const author = pr.user?.login;
    const commitAuthors = skipsAuthor(author)
      ? await commitAuthorsOf({ github, core, owner, repo, pull_number })
      : null;
    result = triage({
      author,
      commitAuthors,
      commitCount: pr.commits,
      changedFiles: pr.changed_files,
      files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
    });
  } catch (error) {
    core?.warning?.(`Triage failed, falling back to the configured arm: ${error.message}`);
  }

  const outputs = {
    tier: result.tier ?? '',
    effort: result.effort ?? '',
    skills: result.skills.join(','),
    skip: result.skip ? 'true' : 'false',
    skip_reason: result.skip?.reason ?? '',
    skip_by: result.skip?.by ?? '',
    api_surface: result.apiSurface ? 'true' : 'false',
    files: result.facts ? String(result.facts.reviewableFiles) : '',
    lines: result.facts ? String(result.facts.reviewableLines) : '',
    risk: result.facts?.risk ? 'true' : 'false',
    why: (result.facts?.reasons ?? []).slice(0, 3).join('; '),
  };
  return outputs;
}

async function selectReviewArm({ github, core, owner, repo, env }) {
  const outputs = {
    error: '',
    rejection: '',
    skipped: 'false',
    stand_down_notice: '',
    model: '',
    effort: '',
    selected_by: '',
    command: '',
    route_source: '',
    route_surface: '',
    receipt: '',
    write_access_commands: '',
    prompt_content_html: '',
    prompt_content_report: '',
  };

  const config = await loadKsaiConfig({ github, core, owner, repo });
  if (config.error) {
    Object.assign(outputs, {
      error: config.error,
      rejection: renderConfigRejection(config.error, env.TRIGGER),
    });
    return { ...outputs, rejected: `Rejected the command alias config: ${config.error}`, note: '' };
  }

  const result = selectArm({
    prompt: env.PROMPT ?? '',
    defaultModel: env.DEFAULT_MODEL,
    defaultEffort: env.DEFAULT_EFFORT,
    allowedModels: env.ALLOWED_MODELS,
    disabledCommands: env.DISABLED_COMMANDS,
    writeAccessCommands: env.WRITE_ACCESS_COMMANDS,
    writeAccessFromFile: config.writeAccess,
    legacyAllowedCommands: env.LEGACY_ALLOWED_COMMANDS,
    maxEffort: env.MAX_EFFORT,
    minEffort: env.MIN_EFFORT,
    triage: { tier: env.TRIAGE_TIER, effort: env.TRIAGE_EFFORT },
    commandAliases: config.aliases,
    onIssue: false,
    threadRootId: env.THREAD_ROOT_ID,
  });
  if (!result.error && env.SHADOW_MODEL) {
    if (env.PUBLISH !== 'false' || !MODEL_SHAPE.test(env.SHADOW_MODEL)) result.error = 'shadow_model requires an unpublished review and a model ID';
    else {
      const shadow = selectArm({ prompt: `review --model ${env.SHADOW_MODEL}`, defaultModel: env.DEFAULT_MODEL, defaultEffort: result.effort, allowedModels: env.ALLOWED_MODELS, minEffort: env.MIN_EFFORT, maxEffort: env.MAX_EFFORT });
      if (shadow.error) result.error = shadow.error;
      else Object.assign(result, { model: shadow.model, selectedBy: 'override' });
    }
  }
  if (result.error) {
    const { error, allowed, ceiling, floor, command } = result;
    Object.assign(outputs, {
      error,
      rejection: renderRejection({ error, allowed, ceiling, floor, command, trigger: env.TRIGGER }),
    });
    return { ...outputs, rejected: `Rejected model/effort selection: ${result.error}`, note: '' };
  }

  const helps = result.command === HELP_COMMAND;
  const read = result.commandNamed ? '' : String(env.CLASSIFIED_COMMAND ?? '').trim();
  const verdict = read === CLARIFY_VERDICT ? CLARIFY_VERDICT : read === '' ? '' : verdictOf(read, env.DISABLED_COMMANDS);
  const routed = verdict !== '' && verdict !== NO_VERDICT;
  const clarified = verdict === CLARIFY_VERDICT;
  const owns =
    clarified
      ? false
      : routed
        ? actOnVerdict(verdict, { flow: 'reviewer', onIssue: false })
        : ownsCommand('reviewer', result.command);
  const wanted = routed ? verdict : result.command;
  const enabled = commandEnabled(wanted, { flow: 'reviewer', disabledCommands: env.DISABLED_COMMANDS });
  const bar = commandAuthorized(wanted, {
    codeowner: env.CODEOWNER,
    write: env.WRITE_ACCESS,
    writeAccessCommands: result.writeAccess,
  });
  const reviews = owns && enabled && (!bar.read || bar.authorized);
  const routeSurface = surfaceOfEvent(false, env.THREAD_ROOT_ID);
  const routeSource = sourceOf({ classified: routed, named: result.commandNamed });

  Object.assign(outputs, {
    skipped: reviews ? 'false' : 'true',
    stand_down_notice:
      helps
        ? renderHelp({
            onIssue: false,
            threadRootId: env.THREAD_ROOT_ID,
            triggerPhrase: env.TRIGGER,
            disabledCommands: env.DISABLED_COMMANDS,
          })
        : verdict === CLARIFY_VERDICT
        ? renderClarification({ triggerPhrase: env.TRIGGER, disabledCommands: env.DISABLED_COMMANDS })
        : routed && !owns
        ? renderStandDown(verdict, { flow: 'reviewer', onIssue: false, repo: `${owner}/${repo}`, triggerPhrase: env.TRIGGER })
        : owns && enabled && bar.read && !bar.authorized
        ? renderUnauthorized({
            repo: `${owner}/${repo}`,
            triggerPhrase: env.TRIGGER,
            command: wanted,
            bar: bar.bar,
            undecided: bar.undecided,
            write: env.WRITE_ACCESS,
            writeAccessCommands: result.writeAccess,
          })
        : '',
    model: helps ? '' : result.model,
    effort: helps ? '' : result.effort,
    selected_by: helps ? '' : result.selectedBy,
    command: clarified ? '' : wanted,
    route_source: clarified ? '' : routeSource,
    route_surface: clarified ? '' : routeSurface,
    receipt: reviews ? receiptOf(wanted, routeSurface, routeSource) : '',
    prompt_content_html: helps ? '' : result.promptHtml,
    prompt_content_report: helps ? '' : result.promptReport,
    write_access_commands: (result.writeAccess ?? []).join(' '),
  });

  const note =
    helps
      ? 'Command `help` was named, so this action published the command guide.'
      : verdict === ''
      ? `Command \`${result.command}\` was ${result.commandNamed ? 'named in the comment' : 'the default'}.`
      : verdict === NO_VERDICT
        ? `The comment reads as \`${NO_VERDICT}\`, which routes nothing, so command \`${result.command}\` decides ` +
          `and this action ${reviews ? 'reviews it' : 'stands aside'}.`
        : `The comment reads as \`${verdict}\`, so this action ${reviews ? 'reviews it' : 'stands down'}.`;
  return { ...outputs, rejected: null, note };
}

function buildReviewPrompt({ env }) {
  const outputs = {
    file: '',
    allowed_tools: '',
    disallowed_tools: '',
    plugin_dir: '',
    error: '',
  };
  const strategy = env.REVIEW_STRATEGY || 'baseline';
  let experiment;
  try {
    if (!STRATEGIES.includes(strategy)) throw new Error('review_strategy must be baseline, evidence or dual');
    if (env.RUNTIME_SHA && env.RUNTIME_SHA !== env.PLUGIN_SHA) throw new Error('review runtime and plugin checkouts disagree; retry against one immutable ref');
    experiment = experimentOf(env.REVIEW_EXPERIMENT || '', { head: env.COMMIT_ID || '', base: env.BASE_SHA || '', plugin: env.PLUGIN_SHA || '', publish: env.PUBLISH !== 'false' });
  } catch (error) {
    outputs.error = error.message;
    return { outputs, error: outputs.error };
  }

  const policy = toolPolicy('review');
  const pluginRoot = `${env.WORKSPACE}/${PLUGIN_DIR}`;
  const routed = resolveReviewers(env.TRIAGE_SKILLS, pluginRoot);
  const open = routed.reviewers.length > 0 ? { reviewers: [], refused: [] } : availableReviewers(pluginRoot);
  const auditorPath = `${pluginRoot}/agents/findings-auditor.md`;
  const common = sharedFields(pluginRoot).map((field) => ({ ...field, body: bodyOf(field.path) }));
  const carry = (entry) => ({ ...entry, body: bodyOf(entry.agentPath) });
  const mandates = { routed: routed.reviewers.map(carry), open: open.reviewers.map(carry) };
  const unreadable = [...mandates.routed, ...mandates.open, ...common]
    .filter((entry) => entry.body === null)
    .map((entry) => entry.agentPath ?? entry.path);
  const refusal =
    routed.refused.length > 0
      ? `triage named a reviewer this checkout cannot resolve: ${routed.refused.join('; ')}`
      : open.refused.length > 0
        ? `the plugin checkout carries a skill with no reviewer: ${open.refused.join('; ')}`
        : routed.reviewers.length === 0 && open.reviewers.length === 0
          ? `no reviewer mandate was found under ${pluginRoot}/skills`
          : common.length === 0
            ? `the plugin checkout carries no shared policy under ${pluginRoot}/resources`
            : unreadable.length > 0
              ? `the plugin checkout holds a file the prompt could not read: ${unreadable.join('; ')}`
              : !fs.existsSync(auditorPath)
                ? `the plugin checkout carries no auditor mandate at ${auditorPath}`
                : '';
  if (refusal !== '') {
    outputs.error = refusal;
    return { outputs, error: refusal };
  }

  const options = {
    baseRef: env.BASE_REF,
    workspace: env.WORKSPACE,
    conventionsDir: env.CONVENTIONS_DIR,
    request: env.REQUEST_HTML,
    priorFindings: experiment.prior_findings === 'ignore' ? '' : env.PRIOR_FINDINGS,
    diffPath: env.DIFF_PATCH,
    changedFilesPath: env.DIFF_FILES,
    shortstat: env.DIFF_SHORTSTAT,
    reviewers: mandates.routed,
    available: mandates.open,
    common,
    auditorPath,
    rules: env.REPO_RULES,
    budgetMinutes: ceilingMinutes(env.JOB_TIMEOUT_MINUTES),
    channelNonce: env.CHANNEL_NONCE,
  };
  const prompt = (strategy === 'baseline' ? renderReviewPrompt : renderPipelineContext)(options);
  const context = renderPipelineContext({ ...options, channelNonce: null });
  const comparable = env.WORKSPACE ? context.replaceAll(env.WORKSPACE, '<workspace>') : context;
  fs.writeFileSync(env.PROMPT_FILE, prompt);
  fs.writeFileSync(`${env.PROMPT_FILE}.pipeline.json`, JSON.stringify({
      prior: experiment.prior_findings === 'ignore' ? '' : env.PRIOR_FINDINGS || '',
      identity: { head_sha: env.COMMIT_ID, base_sha: env.BASE_SHA, plugin_sha: env.PLUGIN_SHA, runtime_sha: env.RUNTIME_SHA,
        prompt_sha256: promptDigest(prompt), context_sha256: promptDigest(comparable), ...experiment },
  }));

  Object.assign(outputs, {
    file: env.PROMPT_FILE,
    allowed_tools: policy.allowed,
    disallowed_tools: policy.disallowed,
    plugin_dir: PLUGIN_DIR,
  });
  return { outputs, error: '' };
}

module.exports = {
  validateExtraArgs,
  telemetryTag,
  runTriage,
  selectReviewArm,
  buildReviewPrompt,
  EXTRA_ARGS_REFUSAL,
};
