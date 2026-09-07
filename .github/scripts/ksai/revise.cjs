'use strict';

const { ANSWERED, readThreads, selectThreads, threadState } = require('./threads.cjs');
const { isPlanFile } = require('./plan.cjs');
const { counted } = require('../lib/text.cjs');

async function resolveRevisePhase({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  botLogin = null,
  planFile = null,
  guidance = null,
} = {}) {
  if (!String(botLogin ?? '').trim()) {
    return { error: 'no bot_login was passed, so review thread state cannot be trusted' };
  }
  const named = String(planFile ?? '').trim();
  if (!isPlanFile(named)) {
    return { error: 'this pull request names no plan document, so there are no plan threads to answer' };
  }

  const read = await readThreads({ github, owner, repo, prNumber });
  if (read.error) return { error: read.error };

  const onPlan = read.threads.filter((thread) => String(thread?.path ?? '') === named);
  const elsewhere = read.threads.length - onPlan.length;
  const { error, ...selected } = selectThreads(onPlan, { botLogin, guidance, core, answerDisputed: true });
  if (error) return { error };

  core?.info?.(
    `#${String(prNumber)}: ${selected.pending.length} of ${counted(selected.total, 'review thread')} on ${named} offered ` +
      `(${selected.resolved} resolved${selected.deferred ? `, ${selected.deferred} deferred past the bound` : ''}` +
      `${elsewhere ? `, ${elsewhere} on other files left alone` : ''})` +
      `${selected.scope ? `, scoped to: ${selected.scope}` : ''}.`,
  );

  return {
    planFile: named,
    pending: selected.pending,
    threads: onPlan,
    deferred: selected.deferred,
    total: selected.total,
    resolved: selected.resolved,
    disputed: selected.disputed,
    elsewhere,
    scope: selected.scope,
  };
}

async function openPlanThreads({
  github = null,
  owner = null,
  repo = null,
  prNumber = null,
  planFile = null,
  botLogin = null,
  includeAnswered = false,
} = {}) {
  const named = String(planFile ?? '').trim();
  if (!isPlanFile(named)) return { threads: [] };
  if (!String(botLogin ?? '').trim()) {
    return { error: 'no bot_login was passed, so an answered plan thread cannot be told from an unanswered one' };
  }
  const read = await readThreads({ github, owner, repo, prNumber });
  if (read.error) return { error: read.error };
  const all = includeAnswered === true;
  return {
    threads: read.threads.filter(
      (thread) =>
        String(thread?.path ?? '') === named &&
        thread?.resolved !== true &&
        (all || threadState(thread, { botLogin }) !== ANSWERED),
    ),
  };
}

module.exports = { resolveRevisePhase, openPlanThreads };
