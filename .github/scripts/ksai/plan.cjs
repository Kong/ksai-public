
const { createHash } = require('node:crypto');
const { escapeForRegExp, triggerPhrases, DEFAULT_TRIGGER_PHRASE } = require('../lib/text.cjs');
const { asAlert, JIRA_KEY_SHAPE, JIRA_ACCOUNT_CORE } = require('../lib/select-arm.cjs');
const { SITE, aboutLink, marked } = require('./marker.cjs');
const { nativeApprovalMarker } = require('./native-approval-ref.cjs');
const { COMMIT_TYPES, BRANCH_SHAPE, FLOW_BRANCH_SHAPE, JIRA_BRANCH_SHAPE, safeEcho } = require('./verify-chunk.cjs');

const REGION_BEGIN = '<!-- ksai-plan:begin -->';
const REGION_END = '<!-- ksai-plan:end -->';

const STATUS_BEGIN = '<!-- ksai-status:begin -->';
const STATUS_END = '<!-- ksai-status:end -->';
const STATUS_FENCE = Object.freeze({ begin: STATUS_BEGIN, end: STATUS_END });

const PLAN_FILE_MARKER_PREFIX = '<!-- ksai-plan-file:';

const PLAN_DOC_MARKER_PREFIX = '<!-- ksai-plan-doc:';

const BLOB_SHAPE = /^[0-9a-f]{40}$/;

const MAX_PATH_SEGMENT_CHARS = 96;

const PATH_SEGMENT = `(?!\\.{1,2}(?:\\/|$))[A-Za-z0-9._-]{1,${MAX_PATH_SEGMENT_CHARS}}`;

const PLAN_FILE_SHAPE = new RegExp(`^(?:${PATH_SEGMENT}\\/){0,8}${PATH_SEGMENT}\\.md$`);

const PLAN_DIR_SHAPE = new RegExp(`^(?:${PATH_SEGMENT}\\/){0,7}${PATH_SEGMENT}$`);

const DEFAULT_PLAN_DIR = 'docs/plans';

const PHASE_HEADING = /^ {0,3}##[ \t]+Phase[ \t]+([1-9][0-9]{0,2})[ \t]*(?:[-:][ \t]*?(.*?))?(?:[ \t]+#+)?[ \t]*$/;

const CONTAINER_RUN = /^(?:[ \t]*>|[ \t]{0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+)+[ \t]*/;

const NESTED_RUN = /^(?:[ \t]*>|[ \t]*(?:[-*+]|[0-9]{1,9}[.)])[ \t]+)*[ \t]*/;

const ATX_TEXT = /^ {0,3}#{1,6}[ \t]+(.*)$/;

