'use strict';

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { MODEL_SHAPE, armLabel } = require('../lib/select-arm.cjs');
const { MAX_CELLS, appendHistory, historyLines, runHeading, statusLine } = require('../lib/run-progress.cjs');
const { collectSecrets, scrub: scrubSecrets } = require('../kreview/secrets.cjs');
const { href: markerHref, marker } = require('./marker.cjs');
const { oneLine, runUrl, scrub } = require('./plan.cjs');
const { identityOf, storesInBody } = require('./write-report.cjs');
const EFFORT_SHAPE = /^[a-z]{1,16}$/;

const CARRIED = Object.freeze([
  'FLOW',
  'SERVER_URL',
  'REPOSITORY',
  'RUN_ID',
  'MODEL',
  'EFFORT',
  'TRIGGER',
  'ISSUE_NUM',
  'PR_NUMBER',
  'TEAM',
  'FEDERATION_RULE',
  'SERVICE_ACCOUNT',
  'WORKFLOW',
  'ATTEMPT_ID',
  'ACTOR',
  'STATUS_HISTORY',
  'BOT_LOGIN',
  'COMMAND',
  'RECEIPT',
  'RECEIPT_AT',
  'JIRA_KEY',
  'REQUEST_COMMENT_ID',
  'PHASE',
]);

const CARRIED_FILE = 'run-start.json';

const RECOVER_FILE = 'recover.json';

const RECOVER_VERSION = 2;

const MAX_SAID_CHARS = 240;

const REPLACERS = Object.freeze(['REVIEW_REPLACED', 'RESULT_REPLACED']);

function armOf(env) {
  const model = String(env.MODEL ?? '').trim();
  const effort = String(env.EFFORT ?? '').trim();
  if (!MODEL_SHAPE.test(model)) return '';
  return `\`${armLabel(model, EFFORT_SHAPE.test(effort) ? effort : '')}\``;
}

function saidFor(text, env) {
  const options = { triggerPhrase: env.TRIGGER };
  const secrets = collectSecrets(process.env);
  return scrubSecrets(oneLine(String(text ?? ''), options), secrets).slice(0, MAX_SAID_CHARS);
}

function receiptEntry(env) {
  const said = saidFor(String(env.RECEIPT ?? ''), env);
  const at = Number(env.RECEIPT_AT);
  if (said === '' || !Number.isSafeInteger(at) || at <= 0) return [];
  return [{ at, stage: 'working', said }];
}

function liveLines(live, options, env) {
  let history = [];
  for (const entry of receiptEntry(env)) history = appendHistory(history, entry);
  for (const entry of Array.isArray(live.history) ? live.history : []) {
    history = appendHistory(history, { ...entry, said: saidFor(entry?.said, env) });
  }
  const status = statusLine(armOf(env), live.cells);
  const prose = scrub(`${status}${status ? ' · ' : ''}`, options);
  const lines = historyLines(history, env.STATUS_HISTORY);
  return [...lines, ...(lines.length ? [''] : []), '---', '', `${prose}[Follow it](${live.link})`];
}

function renderRunProgress(env, live = null) {
  const flow = String(env.FLOW ?? '');
  const link = runUrl({ serverUrl: env.SERVER_URL, repository: env.REPOSITORY, runId: env.RUN_ID });
  const active = Boolean(
    live &&
      (live.stage ||
        (Array.isArray(live.history) && live.history.length > 0) ||
        (Array.isArray(live.cells) && live.cells.length > 0)),
  );
  const pointer = markerHref({ kind: 'run-started', flow, issue: env.ISSUE_NUM, pr: env.PR_NUMBER, run: env.RUN_ID });
  const heading = runHeading(flow, active ? live.stage || 'working' : '', false, env.COMMAND, env.TRIGGER, pointer);
  if (!heading || link === '') return '';

  const options = { triggerPhrase: env.TRIGGER };
  const reading = active ? live : { stage: '', history: [], cells: [] };
  return [heading, '', ...liveLines({ ...reading, link }, options, env)].join('\n');
}

