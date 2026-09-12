
const {
  selectArm,
  parseOptions,
  defaultCommandFor,
  renderConfigRejection,
  renderRejection,
  ownerOf,
  ownsCommand,
  surfaceOf,
  commandFitsSurface,
  commandEnabled,
  commandAuthorized,
  deliveredCommand,
  HELP_COMMAND,
  FLOWS,
  primaryCommandOf,
  THREAD_SURFACE,
  surfaceOfEvent,
} = require('../lib/select-arm.cjs');
const { LABEL_SOURCE, receiptOf, sourceOf } = require('../lib/request-intent.cjs');
const loadConfig = require('./config.cjs');
const {
  verdictOf,
  answerable,
  surfaceForComment,
  CLARIFY_VERDICT,
  CLASSIFIER_SOURCE,
  NO_VERDICT,
  NUDGE_VERDICT,
  BARE_SURFACES,
} = require('./classify.cjs');
const {
  parseBody,
  firstUnchecked,
  isCheckpoint,
  criteriaOf,
  heldBy,
  releaseOf,
  releaseRef,
  stepDigest,
} = require('./plan.cjs');
const { counted, plural } = require('../lib/text.cjs');
const { releasedTokens } = require('./checkpoint.cjs');

function attributeCommand(flow, prompt, commandAliases, defaultCommand) {
  const command = parseOptions(prompt ?? '', { commandAliases, defaultCommand }).command;
  if (command === undefined) return;
  return ownsCommand(flow, command ?? defaultCommand);
}

function classifiedCommandOf(raw, disabledCommands, surface = null) {
  const verdict = verdictOf(raw, disabledCommands, surface);
  return verdict === NO_VERDICT ? '' : verdict;
}

async function classifyTarget({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prompt = null,
  continuation = false,
  disabledCommands = null,
  onIssue = null,
  threadRootId = null,
  onReview = null,
  reviewState = null,
  bare = false,
  readConfig = null,
} = {}) {
  if (continuation === true || String(continuation) === 'true') return { classify: false };
  const surface = surfaceForComment({ onOwnPull: bare, onIssue, threadRootId, onReview });
  if (surface === 'issue' || surface === THREAD_SURFACE || surface === 'review') return { classify: false };
  const usable =
    onIssue == null
      ? answerable(disabledCommands, surface)
      : answerable(disabledCommands, surface).filter((command) =>
          commandFitsSurface(command, { onIssue, threadRootId, onReview }),
        );
  if (usable.every((command) => ownerOf(command) === null)) return { classify: false };
  if (BARE_SURFACES.includes(surface)) {
    const said = String(prompt ?? '').trim();
    return said === '' ? { classify: false } : { classify: true, comment: said };
  }
  try {
    const config = await (readConfig ? readConfig() : loadConfig({ github, core, owner, repo }));
    if (config.error) return { classify: false };
    const parsed = parseOptions(String(prompt ?? ''), {
      commandAliases: config.aliases,
      defaultCommand: defaultCommandFor(onIssue, threadRootId, onReview, reviewState),
    });
    if (parsed.error) return { classify: false };
    if (parsed.command !== null) return { classify: false };
    const comment = String(parsed.prompt ?? '').trim();
    if (comment === '') return { classify: false };
    return { classify: true, comment };
  } catch (error) {
    core?.warning?.(`the classifier gate could not read the comment, so nothing was classified: ${error.message}`);
    return { classify: false };
  }
}