const INLINE_MARKUP = /[*_`~\\]/g;

const NUMERIC_ENTITY = /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g;

const CLOSING_SEQUENCE = /[ \t]+#+[ \t]*$/;

const ITEM_MARKER = /^([ \t]*(?:[-*+]|[0-9]{1,9}[.)]))([ \t]+)/;

const columnAfter = (prefix) => {
  let column = 0;
  for (const one of String(prefix ?? '')) column += one === '\t' ? 4 - (column % 4) : 1;
  return column;
};

const indentOf = (line) => {
  const held = /^[ \t]*/.exec(String(line ?? ''));
  return columnAfter(held[0]);
};

const contentColumn = (marker, gap) => {
  const ends = columnAfter(marker);
  const wide = columnAfter(`${marker}${gap}`) - ends;
  return wide > 4 ? ends + 1 : ends + wide;
};

const NAMED_ENTITY = /&[a-zA-Z][a-zA-Z0-9]*;/g;

const NAMES_PHASE = /^[^\p{L}\p{N}\n]*Phase[^\p{L}\p{N}\n]*[0-9]/iu;

const NAMES_STEPS = /^[^\p{L}\p{N}\n]*Steps[^\p{L}\p{N}\n#]*$/iu;

const HTML_BLOCK_AT = /^<(?:\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t/>]|$)|\?|!(?:[a-zA-Z]|\[CDATA\[))/;

const STEPS_HEADING = /^ {0,3}###[ \t]+Steps(?:[ \t]+#+)?[ \t]*$/;

const DOC_BULLET = /^[-*+][ \t]+(.*?)[ \t]*$/;

const INDENTED_UNDER_STEPS = /^[ \t]+\S/;

const ORDERED_ITEM = /^[0-9]{1,9}[.)][ \t]+\S/;

const RULED_ITEM = /^ {0,3}(?:[-*+][ \t]+\S|[0-9]{1,9}[.)][ \t]+\S)/;

const EMPTY_ITEM = /^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]*$/;

const SETEXT_UNDERLINE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/;

const ANY_HEADING = /^ {0,3}#{1,6}([ \t]|$)/;

const SIBLING_HEADING = /^#{1,3}([ \t]|$)/;

const DOC_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const DOC_QUOTE = /^ {0,3}>/;

const QUOTE_RUN = /^(?: {0,3}>[ \t]?)+/;

const opensFence = (fence) => !(fence[1].startsWith('`') && String(fence[2] ?? '').includes('`'));

const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

const LEGACY_REGION_BEGIN = '<!-- muthur-plan:begin -->';
const LEGACY_REGION_END = '<!-- muthur-plan:end -->';

const FENCES = [
  { begin: REGION_BEGIN, end: REGION_END },
  { begin: LEGACY_REGION_BEGIN, end: LEGACY_REGION_END },
];

const fencesIn = (text) => FENCES.filter((pair) => text.includes(pair.begin) || text.includes(pair.end));

function headingText(said) {
  return String(said ?? '')
    .replace(NUMERIC_ENTITY, (whole, hex, decimal) => {
      const point = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
      if (point <= 0 || point > 0x10ffff) return whole;
      return point <= 0x20 ? ' ' : String.fromCodePoint(point);
    })
    .replace(NAMED_ENTITY, ' ')
    .replace(INLINE_MARKUP, '');
}

function uncontained(line, nested = false) {
  return String(line ?? '').replace(nested ? NESTED_RUN : CONTAINER_RUN, '');
}

function atxText(line, listed = false) {
  const opened = ATX_TEXT.exec(uncontained(line, listed));
  return opened ? headingText(opened[1].replace(CLOSING_SEQUENCE, '')) : null;
}

function underlinedNames(shape, said) {
  const lines = String(said ?? '')
    .split('\n')
    .map((one) => uncontained(one));
  return [lines.join(' '), ...lines].some((one) => shape.test(headingText(one)));
}

function fenceOf(text) {
  const seen = fencesIn(String(text ?? ''));
  if (seen.length > 1) {
    return { error: 'the PR body carries plan fences under two different markers, so which one is the plan is unclear' };
  }
  return { fence: seen[0] ?? FENCES[0] };
}

const REDACTION = '(trigger)';

const ELLIPSIS = '…';

const ADDED_BY_RENDER = Object.freeze([REDACTION.toLowerCase(), ELLIPSIS]);

const MAX_TITLE_CHARS = 200;

const MAX_CUT_PASSES = 8;

const MAX_PHRASE_PASSES = 64;
const MAX_SUMMARY_CHARS = 500;
const MAX_STEPS = 30;

const MAX_ACTOR_CHARS = 64;

const TASK_ROW = /(^|[\s>])((?:[-*+]|\d{1,9}[.)])[ \t]*)\[([ \t]*[xX]?[ \t]*)\]/g;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const RESERVED_COMMENT = /(?:ksai|muthur)-(?:plan|do|phase)|kreview-(?:ids|finding)|ksai-(?:criteria|released|boundaries|write|status|paused)|ksai:/;

const CRITERIA_MARKER_PREFIX = '<!-- ksai-criteria:';

const PHASE_MARKER_PREFIX = '<!-- ksai-phase:';

const CRITERIA_REF_SHAPE = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;

const JIRA_REF_SHAPE = /^([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10})\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9})$/;
const ANY_FOLDED_HEADING = /#{1,6}\s*Additional findings \(not anchored to the diff\)/g;

const URL_SHAPE = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]{1,400}$/;

const LOGIN_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const ROW = /^- \[([ xX])\][ \t]*(.*?)[ \t]*$/;
const UNCHECKED_BOX = /^- \[ \]/;

function countOccurrences(haystack, needle) {
  let found = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found += 1;
  return found;
}

function cap(text, limit) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('').replace(/\\+$/, '')}${ELLIPSIS}`;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function retargetPermalinks(text, { repo = null, from = null, to = null } = {}) {
  const said = String(text ?? '');
  const landed = String(to ?? '');
  const owner = String(repo ?? '');
  if (!COMMIT_SHA.test(landed) || !REPO_SHAPE.test(owner)) return said;
  const stale = (Array.isArray(from) ? from : [from])
    .map((one) => String(one ?? ''))
    .filter((one) => COMMIT_SHA.test(one) && one.toLowerCase() !== landed.toLowerCase());
  if (stale.length === 0) return said;
  const at = new RegExp(
    `(https://github\\.com/${escapeForRegExp(owner)}/blob/)(?:${stale.join('|')})(?=[/?#])`,
    'gi',
  );
  return said.replace(at, (_, head) => `${head}${landed}`);
}

const HELD_URL = new RegExp(`${escapeForRegExp(SITE)}[^\\s)<>]*`, 'g');

const HELD_MARK = '\u0000';

const HELD_BACK = new RegExp(`${HELD_MARK}([0-9]{1,6})${HELD_MARK}`, 'g');

function holdDocsUrls(text) {
  const held = [];
  const masked = String(text ?? '').split(HELD_MARK).join('').replace(HELD_URL, (found) => {
    held.push(found);
    return `${HELD_MARK}${held.length - 1}${HELD_MARK}`;
  });
  return {
    masked,
    restore: (value) =>
      String(value)
        .replace(HELD_BACK, (_, at) => held[Number(at)] ?? '')
        .replaceAll(HELD_MARK, ''),
  };
}

function scrub(text, { triggerPhrase = null } = {}) {
  const phrases = triggerPhrases(triggerPhrase);
  const token = phrases.some((phrase) => ADDED_BY_RENDER.some((made) => made.includes(phrase.toLowerCase())))
    ? ''
    : REDACTION;
  const [before, after] = token === '' ? ['', ''] : ['(?<![A-Za-z0-9])', '(?![A-Za-z0-9])'];
  const onePass = (value) =>
    phrases.reduce(
      (carried, phrase) => carried.replace(new RegExp(`${before}${escapeForRegExp(phrase)}${after}`, 'gi'), token),
      String(value ?? ''),
    );
  const deleteAll = (value) =>
    phrases.reduce(
      (carried, phrase) => carried.replace(new RegExp(escapeForRegExp(phrase), 'gi'), ''),
      String(value ?? ''),
    );
  const removePhrase = (value) => {
    let held = String(value ?? '');
    for (let pass = 0; pass < MAX_PHRASE_PASSES; pass += 1) {
      const next = onePass(held);
      if (next === held) return held;
      held = next;
    }
    return deleteAll(held);
  };
  const removeFolded = (value) => {
    let held = String(value ?? '');
    for (let next = held.replace(ANY_FOLDED_HEADING, ''); next !== held; next = held.replace(ANY_FOLDED_HEADING, '')) {
      held = next;
    }
    return held;
  };
  const { masked, restore } = SITE ? holdDocsUrls(text) : { masked: String(text ?? ''), restore: (value) => value };
  const stripped = removePhrase(
    removeFolded(
      removePhrase(masked).replace(HTML_COMMENT, (comment) => (RESERVED_COMMENT.test(comment) ? '' : comment)),
    ),
  );
  return restore(
    stripped
      .replace(/<!--/g, '&lt;!--')
      .replace(/-->/g, '--&gt;')
      .replace(TASK_ROW, '$1$2\\[$3\\]'),
  );
}

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ');

function oneLine(text, options = {}) {
  return collapse(scrub(collapse(text), options)).trim();
}

function mention(login, options) {
  const raw = String(login ?? '').trim();
  if (!raw) return '';
  if (LOGIN_SHAPE.test(raw)) return `@${raw}`;
  const shown = cap(oneLine(raw, options).replace(/`/g, ''), MAX_ACTOR_CHARS);
  return shown ? `\`${shown}\`` : '';
}

function storedTitle(title, options) {
  let held = oneLine(title, options);
  if (Array.from(held).length <= MAX_TITLE_CHARS) return held;
  for (let pass = 0; pass < MAX_CUT_PASSES && Array.from(held).length > MAX_TITLE_CHARS; pass += 1) {
    held = oneLine(cap(held, MAX_TITLE_CHARS - 1), options);
  }
  return held && Array.from(held).length <= MAX_TITLE_CHARS ? held : '';
}

function normalizeSteps(steps, options) {
  if (!Array.isArray(steps) || !steps.length) return { error: 'the plan holds no steps' };
  const asked = steps.filter((one) => !(one !== null && typeof one === 'object' && one[MINE] === true)).length;
  if (asked > MAX_STEPS) {
    return { error: `the plan holds ${asked} steps, over the limit of ${MAX_STEPS}` };
  }

  const out = [];
  const shortened = [];
  const seen = new Map();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const holder = step && typeof step === 'object' ? step : null;
    const mine = holder !== null && holder[MINE] === true;
    const title = mine ? String(holder.title) : oneLine(holder ? holder.title : step, options);
    const at = i + 1;

    if (!title) return { error: `step ${at} has no title left once its markup is removed` };

    const raw = holder ? holder.title : step;
    if (!mine && (isCheckpoint(title) || isCheckpoint(collapse(raw).trim()))) {
      return { error: `step ${at} is titled like a phase boundary, which this flow writes itself` };
    }

    const length = Array.from(title).length;
    let held = title;
    if (!mine && length > MAX_TITLE_CHARS) {
      held = storedTitle(title, options);
      if (!held) {
        return { error: `step ${at}'s title is ${length} characters and shortening it never settled under ${MAX_TITLE_CHARS}` };
      }
      shortened.push({ at, length });
    }

    const first = seen.get(held);
    if (first !== undefined) {
      return { error: `steps ${first} and ${at} have the same title, so a report naming it could not say which one was done` };
    }
    seen.set(held, at);

    out.push({ title: held });
  }

  return { steps: out, shortened };
}

const MAX_PR_TITLE_CHARS = 72;
const SUBJECT_SHAPE = new RegExp(`^(${COMMIT_TYPES.join('|')})\\([a-z0-9][a-z0-9-]*\\): .+$`);

const CONVENTIONAL_PREFIX = new RegExp(`^(${COMMIT_TYPES.join('|')})(\\([A-Za-z0-9][A-Za-z0-9-]*\\))?:[ \\t]*`, 'i');

const DEFAULT_TYPE = 'chore';

const MAX_SLUG_CHARS = 60;

const FALLBACK_SLUG = 'plan';

const FALLBACK_SCOPE = '(plan)';

function typeOf(title) {
  const found = String(title ?? '').match(CONVENTIONAL_PREFIX);
  return found ? found[1].toLowerCase() : null;
}

const described = (title) => String(title ?? '').replace(CONVENTIONAL_PREFIX, '');

function isThreadless({ issueNumber = null, jiraKey = null } = {}) {
  const key = String(jiraKey ?? '')
    .trim()
    .toUpperCase();
  return { key, threadless: String(issueNumber ?? '').trim() === '' && key !== '' };
}

function branchFor({ issueNumber = null, title = null, jiraKey = null } = {}) {
  const issue = Number(issueNumber);
  const { key, threadless } = isThreadless({ issueNumber, jiraKey });
  if (threadless) {
    if (!JIRA_KEY_SHAPE.test(key)) return null;
  } else if (!Number.isInteger(issue) || issue <= 0 || String(issueNumber ?? '').trim() !== String(issue)) {
    return null;
  }
  const slug =
    described(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/g, '') || FALLBACK_SLUG;
  const reference = threadless ? `jira-${key}` : `issue-${issue}`;
  const branch = `${typeOf(title) ?? DEFAULT_TYPE}/${reference}-${slug}`;
  const shape = threadless ? JIRA_BRANCH_SHAPE : BRANCH_SHAPE;
  return shape.test(branch) ? branch : null;
}

function provisionalTitle({ issueNumber = null, title = null, triggerPhrase = null, jiraKey = null } = {}) {
  const options = { triggerPhrase };
  const clean = oneLine(title, options);
  const found = clean.match(CONVENTIONAL_PREFIX);
  const type = found ? found[1].toLowerCase() : DEFAULT_TYPE;
  const scope = found?.[2] ? found[2].toLowerCase() : FALLBACK_SCOPE;
  const description = described(clean).replace(/^[A-Z](?![A-Z])/, (letter) => letter.toLowerCase());
  const capped = cap(`${type}${scope}: ${description}`, MAX_PR_TITLE_CHARS);
  if (description && SUBJECT_SHAPE.test(capped)) return capped;
  const named = Number(issueNumber);
  if (Number.isInteger(named) && named > 0) return `${type}${scope}: plan the work described in issue ${named}`;
  const key = String(jiraKey ?? '').trim().toUpperCase();
  if (!JIRA_KEY_SHAPE.test(key)) return null;
  return `${type}${scope}: plan the work described in ${key}`;
}

function issueUrl({ issueNumber = null, repository = null } = {}) {
  const issue = Number(issueNumber);
  const [owner, name, ...rest] = String(repository ?? '').split('/');
  if (!Number.isInteger(issue) || issue <= 0 || rest.length || !owner || !name) return '';
  const url = `https://github.com/${owner}/${name}/issues/${issue}`;
  return URL_SHAPE.test(url) ? url : '';
}

function askedLine(who, where) {
  return `- ${where ? `[Requested](${where})` : 'Requested'} by ${who}`;
}

function creditBlock({ issueNumber = null, requestedBy = null, repository = null, jira = null }, options) {
  const who = mention(requestedBy, options);
  const browse = jiraBrowseUrl(jira);
  const issue = Number(issueNumber);
  const below = ['', CREDIT_HEADING, ''];
  if (who) below.push(askedLine(who, issueUrl({ issueNumber, repository }) || browse));
  if (browse) below.push(`- Implements Jira ticket [${jira.key}](${browse})`);
  below.push(`- ${aboutLink()}`);
  if (Number.isInteger(issue) && issue > 0) below.push(`- Closes #${issue}`);
  const criteria = criteriaRef({ issueNumber, repository, jira });
  if (criteria) below.push('', `${CRITERIA_MARKER_PREFIX} ${criteria} -->`);
  return below;
}

function renderPlaceholder({
  issueNumber = null,
  requestedBy = null,
  triggerPhrase = null,
  repository = null,
  jira = null,
} = {}) {
  const options = { triggerPhrase };
  const out = [
    '## Motivation',
    '',
    'This pull request was opened before the work was planned, so the issue has something to point at from the moment the request was accepted. It holds one empty commit and no changes',
    '',
    '## Implementation',
    '',
    "A plan is being written now. When it is ready it replaces this note with the plan's tasks, one box per step, and each step lands as its own commit here",
  ];
  const prose = [
    asAlert('CAUTION', scrub('Work in progress - there is nothing to review here yet', options)),
    '',
    scrub(out.join('\n'), options),
  ].join('\n');
  const below = creditBlock({ issueNumber, requestedBy, repository, jira }, options);
  return { body: `${prose}\n${below.join('\n')}\n` };
}

function hasPlanRegion(body) {
  return fencesIn(String(body ?? '')).length > 0;
}

const MOTIVATION_HEADING = '## Motivation';

function motivationOf(body) {
  const lines = String(body ?? '').split('\n').map((line) => splitEol(line).line);
  const at = lines.findIndex((line) => line.trim() === MOTIVATION_HEADING);
  if (at === -1) return '';
  const said = [];
  for (const line of lines.slice(at + 1)) {
    if (ANY_HEADING.test(line)) break;
    said.push(line);
  }
  return said.join('\n').trim();
}

const { MAX_PLAN_LINES: MAX_DOC_LINES } = require('../lib/plan-given.cjs');

function planDirOf(dir) {
  const asked = String(dir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (asked === '') return DEFAULT_PLAN_DIR;
  return PLAN_DIR_SHAPE.test(asked) ? asked : null;
}

function planFilePathFor({ branch = null, dir = null } = {}) {
  const under = planDirOf(dir);
  if (under === null) return null;
  const name = String(branch ?? '').trim();
  if (!FLOW_BRANCH_SHAPE.test(name)) return null;
  const named = `${under}/${name.slice(name.indexOf('/') + 1)}.md`;
  return PLAN_FILE_SHAPE.test(named) ? named : null;
}

function blobPath({ repository = null, branch = null, path = null } = {}) {
  const repo = String(repository ?? '').trim();
  const ref = String(branch ?? '').trim();
  const file = String(path ?? '').trim();
  if (!REPO_SHAPE.test(repo) || !PLAN_FILE_SHAPE.test(file)) return '';
  if (!FLOW_BRANCH_SHAPE.test(ref)) return '';
  return `/${repo}/blob/${ref}/${file}`;
}

function isPlanFile(path) {
  return PLAN_FILE_SHAPE.test(String(path ?? '').trim());
}

function planFileMarker(planPath) {
  const said = String(planPath ?? '').trim();
  return PLAN_FILE_SHAPE.test(said) ? `${PLAN_FILE_MARKER_PREFIX} ${said} -->` : null;
}

function planFileIn(body) {
  return markerValue(body, PLAN_FILE_MARKER_PREFIX, (value) => (PLAN_FILE_SHAPE.test(value) ? value : null));
}

function codeSpanAt(line, at) {
  if (line[at] !== '`') return -1;
  let opened = at;
  while (line[opened] === '`') opened += 1;
  const run = opened - at;
  let scan = opened;
  while (scan < line.length) {
    if (line[scan] !== '`') {
      scan += 1;
      continue;
    }
    let closed = scan;
    while (line[closed] === '`') closed += 1;
    if (closed - scan === run) return closed;
    scan = closed;
  }
  return -1;
}

function planDocMarker(blob) {
  const said = String(blob ?? '').trim().toLowerCase();
  return BLOB_SHAPE.test(said) ? `${PLAN_DOC_MARKER_PREFIX} ${said} -->` : null;
}

function planDocsIn(body) {
  return markerValues(body, PLAN_DOC_MARKER_PREFIX, (value) => {
    const said = String(value ?? '').trim().toLowerCase();
    return BLOB_SHAPE.test(said) ? said : null;
  });
}

function outsideComments(line, open) {
  const text = String(line);
  let inside = open;
  let said = '';
  let tag = false;
  let ended = false;
  let at = 0;
  while (at < text.length) {
    if (inside) {
      const closed = text.indexOf('-->', at);
      if (closed === -1) return { said, open: true, tag, reopened: ended };
      at = closed + 3;
      inside = false;
      ended = true;
      continue;
    }
    if (text[at] === '\\') {
      said += text.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (text[at] === '`') {
      const span = codeSpanAt(text, at);
      let run = at;
      while (text[run] === '`') run += 1;
      const end = span === -1 ? run : span;
      said += text.slice(at, end);
      at = end;
      continue;
    }
    if (text.startsWith('<!--', at)) {
      at += 2;
      inside = true;
      continue;
    }
    if (text[at] === '<' && !tag) tag = HTML_BLOCK_AT.test(text.slice(at));
    said += text[at];
    at += 1;
  }
  return { said, open: inside, tag, reopened: false };
}

function parsePlanDocument(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > MAX_DOC_LINES) {
    return { error: `the plan document is ${lines.length} lines, over the limit of ${MAX_DOC_LINES}` };
  }
  const phases = [];
  const notAStep = (at) =>
    `line ${at} of the plan document is a list item that is not a step. A step is one top-level ` +
    '`-` bullet on one line, under its phase\'s `### Steps` and above any rule or heading that closes ' +
    'that list - a list item anywhere else renders as one and would not be carried out';
  let region = '';
  let stepped = false;
  let listed = false;
  let itemAt = -1;
  let fenced = '';
  let fencedAt = 0;
  let commented = false;
  let escaped = false;
  let last = '';
  let said = '';
  let saidAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = splitEol(lines[i]).line;
    const was = last;
    const wasText = said;
    const wasAt = saidAt;
    last = '';
    said = '';
    saidAt = 0;
    let hidden = false;
    let tagged = false;
    const fence = DOC_FENCE.exec(line);
    if (fenced === '' && fence !== null && !line.startsWith(' ') && opensFence(fence)) listed = false;
    const coded = was !== 'prose' && indentOf(line) >= (itemAt >= 0 ? itemAt + 4 : 4);
    if (fenced === '' && (!coded || commented)) {
      const seen = outsideComments(line, commented);
      if (!(!commented && fence !== null && opensFence(fence))) {
        const wasCommented = commented;
        if (wasCommented && seen.open === false && escaped) {
          return {
            error:
              `line ${i + 1} of the plan document closes an HTML comment that was opened on a line which had ` +
              'already closed one. CommonMark ends the raw block at that first `-->`, so this line is escaped ' +
              'paragraph text rather than a terminator: the reader is shown nothing from there to the end of the ' +
              'document while this reads everything below as visible. Put each comment on a line of its own',
          };
        }
        escaped = seen.open ? seen.reopened === true || (wasCommented && escaped) : false;
        commented = seen.open;
        tagged = seen.tag;
        if (seen.said.trim() === '') continue;
        hidden = seen.said !== line;
      }
    }
    if (tagged) {
      return {
        error:
          `line ${i + 1} of the plan document holds raw HTML. A reviewer reads this document rendered, and ` +
          '`<details>` renders collapsed, so anything inside one is work nobody saw before approving it - and ' +
          'a tag opened anywhere folds every step below it, not only the ones beside it. Write the plan as ' +
          'headings, prose and plain bullets, and put an example of markup in a fenced code block',
      };
    }
    if (hidden) {
      return {
        error:
          `line ${i + 1} of the plan document puts an HTML comment beside text on the same line. A comment ` +
          'renders as nothing, so the reviewer and this parser read different lines - one inside `## Phase 2` ' +
          'leaves the reviewer a phase this reads as ordinary prose, whose steps join the phase above and lose ' +
          'the checkpoint that would have held them. Put the comment on a line of its own, or write it as a ' +
          'fenced code block. A document already published this way is edited by asking for a rework, which ' +
          'offers the new one - editing it in place moves its blob and the approval names the blob it read',
      };
    }
    if (fence && (fenced !== '' || opensFence(fence))) {
      if (fenced === '' && listed) {
        return {
          error:
            `line ${i + 1} of the plan document opens a code fence inside a list item. ` +
            'The item closes a fence the reader is still inside, and this reads one fence for the ' +
            'whole document, so the two part company and everything below reads as code to one and as ' +
            'markdown to the other - write the fence at the left margin, outside the list',
        };
      }
      if (fenced === '') {
        fenced = fence[1];
        fencedAt = i + 1;
      } else if (fence[1].startsWith(fenced) && String(fence[2] ?? '').trim() === '') {
        fenced = '';
      }
      continue;
    }
    if (fenced !== '') continue;
    if (region === 'steps' && DOC_QUOTE.test(line)) {
      return {
        error:
          `line ${i + 1} of the plan document quotes a line inside a step list. A bullet inside a ` +
          'blockquote renders as a step and is read here as none, so it would be approved and never ' +
          'carried out - write it as a step, or move the quotation out of `### Steps`',
      };
    }
    const underlines = was === 'prose' && SETEXT_UNDERLINE.test(line);
    const ruled = uncontained(line, listed);
    const broken = RULED_ITEM.test(String(wasText).split('\n')[0] ?? '') && !CONTAINER_RUN.test(line);
    const underlinesCarried = was === 'prose' && !broken && SETEXT_UNDERLINE.test(ruled);
    if (underlinesCarried && underlinedNames(NAMES_PHASE, wasText)) {
      return {
        error:
          `line ${wasAt} of the plan document names a phase and line ${i + 1} underlines it, which writes a ` +
          'heading this cannot read. A phase heading is `## Phase N - <name>`, and an underlined one reads as ' +
          'prose here while the reviewer sees a phase - so its steps join the phase above it and lose the ' +
          'checkpoint that would have held them. A document already published this way is edited by asking ' +
          'for a rework, which offers the new one - editing it in place moves its blob and the approval ' +
          'names the blob it read',
      };
    }
    if (underlinesCarried && underlinedNames(NAMES_STEPS, wasText)) {
      return {
        error:
          `line ${wasAt} of the plan document opens a step list and line ${i + 1} underlines it, which ` +
          'writes a heading this cannot read. It is `### Steps`, three hashes and the bare word - an ' +
          'underlined one reads as prose here, and the bullets a reviewer sees under it are dropped ' +
          'rather than becoming steps',
      };
    }
    if (region === 'steps' && (underlines || THEMATIC_BREAK.test(line))) {
      region = underlines ? '' : 'ruled';
      continue;
    }
    const headed = atxText(line, listed);
    const heading = PHASE_HEADING.exec(line);
    if (heading) {
      const at = Number(heading[1]);
      if (at !== phases.length + 1) {
        return { error: `line ${i + 1} of the plan document is phase ${at} where phase ${phases.length + 1} was expected` };
      }
      phases.push({ name: String(heading[2] ?? '').trim(), steps: [] });
      listed = false;
      region = '';
      stepped = false;
      continue;
    }
    if (headed !== null && NAMES_PHASE.test(headed)) {
      return {
        error:
          `line ${i + 1} of the plan document names a phase in a shape this cannot read. A phase heading ` +
          'is `## Phase N - <name>`, two hashes and a plain hyphen or colon, numbered from 1 with no ' +
          'leading zero - anything else reads as an ordinary heading, and its steps join the phase above ' +
          'it and lose the checkpoint that would have held them',
      };
    }
    if (STEPS_HEADING.test(line)) {
      if (phases.length === 0) {
        return { error: `line ${i + 1} of the plan document lists steps before it names a phase` };
      }
      if (stepped) {
        return { error: `line ${i + 1} of the plan document opens a second step list inside one phase` };
      }
      stepped = true;
      listed = false;
      region = 'steps';
      continue;
    }
    if (headed !== null && NAMES_STEPS.test(headed)) {
      return {
        error:
          `line ${i + 1} of the plan document opens a step list in a shape this cannot read. It is ` +
          '`### Steps`, three hashes and the bare word - anything else reads as an ordinary heading, ' +
          'and the bullets a reviewer sees under it are dropped rather than becoming steps',
      };
    }
    if (region !== 'steps') {
      if (ANY_HEADING.test(line)) {
        region = '';
        if (!/^[ \t]/.test(line)) {
          listed = false;
          itemAt = -1;
        }
        continue;
      }
      if (THEMATIC_BREAK.test(line) && !/^[ \t]/.test(line)) {
        listed = false;
        itemAt = -1;
      }
      if (region === 'ruled' && RULED_ITEM.test(line.replace(QUOTE_RUN, ''))) return { error: notAStep(i + 1) };
      if (RULED_ITEM.test(line)) listed = true;
      const marker = coded ? null : ITEM_MARKER.exec(line);
      if (marker) itemAt = contentColumn(marker[1], marker[2]);
      else if (indentOf(line) === 0 && was !== 'bullet') itemAt = -1;
      if (underlines && !/^[ \t]/.test(line)) listed = false;
      last = 'prose';
      said = was === 'prose' ? `${wasText}\n${line}` : line;
      saidAt = was === 'prose' ? wasAt : i + 1;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      if (!SIBLING_HEADING.test(line)) {
        return {
          error:
            `line ${i + 1} of the plan document opens a heading inside its phase's steps that does not ` +
            'close them. A heading deeper than `### Steps`, or one written in from the margin, stays ' +
            'inside the list for the reader while it ends it here, so every step below it is approved ' +
            'and never carried out - move it above the steps, or write it as `### <name>` at the margin',
        };
      }
      region = '';
      listed = false;
      continue;
    }
    const bullet = DOC_BULLET.exec(line);
    if (bullet) {
      phases.at(-1).steps.push(bullet[1]);
      last = 'bullet';
      continue;
    }
    if (EMPTY_ITEM.test(line)) {
      return {
        error:
          `line ${i + 1} of the plan document is a list marker with nothing after it. A reader opens a list ` +
          'item there and reads every line below it as part of that list, while this reads the line as prose ' +
          'and every step under it as prose too - so the two disagree about what this phase holds. Give it a ' +
          'title, or delete the line',
      };
    }
    if (ORDERED_ITEM.test(line)) return { error: notAStep(i + 1) };
    if (INDENTED_UNDER_STEPS.test(line)) {
      return {
        error:
          `line ${i + 1} of the plan document indents text under its phase's steps. A step is one top-level ` +
          'bullet on one line, however long it runs - write this as its own step, or fold it into the step above',
      };
    }
    if (was === 'bullet') {
      return {
        error:
          `line ${i + 1} of the plan document continues the step above onto a second line. A step is one ` +
          'top-level bullet on one line, however long it runs - write this as its own step, or fold it into ' +
          'the step above',
      };
    }
    last = 'prose';
    said = was === 'prose' ? `${wasText}\n${line}` : line;
    saidAt = was === 'prose' ? wasAt : i + 1;
  }
  if (fenced !== '') {
    return {
      error:
        `line ${fencedAt} of the plan document opens a code fence that is never closed. Markdown closes ` +
        'it at the end of the document, so every phase and step below that line renders as code and is ' +
        'read here as nothing - close the fence',
    };
  }
  if (phases.length === 0) return { error: 'the plan document names no phase' };
  const empty = phases.findIndex((phase) => phase.steps.length === 0);
  if (empty !== -1) return { error: `phase ${empty + 1} of the plan document lists no steps` };
  return { phases };
}

function motivationLines(summary, options) {
  const said = String(summary ?? '');
  const summaryLength = Array.from(said).length;
  const prose = scrub(summaryLength > MAX_SUMMARY_CHARS ? cap(said, MAX_SUMMARY_CHARS) : said, options).trim();
  const lines = prose ? ['## Motivation', '', unended(prose), ''] : [];
  return summaryLength > MAX_SUMMARY_CHARS ? { lines, shortened: summaryLength } : { lines };
}

function renderPlanWaiting({
  issueNumber = null,
  requestedBy = null,
  summary = null,
  planPath = null,
  branch = null,
  repository = null,
  triggerPhrase = null,
  jira = null,
} = {}) {
  const options = { triggerPhrase };
  const marker = planFileMarker(planPath);
  if (!marker) return { error: `\`${safeEcho(String(planPath ?? ''))}\` is not a path a plan document can live at` };
  const link = blobPath({ repository, branch, path: planPath });
  if (!link) return { error: 'the plan document could not be linked, so the body would name a file nobody can open' };

  const motivation = motivationLines(summary, options);

  const out = [
    ...motivation.lines,
    '## Implementation',
    '',
    `[The plan](${link}) is committed to this branch. Review it there - it is an ordinary file, so editing it edits what will run`,
    '',
    'No step runs until an approver releases the plan. Approving turns it into the task list that drives the work, one box per step',
  ];
  const below = creditBlock({ issueNumber, requestedBy, repository, jira }, options);
  const alert = asAlert('CAUTION', scrub('Work in progress - the plan is written and nothing is implemented yet', options));
  return {
    body: `${alert}\n\n${out.join('\n')}\n${below.join('\n')}\n\n${marker}\n`,
    shortened: motivation.shortened,
  };
}

function renderDirectBody({
  issueNumber = null,
  requestedBy = null,
  summary = null,
  repository = null,
  triggerPhrase = null,
  jira = null,
} = {}) {
  const options = { triggerPhrase };
  const motivation = motivationLines(summary, options);

  const out = [
    ...motivation.lines,
    '## Implementation',
    '',
    scrub(
      'This work was sized as small enough not to need a plan, so it was built in one run and the commits ' +
        'below are the whole change. Review them as you would any other pull request',
      options,
    ),
  ];
  const below = creditBlock({ issueNumber, requestedBy, repository, jira }, options);
  return {
    body: `${out.join('\n')}\n${below.join('\n')}\n`,
    shortened: motivation.shortened,
  };
}

function summaryNote(shortened) {
  if (!shortened) return '';
  return (
    `\n\nThe summary this run wrote is ${shortened} characters, over the ${MAX_SUMMARY_CHARS}-character limit ` +
    'for a pull request description, so it was shortened there. Nothing else about the run is affected'
  );
}

const MAX_PHASES = 10;

function unended(text) {
  return String(text ?? '').replace(/\.$/, '');
}

const checkpointTitle = (phase) => `**Phase ${phase} complete** - review the commits above, then approve to continue`;

const FINAL_TITLE = '**Plan complete** - review the commits above, then approve to mark this ready for review';

const CHECKPOINT_SHAPE = /^\*\*Phase ([1-9][0-9]{0,2}) complete\*\* - review the commits above, then approve to continue$/;

const LEGACY_CHECKPOINT_SHAPE = /^--- phase ([1-9][0-9]{0,2}) done, review and approve to continue ---$/;

function isCheckpoint(title) {
  const said = String(title ?? '').trim();
  return CHECKPOINT_SHAPE.test(said) || said === FINAL_TITLE || LEGACY_CHECKPOINT_SHAPE.test(said);
}

const MINE = Symbol('checkpoint');

function flattenPhases(phases) {
  if (!Array.isArray(phases) || !phases.length) return { error: 'the plan holds no phases' };
  if (phases.length > MAX_PHASES) {
    return { error: `the plan holds ${phases.length} phases, over the limit of ${MAX_PHASES}` };
  }

  const out = [];
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i];
    const steps = phase && typeof phase === 'object' ? phase.steps : phase;
    if (!Array.isArray(steps) || !steps.length) return { error: `phase ${i + 1} holds no steps` };
    out.push(
      ...steps.map((one) => (one !== null && typeof one === 'object' ? one.title : one)),
      { title: i === phases.length - 1 ? FINAL_TITLE : checkpointTitle(i + 1), [MINE]: true },
    );
  }
  return { steps: out };
}

