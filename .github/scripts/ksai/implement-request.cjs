'use strict';

const { boundedBytes } = require('../lib/evidence.cjs');
const { usableNonce } = require('../lib/prompt-text.cjs');
const { SALVAGE_MARGIN_MINUTES, ceilingMinutes } = require('../lib/watchdog.cjs');
const { isBranchForWork } = require('./phase.cjs');
const { MAX_DIRECT_COMMITS, matchesBranchGrammar } = require('./verify-chunk.cjs');
const { SINKS, renderRequest } = require('../lib/render-request.cjs');

const IMPLEMENT_PHASES = Object.freeze(['plan', 'direct', 'step', 'fix', 'revise', 'do']);
const MAX_INPUT = Object.freeze({
  checks: 262_144,
  deniedPaths: 131_072,
  goFailures: 32_768,
  guidance: 32_768,
  issue: 524_288,
  jira: 262_144,
  planDocument: 524_288,
  retry: 65_536,
  stepTitle: 4_096,
  threads: 262_144,
});
const MAX_RETRY_FILES = 12;
const MAX_RETRY_PATCH_CHARS = 2_000;
const MAX_RETRY_REPORT_CHARS = 1_000;
const MAX_THREAD_COMMENTS = 8;
const MAX_THREAD_COMMENT_CHARS = 1_500;
const MAX_THREADS = 20;
const CHECKS_NOT_READ = Object.freeze({
  sha: '',
  failing: [],
  failingTotal: 0,
  running: [],
  runningTotal: 0,
  cancelledTotal: 0,
  statuses: [],
  statusesTotal: 0,
  logged: 0,
  logsDeferred: 0,
  logsUnavailable: null,
  total: null,
  listTruncated: false,
  unreadable: 'this run is not admitted to the build, so the checks were not read',
  statusesUnreadable: null,
});
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,4095}$/;
const SHA = /^[0-9a-f]{40,64}$/;

const text = (value) => String(value ?? '');

function controlledText(value, name, maximum, { required = false, pattern = null } = {}) {
  const result = text(value);
  if ((required && result === '') || Buffer.byteLength(result) > maximum || /[\0\r\n]/.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  if (pattern && result !== '' && !pattern.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function nonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = text(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result > maximum) throw new Error(`${name} is out of range`);
  return result;
}

function optionalInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = text(value).trim();
  return raw === '' ? 0 : nonNegativeInteger(raw, name, maximum);
}

function boundedText(value, name, maximum) {
  const result = text(value);
  if (Buffer.byteLength(result) > maximum) throw new Error(`${name} exceeds ${maximum} bytes`);
  return result;
}

function readBounded(file, name, maximum, { optional = false } = {}) {
  const named = text(file).trim();
  if (named === '' && optional) return '';
  if (named === '') throw new Error(`${name} file is missing`);
  try {
    return boundedBytes(named, `${name} file`, maximum, { optional }).toString('utf8');
  } catch (error) {
    throw new Error(`${name} could not be read: ${error?.message ?? error}`, { cause: error });
  }
}

const truncate = (value, maximum) => [...text(value)].slice(0, maximum).join('');

function parseJSON(raw, name, fallback = null) {
  if (raw === '') return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error?.message ?? error}`, { cause: error });
  }
  return parsed;
}

function readJSON(file, name, maximum, { optional = false, fallback = null } = {}) {
  return parseJSON(readBounded(file, name, maximum, { optional }), name, fallback);
}

const component = (name, value) => ({ name, value });

function sanitizeThread(thread) {
  const all = Array.isArray(thread?.comments) ? thread.comments : [];
  const tail = all.slice(1).slice(1 - MAX_THREAD_COMMENTS);
  const selected = all.slice(0, 1).concat(tail);
  return {
    id: truncate(thread?.id, 512),
    path: truncate(thread?.path, 4_096),
    line: Number.isInteger(thread?.line) && thread.line >= 1 ? thread.line : null,
    outdated: thread?.outdated === true,
    comment_count: Number.isInteger(thread?.commentCount) && thread.commentCount >= selected.length
      ? thread.commentCount
      : all.length,
    comments: selected.map((comment) => ({
      login: truncate(comment?.login, 256),
      body: truncate(comment?.body, MAX_THREAD_COMMENT_CHARS),
    })),
  };
}

function sanitizeThreads(value, { required = false, threadScoped = false } = {}) {
  if (!Array.isArray(value)) throw new Error('review threads must be an array');
  if (required && value.length === 0) throw new Error('review threads are empty');
  if (value.length > MAX_THREADS) throw new Error(`review threads exceed ${MAX_THREADS}`);
  if (threadScoped && value.length !== 1) {
    throw new Error('a request written inside a review thread must contain exactly one thread');
  }
  return value.map((thread) => sanitizeThread(thread));
}

function sanitizeChecks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checks must be an object');
  const natural = (entry, name) => {
    const number = Number(entry ?? 0);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} is invalid`);
    return number;
  };
  const bounded = (entry, maximum) => truncate(entry, maximum);
  const failing = Array.isArray(value.failing) ? value.failing.slice(0, 20) : [];
  const statuses = Array.isArray(value.statuses) ? value.statuses.slice(0, 20) : [];
  const running = Array.isArray(value.running) ? value.running.slice(0, 20) : [];
  return {
    sha: bounded(value.sha, 128),
    failing: failing.map((entry) => ({
      name: bounded(entry?.name, 512),
      app: bounded(entry?.app, 512),
      conclusion: bounded(entry?.conclusion, 128),
      url: bounded(entry?.url, 4_096),
      title: bounded(entry?.title, 512),
      summary: bounded(entry?.summary, 8_192),
      log: entry?.log === null ? null : bounded(entry?.log, 12_288),
      log_lines: natural(entry?.logLines, 'check log line count'),
      log_truncated: entry?.logTruncated === true,
    })),
    failing_total: natural(value.failingTotal, 'failing check count'),
    running: running.map((entry) => bounded(entry, 512)),
    running_total: natural(value.runningTotal, 'running check count'),
    cancelled_total: natural(value.cancelledTotal, 'cancelled check count'),
    statuses: statuses.map((entry) => ({
      context: bounded(entry?.context, 512),
      state: bounded(entry?.state, 128),
      description: bounded(entry?.description, 512),
      url: bounded(entry?.url, 4_096),
    })),
    statuses_total: natural(value.statusesTotal, 'failing status count'),
    logged: natural(value.logged, 'logged check count'),
    logs_deferred: natural(value.logsDeferred, 'deferred log count'),
    logs_unavailable: value.logsUnavailable === null ? null : bounded(value.logsUnavailable, 2_048),
    total: value.total === null ? null : natural(value.total, 'check count'),
    list_truncated: value.listTruncated === true,
    unreadable: value.unreadable === null ? null : bounded(value.unreadable, 2_048),
    statuses_truncated: value.statusesTruncated === true,
    statuses_unreadable: value.statusesUnreadable === null ? null : bounded(value.statusesUnreadable, 2_048),
  };
}

