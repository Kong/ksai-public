
const { docsLink } = require('./docs.cjs');
const MODEL_CATALOG = require('./model-catalog.json');
const { extractGivenPlan } = require('./plan-given.cjs');
const { DEFAULT_TRIGGER_PHRASE, triggerAlternation, triggerMatcher } = require('./text.cjs');

const ALLOWED_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const DEFAULT_MIN_EFFORT = 'medium';

const ALIASES = Object.freeze(
  Object.assign(Object.create(null), MODEL_CATALOG.aliases),
);

function resolveModel(value) {
  const said = String(value ?? '').trim();
  const asked = said.toLowerCase();
  return asked in ALIASES ? ALIASES[asked] : said;
}

const MODEL_TIERS = Object.freeze([...MODEL_CATALOG.tierOrder]);

/**
 * VENDOR_ALIASES translates the model names other tools speak into the ids this fleet calls.
 *
 * Two readers speak that vocabulary and neither is ours to rename. A kreview agent's frontmatter is
 * read by Claude Code itself, which knows `sonnet` and would not know a tier of ours; and a run
 * report printed `tier \`sonnet\`` for as long as the tiers were named after one vendor's models,
 * so the extractor still meets those rows. Translating here keeps both working while the names a
 * person configures stay vendor-neutral - and a request may still ask only for a tier, because this
 * table is read where a foreign name arrives and nowhere a comment reaches.
 */
const VENDOR_ALIASES = Object.freeze(
  Object.assign(Object.create(null), MODEL_CATALOG.vendorAliases),
);

/** RECORDED_TIERS names every tier spelling a published report may carry, which outlives a rename. */
const RECORDED_TIERS = Object.freeze([...MODEL_CATALOG.tierOrder, ...Object.keys(MODEL_CATALOG.vendorAliases)]);

/**
 * KNOWN_MODELS names every model id this repository can spell, which is not what it permits.
 *
 * `allowedModels` answers whether a request may have one; this answers how it is written. A model
 * the gateway does not route yet is off the allowlist and still spelled correctly here, so a
 * repository that allows it by hand reaches an origin that knows the id rather than a lowercased
 * near-miss of it.
 */
const KNOWN_MODELS = Object.freeze([
  ...new Set([
    ...Object.values(MODEL_CATALOG.aliases),
    ...MODEL_CATALOG.knownModels,
    ...MODEL_CATALOG.allowedModels,
  ]),
]);

const CANONICAL_MODELS = new Map(KNOWN_MODELS.map((model) => [model.toLowerCase(), model]));

/**
 * canonicalOf answers the allowed model a value names, in the spelling the gateway knows it by.
 *
 * A model id is matched case-insensitively because `allowed_models` is a caller's own string, and
 * answered in the catalog's spelling because that is the one the origin resolves. Answering the
 * caller's casing instead sends `zai-org/glm-5.3-flash` to an origin that has `zai-org/GLM-5.3-Flash`
 * and nothing else, which is a model not found rather than a model refused.
 */
function canonicalOf(model, allow) {
  const key = String(model ?? '').trim().toLowerCase();
  if (!key) return null;
  const entry = allow.find((one) => one.toLowerCase() === key);
  if (entry === undefined) return null;
  return CANONICAL_MODELS.get(key) ?? entry;
}

const MODEL_CORE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,2}';

const MODEL_SHAPE = new RegExp(`^${MODEL_CORE}$`);

const shortModel = (model) => String(model ?? '').trim().replace(/^claude-/, '');

function armLabel(model, effort) {
  const said = shortModel(model);
  if (!said) return '';
  const level = String(effort ?? '').trim();
  return level ? `${said}/${level}` : said;
}

const VALUE_OPTIONS = Object.freeze(['--model', '--effort', '--jira']);

const JIRA_KEY_SHAPE = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;

const JIRA_ACCOUNT_CORE = '[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,126}[A-Za-z0-9])?';

const JIRA_ACCOUNT_SHAPE = new RegExp(`^${JIRA_ACCOUNT_CORE}$`);

const FLAGS = Object.freeze(['--force', '--plan', '--no-plan', '--plan-given']);

const FLAG_ALIASES = Object.freeze(Object.assign(Object.create(null), { '-f': '--force' }));

const PLAN_MODES = Object.freeze(['auto', 'always', 'never']);

const PLAN_ASK_COMMANDS = Object.freeze(['implement']);

const OPTIONS = Object.freeze([...VALUE_OPTIONS, ...FLAGS]);

const HELP_COMMAND = 'help';

const COMMAND_TABLE = Object.freeze(
  Object.assign(Object.create(null), {
    review: Object.freeze({
      owner: 'reviewer',
      surface: 'pull',
      doc: 'reviews the change and leaves its findings as inline comments, narrowed to whatever you ask it to look at',
      delivered: false,
      named: false,
    }),
    implement: Object.freeze({
      owner: 'implement',
      surface: 'issue',
      doc: 'builds a small issue directly, or plans larger work and carries it out one step at a time',
      delivered: false,
      named: false,
    }),
    approve: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'releases a plan that is waiting for an approver to agree to it',
      delivered: false,
      named: true,
    }),
    fix: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'answers the open review threads, changing the code where the review asks for it',
      delivered: false,
      named: false,
    }),
    do: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'does one piece of work you describe on this branch - fixing a failing check, resolving conflicts, adding a missing test',
      delivered: false,
      named: false,
    }),
    revise: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'reworks the plan document to answer the review threads left on it, and replies in each one',
      delivered: false,
      named: false,
    }),
    unlock: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'releases a review thread that was locked over a disagreement, and does what your message asks in it',
      delivered: false,
      named: true,
    }),
    stop: Object.freeze({
      owner: null,
      surface: null,
      doc: 'asks the run working on this pull request right now to stop, which starts nothing of its own',
      delivered: true,
      named: true,
    }),
    pause: Object.freeze({
      owner: null,
      surface: null,
      doc: 'stops the run working on this pull request and holds the plan there, dispatching no successor',
      delivered: true,
      named: true,
    }),
    resume: Object.freeze({
      owner: 'implement',
      surface: 'pull',
      doc: 'starts the next step of a plan that was paused, picking up at the first unchecked box',
      delivered: false,
      named: true,
    }),
    [HELP_COMMAND]: Object.freeze({
      owner: null,
      surface: null,
      doc: 'lists the commands available here and links to the full command guide',
      delivered: false,
      named: true,
    }),
    test: Object.freeze({
      owner: 'tester',
      surface: 'pull',
      doc: 'starts the environments this repository declares and runs an adversarial tester against the change',
      delivered: false,
      named: false,
    }),
  }),
);

