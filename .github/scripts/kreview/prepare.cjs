const fs = require('node:fs');
const crypto = require('node:crypto');
const { CLARIFY_VERDICT, NO_VERDICT, actOnVerdict, renderClarification, renderStandDown, verdictOf } =
  require('../ksai/classify.cjs');
const loadKsaiConfig = require('../ksai/config.cjs');
const { EXTRA_ARGS_REFUSAL, toolPolicy, validateExtraArgs } = require('../lib/claude-args.cjs');
const { mintedId, postTo, reachControlPlane, unreached } = require('../lib/control-plane.cjs');
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
const { ASSIGNED_SOURCE, receiptOf, sourceOf } = require('../lib/request-intent.cjs');
const { ceilingMinutes } = require('../lib/watchdog.cjs');
const { SKILLS: REVIEWER_SKILLS, skipsAuthor, stackManifests, triage } = require('../triage/policy.cjs');
const { renderReviewPrompt, renderPipelineContext } = require('./prompt.cjs');
const { STRATEGIES, experimentOf, promptDigest } = require('./review-pipeline.cjs');
const { materializeScopes } = require('./review-scopes.cjs');
const { availableReviewers, bodyOf, resolveReviewers, sharedFields } = require('./reviewers.cjs');

const PLUGIN_DIR = '_ksai/plugins/kreview';

const NO_TRIAGE_DEFAULTS = { tier: null, model: null, effort: null, skills: [], skip: null, apiSurface: false, facts: null };
const NO_TRIAGE = Object.freeze(NO_TRIAGE_DEFAULTS);
const TRIAGE_API_VERSION = 'triage/v1';
const TRIAGE_MODES = Object.freeze(['local', 'shadow', 'cp']);
const SHA = /^[0-9a-f]{40}$/;

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
    return { authors: commits.map((commit) => commit.author?.login ?? ''), read: true, error: '' };
  } catch (error) {
    core?.warning?.(`Could not read who wrote the commits, so the review runs: ${error.message}`);
    return { authors: [], read: false, error: String(error.message ?? 'GitHub refused the commit list').slice(0, 1024) };
  }
}

const STACK_MANIFEST_BYTES = 256 * 1024;

