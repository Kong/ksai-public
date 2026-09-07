'use strict';

const { SITE } = require('../lib/docs.cjs');
const { headedBlock, reportTable } = require('../lib/run-progress.cjs');
const { SURFACE } = require('../lib/select-arm.cjs');
const { escapeForRegExp } = require('../lib/text.cjs');

const VERSION = 1;

const FLOWS = Object.freeze(['implement', 'review']);

const NEEDS = Object.freeze(['approve', 'retrigger', 'manual', 'none']);

const WHERE = Object.freeze(['pr', 'issue']);

const KIND_TABLE = Object.freeze(
  Object.assign(Object.create(null), {
    'run-started': { needs: 'none', said: 'Started', mark: 'spark', next: '' },
    'write-report': { needs: 'none', said: 'In progress', mark: 'dash', next: '' },
    'pr-opened': { needs: 'none', said: 'Draft opened', mark: 'done', next: 'the plan is written to a document on this branch' },
    'plan-published': { needs: 'none', said: 'Plan published', mark: 'done', next: 'a code owner approves the plan, and its tasks start' },
    'plan-waiting': { needs: 'approve', said: 'Waiting for approval', mark: 'waiting', next: '', answers: 'approve' },
    'plan-approved': { needs: 'none', said: 'Approval recorded', mark: 'done', next: 'the first unchecked step runs' },
    'plan-blocked': { needs: 'manual', said: 'Blocked', mark: 'failed', next: '' },
    'build-blocked': { needs: 'manual', said: 'Blocked', mark: 'failed', next: '' },
    'step-done': { needs: 'none', said: 'Step done', mark: 'done', next: 'the next unchecked step runs' },
    'phase-waiting': { needs: 'approve', said: 'Waiting for approval', mark: 'waiting', next: '', answers: 'approve' },
    'plan-complete': { needs: 'approve', said: 'Waiting for approval', mark: 'waiting', next: '', answers: 'approve' },
    'phase-released': { needs: 'none', said: 'Phase released', mark: 'done', next: 'the first step of the next phase runs' },
    'last-phase-released': { needs: 'none', said: 'Last phase released', mark: 'done', next: 'the pull request opens for review' },
    'run-finished': { needs: 'none', said: 'Finished', mark: 'done', next: '' },
    'run-failed': { needs: 'retrigger', said: 'Failed', mark: 'failed', next: '', answers: 'implement' },
    'run-stopped': { needs: 'retrigger', said: 'Stopped', mark: 'stopped', next: '', answers: 'implement' },
    'run-paused': { needs: 'retrigger', said: 'Paused', mark: 'stopped', next: '', answers: 'resume' },
    'chain-stopped': { needs: 'retrigger', said: 'Stopped', mark: 'stopped', next: '', answers: 'implement' },
    notice: { needs: 'manual', said: 'Nothing ran', mark: 'failed', next: '' },
    guide: { needs: 'none', said: 'Commands here', mark: 'done', next: '' },
    receipt: { needs: 'none', said: 'Started', mark: 'spark', next: '' },
    'fix-answered': { needs: 'none', said: 'Review threads answered', mark: 'done', next: '' },
    'revise-answered': { needs: 'none', said: 'Plan revised', mark: 'done', next: 'a code owner approves the plan, and its tasks start' },
    'do-reported': { needs: 'none', said: 'Change made', mark: 'done', next: '' },
    'thread-agreed': { needs: 'none', said: 'Thread answered', mark: 'done', next: '' },
    'thread-unclear': { needs: 'none', said: 'Thread unclear', mark: 'waiting', next: '' },
    'thread-locked': { needs: 'manual', said: 'Thread locked', mark: 'waiting', next: '' },
    'thread-unlocked': { needs: 'none', said: 'Thread unlocked', mark: 'done', next: '' },
    'thread-overridden': { needs: 'none', said: 'Threads resolved', mark: 'done', next: '' },
  }),
);

for (const row of Object.values(KIND_TABLE)) Object.freeze(row);

const KINDS = Object.freeze(Object.keys(KIND_TABLE));

const PAGE_OF = Object.freeze(Object.assign(Object.create(null), { pull: 'pr', issue: 'issue' }));

const PAGE = Object.freeze(
  Object.assign(Object.create(null), {
    approve: `${SITE}/implement/approval`,
    retrigger: `${SITE}/implement/commands`,
    manual: `${SITE}/implement`,
    none: `${SITE}/implement`,
  }),
);

const REVIEW_PAGE = Object.freeze(
  Object.assign(Object.create(null), {
    retrigger: `${SITE}/review`,
    manual: `${SITE}/review`,
    none: `${SITE}/review`,
  }),
);