function readGoFacts(file) {
  const value = readJSON(file, 'Go facts', MAX_INPUT.goFailures, {
    optional: true,
    fallback: { available: false, cache_warmed: false, failed: [], version: '' },
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Go facts must be an object');
  const failed = Array.isArray(value.failed)
    ? value.failed.map((entry) => truncate(entry, 4_096))
    : [];
  if (failed.length > 128) throw new Error('Go facts contain too many failed modules');
  return {
    available: value.available === true,
    cache_warmed: value.cache_warmed === true,
    version: controlledText(value.version, 'Go version', 256, {
      pattern: /^go version go[0-9A-Za-z.+_-]+ [A-Za-z0-9_/-]+$/,
    }),
    failed,
  };
}

function readPackageFacts(file) {
  const value = readJSON(file, 'Node dependency facts', 4_096, {
    optional: true,
    fallback: { present: false, manager: '', version: '', failed: false },
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Node dependency facts must be an object');
  return {
    present: value.present === true,
    manager: controlledText(value.manager, 'package manager', 64, { pattern: /^(npm|pnpm|yarn)?$/ }),
    version: controlledText(value.version, 'package manager version', 64, { pattern: /^[0-9A-Za-z.+-]*$/ }),
    failed: value.failed === true,
  };
}

function majorBumpFacts(env) {
  const found = text(env.MAJOR_BUMP) === 'true';
  const ambiguous = text(env.MAJOR_BUMP_AMBIGUOUS) === 'true';
  const omitted = optionalInteger(env.MAJOR_BUMP_OMITTED, 'omitted dependency ranges', 100_000);
  return {
    found,
    ambiguous,
    omitted,
    summary: found ? truncate(env.MAJOR_BUMP_SUMMARY, 2_000).replaceAll(/[\0\r\n<]/g, ' ') : '',
    any: found || ambiguous || omitted > 0,
  };
}

function readRetry(file) {
  const value = readJSON(file, 'the attempt this retries', MAX_INPUT.retry, { optional: true, fallback: null });
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('the attempt this retries must be an object');
  const commit = controlledText(value.commit, 'the retried commit', 128, { pattern: /^[0-9a-f]{7,64}$/ });
  if (commit === '') return null;
  const files = Array.isArray(value.files) ? value.files.slice(0, MAX_RETRY_FILES) : [];
  return {
    commit,
    files: files.map((one) => ({
      path: truncate(one?.path, 300),
      status: truncate(one?.status, 20),
      additions: Number.isSafeInteger(one?.additions) && one.additions >= 0 ? one.additions : null,
      deletions: Number.isSafeInteger(one?.deletions) && one.deletions >= 0 ? one.deletions : null,
      patch: truncate(one?.patch, MAX_RETRY_PATCH_CHARS),
      patch_cut: one?.patch_cut === true,
    })),
    report: truncate(value.report, MAX_RETRY_REPORT_CHARS),
  };
}

function commonContext(env, phase, goFacts) {
  const budget = ceilingMinutes(env.JOB_TIMEOUT_MINUTES);
  const nonce = text(env.CHANNEL_NONCE);
  const issueNumber = controlledText(env.ISSUE_NUM, 'issue number', 32, { pattern: /^\d*$/ });
  const jiraKey = controlledText(env.JIRA_KEY, 'Jira key', 128, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  const branch = controlledText(env.BRANCH, 'branch', 1_024, { required: phase !== 'plan', pattern: SAFE_REF });
  const mergedSha = controlledText(env.MERGED_SHA, 'merged sha', 128, { pattern: SHA });
  const conflicted = optionalInteger(env.MERGE_CONFLICTED, 'merge conflict count', 100_000);
  return {
    phase,
    repository: controlledText(env.REPO, 'repository', 512, { required: true, pattern: REPOSITORY }),
    issue_number: issueNumber,
    pr_number: controlledText(env.PR_NUMBER, 'pull request number', 32, { pattern: /^\d*$/ }),
    jira_key: jiraKey,
    show_issue: issueNumber !== '' && !isBranchForWork(branch, jiraKey),
    default_branch: controlledText(env.DEFAULT_BRANCH, 'default branch', 1_024, { pattern: SAFE_REF }),
    branch,
    base_sha: controlledText(env.BASE_SHA, 'base sha', 128, { pattern: SHA }),
    base_diff_ref: controlledText(env.BASE_DIFF_REF, 'base diff ref', 1_024, { pattern: SAFE_REF }),
    base_diff_available: matchesBranchGrammar(text(env.BASE_DIFF_REF), 'human-named'),
    plan_path: controlledText(env.PLAN_PATH, 'plan path', 4_096, { pattern: SAFE_PATH }),
    budget: {
      enabled: Number.isInteger(budget) && budget > SALVAGE_MARGIN_MINUTES,
      minutes: Number.isInteger(budget) ? budget : 0,
      stop_after_minutes: Number.isInteger(budget) ? budget - SALVAGE_MARGIN_MINUTES : 0,
    },
    channel: {
      enabled: usableNonce(nonce),
      nonce: usableNonce(nonce) ? text(nonce) : '',
    },
    go: {
      available: goFacts.available,
      cache_warmed: goFacts.cache_warmed,
      incomplete: goFacts.failed.length > 0,
      version: goFacts.version,
    },
    merge: {
      active: mergedSha !== '',
      ref: controlledText(env.MERGED_REF, 'merged ref', 1_024, { pattern: SAFE_REF }),
      sha: mergedSha,
      conflicted,
      has_conflicts: conflicted > 0,
      singular: conflicted === 1,
    },
  };
}

function contextFor(env, phase, goFacts, packageFacts) {
  const context = commonContext(env, phase, goFacts);
  const guidance = boundedText(env.GUIDANCE, 'guidance', MAX_INPUT.guidance);
  const remaining = phase === 'step' ? nonNegativeInteger(env.REMAINING, 'remaining', 10_000) : 0;
  const total = phase === 'step' ? nonNegativeInteger(env.TOTAL, 'total', 10_000) : 0;
  if (phase === 'step' && (remaining < 1 || remaining > total)) {
    throw new Error('remaining must be between 1 and total');
  }
  const deferred = optionalInteger(env.DEFERRED, 'deferred review count', 100_000);
  return {
    ...context,
    has_guidance: guidance.trim() !== '',
    major_bump: majorBumpFacts(env),
    package: packageFacts,
    writes_plan: phase === 'plan' && context.plan_path !== '',
    thread_scoped: text(env.THREAD_ROOT_ID) !== '',
    deferred,
    has_deferred: deferred > 0,
    max_commits: phase === 'direct' ? MAX_DIRECT_COMMITS : 1,
    remaining,
    total,
    ordinal: phase === 'step' ? total - remaining + 1 : 0,
  };
}

function phaseInputs(phase, values) {
  const context = component('context', values.context);
  const additionalPrompt = component('additional_prompt', values.additionalPrompt);
  const issue = component('issue', values.issue);
  const guidance = component('guidance', values.guidance);
  const denied = component('denied_paths', values.denied);
  const failures = component('go_failures', values.goFailures);
  if (phase === 'plan') {
    return [context, additionalPrompt, guidance, issue, component('jira', values.jira)];
  }
  if (phase === 'direct') {
    return [context, additionalPrompt, guidance, issue, component('jira', values.jira), denied, failures];
  }
  if (phase === 'step') {
    return [
      context,
      additionalPrompt,
      component('step_title', values.stepTitle),
      issue,
      component('jira', values.jira),
      denied,
      failures,
    ];
  }
  if (phase === 'fix') {
    return [context, additionalPrompt, guidance, component('threads', values.threads), issue, denied, failures];
  }
  if (phase === 'revise') {
    return [
      context,
      additionalPrompt,
      guidance,
      component('threads', values.threads),
      component('plan_document', values.planDocument),
      issue,
      component('jira', values.jira),
      denied,
    ];
  }
  const inputs = [
    context,
    additionalPrompt,
    guidance,
    component('threads', values.threads),
    component('checks', values.checks),
    issue,
    denied,
    failures,
    component('retry', values.retry ?? null),
  ];
  return inputs;
}

function implementRenderRequest(phase, values, { model = '' } = {}) {
  if (!IMPLEMENT_PHASES.includes(phase)) throw new Error(`no prompt for phase: ${phase || '(none)'}`);
  return renderRequest({
    promptId: `runtime.implement.${phase}`,
    sink: SINKS.implement,
    model: controlledText(model, 'model', 512, {
      required: true,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    }),
    inputs: phaseInputs(phase, values),
  });
}

function implementValues(env, phase, { denied = [], planDocument = '' } = {}) {
  const goFacts = readGoFacts(env.GO_FACTS_FILE);
  const packageFacts = readPackageFacts(env.PACKAGE_FACTS_FILE);
  const retry = phase === 'do' ? readRetry(env.RETRY_FILE) : null;
  const issue = readJSON(env.ISSUE_FILE, 'issue', MAX_INPUT.issue, { optional: true });
  const jira = readJSON(env.JIRA_FILE, 'Jira issue', MAX_INPUT.jira, { optional: true });
  const threadScoped = text(env.THREAD_ROOT_ID) !== '';
  const threads = ['fix', 'revise', 'do'].includes(phase)
    ? sanitizeThreads(readJSON(env.THREADS_FILE, 'review threads', MAX_INPUT.threads, {
      optional: phase === 'do',
      fallback: [],
    }), { required: phase !== 'do', threadScoped: phase === 'fix' && threadScoped })
    : [];
  const checks = phase === 'do'
    ? sanitizeChecks(text(env.CHECKS_FILE).trim() === ''
      ? CHECKS_NOT_READ
      : readJSON(env.CHECKS_FILE, 'checks', MAX_INPUT.checks))
    : {};
  const guidance = boundedText(env.GUIDANCE, 'guidance', MAX_INPUT.guidance);
  const stepTitle = phase === 'step'
    ? boundedText(env.STEP_TITLE, 'step title', MAX_INPUT.stepTitle)
    : '';
  if (phase === 'step' && stepTitle.trim() === '') throw new Error('step title is empty');
  const phaseContext = contextFor(
    { ...env, PLAN_PATH: phase === 'plan' ? env.PLAN_PATH : env.PLAN_FILE }, phase, goFacts, packageFacts,
  );
  const context = {
    ...phaseContext,
    has_threads: threads.length > 0,
    has_request: guidance.trim() !== '',
    has_retry: retry !== null,
    checks: {
      failing_total: phase === 'do' ? checks.failing_total : 0,
      statuses_total: phase === 'do' ? checks.statuses_total : 0,
      running_total: phase === 'do' ? checks.running_total : 0,
      cancelled_total: phase === 'do' ? checks.cancelled_total : 0,
      unreadable: phase === 'do' && checks.unreadable !== null,
      list_truncated: phase === 'do' && checks.list_truncated,
      stale: phase === 'do' && checks.sha !== '' && checks.sha !== phaseContext.base_sha,
    },
  };
  if (
    phase === 'do' && !context.has_request && !context.has_threads && !context.merge.active &&
    context.checks.failing_total + context.checks.statuses_total === 0
  ) {
    throw new Error('do prompt has no request, review thread, merge, or failing check');
  }
  return {
    additionalPrompt: text(env.ADDITIONAL_PROMPT),
    context,
    guidance,
    issue,
    jira,
    threads,
    checks,
    planDocument: boundedText(planDocument, 'plan document', MAX_INPUT.planDocument),
    stepTitle,
    denied,
    goFailures: goFacts.failed,
    retry,
  };
}

module.exports = {
  IMPLEMENT_PHASES,
  MAX_INPUT,
  implementRenderRequest,
  implementValues,
  sanitizeChecks,
  sanitizeThreads,
};