const COMMAND_FIELDS = Object.freeze(['owner', 'surface', 'doc', 'delivered', 'named']);

const columnOf = (field) =>
  Object.freeze(
    Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(COMMAND_TABLE).map(([command, record]) => [command, record[field]])),
    ),
  );

const OWNER = columnOf('owner');

const SURFACE = columnOf('surface');

const NAMED_ONLY = columnOf('named');

const namedOnly = (command) => NAMED_ONLY[String(command ?? '').toLowerCase()] === true;

const NEVER_INFERRED = Object.freeze(Object.keys(COMMAND_TABLE).filter((command) => namedOnly(command)));

const THREAD_SURFACE = 'thread';

const REVIEW_SURFACE = 'review';

const WRONG_SURFACE_EXTRA = Object.freeze(
  Object.assign(Object.create(null), {
    approve:
      '. An approval on an issue does count - the next run to look will pick it up - but it starts nothing' +
      ' by itself',
    fix: '. It answers open review threads, and only a pull request has any',
    do: '. It works on a branch a pull request already has, and an issue has none - describe the work in the issue and `implement` it instead',
    test: '. It executes the tree a pull request holds, and an issue has no tree to run',
  }),
);

function surfaceOf(command) {
  const candidate = String(command ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SURFACE, candidate) ? SURFACE[candidate] : undefined;
}

function docOf(command) {
  const candidate = String(command ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(COMMAND_TABLE, candidate) ? COMMAND_TABLE[candidate].doc : undefined;
}

const commandsFor = (surface, flow, disabledCommands) =>
  Object.keys(COMMAND_TABLE).filter(
    (command) =>
      OWNER[command] !== null &&
      SURFACE[command] === surface &&
      (!flow || OWNER[command] === flow) &&
      commandEnabled(command, { flow: OWNER[command], disabledCommands }),
  );

function renderUnnamedCommand({ onIssue = null, triggerPhrase = null, flow = null, disabledCommands = null } = {}) {
  const here = String(onIssue) === 'true' ? 'issue' : 'pull';
  const there = here === 'issue' ? 'pull' : 'issue';
  const named = (surface) => commandsFor(surface, flow, disabledCommands).map((command) => `- \`${command}\` ${docOf(command)}`);
  const where = (surface) => (surface === 'issue' ? 'an issue' : 'a pull request');
  const section = (surface, lead) => {
    const rows = named(surface);
    return rows.length === 0 ? [] : ['', lead, ...rows];
  };
  if (commandsFor(here, flow).length + commandsFor(there, flow).length === 0) {
    throw new Error(`no implemented command belongs to the \`${String(flow)}\` flow, so there is nothing to offer`);
  }
  if (named(here).length + named(there).length === 0) {
    return asAlert(
      'WARNING',
      scrubTrigger(
        'That comment names no command, and this repository has every command this flow answers turned off, so ' +
          'nothing ran. A code owner turns them off with `disabled_commands` in the workflow file.',
        triggerPhrase,
      ),
    );
  }
  const lead =
    named(here).length > 0
      ? 'That comment names no command, so nothing ran. Write one of these directly after the phrase that starts ' +
        'a run here.'
      : `That comment names no command, so nothing ran. Nothing this repository answers is written on ` +
        `${where(here)} - these are answered on ${where(there)}.`;
  const typed = NEVER_INFERRED.filter(
    (command) => command !== HELP_COMMAND && [...named(here), ...named(there)].some((row) => row.startsWith(`- \`${command}\``)),
  );
  const lines = [
    lead,
    ...section(here, `On ${where(here)}, where this was left:`),
    ...section(there, `On ${where(there)}:`),
    ...(typed.length === 0
      ? []
      : [
        '',
        `${typed.map((command) => `\`${command}\``).join(', ')} are never guessed from prose and have to be ` +
          'written by name, because each is a decision only you can make.',
      ]),
  ];
  return asAlert('NOTE', scrubTrigger(lines.join('\n'), triggerPhrase));
}

function reference() {
  const link = docsLink('Open the command reference', '/reference/#commands', { scrubbed: true });
  return link ? ['', link] : [];
}

function renderHelp({
  onIssue = null,
  threadRootId = null,
  triggerPhrase = null,
  disabledCommands = null,
  repo = null,
  authorized = null,
  owners = null,
  writeAccessCommands = null,
  write = null,
} = {}) {
  const inThread = String(threadRootId ?? '').trim() !== '';
  const here = !inThread && String(onIssue) === 'true' ? 'issue' : 'pull';
  const there = here === 'issue' ? 'pull' : 'issue';
  const named = (surface, thread = false) =>
    commandsFor(surface, null, disabledCommands).filter((command) => command !== 'unlock' || thread);
  const hereCommands = named(here, inThread);
  const thereCommands = named(there);
  const controlCommands = Object.keys(COMMAND_TABLE).filter((command) => deliveredCommand(command));
  const offered = new Set([...hereCommands, ...thereCommands, ...controlCommands]);
  const rows = (commands) => commands.map((command) => `- \`${command}\` ${docOf(command)}`);
  const controls = rows(controlCommands);
  const where = (surface, current, thread) =>
    thread
      ? 'In this review thread:'
      : current
        ? `On this ${surface === 'issue' ? 'issue' : 'pull request'}:`
        : `On ${surface === 'issue' ? 'an issue' : 'a pull request'}:`;
  const section = (commands, surface, current, thread = false) => [
    '',
    where(surface, current, thread),
    ...(commands.length > 0 ? rows(commands) : ['- _No work command is enabled on this surface._']),
  ];
  const sections = [
    ...section(hereCommands, here, true, inThread),
    ...section(thereCommands, there, false),
  ];
  const phrase = String(triggerPhrase ?? '').trim() || DEFAULT_TRIGGER_PHRASE;
  const fallback = defaultCommandFor(here === 'issue', threadRootId);
  const typed = NEVER_INFERRED.filter((command) => command !== HELP_COMMAND && offered.has(command));
  const asking = [
    '',
    'How to ask:',
    `- Describe what you want in plain words on a pull request KSAI opened, and it reads the comment - no ` +
      `\`${phrase}\` and no command name`,
    offered.has(fallback)
      ? `- Anywhere else, open the comment with \`${phrase}\`; naming no command here means \`${fallback}\``
      : `- Anywhere else, open the comment with \`${phrase}\` and name one of the commands above`,
    ...(typed.length === 0
      ? []
      : [
        `- ${typed.map((command) => `\`${command}\``).join(', ')} are never guessed from prose - write ` +
          `\`${phrase} <command>\`, because each is a decision only you can make`,
      ]),
  ];
  const lines = [
    'What KSAI can do here:',
    'Help starts no model.',
    ...standing({ authorized, owners, repo, writeAccessCommands, write }),
    ...sections,
    '',
    'While a run is working:',
    ...controls,
    ...asking,
    ...reference(),
  ];
  return asAlert('NOTE', scrubTrigger(lines.join('\n'), triggerPhrase));
}