function renderBody({
  steps = null,
  phases = null,
  issueNumber = null,
  requestedBy = null,
  summary = null,
  triggerPhrase = null,
  repository = null,
  jira = null,
} = {}) {
  const options = { triggerPhrase };
  const grouped = flattenPhases(Array.isArray(phases) && phases.length ? phases : [{ steps }]);
  if (grouped.error) return { error: grouped.error };
  const plan = normalizeSteps(grouped.steps, options);
  if (plan.error) return { error: plan.error };

  const motivation = motivationLines(summary, options);

  const out = [
    ...motivation.lines,
    '## Implementation',
    '',
    'These tasks come from the plan and are the run state. The next one is the first unchecked box, so reordering or rewording a title changes what runs next',
    '',
    REGION_BEGIN,
  ];
  for (const step of plan.steps) out.push(`- [ ] ${step.title}`);
  out.push(REGION_END, ...creditBlock({ issueNumber, requestedBy, repository, jira }, options));

  return {
    body: `${out.join('\n')}\n`,
    steps: plan.steps.length,
    checkpoints: plan.steps.filter((step) => isCheckpoint(step.title)).length,
    shortened: plan.shortened,
    summaryShortened: motivation.shortened,
  };
}

function shortenedNote(shortened, summaryShortened) {
  const cuts = Array.isArray(shortened) ? shortened : [];
  const named = cuts.map((cut) => `step ${cut.at} at ${cut.length}`).join(', ');
  const one = cuts.length === 1;
  const titles = cuts.length
    ? `\n\nThe plan was written with ${one ? 'a title' : 'titles'} over the ${MAX_TITLE_CHARS}-character task ` +
      `limit, so ${one ? 'it was' : 'they were'} shortened for the task list: ${named}. The plan document keeps the ` +
      'full wording'
    : '';
  return `${titles}${summaryNote(summaryShortened)}`;
}

