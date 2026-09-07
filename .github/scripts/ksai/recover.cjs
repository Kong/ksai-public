'use strict';

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const { ALLOWED_EFFORTS, KNOWN_MODELS, MODEL_SHAPE, asAlert } = require('../lib/select-arm.cjs');
const { collectSecrets, scrub: scrubSecrets } = require('../kreview/secrets.cjs');
const { STATE_SHAPE } = require('./write-report.cjs');
const { MAX_CELLS, RECOVER_FILE, RECOVER_VERSION } = require('./run-start.cjs');
const { dispatchSuccessor } = require('./continue.cjs');
const { probeComments } = require('./pages.cjs');
const {
  LOGIN_SHAPE,
  POSITIVE_ID_SHAPE,
  locateStatus,
  markerValues,
  runUrl,
  scrub,
  spliceStatus,
} = require('./plan.cjs');

const LIVE_TAIL = '[Follow it](';

const REPORT_SPLIT = '\n\n---\n\n<details>';

const RUNNING = 'running';

const RECOVERED_PREFIX = '<!-- ksai-recovered:';

const RECOVERED_SHAPE = /^[a-z]{1,16}$/;

const COMPACT = String.raw`(?:[0-9]{1,7}|[0-9]{1,4}k|[0-9]{1,4}\.[0-9]M)`;

const ESCAPED = (value) => String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * ARM_SHAPES admits the two forms `armOf` renders and nothing a writer could type in their place.
 *
 * A model id carries a slash now, so one pattern can no longer tell `zai-org/GLM-5.3-Flash` from a
 * forged `haiku/HIGH`: both are two segments. The suffixed form is therefore bound to a real effort,
 * and the bare form to a model this repository knows by name - a caller's own model still reaches a
 * reader through the suffixed form, which is the one a run with an effort renders.
 */
const ARM_SHAPES = Object.freeze([
  new RegExp(`^${MODEL_SHAPE.source.slice(1, -1)}/(?:${ALLOWED_EFFORTS.join('|')})$`),
  new RegExp(`^(?:${KNOWN_MODELS.map((model) => ESCAPED(model)).join('|')})$`, 'i'),
]);

const COUNTER_SHAPES = Object.freeze([
  ...ARM_SHAPES,
  /^under a minute left$/,
  /^[0-9]{1,4} min left$/,
  new RegExp(`^${COMPACT} in / ${COMPACT} out$`),
  /^[0-9]{1,7} calls?$/,
  /^[0-9]{1,4} subagents?$/,
]);

const RESULTS = Object.freeze(['failure', 'cancelled']);

const RESULT_OF = Object.freeze(
  Object.assign(Object.create(null), { review: 'RESULT_REVIEW', implement: 'RESULT_IMPLEMENT' }),
);

const SAID = Object.freeze(
  Object.assign(Object.create(null), {
    review: Object.freeze(
      Object.assign(Object.create(null), {
        failure: Object.freeze({
          lead: 'This review ended without a report.',
          rest:
            'Its job stopped before it could publish, so nothing in it ran - not even the steps that report a ' +
            'failure. No review was posted.',
          after: 'Ask for it again once the runners are healthy.',
        }),
        cancelled: Object.freeze({
          lead: 'This review was cancelled before it could report.',
          rest: 'No review was posted.',
          after: 'If nothing replaced it, ask for the review again.',
        }),
      }),
    ),
    implement: Object.freeze(
      Object.assign(Object.create(null), {
        failure: Object.freeze({
          lead: 'This run ended without a report.',
          rest:
            'Its job stopped before it could publish, so nothing in it ran - not even the steps that report a ' +
            'failure. Anything it had not already committed is not on the branch.',
          after: 'Ask for it again once the runners are healthy.',
        }),
        cancelled: Object.freeze({
          lead: 'This run was cancelled before it could report.',
          rest: 'Anything it had not already committed is not on the branch.',
          after: 'If a newer run replaced this one, that run reports instead.',
        }),
      }),
    ),
  }),
);

const RETRIED = 'A replacement run has been started.';

function recordDirs(root, { list = readdirSync } = {}) {
  const at = String(root ?? '');
  let nested = [];
  try {
    nested = list(at, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(at, entry.name));
  } catch {
    nested = [];
  }
  return [at, ...nested];
}