function namedRepo(repo) {
  const slug = String(repo ?? '').trim();
  if (slug === '') return 'this repository';
  const cut = slug.lastIndexOf('/');
  return cut <= 0 || cut === slug.length - 1 ? slug : `\`${slug.slice(0, cut)}\`/\`${slug.slice(cut + 1)}\``;
}

function renderUnimplemented(command, { repo = null, triggerPhrase = null, classified = false } = {}) {
  const named = String(command ?? '');
  if (!COMMANDS.includes(named)) {
    throw new Error(`\`${named}\` is not a command, so there is no unimplemented notice to render for it`);
  }
  const where = namedRepo(repo);
  const body = classified
    ? `That reads as a request to \`${named}\`, which is a command this bot knows and no flow implements in ${where} ` +
      'yet, so nothing ran. Nothing is wrong with how you wrote it - the flow it needs has not shipped here'
    : `The \`${named}\` command is recognized and no flow implements it in ${where} yet, so nothing ran. This is not ` +
      'a typo on your part - the command exists and its flow has not shipped here';
  return asAlert('WARNING', scrubTrigger(body, triggerPhrase));
}

function renderDisabled(command, { repo = null, triggerPhrase = null } = {}) {
  const named = String(command ?? '');
  if (!COMMANDS.includes(named)) {
    throw new Error(`\`${named}\` is not a command, so there is no turned-off notice to render for it`);
  }
  return asAlert(
    'WARNING',
    scrubTrigger(
      `The \`${named}\` command is turned off in ${namedRepo(repo)}, so nothing ran. It is not a typo and the ` +
        'flow is installed - a code owner listed this command in `disabled_commands` in the workflow file',
      triggerPhrase,
    ),
  );
}

function hasNoOwners(repo, { open = NO_WRITE_ACCESS } = {}) {
  return (
    `${namedRepo(repo)} has no \`CODEOWNERS\` file, so it has no code owners at all and ` +
    (open.length === 0 ? 'nobody can be authorized' : 'nothing holding the ownership bar can be authorized')
  );
}

const spelled = (commands) =>
  [...commands]
    .map((command) => `\`${command}\``)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');

const saidOpen = (open) => {
  const every = OPENABLE.every((command) => open.includes(command));
  const one = every || open.length === 1;
  return { every, said: every ? 'Every command' : spelled(open), runs: one ? 'runs' : 'run', needs: one ? 'needs' : 'need' };
};

function openToWrite(writeAccessCommands, { write = null } = {}) {
  const open = writeAccessCommands ?? NO_WRITE_ACCESS;
  if (open.length === 0) return '';
  const holds = asFact(write) === 'true' ? ', which you hold' : '';
  const { said, runs } = saidOpen(open);
  return `${said} ${runs} here for anyone with write access${holds}`;
}

function notAnOwner(repo, { command = null, writeAccessCommands = null, write = null, asked = false } = {}) {
  const named = namedCommand(command);
  const also = named === '' ? '' : openToWrite(writeAccessCommands, { write });
  const scope = named === '' ? (asked ? ' for a command this run could not name' : ' here') : ` for \`${named}\` here`;
  return (
    `you are not a code owner of ${namedRepo(repo)} with write access - owning any path in \`CODEOWNERS\` is ` +
    `the bar${scope}, and a code owner has to ask for it` +
    `${also ? `. ${also}` : ''}`
  );
}

function standing({ authorized = null, owners = null, repo = null, writeAccessCommands = null, write = null } = {}) {
  const open = writeAccessCommands ?? NO_WRITE_ACCESS;
  const { every, said, needs } = saidOpen(open);
  const bars =
    open.length === 0
      ? []
      : [
        `${said} ${needs} only write access here` +
          (every ? '.' : '; every other command needs `CODEOWNERS` ownership.'),
      ];
  if (String(authorized) !== 'false') return bars;
  const holds = asFact(write);
  if (every && holds === 'true') return bars;
  if (every) {
    return [
      holds === 'false'
        ? `None of these will run for you, because you do not have write access to ${namedRepo(repo)}.`
        : `Whether any of these runs for you could not be told, because GitHub could not be asked whether ` +
          `you have write access to ${namedRepo(repo)}. ${UNREADABLE_WRITE}`,
      ...bars,
    ];
  }
  const why = String(owners) === 'absent' ? hasNoOwners(repo, { open }) : notAnOwner(repo);
  const runs = open.length > 0 && holds === 'true' ? `Only ${spelled(open)} will` : 'None of these will';
  return [`${runs} run for you, because ${why}.`, ...bars];
}