const SHAPE_MARKER_PREFIX = '<!-- ksai-boundaries:';

const DIGEST_CHARS = 16;

const DIGEST_SHAPE = new RegExp(`^[0-9a-f]{${DIGEST_CHARS}}$`);

const SHAPE_SHAPE = new RegExp(
  `^([1-9][0-9]{0,3})(?:\\/(${LOGIN_SHAPE.source.slice(1, -1)})?(?:\\/([0-9a-f]{${DIGEST_CHARS}}))?)?$`,
);

function stepDigest(body) {
  const plan = parseBody(body);
  if (plan.error) return null;
  const titles = plan.steps.map((step) => step.title).join('\n');
  return createHash('sha256').update(titles, 'utf8').digest('hex').slice(0, DIGEST_CHARS);
}

function renderShape(checkpoints, requestedBy = null, { sealedWith = null } = {}) {
  const count = String(checkpoints ?? '');
  const who = String(requestedBy ?? '').trim();
  const sum = String(sealedWith ?? '').trim();
  const named = LOGIN_SHAPE.test(who) ? who : '';
  const sealed = `${count}/${named}/${sum}`;
  if (DIGEST_SHAPE.test(sum) && SHAPE_SHAPE.test(sealed)) return `${SHAPE_MARKER_PREFIX} ${sealed} -->`;
  const credited = `${count}/${named}`;
  if (named && SHAPE_SHAPE.test(credited)) return `${SHAPE_MARKER_PREFIX} ${credited} -->`;
  return SHAPE_SHAPE.test(count) ? `${SHAPE_MARKER_PREFIX} ${count} -->` : null;
}

