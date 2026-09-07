'use strict';

const { scrubTrigger } = require('./select-arm.cjs');

const MAX_HISTORY = 24;

const MAX_NOTE_CHARS = 240;

const MAX_CELLS = 8;

const CELL_SHAPE = /^[\w $~.,/-]{1,40}$/;

function statusLine(arm, cells) {
  const kept = (Array.isArray(cells) ? cells : [])
    .slice(0, MAX_CELLS)
    .map((cell) => String(cell ?? '').trim())
    .filter((cell) => CELL_SHAPE.test(cell));
  return [String(arm ?? '').trim(), ...kept.map((cell) => `\`${cell}\``)].filter(Boolean).join(' · ');
}

const STAGES = Object.freeze(
  Object.assign(Object.create(null), {
    working: true,
    inspecting: true,
    changing: true,
    testing: true,
    auditing: true,
    reporting: true,
  }),
);

const REVIEW_LABELS = Object.freeze(
  Object.assign(Object.create(null), {
    working: ['dash', 'In progress'],
    inspecting: ['scan', 'Inspecting changes'],
    changing: ['scan', 'Inspecting changes'],
    testing: ['check', 'Validating evidence'],
    auditing: ['sift', 'Auditing findings'],
    reporting: ['report', 'Preparing the report'],
  }),
);

const IMPLEMENT_LABELS = Object.freeze(
  Object.assign(Object.create(null), {
    working: ['dash', 'In progress'],
    inspecting: ['scan', 'Investigating'],
    changing: ['write', 'Changing files'],
    testing: ['check', 'Validating changes'],
    auditing: ['sift', 'Checking its work'],
    reporting: ['report', 'Preparing the result'],
  }),
);

const ASSET_REF = '';
const ASSET_BASE = `https://github.com/the ksai source repository/blob/${ASSET_REF}/.github/assets`;

const PINNED = /\/blob\/[0-9a-f]{40}\//.test(ASSET_BASE);

const loader = (name) =>
  !PINNED
    ? ''
    : [
      '<picture>',
      `<source media="(prefers-color-scheme: dark)" srcset="${ASSET_BASE}/${name}-dark.svg?raw=true">`,
      `<img src="${ASSET_BASE}/${name}.svg?raw=true" width="12" height="15" alt="" align="absmiddle">`,
      '</picture>',
    ].join('');

const beside = (mark, words) => (mark === '' ? words : `${mark} ${words}`);

const MOVING = Object.freeze(['spark', 'dash', 'scan', 'write', 'check', 'sift', 'report']);

const STILL = Object.freeze(
  Object.assign(Object.create(null), { done: '✅', failed: '❌', stopped: '⏹️', waiting: '⏳' }),
);

const MARKS = Object.freeze([...MOVING, ...Object.keys(STILL)]);

const FLOW_COMMAND = Object.freeze(
  Object.assign(Object.create(null), { review: 'review', implement: 'implement', tester: 'test' }),
);

const COMMAND_SHAPE = /^[a-z][a-z-]{0,23}$/;

const SAID_SHAPE = /^[A-Z][^\n]{0,79}$/;

function commandName(value) {
  const said = String(value ?? '').trim().toLowerCase();
  if (!COMMAND_SHAPE.test(said)) return '';
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}

function symbolFor(mark) {
  const named = String(mark ?? '').trim();
  if (Object.hasOwn(STILL, named)) return STILL[named];
  return MOVING.includes(named) ? loader(named) : '';
}

const HREF_SHAPE = /^https:\/\/[^\s()<>]+$/;

function ksaiHeading({ command = '', flow = '', said = '', mark = '', href = '', triggerPhrase = null } = {}) {
  const who = commandName(command) || commandName(FLOW_COMMAND[String(flow ?? '').trim()]);
  const words = String(said ?? '').trim();
  if (who === '' || !SAID_SHAPE.test(words)) return '';
  const link = String(href ?? '').trim();
  const label = `KSAI ${who}`;
  const named = HREF_SHAPE.test(link) ? `[${label}](${link})` : label;
  return scrubTrigger(beside(symbolFor(mark), `**${named}: ${words}**`), triggerPhrase);
}