function noWriteAccess(repo, { command = null, undecided = false } = {}) {
  const said = namedCommand(command);
  const named = said === '' ? 'the command you asked for' : `\`${said}\``;
  return undecided
    ? `GitHub could not be asked whether you have write access to ${namedRepo(repo)}, which is the bar ${named} ` +
      `holds here, so this refused rather than guessing. ${UNREADABLE_WRITE}`
    : `you do not have write access to ${namedRepo(repo)}, which is the bar ${named} holds here`;
}

function renderUnauthorized({
  repo = null,
  triggerPhrase = null,
  command = null,
  bar = CODEOWNERS_BAR,
  write = null,
  writeAccessCommands = null,
  undecided = false,
} = {}) {
  const body =
    bar === WRITE_BAR
      ? noWriteAccess(repo, { command, undecided })
      : notAnOwner(repo, { command, writeAccessCommands, write, asked: true });
  return asAlert('WARNING', scrubTrigger(`${body.charAt(0).toUpperCase()}${body.slice(1)}`, triggerPhrase));
}

function prerequisite(said, label, path, triggerPhrase) {
  const link = docsLink(label, path, { scrubbed: true });
  return asAlert('WARNING', scrubTrigger(link ? `${said}. ${link}` : said, triggerPhrase));
}

function renderNoOwners({ repo = null, triggerPhrase = null, writeAccessCommands = null, write = null } = {}) {
  const open = writeAccessCommands ?? NO_WRITE_ACCESS;
  const also = openToWrite(open, { write });
  return prerequisite(
    `Nothing ran, because ${hasNoOwners(repo, { open })}. Add one to the default branch naming who owns which paths` +
      (also
        ? `. ${also}`
        : ', or name the commands write access is enough for in `write_access_commands` in the workflow file'),
    'How to add one',
    '/start/repo#problems',
    triggerPhrase,
  );
}

function renderNotInstalled({ repo = null, triggerPhrase = null } = {}) {
  return prerequisite(
    `Nothing ran, because no App token could be minted for ${namedRepo(repo)}, so nothing this flow does ` +
      'could start. Check that the KSAI App is installed on this repository, which is what a mint fails on ' +
      'when the workflow itself is correct',
    'How to install it',
    '/start/repo#problems',
    triggerPhrase,
  );
}

function renderNoFederation({ repo = null, triggerPhrase = null } = {}) {
  return prerequisite(
    `Nothing will run, because ${namedRepo(repo)} is not listed in its team's federation, so no Anthropic ` +
      'token can be minted for it. Add the repository to `federations/<team>.yaml` in the ksai source repository',
    'How a federation change proceeds',
    '/federation#changes',
    triggerPhrase,
  );
}

function renderWrongSurface(command, { triggerPhrase = null } = {}) {
  const named = String(command ?? '').toLowerCase();
  const wants = surfaceOf(named);
  if (wants !== 'issue' && wants !== 'pull') return '';
  const where = wants === 'issue' ? 'an issue' : 'a pull request';
  return asAlert(
    'WARNING',
    scrubTrigger(
      `The \`${named}\` command is answered on ${where} rather than here, so nothing ran${WRONG_SURFACE_EXTRA[named] ?? ''}`,
      triggerPhrase,
    ),
  );
}

function commandFitsSurface(command, { onIssue = null, threadRootId = null, onReview = null } = {}) {
  const wants = surfaceOf(command);
  if (wants === null || wants === undefined) return true;
  const where = surfaceOfEvent(onIssue, threadRootId, onReview);
  return wants === where || (wants === 'pull' && (where === THREAD_SURFACE || where === REVIEW_SURFACE));
}

function surfaceOfEvent(onIssue, threadRootId = null, onReview = null) {
  if (String(onReview) === 'true') return REVIEW_SURFACE;
  if (String(threadRootId ?? '').trim() !== '') return THREAD_SURFACE;
  return String(onIssue) === 'true' ? 'issue' : 'pull';
}