function shapesIn(body) {
  return markerValues(body, SHAPE_MARKER_PREFIX, (value) => {
    const found = SHAPE_SHAPE.exec(value);
    return found ? { checkpoints: Number(found[1]), requestedBy: found[2] ?? '', digest: found[3] ?? '' } : null;
  });
}

function jiraBrowseUrl(jira) {
  const site = String(jira?.site ?? '');
  const key = String(jira?.key ?? '');
  if (!site || !key || !JIRA_REF_SHAPE.test(`${site}/${key}`)) return null;
  return `https://${site}/browse/${key}`;
}

function criteriaRef({ issueNumber = null, repository = null, jira = null } = {}) {
  const site = String(jira?.site ?? '');
  const key = String(jira?.key ?? '');
  if (site && key) {
    const ref = `${site}/${key}`;
    return JIRA_REF_SHAPE.test(ref) ? ref : null;
  }
  const issue = Number(issueNumber);
  if (!Number.isInteger(issue) || issue <= 0) return null;
  const [owner, name, ...rest] = String(repository ?? '').split('/');
  if (rest.length || !owner || !name) return null;
  const ref = `${owner}/${name}#${issue}`;
  return CRITERIA_REF_SHAPE.test(ref) ? ref : null;
}

const RELEASE_MARKER_PREFIX = '<!-- ksai-released:';