async function resolveRequest({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prompt = null,
  flow = null,
  trigger = null,
  arm = null,
  continuation = false,
  onIssue = true,
  threadRootId = null,
  onReview = null,
  reviewState = null,
  bare = false,
  commented = true,
  label = '',
  labelReview = false,
  classifiedCommand = '',
  codeowner = null,
  write = null,
} = {}) {
  const own = String(flow ?? '').trim().toLowerCase();
  if (!FLOWS.includes(own)) {
    return { error: `the \`flow\` input must be one of ${FLOWS.join(', ')}, got: ${own}` };
  }

  const here = defaultCommandFor(onIssue, threadRootId, onReview, reviewState);
  const requestSurface = surfaceOfEvent(onIssue, threadRootId, onReview);

  if (continuation === true || String(continuation) === 'true') {
    const armed = selectArm({ ...arm, prompt: '' });
    if (armed.error) return { error: armed.error };
    const primary = primaryCommandOf(own);
    if (!commandEnabled(primary, { flow: own, disabledCommands: arm?.disabledCommands })) {
      return { mine: false, disabled: primary };
    }
    const source = sourceOf({ continuation: true });
    return {
      mine: true,
      command: primary,
      model: armed.model,
      effort: armed.effort,
      modelSelectedBy: armed.modelSelectedBy,
      effortSelectedBy: armed.effortSelectedBy,
      guidanceHtml: '',
      continuation: true,
      routeSource: source,
      routeSurface: requestSurface,
      receipt: receiptOf(primary, requestSurface, source),
    };
  }

  const classifierSurface = surfaceForComment({ onOwnPull: bare, onIssue, threadRootId, onReview });
  const asked = BARE_SURFACES.includes(classifierSurface);
  const direct = parseOptions(prompt ?? '', { defaultCommand: here, bare: asked });
  if (!direct.error && direct.command !== null && direct.command === HELP_COMMAND) {
    return { mine: false, help: true };
  }

  const config = await loadConfig({ github, core, owner, repo });
  if (config.error) {
    return {
      error: config.error,
      rejection: renderConfigRejection(config.error, trigger),
      mine: attributeCommand(own, prompt, undefined, here),
    };
  }

  const result = selectArm({
    ...arm,
    prompt: prompt ?? '',
    commandAliases: config.aliases,
    writeAccessFromFile: config.writeAccess,
    onIssue,
    threadRootId,
    onReview,
    reviewState,
    bare: asked,
  });
  if (result.error) {
    const mine =
      result.command === undefined ? attributeCommand(own, prompt, config.aliases, here) : ownsCommand(own, result.command);
    const { error, allowed, ceiling, floor, command } = result;
    return { error, rejection: renderRejection({ error, allowed, ceiling, floor, command, trigger }), mine };
  }

  const verdict = result.commandNamed
    ? ''
    : String(classifiedCommand ?? '').trim() === CLARIFY_VERDICT
      ? CLARIFY_VERDICT
      : classifiedCommandOf(classifiedCommand, arm?.disabledCommands, classifierSurface);
  if (verdict === CLARIFY_VERDICT) return { mine: false, clarify: true };
  if (verdict === NUDGE_VERDICT) return { mine: false, nudge: true, routeSource: CLASSIFIER_SOURCE };
  const classified = verdict !== '' && commandFitsSurface(verdict, { onIssue, threadRootId }) ? verdict : '';
  if (asked && classified === '') return { mine: false };
  const command = classified || result.command;
  const named = result.commandNamed || classified !== '';
  const labelled = String(label ?? '').trim() !== '';
  const routeSource = labelled ? LABEL_SOURCE : sourceOf({ classified: classified !== '', named: result.commandNamed, commented });
  if (asked && ownerOf(classified) && ownerOf(classified) !== own) {
    return { mine: false, unaddressed: classified, routeSource };
  }

  if (command === HELP_COMMAND) return { mine: false, help: true, routeSource };

  if (ownerOf(command) === null) {
    if (deliveredCommand(command)) return { mine: false, delivered: command, routeSource };
    return { mine: false, unimplemented: command, classified: classified !== '', routeSource };
  }

  if (!named && !commandFitsSurface(command, { onIssue, threadRootId, onReview })) {
    return { mine: false, unnamed: true, routeSource };
  }

  if (!commandEnabled(command, { flow: ownerOf(command), disabledCommands: arm?.disabledCommands })) {
    return { mine: false, disabled: command, routeSource };
  }

  if (!named && !ownsCommand(own, command)) {
    return { mine: false, foreign: command, routeSource };
  }

  if (!commandFitsSurface(command, { onIssue, threadRootId, onReview })) {
    return { mine: false, wrongSurface: { command, wants: surfaceOf(command) }, routeSource };
  }

  if (ownsCommand(own, command)) {
    const bar = commandAuthorized(command, { codeowner, write, writeAccessCommands: result.writeAccess });
    if (bar.read && !bar.authorized) {
      return {
        mine: false,
        unauthorized: { command, bar: bar.bar, undecided: bar.undecided, writeAccessCommands: result.writeAccess },
        routeSource,
      };
    }
    const source = routeSource;
    return {
      mine: true,
      command,
      writeAccessCommands: result.writeAccess,
      model: result.model,
      effort: result.effort,
      modelSelectedBy: result.modelSelectedBy,
      effortSelectedBy: result.effortSelectedBy,
      guidanceHtml: result.promptHtml,
      jiraKey: result.jiraKey ?? null,
      planAsk: result.planAsk ?? '',
      planGiven: result.planGiven === true,
      dryRun: result.dryRun === true,
      classified: classified !== '',
      routeSource: source,
      routeSurface: requestSurface,
      receipt: receiptOf(command, requestSurface, source, { label, review: labelReview }),
    };
  }
  return { mine: false, foreign: command, routeSource };
}