const pageFor = (flow, needs) => (flow === 'review' ? REVIEW_PAGE[needs] : undefined) ?? PAGE[needs];

const LABEL = Object.freeze(
  Object.assign(Object.create(null), {
    approve: 'How to approve this',
    retrigger: 'How to resume this',
    manual: 'Why this stopped, and what unblocks it',
    none: 'About KSAI',
  }),
);

const aboutLink = () => `[${LABEL.none}](${PAGE.none})`;

const MARKER_SHAPE = /<!-- ksai:(\{[^]*?\}) -->/;

function positive(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const DEAD_REASON = Object.freeze(['approve-disabled']);

function resolve({ kind = null, needs = null, where = null, reason = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`\`${String(kind)}\` is not a ksai comment kind`);
  const dead = DEAD_REASON.includes(String(reason ?? ''));
  const declared = NEEDS.includes(needs) ? needs : KIND_TABLE[kind].needs;
  const wanted = dead ? 'manual' : (declared ?? 'manual');
  const answers = KIND_TABLE[kind]?.answers;
  const at = WHERE.includes(where) ? where : PAGE_OF[SURFACE[answers]];
  return { needs: wanted, where: at ?? null };
}

function payloadOf({ kind = null, flow = null, issue = null, pr = null, run = null, needs = null, where = null, reason = null } = {}) {
  const answer = resolve({ kind, needs, where, reason });
  const payload = { v: VERSION, kind, needs: answer.needs };
  if (answer.where) payload.where = answer.where;
  if (FLOWS.includes(flow)) payload.flow = flow;
  for (const [key, value] of [
    ['issue', issue],
    ['pr', pr],
    ['run', run],
  ]) {
    const number = positive(value);
    if (number !== null) payload[key] = number;
  }
  return payload;
}

function marker(fields) {
  const json = JSON.stringify(payloadOf(fields));
  if (json.includes('--')) throw new Error('a ksai comment marker cannot carry `--`, which ends the comment');
  return `<!-- ksai:${json} -->`;
}

function href(fields) {
  const payload = payloadOf(fields);
  if (!SITE) return '';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) query.set(key, String(value));
  return `${pageFor(payload.flow, payload.needs)}?${query.toString()}`;
}

function headingFor(fields) {
  const kind = String(fields?.kind ?? '');
  if (!Object.hasOwn(KIND_TABLE, kind)) return '';
  return headedBlock(KIND_TABLE[kind], {
    command: fields?.command,
    flow: fields?.flow ?? 'implement',
    href: href(fields),
    triggerPhrase: fields?.triggerPhrase,
  });
}

function marked(body, fields) {
  const text = String(body ?? '').replace(/\s+$/, '');
  const rows = Array.isArray(fields?.table) ? fields.table.filter(([, value]) => String(value ?? '') !== '') : [];
  const heading = headingFor(fields);
  const opening = heading ? [heading] : [];
  if (rows.length === 0) return [...opening, text, marker(fields)].join('\n\n').concat('\n');
  const heads = rows.map(([head]) => head);
  const cells = rows.map(([, value]) => value);
  const table = reportTable(heads, [cells], '');
  return `${[...opening, table.join('\n'), text].join('\n\n')}\n\n${marker(fields)}\n`;
}

function markerOf(body) {
  const found = String(body ?? '').match(MARKER_SHAPE);
  if (!found) return null;
  let parsed;
  try {
    parsed = JSON.parse(found[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return KINDS.includes(parsed.kind) ? parsed : null;
}

function stateOf(body) {
  if (!SITE) return null;
  const found = String(body ?? '').match(new RegExp(`\\]\\(${escapeForRegExp(SITE)}[^)\\s]*\\?([^)\\s]+)\\)`));
  if (!found) return null;
  const query = Object.fromEntries(new URLSearchParams(found[1]));
  return KINDS.includes(query.kind) && NEEDS.includes(query.needs) ? query : null;
}

function payloadFor(env, extra) {
  return {
    flow: 'implement',
    command: env.COMMAND,
    triggerPhrase: env.TRIGGER,
    issue: env.ISSUE_NUM,
    pr: env.PR_NUMBER,
    run: env.RUN_ID,
    ...extra,
  };
}

module.exports = {
  payloadFor,
  positive,
  VERSION,
  KIND_TABLE,
  KINDS,
  FLOWS,
  NEEDS,
  WHERE,
  SITE,
  aboutLink,
  href,
  marker,
  marked,
  markerOf,
  stateOf,
};