function ownerOf(command) {
  const candidate = String(command ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(OWNER, candidate) ? OWNER[candidate] : undefined;
}

function ownsCommand(flow, command) {
  const owner = ownerOf(command);
  return typeof owner === 'string' && owner === flow;
}

const PRIMARY_COMMAND = Object.freeze(
  Object.assign(Object.create(null), {
    reviewer: 'review',
    implement: 'implement',
    tester: 'test',
  }),
);

function primaryCommandOf(flow) {
  const candidate = String(flow ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRIMARY_COMMAND, candidate) ? PRIMARY_COMMAND[candidate] : undefined;
}

const FLOWS = Object.freeze([...new Set(Object.values(OWNER).filter(Boolean))]);

const DELIVERED = columnOf('delivered');

const UNIMPLEMENTED_COMMANDS = Object.freeze(
  Object.keys(OWNER).filter(
    (command) => command !== HELP_COMMAND && OWNER[command] === null && DELIVERED[command] !== true,
  ),
);

const deliveredCommand = (command) => DELIVERED[String(command ?? '').toLowerCase()] === true;

const COMMANDS = Object.freeze(Object.keys(OWNER));

const OPENABLE = Object.freeze(COMMANDS.filter((command) => !deliveredCommand(command)));

const EVERY_COMMAND = 'all';

const expandEveryCommand = (names) => names.flatMap((name) => (name === EVERY_COMMAND ? OPENABLE : [name]));

const writeAccessNames = (input) => expandEveryCommand(parseDisabledCommands(input));

function resolveCommand(token, aliases) {
  const candidate = String(token ?? '').toLowerCase();
  if (COMMANDS.includes(candidate)) return candidate;
  const aliased = aliases ? aliases[candidate] : undefined;
  return typeof aliased === 'string' && COMMANDS.includes(aliased) ? aliased : null;
}

const DEFAULT_COMMAND = 'review';

const ISSUE_DEFAULT_COMMAND = 'implement';

const THREAD_DEFAULT_COMMAND = 'fix';

const REVIEW_DEFAULT_COMMAND = 'revise';

function defaultCommandFor(onIssue, threadRootId = null, onReview = null, reviewState = null) {
  const where = surfaceOfEvent(onIssue, threadRootId, onReview);
  if (where === REVIEW_SURFACE) {
    return String(reviewState ?? '').trim().toLowerCase() === 'approved' ? 'approve' : REVIEW_DEFAULT_COMMAND;
  }
  if (where === THREAD_SURFACE) return THREAD_DEFAULT_COMMAND;
  return where === 'issue' ? ISSUE_DEFAULT_COMMAND : DEFAULT_COMMAND;
}

const SEPARATOR = /[ \t]/;
const TERMINATOR = /[\r\n]/;

function safeEcho(value) {
  const text = String(value ?? '');
  const scrubbed = text.replace(/[^A-Za-z0-9._-]/g, '?');
  return scrubbed.length > 40 ? `${scrubbed.slice(0, 40)}…` : scrubbed;
}

function parseAllowedModels(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function parseDisabledCommands(raw) {
  return parseAllowedModels(raw).map((command) => command.toLowerCase());
}

function commandEnabled(command, { flow = null, disabledCommands = null } = {}) {
  const listed = parseDisabledCommands(disabledCommands);
  if (listed.length === 0) return true;
  if (!ownsCommand(flow, command)) return true;
  return !listed.includes(String(command ?? '').toLowerCase());
}

const CODEOWNERS_BAR = 'codeowners';

const WRITE_BAR = 'write';

const NO_WRITE_ACCESS = Object.freeze([]);

const UNREADABLE_WRITE = 'The authorization token needs metadata:read on this repository.';

function undecidedWriteAccess(command, { subject = null } = {}) {
  const named = namedCommand(command);
  return (
    `\`${named || 'that command'}\` runs here for anyone with write access, and GitHub could not be asked ` +
    `whether ${subject ? `@${subject}` : 'the requester'} holds it, so this run refused rather than guessing. ` +
    UNREADABLE_WRITE
  );
}

function unknownCommandIn(named, { where = null, commandAliases = null } = {}) {
  const unknown = named.find((command) => !COMMANDS.includes(command));
  if (unknown === undefined) return null;
  const aliased = commandAliases?.[unknown];
  return typeof aliased === 'string' && COMMANDS.includes(aliased)
    ? `${where} lists the alias \`${safeEcho(unknown)}\`; list the command \`${aliased}\` instead`
    : `${where} names \`${safeEcho(unknown)}\`, which is not a command; the commands are ${COMMANDS.join(', ')}`;
}

const carriedRefusal = (where, carried) =>
  `${where} names \`${safeEcho(carried)}\`, which is carried into a run already going rather than starting one, ` +
  'so it is answered by whoever wrote the comment rather than by the command; remove it, and every command left ' +
  'in the list keeps working';

function resolveWriteAccess({ input = null, fromFile = null, commandAliases = null } = {}) {
  const named = [...new Set(writeAccessNames(input))];
  const unknown = unknownCommandIn(named, { where: 'the `write_access_commands` input', commandAliases });
  if (unknown !== null) return { error: unknown };
  const carried = named.find((command) => deliveredCommand(command));
  if (carried !== undefined) return { error: carriedRefusal('the `write_access_commands` input', carried) };
  if (fromFile === null || fromFile === undefined) {
    return { commands: Object.freeze(named) };
  }
  const asked = [...new Set([...fromFile].map((command) => String(command ?? '').trim().toLowerCase()))];
  const held = [...new Set(expandEveryCommand(asked))];
  const heldCarried = held.find((command) => deliveredCommand(command));
  if (heldCarried !== undefined) {
    return { error: carriedRefusal('`write_access_commands` in `.ksai/ksai.json`', heldCarried) };
  }
  const widened = held.find((command) => !named.includes(command));
  if (widened !== undefined) {
    const word = !asked.includes(widened) && asked.includes(EVERY_COMMAND);
    return {
      error:
        `\`write_access_commands\` in \`.ksai/ksai.json\` names \`${safeEcho(word ? EVERY_COMMAND : widened)}\`, ` +
        `which ${word ? `opens \`${safeEcho(widened)}\` and ` : ''}the workflow's own ` +
        '`write_access_commands` does not; a repository may narrow that list and may never widen it',
    };
  }
  return { commands: Object.freeze(held) };
}

const namedCommand = (command) => {
  const said = String(command ?? '').trim().toLowerCase();
  return COMMANDS.includes(said) ? said : '';
};

const anyCommandOpen = (input) => (resolveWriteAccess({ input }).commands ?? NO_WRITE_ACCESS).length > 0;

function commandBar(command, { writeAccessCommands = null } = {}) {
  return (writeAccessCommands ?? NO_WRITE_ACCESS).includes(namedCommand(command)) ? WRITE_BAR : CODEOWNERS_BAR;
}

const opensApprove = (writeAccessCommands) => commandBar('approve', { writeAccessCommands }) === WRITE_BAR;

const releaserOf = (writeAccessCommands) =>
  opensApprove(writeAccessNames(writeAccessCommands))
    ? 'a code owner or anyone with write access here'
    : 'a code owner';

const asFact = (fact) => String(fact ?? '').trim();

function commandAuthorized(command, { codeowner = null, write = null, writeAccessCommands = null } = {}) {
  const bar = commandBar(command, { writeAccessCommands });
  const owns = asFact(codeowner);
  const holds = asFact(write);
  if (owns !== 'true' && owns !== 'false') return { bar, read: false, authorized: false, undecided: false };
  if (bar === CODEOWNERS_BAR) return { bar, read: true, authorized: owns === 'true', undecided: false };
  return {
    bar,
    read: true,
    authorized: owns === 'true' || holds === 'true',
    undecided:
      namedCommand(command) !== HELP_COMMAND && owns !== 'true' && holds !== 'true' && holds !== 'false',
  };
}

const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseOptions(prompt, { commandAliases = null, defaultCommand = DEFAULT_COMMAND, bare = false } = {}) {
  const text = String(prompt ?? '');
  const requested = Object.create(null);
  let command = null;
  let i = 0;

  if (bare === true) return { command, requested, prompt: text.trimStart() };

  const skipSeparators = () => {
    while (i < text.length && SEPARATOR.test(text[i])) i += 1;
  };

  const readToken = () => {
    const start = i;
    while (i < text.length && !SEPARATOR.test(text[i]) && !TERMINATOR.test(text[i])) i += 1;
    return text.slice(start, i);
  };

  skipSeparators();

  const commandStart = i;
  const leading = resolveCommand(readToken(), commandAliases);
  if (leading) {
    command = leading;
    skipSeparators();
  } else {
    i = commandStart;
  }

  const reject = (error) => ({ error, command: command ?? undefined, commandNamed: command !== null });

  for (;;) {
    if (i >= text.length || TERMINATOR.test(text[i])) break;

    const mark = i;
    const token = readToken();
    const aliased = Object.prototype.hasOwnProperty.call(FLAG_ALIASES, token) ? FLAG_ALIASES[token] : null;
    if (aliased) {
      if (aliased in requested) return reject(`\`${aliased}\` given more than once`);
      requested[aliased] = true;
      skipSeparators();
      continue;
    }
    if (!token.startsWith('--')) {
      const candidate = command == null ? resolveCommand(token, commandAliases) : null;
      if (candidate && candidate !== defaultCommand) {
        return reject(`the command \`${safeEcho(token)}\` must be the first word after the trigger phrase`);
      }
      i = mark;
      break;
    }

    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!OPTIONS.includes(name)) {
      return reject(`unrecognized option \`${safeEcho(token)}\``);
    }
    if (name in requested) {
      return reject(`\`${name}\` given more than once`);
    }

    if (FLAGS.includes(name)) {
      if (eq !== -1) {
        return reject(`\`${name}\` takes no value`);
      }
      requested[name] = true;
      skipSeparators();
      continue;
    }

    let value = eq === -1 ? null : token.slice(eq + 1);
    if (value === null) {
      skipSeparators();
      value = i < text.length && !TERMINATOR.test(text[i]) ? readToken() : '';
    }
    if (value === '' || value.startsWith('--')) {
      return reject(`\`${name}\` needs a value`);
    }
    requested[name] = value;

    skipSeparators();
  }

  return { command, requested, prompt: text.slice(i).trimStart() };
}