async function nextStep({ github = null, owner = null, repo = null, prNumber = null, botLogin = null } = {}) {
  const [{ data: pr }, seen] = await Promise.all([
    github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) }),
    releasedTokens({ github, owner, repo, prNumber, botLogin }),
  ]);

  const body = pr.body ?? '';
  const paused = heldBy(body);
  if (paused !== null) return { held: paused, atCheckpoint: false, hasStep: false, total: 0, remaining: 0, remainingSteps: 0, stepTitle: '' };
  const plan = parseBody(body);
  if (plan.error) return { error: plan.error, errorKind: 'unreadable' };

  const boundaries = plan.steps.filter((step) => isCheckpoint(step.title));
  const ticked = boundaries.filter((step) => step.done).length;
  if (seen.unreadable) return { error: seen.unreadable, errorKind: 'unreadable-releases' };
  if (boundaries.length === 0) {
    return {
      error:
        'this plan holds no phase boundary row at all, and every plan this flow publishes ends in one. A ' +
        'body whose boundaries are gone is not a plan this run will carry on with',
      errorKind: 'edited-plan',
    };
  }
  if (seen.shape === null) {
    return {
      error:
        `no comment on #${String(prNumber)} records how many phase boundaries this plan was published with, ` +
        'so there is nothing to check the body against. That record is written before the plan is, and it is ' +
        'removable only by editing or deleting a comment - which is the same access that can delete the ' +
        'boundary rows themselves',
      errorKind: 'no-boundary-record',
    };
  }
  if (seen.sealed === null) {
    return {
      error:
        `no comment on #${String(prNumber)} records what an approver released, and the record left behind is ` +
        'the one written before the plan was approved. That earlier record carries no seal over the step ' +
        'wording, so reconciling against it would run a body nobody has checked. Either this plan was released ' +
        'before that seal was recorded, or the comment recording it has been deleted - which is the same ' +
        'access that can reword the steps themselves',
      errorKind: 'no-release-record',
    };
  }
  if (seen.sealed.checkpoints !== boundaries.length) {
    return {
      error:
        `this plan was released with ${counted(seen.sealed.checkpoints, 'phase boundary row')} and the body now holds ` +
        `${boundaries.length}. A boundary is an approver's review, so a plan whose boundaries have changed ` +
        'is not run',
      errorKind: 'edited-plan',
    };
  }
  if (seen.sealed.digest !== stepDigest(body)) {
    return {
      error:
        'the step titles in this body are not the ones an approver released. A title is the task this flow ' +
        'carries out verbatim, so a body whose steps have been reworded since the review is not a plan this ' +
        'run will carry on with. Restore the wording that was released, or plan the work again from scratch',
      errorKind: 'edited-steps',
    };
  }
  if (ticked > seen.tokens.size) {
    return {
      error:
        `${counted(ticked, 'checkpoint')} ${plural(ticked, 'is', 'are')} ticked and ` +
        `${counted(seen.tokens.size, 'release')} ${plural(seen.tokens.size, 'accounts', 'account')} for that` +
        (seen.editedRelease
          ? ', and a comment of mine recording a release has been edited, so what it published is no longer ' +
            'evidence that a phase was released'
          : ''),
      errorKind: 'unreleased-checkpoint',
    };
  }
  const namedAt = new Set(seen.bound.filter((release) => release.at > 0).map((release) => release.at));
  const unbound = new Set(seen.bound.filter((release) => release.at === 0).map((release) => release.token)).size;
  const unfunded = boundaries.filter((step, at) => step.done && !namedAt.has(at + 1)).length;
  if (unfunded > unbound) {
    return {
      error:
        `${counted(unfunded, 'ticked phase boundary')} ${plural(unfunded, 'names', 'name')} no release of its own, ` +
        `and ${counted(unbound, 'release')} ${plural(unbound, 'does', 'do')} not say which boundary ${plural(unbound, 'it', 'they')} paid for. ` +
        'A release names the boundary it took, so a second approval of one boundary cannot pay for the next',
      errorKind: 'unreleased-checkpoint',
    };
  }

  const next = firstUnchecked(plan);
  return {
    total: plan.steps.length,
    remaining: plan.steps.filter((step) => !step.done).length,
    remainingSteps: plan.steps.filter((step) => !step.done && !isCheckpoint(step.title)).length,
    stepTitle: next ?? '',
    hasStep: Boolean(next),
    atCheckpoint: isCheckpoint(next),
    criteria: criteriaOf(body),
    releasedRef: releaseRef(releaseOf(body) ?? {}) ?? '',
    requestedBy: seen.shape?.requestedBy ?? '',
  };
}

module.exports = { resolveRequest, nextStep, classifyTarget };