function headedBlock(row, fields = {}) {
  const { said, mark, next } = row ?? {};
  const heading = ksaiHeading({ ...fields, said, mark });
  if (heading === '') return '';
  const after = String(next ?? '').trim();
  return after === '' ? heading : `${heading} · ${scrubTrigger(`_Next: ${after}_`, fields.triggerPhrase)}`;
}

const HEADED = /^(?:<picture>.*<\/picture> |\S+ )?\*\*\[?KSAI [A-Z][A-Za-z-]*(?:\]\([^)]*\))?: /;

const carriesHeading = (text) => HEADED.test(String(text ?? '').split('\n', 1)[0] ?? '');

function stageOf(value) {
  const stage = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(STAGES, stage) ? stage : 'working';
}

function runHeading(flow, stage = '', finished = false, command = '', triggerPhrase = null, href = '') {
  const kind = String(flow ?? '');
  if (kind !== 'review' && kind !== 'implement') return '';
  const said = { command, flow: kind, triggerPhrase, href };
  if (finished) return ksaiHeading({ ...said, said: 'Finished', mark: 'done' });
  if (!stage) return ksaiHeading({ ...said, said: 'Started', mark: 'spark' });
  const labels = kind === 'review' ? REVIEW_LABELS : IMPLEMENT_LABELS;
  const [mark, label] = labels[stageOf(stage)];
  return ksaiHeading({ ...said, said: label, mark });
}

const ELLIPSIS = '…';

function cutNote(text) {
  const said = String(text ?? '').trim();
  const points = Array.from(said);
  if (points.length <= MAX_NOTE_CHARS) return said;
  let held = points.slice(0, MAX_NOTE_CHARS - 1).join('');
  held = held.replace(/\s+\S*$/, '') || held;
  const opened = held.lastIndexOf('](');
  if (opened > 0 && !held.slice(opened).includes(')')) held = held.slice(0, opened);
  const tick = held.lastIndexOf('`');
  if (tick > 0 && (held.match(/`/g)?.length ?? 0) % 2 === 1) held = held.slice(0, tick);
  return `${held.trimEnd().replace(/[\\[,;:]+$/, '')}${ELLIPSIS}`;
}

const BLANK_CELL = '—';

function reportTable(columns, rows, blank = BLANK_CELL) {
  const kept = columns.map((_, at) => rows.length === 0 || rows.some((row) => row[at] !== blank));
  const only = (row) => row.filter((_, at) => kept[at]);
  return [
    `| ${only(columns).join(' | ')} |`,
    `| ${only(columns).map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${only(row).join(' | ')} |`),
  ];
}

const spendSaid = (clauses) =>
  clauses.length === 0 ? [] : ['', clauses.join('; ').replace(/^./, (one) => one.toUpperCase())];

function appendHistory(history, entry) {
  const kept = Array.isArray(history) ? history.slice(-MAX_HISTORY) : [];
  const at = Number(entry?.at);
  const said = cutNote(entry?.said).trimEnd().replace(/\.+$/, '');
  if (!Number.isFinite(at) || at <= 0 || said === '') return kept;
  const stage = stageOf(entry?.stage);
  const last = kept.at(-1);
  if (last?.said === said && last?.stage === stage) return kept;
  return [...kept, { at, stage, said }].slice(-MAX_HISTORY);
}

function shortUtc(value) {
  const at = new Date(Number(value));
  if (!Number.isFinite(at.getTime())) return '';
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}

function visibleHistory(history, mode = 'auto') {
  const entries = Array.isArray(history) ? history : [];
  return mode === 'off' ? entries.slice(-1) : entries;
}

function historyLines(history, mode = 'auto') {
  const lines = visibleHistory(history, mode).flatMap((entry) => {
    const at = shortUtc(entry?.at);
    const said = String(entry?.said ?? '').trim().replace(/\.+$/, '');
    return at && said ? [{ at, said }] : [];
  });
  return lines.map(({ at, said }, index) => `${index + 1}. **\`${at}\`** ${said}`);
}

module.exports = {
  MARKS,
  MAX_CELLS,
  MAX_HISTORY,
  MAX_NOTE_CHARS,
  BLANK_CELL,
  appendHistory,
  carriesHeading,
  cutNote,
  headedBlock,
  historyLines,
  ksaiHeading,
  reportTable,
  runHeading,
  spendSaid,
  stageOf,
  statusLine,
  visibleHistory,
};