function selectArm({
  prompt = null,
  defaultModel = null,
  defaultEffort = null,
  allowedModels = null,
  disabledCommands = null,
  legacyAllowedCommands = null,
  writeAccessCommands = null,
  writeAccessFromFile = null,
  maxEffort = null,
  minEffort = null,
  triage = null,
  commandAliases = null,
  onIssue = null,
  threadRootId = null,
  onReview = null,
  reviewState = null,
  bare = false,
} = {}) {
  const allowed = parseAllowedModels(allowedModels);
  const fallbackEffort = String(defaultEffort ?? '').trim();
  const fallbackModel = resolveModel(defaultModel);

  if (!ALLOWED_EFFORTS.includes(fallbackEffort)) {
    return { error: `the \`effort\` input must be one of ${ALLOWED_EFFORTS.join(', ')}, got: ${safeEcho(fallbackEffort)}` };
  }
  if (!MODEL_SHAPE.test(fallbackModel)) {
    return { error: `the \`model\` input is not a usable model id: ${safeEcho(fallbackModel)}` };
  }
  const badEntry = allowed.find((m) => !MODEL_SHAPE.test(m));
  if (badEntry !== undefined) {
    return { error: `the \`allowed_models\` input carries an unusable model id: ${safeEcho(badEntry)}` };
  }
  const aliasEntry = allowed.find((m) => m.toLowerCase() in ALIASES);
  if (aliasEntry !== undefined) {
    return {
      error: `the \`allowed_models\` input lists the alias \`${safeEcho(aliasEntry)}\`; list the model id \`${ALIASES[aliasEntry.toLowerCase()]}\` instead`,
    };
  }

  if (String(legacyAllowedCommands ?? '').trim() !== '') {
    return {
      error:
        'the `allowed_commands` input was replaced by `disabled_commands`, which names the commands this ' +
        'repository turns off rather than the ones it answers; remove `allowed_commands` and list the ' +
        'commands you do not want in `disabled_commands`',
    };
  }

  const turnedOff = unknownCommandIn(parseDisabledCommands(disabledCommands), {
    where: 'the `disabled_commands` input',
    commandAliases,
  });
  if (turnedOff !== null) return { error: turnedOff };

  const opened = resolveWriteAccess({ input: writeAccessCommands, fromFile: writeAccessFromFile, commandAliases });
  if (opened.error) return { error: opened.error };

  const configuredCeiling = String(maxEffort ?? '').trim();
  const ceiling = configuredCeiling || fallbackEffort;
  if (!ALLOWED_EFFORTS.includes(ceiling)) {
    return { error: `the \`max_effort\` input must be one of ${ALLOWED_EFFORTS.join(', ')}, got: ${safeEcho(ceiling)}` };
  }

  const configuredFloor = String(minEffort ?? '').trim();
  let floor = configuredFloor || DEFAULT_MIN_EFFORT;
  if (!ALLOWED_EFFORTS.includes(floor)) {
    return { error: `the \`min_effort\` input must be one of ${ALLOWED_EFFORTS.join(', ')}, got: ${safeEcho(floor)}` };
  }
  if (!configuredFloor && !configuredCeiling && ALLOWED_EFFORTS.indexOf(floor) > ALLOWED_EFFORTS.indexOf(ceiling)) {
    floor = ceiling;
  }
  if (ALLOWED_EFFORTS.indexOf(floor) > ALLOWED_EFFORTS.indexOf(ceiling)) {
    return { error: `\`min_effort\` (\`${floor}\`) is above \`max_effort\` (\`${ceiling}\`), so no effort can be requested` };
  }

  const defaultCommand = defaultCommandFor(onIssue, threadRootId, onReview, reviewState);
  const parsed = parseOptions(prompt, { commandAliases, defaultCommand, bare });
  if (parsed.error) {
    return {
      error: parsed.error,
      allowed,
      ceiling,
      floor,
      command: parsed.command,
      commandNamed: parsed.commandNamed,
    };
  }

  const command = parsed.command ?? defaultCommand;
  const commandNamed = parsed.command !== null;

  const reject = (error) => ({ error, allowed, ceiling, floor, command, commandNamed });

  const { requested } = parsed;
  let model = fallbackModel;
  let effort = fallbackEffort;

  if ('--effort' in requested) {
    const wanted = requested['--effort'].toLowerCase();
    if (!ALLOWED_EFFORTS.includes(wanted)) {
      return reject(`unknown effort \`${safeEcho(wanted)}\``);
    }
    if (ALLOWED_EFFORTS.indexOf(wanted) > ALLOWED_EFFORTS.indexOf(ceiling)) {
      return reject(`effort \`${safeEcho(wanted)}\` is above this repo's ceiling of \`${ceiling}\``);
    }
    if (ALLOWED_EFFORTS.indexOf(wanted) < ALLOWED_EFFORTS.indexOf(floor)) {
      return reject(
        `effort \`${safeEcho(wanted)}\` is below this repo's floor of \`${floor}\`, where a run does not reliably complete`,
      );
    }
    effort = wanted;
  }

  if ('--model' in requested) {
    const wanted = requested['--model'].toLowerCase();
    const resolved = canonicalOf(resolveModel(wanted), allowed);
    if (!resolved) {
      return reject(`model \`${safeEcho(wanted)}\` is not available in this repo`);
    }
    model = resolved;
  }

  let jiraKey = null;
  if ('--jira' in requested) {
    const wanted = requested['--jira'].toUpperCase();
    if (!JIRA_KEY_SHAPE.test(wanted)) {
      return reject(`\`--jira\` needs a Jira issue key like \`KONG-1234\`, got: ${safeEcho(requested['--jira'])}`);
    }
    if (command !== 'implement') {
      return reject(
        `\`--jira\` names the work to plan, so it belongs on \`implement\` rather than on \`${safeEcho(command)}\``,
      );
    }
    jiraKey = wanted;
  }

  let usedTriage = false;
  const wantTier = String(triage?.tier ?? '');
  if (wantTier && !('--model' in requested)) {
    const named = String(model ?? '').toLowerCase();
    const callerTier = MODEL_TIERS.findIndex((tier) => String(ALIASES[tier]).toLowerCase() === named);
    const wantedTier = MODEL_TIERS.indexOf(wantTier);
    if (callerTier !== -1 && wantedTier !== -1 && wantedTier < callerTier) {
      const resolved = canonicalOf(ALIASES[wantTier], allowed);
      if (resolved) {
        model = resolved;
        usedTriage = true;
      }
    }
  }

  const wantEffort = String(triage?.effort ?? '');
  if (wantEffort && !('--effort' in requested)) {
    const wantedIdx = ALLOWED_EFFORTS.indexOf(wantEffort);
    if (wantedIdx !== -1 && wantedIdx >= ALLOWED_EFFORTS.indexOf(floor) && wantedIdx < ALLOWED_EFFORTS.indexOf(fallbackEffort)) {
      effort = wantEffort;
      usedTriage = true;
    }
  }

  if (!MODEL_SHAPE.test(model)) {
    return reject(`resolved model is not a usable model id: ${safeEcho(model)}`);
  }

  const force = '--force' in requested;
  const wantsPlan = '--plan' in requested;
  const wantsNoPlan = '--no-plan' in requested;
  const planGiven = '--plan-given' in requested;
  if (wantsPlan && wantsNoPlan) {
    return reject('`--plan` and `--no-plan` ask for opposite things, so name one or neither');
  }
  if (planGiven && wantsNoPlan) {
    return reject('`--plan-given` hands in a plan and `--no-plan` asks for no plan at all, so name one or neither');
  }
  const planAsk = wantsPlan || planGiven ? 'always' : wantsNoPlan ? 'never' : '';
  const askedBy = planGiven ? '--plan-given' : wantsPlan ? '--plan' : '--no-plan';
  if (planAsk !== '' && !PLAN_ASK_COMMANDS.includes(command)) {
    return reject(
      `\`${askedBy}\` decides whether work is planned before it starts, so it belongs ` +
        `on ${PLAN_ASK_COMMANDS.map((named) => `\`${named}\``).join(' or ')} rather than on \`${safeEcho(command)}\``,
    );
  }
  if (planGiven) {
    const given = extractGivenPlan(prompt);
    if (given.error) {
      return reject(`\`--plan-given\` hands the plan in with the comment, and ${given.error}`);
    }
  }
  if (force && command !== 'approve') {
    return reject(
      `\`--force\` releases a plan over the review still open on it, so it belongs on \`approve\` rather than ` +
        `on \`${safeEcho(command)}\``,
    );
  }
  const escaped = escapeHtml(parsed.prompt);
  return {
    command,
    commandNamed,
    writeAccess: opened.commands,
    model,
    effort,
    planAsk,
    planGiven,
    jiraKey,
    selectedBy: '--model' in requested || '--effort' in requested ? 'comment' : usedTriage ? 'triage' : 'input',
    modelSelectedBy: '--model' in requested ? 'comment' : usedTriage && model !== fallbackModel ? 'triage' : 'input',
    effortSelectedBy: '--effort' in requested ? 'comment' : usedTriage && effort !== fallbackEffort ? 'triage' : 'input',
    prompt: parsed.prompt,
    promptHtml: escaped,
    promptReport: escaped.replace(/\r?\n/g, '<br>').replace(/\|/g, '&#124;'),
  };
}