const GITHUB_RELEASE_SHAPE = new RegExp(`^github\\/(${LOGIN_SHAPE.source.slice(1, -1)})$`);

const JIRA_RELEASE_SHAPE = new RegExp(`^jira\\/(${JIRA_ACCOUNT_CORE})$`);

function releaseRef({ login = null, accountId = null } = {}) {
  const who = String(login ?? '').trim();
  if (who) {
    const ref = `github/${who}`;
    return GITHUB_RELEASE_SHAPE.test(ref) ? ref : null;
  }
  const account = String(accountId ?? '').trim();
  if (!account) return null;
  const ref = `jira/${account}`;
  return JIRA_RELEASE_SHAPE.test(ref) ? ref : null;
}

function readRelease(value) {
  const ref = String(value ?? '');
  const github = GITHUB_RELEASE_SHAPE.exec(ref);
  if (github) return { kind: 'github', login: github[1] };
  const jira = JIRA_RELEASE_SHAPE.exec(ref);
  if (jira) return { kind: 'jira', accountId: jira[1] };
  return null;
}

const MARKER_SHAPES = new Map();

function markerShape(prefix) {
  const held = MARKER_SHAPES.get(prefix);
  if (held !== undefined) return held;
  const name = String(prefix).replace(/^<!--\s*/, '');
  const shape = new RegExp(`^\\s*<!--\\s*${escapeForRegExp(name)}\\s*(\\S+)\\s*-->\\s*$`);
  MARKER_SHAPES.set(prefix, shape);
  return shape;
}

function markerValues(body, prefix, read) {
  const shape = markerShape(prefix);
  const found = [];
  for (const line of String(body ?? '').split('\n')) {
    const matched = line.match(shape);
    const answer = matched ? read(matched[1]) : null;
    if (answer) found.push(answer);
  }
  return found;
}

function markerValue(body, prefix, read) {
  return markerValues(body, prefix, read)[0] ?? null;
}

const appended = (body, record) => `${String(body ?? '').replace(/\s+$/, '')}\n\n${record}\n`;

function releaseOf(body) {
  return markerValue(body, RELEASE_MARKER_PREFIX, readRelease);
}

const RELEASED_BY_SHAPE = new RegExp(`^[^\\n<>()]+ \\(jira:${JIRA_ACCOUNT_CORE}\\)$`);

const CREDIT_HEADING = '## Additional information';