async function readStackManifests({ github, core, owner, repo }) {
  const manifests = {};
  for (const path of stackManifests()) {
    try {
      const { data } = await github.rest.repos.getContent({ owner, repo, path });
      if (data?.encoding !== 'base64' || typeof data.content !== 'string') continue;
      if (typeof data.size === 'number' && data.size > STACK_MANIFEST_BYTES) continue;
      manifests[path] = Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (error) {
      if (error?.status !== 404) core?.info?.(`Could not read \`${path}\`, so the stack renames nothing: ${error?.message}`);
    }
  }
  return manifests;
}

const splitNames = (value) => String(value ?? '').split(/[\s,]+/).map((one) => one.trim()).filter(Boolean);

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function goJSON(value) {
  const escaped = { '<': '003c', '>': '003e', '&': '0026', '\u2028': '2028', '\u2029': '2029' };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${escaped[character]}`);
}

function decisionOf(result) {
  return {
    tier: result.tier ?? '',
    skills: result.skills ?? [],
    skip: result.skip
      ? { proposed: true, reason: result.skip.reason ?? '', by: result.skip.by ?? '' }
      : { proposed: false },
    risk: result.facts?.risk === true,
    api_surface: result.apiSurface === true,
    facts: {
      reviewable_files: result.facts?.reviewableFiles ?? 0,
      reviewable_lines: result.facts?.reviewableLines ?? 0,
    },
    reasons: result.facts?.reasons ?? [],
  };
}

function resultOf(decision) {
  return {
    tier: decision.tier || null,
    model: decision.model,
    effort: null,
    skills: decision.skills,
    skip: decision.skip.proposed ? { reason: decision.skip.reason, by: decision.skip.by } : null,
    apiSurface: decision.api_surface,
    facts: {
      reviewableFiles: decision.facts.reviewable_files,
      reviewableLines: decision.facts.reviewable_lines,
      risk: decision.risk,
      reasons: decision.reasons,
    },
  };
}

function differentFields(local, remote) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map((entry) => canonical(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return ['tier', 'skills', 'skip', 'risk', 'api_surface', 'facts', 'reasons']
    .filter((field) => JSON.stringify(canonical(local[field])) !== JSON.stringify(canonical(remote[field])));
}

function jwtClaims(token) {
  const pieces = String(token).split('.');
  if (pieces.length !== 3) throw new Error('the identity token is malformed');
  return JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
}

function validReviewDecision(decision, { evidenceRevision, requestId, headSha, models }) {
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
  const top = [
    'api_version', 'policy_version', 'evidence_revision', 'request_id', 'head_sha', 'tier', 'model', 'skills',
    'skip', 'risk', 'api_surface', 'facts', 'reasons',
  ];
  const skipKeys = decision?.skip?.proposed ? ['proposed', 'reason', 'by'] : ['proposed'];
  if (!decision || decision.api_version !== TRIAGE_API_VERSION || decision.head_sha !== headSha
    || decision.evidence_revision !== evidenceRevision || decision.request_id !== requestId
    || !exactKeys(decision, top) || !exactKeys(decision.skip, skipKeys)
    || !exactKeys(decision.facts, ['reviewable_files', 'reviewable_lines'])
    || !/^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$/.test(String(decision.policy_version ?? ''))
    || !['', 'fast', 'balanced', 'flagship'].includes(decision.tier)
    || !MODEL_SHAPE.test(String(decision.model ?? '')) || !models.includes(decision.model)
    || !Array.isArray(decision.skills) || decision.skills.length > 2
    || decision.skills.some((skill) => !REVIEWER_SKILLS.includes(skill))
    || new Set(decision.skills).size !== decision.skills.length
    || typeof decision.risk !== 'boolean' || typeof decision.api_surface !== 'boolean'
    || !decision.facts || !Number.isInteger(decision.facts.reviewable_files) || decision.facts.reviewable_files < 0
    || !Number.isInteger(decision.facts.reviewable_lines) || decision.facts.reviewable_lines < 0
    || !Array.isArray(decision.reasons) || decision.reasons.length > 16
    || decision.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0 || Buffer.byteLength(reason) > 1024)
    || !decision.skip || typeof decision.skip.proposed !== 'boolean') return false;
  if (decision.skip.proposed) {
    return ['author', 'content', 'manifest'].includes(decision.skip.by)
      && typeof decision.skip.reason === 'string' && decision.skip.reason.length > 0
      && Buffer.byteLength(decision.skip.reason) <= 1024;
  }
  return !decision.skip.by && !decision.skip.reason;
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function requestReviewTriage({ core, endpoint, request, mint, call = fetch, rest = pause }) {
  const { base, token, failure } = await reachControlPlane({
    endpoint, env: process.env, mint, secret: (minted) => core?.setSecret?.(minted),
  });
  if (failure) throw new Error(failure);
  const claims = jwtClaims(token);
  const evidenceRevision = sha256(goJSON({ kind: 'review', head: request.head_sha, evidence: request.evidence }));
  const requestRevision = sha256(goJSON({ kind: 'review', request }));
  const [workflow] = String(claims.job_workflow_ref ?? '').split('@');
  const requestId = crypto.createHash('sha256').update([
    String(claims.repository ?? '').toLowerCase(), String(claims.run_id ?? ''),
    `${workflow}@${claims.job_workflow_sha ?? ''}`, request.record_id, 'review', requestRevision,
  ].join('\0')).digest('hex').slice(0, 32);
  const url = `${base}/v1/triage/review`;
  const body = JSON.stringify(request);
  let answer;
  let lastFailure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      answer = await postTo(call, url, { token, body, timeout: 15000 });
      lastFailure = null;
    } catch (error) {
      lastFailure = error;
    }
    const retryable = lastFailure || answer.status === 408 || answer.status === 429 || answer.status >= 500;
    if (!retryable || attempt === 2) break;
    await Promise.resolve(answer?.body?.cancel?.()).catch(() => {});
    const asked = Number(answer?.headers?.get?.('retry-after')) * 1000;
    await rest(Number.isFinite(asked) && asked > 0 ? Math.min(asked, 5000) : 1000 * (attempt + 1));
    answer = undefined;
  }
  if (lastFailure) throw new Error(unreached(lastFailure));
  if (!answer.ok) throw new Error(`the control plane answered ${answer.status}`);
  if (answer.status === 204) {
    throw Object.assign(new Error('the control plane made no review decision for this evidence, so this run keeps its own arm'), { undecided: true });
  }
  const raw = await answer.text();
  if (Buffer.byteLength(raw) > 65536) throw new Error('the control plane returned an oversized review decision');
  let decision;
  try {
    decision = JSON.parse(raw);
  } catch {
    throw new Error('the control plane returned a malformed review decision');
  }
  if (!validReviewDecision(decision, {
    evidenceRevision, requestId, headSha: request.head_sha, models: request.capabilities.models,
  })) {
    throw new Error('the control plane returned a stale or malformed review decision');
  }
  return decision;
}

async function runTriage({ github, core, owner, repo, prNumber, env = process.env, mint, call, rest }) {
  let result = NO_TRIAGE;
  let remote = null;
  let source = 'local';
  let mismatch = [];
  let policyVersion = '';
  try {
    const pull_number = Number(prNumber);
    const manifests = readStackManifests({ github, core, owner, repo });
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
    const author = pr.user?.login;
    const commits = skipsAuthor(author)
      ? await commitAuthorsOf({ github, core, owner, repo, pull_number })
      : { authors: [], read: false, error: '' };
    result = {
      ...triage({
        author,
        commitAuthors: skipsAuthor(author) ? commits.authors : null,
        commitCount: pr.commits,
        changedFiles: pr.changed_files,
        manifests: await manifests,
        files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
      }),
      model: null,
    };
    const mode = TRIAGE_MODES.includes(env.REVIEW_TRIAGE_MODE) ? env.REVIEW_TRIAGE_MODE : 'local';
    const record = mintedId(env.RECORD_ID);
    const remoteReady = env.CONTROL_PLANE_ENDPOINT && record !== ''
      && SHA.test(env.RUN_HEAD_SHA ?? '') && SHA.test(pr.head?.sha ?? '');
    if (mode !== 'local' && remoteReady) {
      const models = [...new Set([env.CONFIGURED_MODEL, ...splitNames(env.ALLOWED_MODELS)].filter(Boolean))].slice(0, 16);
      const boundedFiles = files.slice(0, 3000);
      const boundedAuthors = commits.authors.slice(0, 250);
      const request = {
        api_version: TRIAGE_API_VERSION,
        record_id: record,
        run_head_sha: env.RUN_HEAD_SHA,
        head_sha: pr.head.sha.toLowerCase(),
        capabilities: { reviewer_skills: [...REVIEWER_SKILLS], models },
        enforcement: {
          triage: env.TRIAGE_MODE === 'off' ? 'off' : 'auto',
          configured_model: env.CONFIGURED_MODEL,
          configured_effort: env.CONFIGURED_EFFORT,
          minimum_effort: env.MIN_EFFORT || undefined,
          maximum_effort: env.MAX_EFFORT || undefined,
        },
        evidence: {
          pull_request: pull_number,
          author,
          changed_files: pr.changed_files,
          commit_count: pr.commits,
          files: boundedFiles.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
          files_complete: boundedFiles.length === pr.changed_files,
          files_error: boundedFiles.length === files.length ? undefined : 'file evidence exceeded the runner bound',
          commit_authors_read: commits.read && boundedAuthors.length === commits.authors.length,
          commit_authors: boundedAuthors.length === commits.authors.length ? boundedAuthors : [],
          commit_authors_error: commits.read && boundedAuthors.length !== commits.authors.length
            ? 'commit author evidence exceeded the runner bound' : commits.error || undefined,
        },
      };
      try {
        remote = await requestReviewTriage({
          core, endpoint: env.CONTROL_PLANE_ENDPOINT, request,
          mint: mint ?? ((audience) => core.getIDToken(audience)), call, rest,
        });
        policyVersion = remote.policy_version;
        mismatch = differentFields(decisionOf(result), remote);
        source = mode === 'cp' ? 'cp' : 'shadow';
        if (mode === 'cp') result = resultOf(remote);
      } catch (error) {
        if (error.undecided) core?.notice?.(error.message);
        else core?.warning?.(`Control-plane review triage failed: ${error.message}`);
        if (mode === 'cp') {
          result = NO_TRIAGE;
          source = 'fallback';
        }
      }
    } else if (mode === 'cp') {
      result = NO_TRIAGE;
      source = 'fallback';
    }
  } catch (error) {
    core?.warning?.(`Triage failed, falling back to the configured arm: ${error.message}`);
  }

  const outputs = {
    tier: result.tier ?? '',
    model: result.model ?? '',
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
    source,
    policy_version: source === 'cp' ? policyVersion : source === 'fallback' ? 'configured' : 'local/review-v1',
    local_policy_version: 'local/review-v1',
    cp_policy_version: policyVersion,
    mismatch: mismatch.join(','),
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
    triage: { tier: env.TRIAGE_TIER, model: env.TRIAGE_MODEL, effort: env.TRIAGE_EFFORT },
    modelPinned: env.MODEL_PINNED,
    effortPinned: env.EFFORT_PINNED,
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
  const routeSource = sourceOf({
    classified: routed,
    named: result.commandNamed,
    commented: String(env.COMMENT_ID ?? '').trim() !== '',
    uncommented: ASSIGNED_SOURCE,
  });

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

async function reviewCommandStatus(options) {
  const { error, skipped } = await selectReviewArm(options);
  return { error, skipped };
}

function reviewOptions(env, experiment) {
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
    resultTransport: experiment.result_transport,
  };
  return { options, refusal };
}

function buildReviewPrompt({ env }) {
  const outputs = {
    file: '',
    allowed_tools: '',
    disallowed_tools: '',
    result_transport: '',
    lsp_tool: '',
    lsp_measure: '',
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
  const { options, refusal } = reviewOptions(env, experiment);
  if (refusal !== '') {
    outputs.error = refusal;
    return { outputs, error: refusal };
  }
  const prompt = (strategy === 'baseline' ? renderReviewPrompt : renderPipelineContext)(options);
  const context = renderPipelineContext({ ...options, channelNonce: null });
  const comparable = env.WORKSPACE ? context.replaceAll(env.WORKSPACE, '<workspace>') : context;
  let scoping;
  if (strategy !== 'baseline') {
    try {
      if (!env.DIFF_PATCH || !env.DIFF_STATUS) throw new Error('scoped review requires the trusted patch and NUL status inventory');
      scoping = materializeScopes(env.DIFF_PATCH, env.DIFF_STATUS);
      scoping.scopes = scoping.scopes.map((scope) => ({ ...scope,
        context: renderPipelineContext({ ...options, diffPath: scope.diffPath, changedFilesPath: scope.changedFilesPath, shortstat: `${scope.files.length} files; ${scope.lines} changed lines in this scope` }),
      }));
    } catch (error) {
      outputs.error = error.message;
      return { outputs, error: outputs.error };
    }
  }
  fs.writeFileSync(env.PROMPT_FILE, prompt);
  fs.writeFileSync(`${env.PROMPT_FILE}.pipeline.json`, JSON.stringify({
      scoping,
      resultTransport: experiment.result_transport,
      prior: experiment.prior_findings === 'ignore' ? '' : env.PRIOR_FINDINGS || '',
      identity: { head_sha: env.COMMIT_ID, base_sha: env.BASE_SHA, plugin_sha: env.PLUGIN_SHA, runtime_sha: env.RUNTIME_SHA,
        prompt_sha256: promptDigest(prompt), context_sha256: promptDigest(comparable), ...experiment },
  }));

  Object.assign(outputs, {
    file: env.PROMPT_FILE,
    allowed_tools: policy.allowed,
    disallowed_tools: policy.disallowed,
    result_transport: experiment.result_transport,
    lsp_tool: experiment.lsp_tool,
    lsp_measure: String(experiment.lsp_measure),
  });
  return { outputs, error: '' };
}

module.exports = {
  validateExtraArgs,
  telemetryTag,
  runTriage,
  reviewCommandStatus,
  selectReviewArm,
  buildReviewPrompt,
  reviewOptions,
  EXTRA_ARGS_REFUSAL,
};