function planMode({ input = '', fromFile = '', asked = '' } = {}) {
  const named = String(input ?? '').trim().toLowerCase() || 'auto';
  if (!PLAN_MODES.includes(named)) {
    return { error: `\`plan_mode\` must be one of ${PLAN_MODES.join(', ')}, got: ${safeEcho(String(input))}` };
  }
  const held = String(fromFile ?? '').trim().toLowerCase();
  if (held !== '' && !PLAN_MODES.includes(held)) {
    return { error: `\`plan_mode\` in \`.ksai/ksai.json\` must be one of ${PLAN_MODES.join(', ')}, got: ${safeEcho(held)}` };
  }
  const settled = held === 'always' ? 'always' : named;
  const wanted = String(asked ?? '').trim().toLowerCase();
  if (wanted !== '' && !PLAN_MODES.includes(wanted)) {
    return { error: `a plan flag resolved to ${safeEcho(wanted)}, which is not one of ${PLAN_MODES.join(', ')}` };
  }
  if (wanted === 'never' && settled === 'always') {
    return {
      error:
        '`--no-plan` cannot skip the plan here, because this repository requires every change to be planned. ' +
        'Ask a maintainer to change `plan_mode` if that is wrong',
    };
  }
  return { mode: wanted === '' ? settled : wanted, asked: wanted !== '' };
}