const ASKED_SHAPE = /^- (?:\[Requested\]\((?<where>[^)\s]+)\)|Requested) by (?<who>@[A-Za-z0-9-]+|`[^`\n]+`)\.?$/;

function approverOf(ref, name) {
  const read = readRelease(String(ref ?? ''));
  if (!read) return null;
  if (read.kind === 'github') return `@${read.login}`;
  const said = String(name ?? '').trim();
  return RELEASED_BY_SHAPE.test(said) ? said : null;
}

function creditLine(ref, { name = null, url = null, asked = null } = {}) {
  const who = approverOf(ref, name);
  if (who === null) return null;
  const at = String(url ?? '');
  const verb = URL_SHAPE.test(at) ? `[approved](${at})` : 'approved';
  const said = verb.replace(/^\[?a/, (letter) => letter.toUpperCase());
  if (asked === null) return `- ${said} by ${who}`;
  if (asked.who === who) return `${asked.head} and ${verb} by ${who}`;
  return `${asked.head} by ${asked.who}, ${verb} by ${who}`;
}

const APPROVED_SHAPE = /(?:^-? ?|, |and )(?:\[approved\]\((?<where>[^)\s]+)\)|approved) by (?<who>@[A-Za-z0-9-]+|[^\n]+ \(jira:[^)\n]+\))$/im;

function approvalIn(body) {
  const found = APPROVED_SHAPE.exec(creditSpan(String(body ?? '')).said);
  if (!found) return { name: null, url: null };
  const who = found.groups.who;
  return { name: who.startsWith('@') ? null : who, url: found.groups.where ?? null };
}

function askedIn(said) {
  for (const line of said.split('\n')) {
    const found = ASKED_SHAPE.exec(line);
    if (!found) continue;
    const where = found.groups.where ?? '';
    return {
      line,
      who: found.groups.who,
      head: where ? `- [Requested](${where})` : '- Requested',
    };
  }
  return null;
}

function creditSpan(text) {
  const { fence, error } = fenceOf(text);
  const end = error ? -1 : text.indexOf(fence.end);
  const cut = end === -1 ? 0 : end + fence.end.length;
  const status = text.indexOf(STATUS_BEGIN, cut);
  const stop = status === -1 ? text.length : status;
  return { above: text.slice(0, cut), said: text.slice(cut, stop), below: text.slice(stop) };
}

function withCredit(body, line, asked) {
  const text = String(body ?? '');
  const { above, said, below } = creditSpan(text);
  const lines = said.split('\n');

  if (asked) {
    const at = lines.indexOf(asked.line);
    if (at === -1) return text;
    return above + [...lines.slice(0, at), line, ...lines.slice(at + 1)].join('\n') + below;
  }

  const heading = lines.findIndex((one) => one.trim() === CREDIT_HEADING);
  if (heading === -1) {
    return `${above}${said.replace(/\s+$/, '')}\n\n${CREDIT_HEADING}\n\n${line}${below === '' ? '' : `\n\n${below}`}`;
  }
  let last = heading;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ')) last = i;
    else if (lines[i].trim().startsWith('#')) break;
  }
  return above + [...lines.slice(0, last + 1), line, ...lines.slice(last + 1)].join('\n') + below;
}

function withRelease(body, ref, { name = null, url = null } = {}) {
  const text = String(body ?? '');
  const value = String(ref ?? '');
  if (!readRelease(value)) return null;
  if (releaseOf(text)) return { body: text, changed: false };
  const span = creditSpan(text).said;
  const asked = askedIn(span);
  const credit = APPROVED_SHAPE.test(span) ? null : creditLine(value, { name, url, asked });
  const said = credit ? withCredit(text, credit, asked) : text;
  return { body: appended(said, `${RELEASE_MARKER_PREFIX} ${value} -->`), changed: true };
}

const HOLD_MARKER_PREFIX = '<!-- ksai-paused:';

const HOLD_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const readHold = (value) => (HOLD_SHAPE.test(String(value ?? '')) ? String(value) : null);

function holdMarker(runId) {
  const said = String(runId ?? '').trim();
  return readHold(said) === null ? null : `${HOLD_MARKER_PREFIX} ${said} -->`;
}

function heldBy(body) {
  return markerValue(body, HOLD_MARKER_PREFIX, readHold);
}

function withHold(body, runId) {
  const marker = holdMarker(runId);
  if (marker === null) return null;
  const text = String(body ?? '');
  if (heldBy(text) !== null) return { body: text, changed: false };
  return { body: appended(text, marker), changed: true };
}

function withoutHold(body) {
  const text = String(body ?? '');
  if (heldBy(text) === null) return { body: text, changed: false };
  const next = text.split('\n').filter((line) => heldBy(line) === null).join('\n');
  return { body: next, changed: true };
}

function linked(text, url) {
  const said = String(text ?? '');
  const at = String(url ?? '');
  if (at === '') return said.replace(/\[([^\]]*)\]\(LINK\)/g, '`$1`');
  return said.replaceAll('(LINK)', `(${at})`);
}

function carryRecords(from, to) {
  const was = String(from ?? '');
  let body = String(to ?? '');
  const released = releaseOf(was);
  if (released) {
    const kept = withRelease(body, releaseRef(released), approvalIn(was));
    if (kept !== null) body = kept.body;
  }
  const marker = was.split('\n').find((line) => line.trimStart().startsWith(CRITERIA_MARKER_PREFIX));
  if (marker !== undefined && criteriaOf(marker) !== null) {
    const without = body
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(CRITERIA_MARKER_PREFIX))
      .join('\n');
    body = appended(without, marker.trim());
  }
  const carried = new Set(body.split('\n').map((line) => line.trim()));
  const phases = [
    ...new Set(
      was
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(PHASE_MARKER_PREFIX) && !carried.has(line)),
    ),
  ];
  if (phases.length > 0) body = appended(body, phases.join('\n'));
  const status = locateStatus(was);
  if (!status.absent && !status.error) {
    const spliced = spliceStatus(body, was.slice(status.start, status.end));
    if (!spliced.error) body = spliced.body;
  }
  const paused = heldBy(was);
  if (paused !== null) {
    const kept = withHold(body, paused);
    if (kept !== null) body = kept.body;
  }
  return body;
}

function readCriteria(value) {
  const parts = CRITERIA_REF_SHAPE.exec(String(value ?? ''));
  if (parts) return { kind: 'github', owner: parts[1], repo: parts[2], number: Number(parts[3]) };
  const jira = JIRA_REF_SHAPE.exec(String(value ?? ''));
  if (jira) return { kind: 'jira', site: jira[1], key: jira[2] };
  return null;
}

function criteriaOf(body) {
  return markerValue(body, CRITERIA_MARKER_PREFIX, readCriteria);
}

function requesterOf(body) {
  const text = String(body ?? '');
  const { error } = fenceOf(text);
  if (error) return null;
  const below = creditSpan(text).said;
  const at = below.lastIndexOf(`\n${CREDIT_HEADING}`);
  const said = at === -1 ? below : below.slice(at);
  const found = said.match(
    /^-? ?(?:\[Requested\]\([^)\s]+\)|Requested)(?: and (?:\[approved\]\([^)\s]+\)|approved))? by @([A-Za-z0-9-]+)(?:\.?$|, (?:\[approved\]\([^)\s]+\)|approved) by )/m,
  );
  if (!found) return null;
  return LOGIN_SHAPE.test(found[1]) ? found[1] : null;
}

function creditOf(body) {
  const requested = requesterOf(body);
  if (requested) return requested;
  const released = releaseOf(body);
  return released?.kind === 'github' ? released.login : null;
}

function regionBetween(text, fence, named) {
  const begins = countOccurrences(text, fence.begin);
  const ends = countOccurrences(text, fence.end);
  if (!begins || !ends) return { absent: true, begins, ends };
  if (begins > 1 || ends > 1) return { error: `the PR body carries more than one ${named} region, so which one is the ${named} is unclear` };

  const open = text.indexOf(fence.begin);
  const close = text.indexOf(fence.end);
  if (close < open) return { error: `the ${named} region ends before it begins` };
  return { start: open + fence.begin.length, end: close };
}

function locateRegion(text) {
  const { fence, error } = fenceOf(text);
  if (error) return { error };
  const found = regionBetween(text, fence, 'plan');
  if (found.absent) return { error: 'the PR body carries no plan region, so there is no plan to read' };
  return found;
}

function locateStatus(body) {
  const text = String(body ?? '');
  const found = regionBetween(text, STATUS_FENCE, 'status');
  if (!found.absent) return found;
  if (found.begins || found.ends) {
    return { error: 'the PR body carries half a status region, so where the run report starts or ends is unclear' };
  }
  return found;
}

function spliceStatus(body, rendered) {
  const text = String(body ?? '');
  const found = locateStatus(text);
  if (found.error) return { error: found.error };
  const inner = `\n${String(rendered ?? '').replace(/^\n+|\n+$/g, '')}\n`;
  const next = found.absent
    ? `${text}${text.endsWith('\n') ? '' : '\n'}\n<hr />\n\n${STATUS_BEGIN}${inner}${STATUS_END}\n`
    : text.slice(0, found.start) + inner + text.slice(found.end);
  return { body: next, changed: next !== text };
}

const splitEol = (line) => (line.endsWith('\r') ? { line: line.slice(0, -1), eol: '\r' } : { line, eol: '' });

function parseBody(body) {
  const text = String(body ?? '');
  const region = locateRegion(text);
  if (region.error) return { error: region.error, steps: [] };

  const offset = countOccurrences(text.slice(0, region.start), '\n') + 1;
  const steps = [];
  const lines = text.slice(region.start, region.end).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const { line } = splitEol(lines[i]);
    if (!line.trim()) continue;
    const row = ROW.exec(line);
    if (!row) return { error: `line ${offset + i} of the PR body is inside the plan region but is not a step`, steps: [] };
    if (!row[2]) return { error: `line ${offset + i} of the PR body is a step with no title`, steps: [] };
    steps.push({ title: row[2], done: row[1] !== ' ' });
  }

  if (!steps.length) return { error: 'the plan region holds no steps', steps: [] };
  return { steps, region };
}

function firstUnchecked(parsed) {
  if (!parsed || parsed.error || !Array.isArray(parsed.steps)) return null;
  const next = parsed.steps.find((step) => !step.done);
  return next ? next.title : null;
}

function pendingBoundary(parsed) {
  if (!parsed || parsed.error || !Array.isArray(parsed.steps)) return 0;
  let seen = 0;
  for (const step of parsed.steps) {
    const boundary = isCheckpoint(step.title);
    if (boundary) seen += 1;
    if (step.done) continue;
    return boundary ? seen : 0;
  }
  return 0;
}

function checkStep(body, stepTitle, options = {}) {
  const text = String(body ?? '');
  const parsed = parseBody(text);
  if (parsed.error) return { error: parsed.error };

  const literal = collapse(stepTitle).trim();
  const wanted = isCheckpoint(literal) ? literal : oneLine(stepTitle, options);
  if (!wanted) return { error: 'no step title was given, so no box was ticked' };
  const folded = (title) => collapse(title).trim();
  if (!parsed.steps.some((step) => folded(step.title) === wanted)) {
    return { error: 'the plan holds no step with that title, so no box was ticked' };
  }

  const { region } = parsed;
  const lines = text.slice(region.start, region.end).split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const { line, eol } = splitEol(lines[i]);
    const row = ROW.exec(line);
    if (!row) continue;
    const boundary = isCheckpoint(folded(row[2]));
    if (boundary) seen += 1;
    if (row[1] !== ' ' || folded(row[2]) !== wanted) continue;
    lines[i] = `${line.replace(UNCHECKED_BOX, '- [x]')}${eol}`;
    return {
      body: text.slice(0, region.start) + lines.join('\n') + text.slice(region.end),
      changed: true,
      at: boundary ? seen : 0,
    };
  }

  return { body: text, changed: false, at: 0 };
}

function renderNativeApprovalReceipt({
  triggerPhrase = null,
  issueNumber = null,
  prNumber = null,
  runId = null,
  approvalRef = null,
} = {}) {
  const native = nativeApprovalMarker(approvalRef);
  if (native === null) throw new Error('a readable native approval reference is required');
  return marked(`Recorded this GitHub approval before changing the pull request head\n\n${native}`, {
    kind: 'plan-approved',
    flow: 'implement',
    command: 'approve',
    issue: issueNumber,
    pr: prNumber,
    run: runId,
    triggerPhrase,
  });
}

const POSITIVE_ID_SHAPE = /^[1-9][0-9]{0,18}$/;

const SERVER_SHAPE = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

const githubUrl = ({ serverUrl = null, repository = null, number = null, path = '' } = {}) => {
  const server = String(serverUrl ?? '').trim().replace(/\/$/, '');
  const repo = String(repository ?? '').trim();
  const id = String(number ?? '').trim();
  if (!SERVER_SHAPE.test(server) || !REPO_SHAPE.test(repo) || !POSITIVE_ID_SHAPE.test(id)) return '';
  return `${server}/${repo}/${path}/${id}`;
};

function runUrl({ serverUrl = null, repository = null, runId = null } = {}) {
  return githubUrl({ serverUrl, repository, number: runId, path: 'actions/runs' });
}

function pullUrl({ serverUrl = null, repository = null, prNumber = null } = {}) {
  return githubUrl({ serverUrl, repository, number: prNumber, path: 'pull' });
}

module.exports = {
  LOGIN_SHAPE,
  appended,
  criteriaOf,
  markerValue,
  markerValues,
  renderShape,
  stepDigest,
  shortenedNote,
  shapesIn,
  releaseOf,
  carryRecords,
  PHASE_MARKER_PREFIX,
  linked,
  readRelease,
  releaseRef,
  withRelease,
  heldBy,
  holdMarker,
  withHold,
  withoutHold,
  RELEASED_BY_SHAPE,
  jiraBrowseUrl,
  REGION_BEGIN,
  REGION_END,
  STATUS_BEGIN,
  STATUS_END,
  locateStatus,
  spliceStatus,
  DEFAULT_TRIGGER_PHRASE,
  retargetPermalinks,
  MAX_TITLE_CHARS,
  MAX_DOC_LINES,
  storedTitle,
  MAX_SUMMARY_CHARS,
  MAX_STEPS,
  MAX_ACTOR_CHARS,
  cap,
  scrub,
  oneLine,
  renderBody,
  renderDirectBody,
  MAX_PR_TITLE_CHARS,
  SUBJECT_SHAPE,
  URL_SHAPE,
  isThreadless,
  branchFor,
  provisionalTitle,
  renderPlaceholder,
  hasPlanRegion,
  DEFAULT_PLAN_DIR,
  planDirOf,
  planFilePathFor,
  planDocMarker,
  planDocsIn,
  planFileMarker,
  planFileIn,
  isPlanFile,
  parsePlanDocument,
  renderPlanWaiting,
  motivationOf,
  MAX_PHASES,
  checkpointTitle,
  FINAL_TITLE,
  isCheckpoint,
  parseBody,
  firstUnchecked,
  pendingBoundary,
  requesterOf,
  creditOf,
  runUrl,
  pullUrl,
  POSITIVE_ID_SHAPE,
  checkStep,
  renderNativeApprovalReceipt,
};