function readRecords(root, { read = readFileSync, list = readdirSync } = {}) {
  const seen = new Set();
  return recordDirs(root, { list })
    .map((dir) => readRecord(dir, { read }))
    .filter((record) => {
      if (record === null) return false;
      const key = `${record.run}/${record.flow}/${record.number}/${record.comment_id}/${record.pr}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function readRecord(dir, { read = readFileSync } = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(read(join(String(dir ?? ''), RECOVER_FILE), 'utf-8'));
  } catch {
    return null;
  }
  if (Number(parsed?.v) !== RECOVER_VERSION) return null;
  const record = {
    run: String(parsed.run ?? ''),
    flow: String(parsed.flow ?? ''),
    number: String(parsed.number ?? ''),
    comment_id: String(parsed.comment_id ?? ''),
    pr: String(parsed.pr ?? ''),
    in_body: parsed.in_body === true,
  };
  if (!POSITIVE_ID_SHAPE.test(record.run) || !Object.hasOwn(SAID, record.flow)) return null;
  if (!POSITIVE_ID_SHAPE.test(record.comment_id) && !record.in_body) return null;
  return record;
}

function liveTail(env) {
  const link = runUrl({ serverUrl: env.SERVER_URL, repository: env.REPOSITORY, runId: env.RUN_ID });
  return link === '' ? null : { link, mark: `${LIVE_TAIL}${link})` };
}

function cellsOf(body, mark) {
  const line = String(body ?? '')
    .split('\n')
    .find((one) => one.includes(mark));
  if (line === undefined) return [];
  return line
    .slice(0, line.indexOf(LIVE_TAIL))
    .split(' · ')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 2 && cell.startsWith('`') && cell.endsWith('`'))
    .map((cell) => cell.slice(1, -1))
    .filter((cell) => COUNTER_SHAPES.some((shape) => shape.test(cell)))
    .slice(0, MAX_CELLS);
}

function runsStill(body, runId) {
  const found = STATE_SHAPE.exec(String(body ?? ''));
  if (!found) return false;
  let state = null;
  try {
    state = JSON.parse(found[1]);
  } catch {
    return false;
  }
  const at = `${String(runId ?? '')}:`;
  return (Array.isArray(state?.a) ? state.a : []).some(
    (attempt) => String(attempt?.[0] ?? '').startsWith(at) && String(attempt?.[2] ?? '') === RUNNING,
  );
}

function replaceCurrent(body, notice) {
  const text = String(body ?? '');
  const at = text.indexOf(REPORT_SPLIT);
  if (at < 0) return null;
  const next = `${String(notice ?? '')}${text.slice(at)}`;
  return next === text ? null : next;
}

function replaceLive(body, notice, mark) {
  const lines = String(body ?? '').split('\n');
  const at = lines.findIndex((one) => one.includes(mark));
  if (at < 0) return null;
  const next = [String(notice ?? ''), ...lines.slice(at + 1)].join('\n');
  return next === String(body ?? '') ? null : next;
}

function recoveredIn(body, flow) {
  const only = String(flow ?? '');
  const read = (token) => (RECOVERED_SHAPE.test(token) && token === only ? token : null);
  return markerValues(body, RECOVERED_PREFIX, read).length > 0;
}

function renderNotice({
  flow,
  result,
  cells = [],
  link = '',
  retried = false,
  triggerPhrase = null,
}) {
  const said = SAID[flow]?.[result];
  if (!said) return '';
  const secrets = collectSecrets(process.env);
  const spend = cells.length
    ? `Last reading before it stopped: ${cells.map((cell) => `\`${cell}\``).join(' · ')}. ` +
      `That work was paid for; [this run](${link}) is the record of it.`
    : `[This run](${link}) is the record of what it spent.`;
  const closing = retried ? RETRIED : said.after;
  const lines = [`**${said.lead}** ${said.rest}`, '', spend, '', closing];
  const body = scrubSecrets(scrub(lines.join('\n'), { triggerPhrase }), secrets);
  return `${asAlert('WARNING', body)}\n\n${RECOVERED_PREFIX}${flow} -->`;
}

function spliceOver(body, replace) {
  const text = String(body ?? '');
  const found = locateStatus(text);
  if (found.error || found.absent) return null;
  const next = replace(text.slice(found.start, found.end));
  if (next === null) return null;
  const spliced = spliceStatus(text, next);
  return spliced.error || !spliced.changed ? null : spliced.body;
}

async function readSurface({ github, owner, repo, record }) {
  if (record.in_body) {
    const got = await github.rest.pulls.get({ owner, repo, pull_number: Number(record.pr) });
    return { body: String(got?.data?.body ?? '') };
  }
  const got = await github.rest.issues.getComment({ owner, repo, comment_id: Number(record.comment_id) });
  return { body: String(got?.data?.body ?? '') };
}

async function writeSurface({ github, owner, repo, record, body }) {
  if (record.in_body) {
    await github.rest.pulls.update({ owner, repo, pull_number: Number(record.pr), body });
    return;
  }
  await github.rest.issues.updateComment({ owner, repo, comment_id: Number(record.comment_id), body });
}

async function recoveredBefore({ github, owner, repo, record }) {
  if (!POSITIVE_ID_SHAPE.test(record.number)) return null;
  let found = false;
  const { unreadable } = await probeComments({
    github,
    owner,
    repo,
    prNumber: record.number,
    take: (comment) => {
      found = found || recoveredIn(comment?.body, record.flow);
    },
    cannot: 'run cannot say whether it has already started a replacement',
  });
  return unreadable === null ? found : null;
}

function dispatchInputs(record, env) {
  if (record.flow !== 'review' || !POSITIVE_ID_SHAPE.test(record.number)) return null;
  const actor = String(env.ACTOR ?? '').trim();
  return LOGIN_SHAPE.test(actor) ? { actor, pr: record.number } : { pr: record.number };
}

async function retryRun({ github, core, owner, repo, record, env }) {
  const inputs = dispatchInputs(record, env);
  if (inputs === null) return { started: false, why: 'nothing named what the replacement run would work on' };
  const out = await dispatchSuccessor({
    github,
    core,
    owner,
    repo,
    workflowFile: String(env.CONTINUATION_WORKFLOW ?? '').trim(),
    defaultBranch: String(env.DEFAULT_BRANCH ?? '').trim(),
    inputs,
  });
  return { started: out.ok === true, why: String(out.reason ?? '') };
}

async function recoverRun({ github, core, owner, repo, env, dir, read = readFileSync, list = readdirSync }) {
  const held = { repaired: 'false', retried: 'false' };
  const records = readRecords(dir, { read, list });
  if (records.length === 0) return { outputs: held, notices: ['this run left no record of a surface to recover'] };

  const notices = [];
  const outputs = { ...held };
  for (const record of records) {
    const one = await recoverSurface({ github, core, owner, repo, env, record });
    notices.push(...one.notices);
    for (const name of Object.keys(held)) {
      if (one.outputs[name] === 'true') outputs[name] = 'true';
    }
  }
  return { outputs, notices };
}

async function recoverSurface({ github, core, owner, repo, env, record }) {
  const outputs = { repaired: 'false', retried: 'false' };
  const notices = [];

  if (record.run !== String(env.RUN_ID ?? '')) {
    return { outputs, notices: [`the recovery record names run ${record.run}, and this is ${env.RUN_ID}`] };
  }

  const result = String(env[RESULT_OF[record.flow]] ?? '');
  if (!RESULTS.includes(result)) {
    return { outputs, notices: [`nothing to recover from a ${record.flow} job that ${result || 'never ran'}`] };
  }

  const tail = liveTail(env);
  if (tail === null) return { outputs, notices: ['this run had no run link, so it can name nothing to recover'] };

  let body = '';
  try {
    ({ body } = await readSurface({ github, owner, repo, record }));
  } catch (error) {
    core?.warning?.(`the surface this run was writing to could not be read (${error.message}).`);
    return { outputs, notices: [] };
  }
  const writes = record.flow === 'implement';
  const stale = writes ? runsStill(body, env.RUN_ID) : body.includes(tail.mark);
  if (!stale) {
    return { outputs, notices: ['what this run was writing to no longer shows it working, so it was left alone'] };
  }

  let spent = null;
  if (record.flow === 'review') {
    try {
      spent = await recoveredBefore({ github, owner, repo, record });
    } catch (error) {
      core?.warning?.(`whether a replacement was already started could not be read (${error.message}).`);
    }
  }

  const mayRetry = String(env.RETRY ?? '') === 'true' && result === 'failure' && spent === false;

  const retry = mayRetry ? await retryRun({ github, core, owner, repo, record, env }) : { started: false, why: '' };
  if (mayRetry && !retry.started) core?.warning?.(`no replacement run was started (${retry.why}).`);

  const notice = renderNotice({
    flow: record.flow,
    result,
    cells: cellsOf(body, tail.mark),
    link: tail.link,
    retried: retry.started,
    triggerPhrase: env.TRIGGER,
  });
  if (notice === '') return { outputs, notices: [`no notice could be rendered for a ${record.flow} run`] };
  const replace = writes ? (text) => replaceCurrent(text, notice) : (text) => replaceLive(text, notice, tail.mark);
  const next = record.in_body ? spliceOver(body, replace) : replace(body);
  if (next === null) {
    return { outputs, notices: [`the ${record.flow} report could not be rewritten, so it was left alone`] };
  }

  try {
    await writeSurface({ github, owner, repo, record, body: next });
  } catch (error) {
    core?.warning?.(`what this run was writing to could not be rewritten (${error.message}).`);
    return { outputs, notices: [] };
  }

  outputs.repaired = 'true';
  outputs.retried = retry.started ? 'true' : 'false';
  notices.push(`said on the ${record.flow} report that this run ended without one`);
  if (retry.started) notices.push('and started one replacement run');
  return { outputs, notices };
}

module.exports = {
  LIVE_TAIL,
  COUNTER_SHAPES,
  RECOVERED_PREFIX,
  RESULTS,
  SAID,
  cellsOf,
  dispatchInputs,
  liveTail,
  readRecord,
  readRecords,
  recordDirs,
  recoverRun,
  recoveredBefore,
  recoveredIn,
  renderNotice,
  replaceCurrent,
  replaceLive,
  runsStill,
  spliceOver,
};