function scrubTrigger(body, trigger) {
  const token = triggerMatcher(trigger).test('<trigger>') ? '' : '<trigger>';
  const matcher = new RegExp(`(^|\\s)${triggerAlternation(trigger)}(?=\\s|$)`, 'gi');
  return String(body ?? '').replace(matcher, (_, lead) => `${lead}${token}`);
}

function asAlert(kind, body) {
  const text = String(body ?? '');
  if (text === '') return '';
  const quoted = text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`));
  return [`> [!${kind}]`, ...quoted].join('\n');
}

function renderRejection({ error, allowed, ceiling, floor, command, trigger }) {
  const scrub = (body) => asAlert('WARNING', scrubTrigger(body, trigger));

  if (allowed === undefined || ceiling === undefined || floor === undefined) {
    return scrub(
      [
        `**${error}**`,
        '',
        "This is the repo's own run configuration, not the request. A code owner needs to fix the workflow inputs.",
      ].join('\n'),
    );
  }

  const efforts = ALLOWED_EFFORTS.slice(ALLOWED_EFFORTS.indexOf(floor), ALLOWED_EFFORTS.indexOf(ceiling) + 1);
  const aliases = MODEL_CATALOG.allowedAliases.filter((name) => canonicalOf(ALIASES[name], allowed) !== null);
  const named = namedCommand(command);

  const lines = [
    `**${error}**`,
    '',
    named === ''
      ? 'Add the options directly after the trigger phrase, before the rest of the request:'
      : 'Add the options directly after the command, before the rest of the request:',
    '',
    '```text',
    `<trigger>${named === '' ? '' : ` ${named}`} --model balanced --effort medium focus on the auth path`,
    '```',
    '',
    `| Option | Accepted |`,
    `| ---: | :--- |`,
    `| \`--model\` | ${allowed.map((m) => `\`${m}\``).join(', ') || '_none configured_'} |`,
    `| \`--effort\` | ${efforts.map((e) => `\`${e}\``).join(', ')} |`,
  ];
  if (aliases.length) {
    lines.push(`| aliases | ${aliases.map((a) => `\`${a}\` → \`${ALIASES[a]}\``).join(', ')} |`);
  }
  lines.push('', 'Omit an option to use the repo default');

  return scrub(lines.join('\n'));
}

function renderConfigRejection(error, trigger) {
  return asAlert(
    'WARNING',
    scrubTrigger(
      [
        `**${error}**`,
        '',
        "This is the repository's own `ksai.json` in `.ksai/`, not the request. A code owner needs to fix it",
      ].join('\n'),
      trigger,
    ),
  );
}

module.exports = {
  FLAGS,
  PLAN_MODES,
  planMode,
  renderConfigRejection,
  UNIMPLEMENTED_COMMANDS,
  deliveredCommand,
  COMMAND_TABLE,
  NAMED_ONLY,
  NEVER_INFERRED,
  namedOnly,
  COMMAND_FIELDS,
  OWNER,
  ownerOf,
  ownsCommand,
  FLOWS,
  PRIMARY_COMMAND,
  primaryCommandOf,
  SURFACE,
  THREAD_SURFACE,
  surfaceOf,
  docOf,
  commandFitsSurface,
  surfaceOfEvent,
  renderWrongSurface,
  renderUnnamedCommand,
  renderHelp,
  renderUnimplemented,
  renderDisabled,
  renderUnauthorized,
  renderNoOwners,
  renderNotInstalled,
  renderNoFederation,
  commandEnabled,
  CODEOWNERS_BAR,
  WRITE_BAR,
  NO_WRITE_ACCESS,
  resolveWriteAccess,
  anyCommandOpen,
  releaserOf,
  opensApprove,
  unknownCommandIn,
  commandAuthorized,
  namedCommand,
  undecidedWriteAccess,
  parseDisabledCommands,
  parseAllowedCommands: parseDisabledCommands,
  writeAccessNames,
  EVERY_COMMAND,
  scrubTrigger,
  asAlert,
  namedRepo,
  ALLOWED_EFFORTS,
  DEFAULT_MIN_EFFORT,
  ALIASES,
  MODEL_TIERS,
  COMMANDS,
  OPENABLE,
  HELP_COMMAND,
  DEFAULT_COMMAND,
  defaultCommandFor,
  MODEL_CORE,
  MODEL_SHAPE,
  KNOWN_MODELS,
  RECORDED_TIERS,
  VENDOR_ALIASES,
  shortModel,
  armLabel,
  JIRA_KEY_SHAPE,
  JIRA_ACCOUNT_CORE,
  JIRA_ACCOUNT_SHAPE,
  parseAllowedModels,
  resolveModel,
  parseOptions,
  resolveCommand,
  selectArm,
  renderRejection,
  safeEcho,
};