function renderRunStart(env, live = null) {
  const body = renderRunProgress(env, live);
  const flow = String(env.FLOW ?? '');
  if (body === '') return '';
  if (flow !== 'implement') return body;
  const fields = { kind: 'run-started', flow, issue: env.ISSUE_NUM, pr: env.PR_NUMBER, run: env.RUN_ID };
  return `${body}\n\n${marker(fields)}\n`;
}

function recoverRecord(env, commentId) {
  return {
    v: RECOVER_VERSION,
    run: String(env.RUN_ID ?? ''),
    flow: String(env.FLOW ?? ''),
    number: String(env.REPORT_NUM || env.PR_NUMBER || env.ISSUE_NUM || ''),
    comment_id: String(commentId ?? ''),
    pr: String(env.PR_NUMBER ?? ''),
    in_body: storesInBody(identityOf(env).identity),
  };
}

function recordRecovery(env, commentId, { write = writeFileSync } = {}) {
  const dir = String(env.RECOVER_DIR ?? '');
  if (dir === '') return false;
  try {
    write(join(dir, RECOVER_FILE), JSON.stringify(recoverRecord(env, commentId)));
  } catch {
    return false;
  }
  return true;
}

function carry(env, commentId, { write = writeFileSync } = {}) {
  recordRecovery(env, commentId, { write });
  const dir = String(env.CHANNEL_DIR ?? '');
  if (dir === '' || (commentId === '' && !storesInBody(identityOf(env).identity))) return false;
  const held = { COMMENT_ID: commentId };
  for (const name of CARRIED) held[name] = String(env[name] ?? '');
  try {
    write(join(dir, CARRIED_FILE), JSON.stringify(held));
  } catch {
    return false;
  }
  return true;
}

async function publishRunStart({ github, core, owner, repo, env, write = writeFileSync, now = Date.now }) {
  const outputs = { comment_id: '' };
  const stamped = { ...env, RECEIPT_AT: String(now()) };
  const body = renderRunStart(stamped);
  const target = Number(stamped.REPORT_NUM);

  if (body === '') return { outputs, notices: ['this run had no run link to publish, so it said nothing'] };
  if (!Number.isInteger(target) || target <= 0) {
    return { outputs, notices: ['this run had nowhere to say it had started'] };
  }

  try {
    const posted = await github.rest.issues.createComment({ owner, repo, issue_number: target, body });
    const id = Number(posted?.data?.id);
    outputs.comment_id = Number.isInteger(id) && id > 0 ? String(id) : '';
    const notices = [`said the run had started on #${target}`];
    if (carry(stamped, outputs.comment_id, { write })) notices.push('and left what a live status re-renders from');
    return { outputs, notices };
  } catch (error) {
    core?.warning?.(`this run could not say it had started (${error.message}); the token may lack issues:write.`);
    return { outputs, notices: [] };
  }
}

async function dropRunStart({ github, core, owner, repo, env }) {
  const id = Number(env.COMMENT_ID);
  if (!Number.isInteger(id) || id <= 0) return { notices: ['this run opened with no comment to remove'] };
  if (REPLACERS.some((name) => String(env[name] ?? '') === 'true')) {
    return { notices: ['the report replaced the comment this run opened with'] };
  }

  try {
    await github.rest.issues.deleteComment({ owner, repo, comment_id: id });
    return { notices: ['removed the comment this run opened with, because nothing replaced it'] };
  } catch (error) {
    core?.warning?.(`the comment this run opened with could not be removed (${error.message}).`);
    return { notices: [] };
  }
}

module.exports = {
  CARRIED,
  CARRIED_FILE,
  MAX_CELLS,
  armOf,
  RECOVER_FILE,
  RECOVER_VERSION,
  carry,
  recordRecovery,
  recoverRecord,
  dropRunStart,
  publishRunStart,
  renderRunProgress,
  renderRunStart,
  saidFor,
  REPLACERS,
};
