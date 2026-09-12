const fs = require('node:fs');
const { afterTrigger } = require('../lib/text.cjs');
const {
  COMMANDS,
  commandEnabled,
  defaultCommandFor,
  HELP_COMMAND,
  ownerOf,
  deliveredCommand,
  ownsCommand,
  parseDisabledCommands,
  writeAccessNames,
  parseOptions,
  commandFitsSurface,
  resolveWriteAccess,
  commandAuthorized,
  namedCommand,
  undecidedWriteAccess,
} = require('../lib/select-arm.cjs');
const {
  CLARIFY_VERDICT,
  NO_VERDICT,
  NUDGE_VERDICT,
  classifierModel,
  renderClassifierSpend,
  renderCommandClassifierPrompt,
  surfaceForComment,
  verdictFromExecution,
  verdictOf,
} = require('./classify.cjs');
const {
  AUTHZ_LOGIN_SHAPE,
  COMMENT_EVENT,
  REVIEW_COMMENT_EVENT,
  REVIEW_EVENT,
  asCommentEvent,
  commentReaders,
  resolveDispatchedComment,
  resolveOnIssue,
  threadRootOf,
} = require('./context.cjs');
const { labelReaders, readLabelBasis, readReviewBasis, recordBasis } = require('./label-basis.cjs');
const { classifyTarget } = require('./dispatch.cjs');
const { bareMode, ownPull, ownSurface } = require('./bare.cjs');
const loadKsaiConfig = require('./config.cjs');

function unquoted(body) {
  return String(body ?? '')
    .split('\n')
    .filter((line) => !/^\s{0,3}>/.test(line))
    .join('\n');
}

function resolveSurface({ eventName, payload }) {
  return String(eventName ?? '') === COMMENT_EVENT && !payload?.issue?.pull_request;
}

function resolveReview({ eventName }) {
  return String(eventName ?? '') === REVIEW_EVENT;
}

function decide({ command, spelled, onIssue, onReview = null, disabledCommands }) {
  if (command === HELP_COMMAND) return { review: false, implement: false, help: true, command };
  const enabled = commandEnabled(command, { flow: ownerOf(command), disabledCommands });
  const fits = commandFitsSurface(command, { onIssue, onReview });
  return {
    command,
    review: ownsCommand('reviewer', command) && fits && enabled,
    test: ownsCommand('tester', command) && fits && enabled,
    implement:
      ownsCommand('implement', command) ||
      ownerOf(command) === null ||
      !fits ||
      !enabled ||
      (onIssue && spelled === null),
  };
}

function routeVerdict({ verdict, onIssue, disabledCommands }) {
  return decide({ command: verdict, spelled: null, onIssue, disabledCommands });
}

async function routeCommand({ eventName, onIssue, threadRootId, onReview, reviewState, body, trigger, disabledCommands, loadConfig }) {
  const here = defaultCommandFor(onIssue, threadRootId, onReview, reviewState);

  if (String(onReview) === 'true') {
    return decide({ command: here, spelled: here, onIssue, onReview, disabledCommands });
  }

  const fallbackIsReviewers = !onIssue && ownsCommand('reviewer', here);
  const fallbackEnabled = () => commandEnabled(here, { flow: ownerOf(here), disabledCommands });

  const both = () => ({ review: fallbackIsReviewers && fallbackEnabled(), implement: true, test: false });

  if (parseDisabledCommands(disabledCommands).some((command) => !COMMANDS.includes(command))) {
    return { review: fallbackIsReviewers, implement: true, test: false };
  }

  if (eventName === 'workflow_dispatch') {
    return { review: fallbackEnabled(), implement: false, test: false, command: here };
  }

  const request = afterTrigger(body, trigger);
  if (request === null) return { review: false, implement: false, test: false };

  const config = await loadConfig();
  const parsed = parseOptions(request, {
    commandAliases: config.error ? undefined : config.aliases,
    defaultCommand: here,
  });

  if (parsed.error) return both();
  if (config.error && parsed.command === null) return both();
  if (parsed.command === null && String(parsed.prompt ?? '').trim() !== '') return both();
  if (deliveredCommand(parsed.command)) return { review: false, implement: false, command: parsed.command };

  return decide({ command: parsed.command ?? here, spelled: parsed.command, onIssue, disabledCommands });
}

async function bareTarget({ github, core, context, payload, eventName, env, onIssue, threadRootId, body, readConfig, opened }) {
  const inThread = String(threadRootId ?? '').trim() !== '';
  if (eventName !== (inThread ? REVIEW_COMMENT_EVENT : COMMENT_EVENT)) return false;
  if (onIssue) return false;
  if (String(body).trim() === '') return false;
  const asked = bareMode({ input: env.BARE_COMMENTS });
  if (asked.error) {
    core.setFailed(asked.error);
    return false;
  }
  if (asked.mode === 'off') return false;
  const byWrite = String(env.CODEOWNER ?? '') !== 'true' && String(env.WRITE_ACCESS ?? '') === 'true';
  if (byWrite && (await opened()) === '') return false;
  const mine = await ownSurface({
    github,
    core,
    owner: context.repo.owner,
    repo: context.repo.repo,
    botLogin: env.BOT_LOGIN,
    rootId: threadRootId,
    prNumber: payload?.issue?.number,
  });
  if (!mine) return false;
  const config = await readConfig();
  if (config.error) return false;
  const narrowed = bareMode({ input: env.BARE_COMMENTS, fromFile: config.bareComments });
  return !narrowed.error && narrowed.mode === 'auto';
}

async function resolvedWriteCommands({ core, env, readConfig }) {
  const asked = String(env.WRITE_ACCESS_COMMANDS ?? '').trim();
  if (asked === '') return '';
  const config = await readConfig();
  if (config.error) {
    core.warning(`${config.error}; no command is open to write access on this run.`);
    return '';
  }
  const opened = resolveWriteAccess({ input: asked, fromFile: config.writeAccess, commandAliases: config.aliases });
  if (opened.error) {
    core.warning(`${opened.error}; no command is open to write access on this run.`);
    return '';
  }
  return opened.commands.join(' ');
}

async function resolveRequester({ github, context, env }) {
  const basis = recordBasis(env);
  if (basis?.error) return { login: '', failure: basis.error };
  if (basis) {
    const read = await readLabelBasis({ basis, ...labelReaders({ github, context }) });
    return read.error ? { login: '', failure: read.error } : { login: read.login, failure: null };
  }

  const held = await resolveDispatchedComment({
    eventName: context.eventName,
    commentId: env.COMMENT_ID,
    commentKind: env.COMMENT_KIND,
    issueNumber: env.PR_NUMBER,
    actor: env.TRIGGERING_ACTOR,
    appSlug: env.APP_SLUG,
    ...commentReaders({ github, context }),
  });
  if (held.error) return { login: '', failure: held.error };
  if (!held.held) return { login: String(env.REQUESTER ?? ''), failure: null };

  const login = String(held.comment?.user?.login ?? '');
  if (!AUTHZ_LOGIN_SHAPE.test(login)) {
    return {
      login: '',
      failure:
        `comment #${env.COMMENT_ID} names no author this gate can authorize (got \`${login}\`), so nothing ran. ` +
        'A run is authorized against the account that wrote the comment, and an unreadable one is refused ' +
        'rather than falling back to the login the dispatch named.',
    };
  }
  return { login, failure: null };
}

async function routeLabelled({ github, core, context, env, basis, asker = 'A label' }) {
  const decision = decide({ command: basis.command, spelled: basis.command, onIssue: false, disabledCommands: env.DISABLED_COMMANDS });
  let pending;
  const readConfig = () => {
    pending ??= loadKsaiConfig({ github, core, owner: context.repo.owner, repo: context.repo.repo });
    return pending;
  };
  core.setOutput('review', decision.review ? 'true' : 'false');
  core.setOutput('implement', decision.implement ? 'true' : 'false');
  core.setOutput('test', decision.test ? 'true' : 'false');
  core.setOutput('help', decision.help ? 'true' : 'false');
  core.setOutput('command', COMMANDS.includes(decision.command) ? decision.command : '');
  core.setOutput('classify', 'false');
  core.setOutput('own_pull', 'false');
  core.setOutput('thread_root_id', '');
  core.setOutput('on_issue', 'false');
  core.setOutput('issue_number', String(basis.pr));
  core.setOutput('requested', 'true');
  core.setOutput('write_access_commands', await resolvedWriteCommands({ core, env, readConfig }));
  core.info(`${asker} on pull request #${basis.pr} asked for \`${basis.command}\` at ${basis.headSha}.`);
  return decision;
}

async function route({ github, core, context, env }) {
  const basis = recordBasis(env);
  if (basis?.error) {
    core.setFailed(basis.error);
    return null;
  }
  if (basis) return routeLabelled({ github, core, context, env, basis });

  const readers = commentReaders({ github, context });
  const dispatched = await resolveDispatchedComment({
    eventName: context.eventName,
    commentId: env.COMMENT_ID,
    commentKind: env.COMMENT_KIND,
    issueNumber: env.PR_NUMBER,
    actor: env.TRIGGERING_ACTOR,
    appSlug: env.APP_SLUG,
    ...readers,
  });
  if (dispatched.error) {
    core.setFailed(dispatched.error);
    return null;
  }

  let carried = null;
  if (dispatched.held) {
    const surface = dispatched.review
      ? { onIssue: false }
      : await resolveOnIssue({
          eventName: context.eventName,
          commentBody: String(dispatched.comment?.body ?? ''),
          issueNumber: String(dispatched.number),
          pullsGet: (pull_number) => github.rest.pulls.get({ ...context.repo, pull_number }),
        });
    if (surface.error) {
      core.setFailed(surface.error);
      return null;
    }
    carried = asCommentEvent({ dispatched, onIssue: surface.onIssue, payload: context.payload });
  }

  const eventName = carried?.eventName ?? context.eventName;
  const payload = carried?.payload ?? context.payload;

  const onIssue = resolveSurface({ eventName, payload });
  const onReview = resolveReview({ eventName });
  const reviewState = String(payload?.review?.state ?? '').trim().toLowerCase();
  const threadRootId = threadRootOf({ eventName, payload });
  const body = payload?.comment?.body ?? '';
  const disabledCommands = env.DISABLED_COMMANDS;

  let pending;
  const readConfig = () => {
    pending ??= loadKsaiConfig({ github, core, owner: context.repo.owner, repo: context.repo.repo });
    return pending;
  };

  let openedPending;
  const opened = () => (openedPending ??= resolvedWriteCommands({ core, env, readConfig }));

  const ownReview =
    onReview &&
    (await ownPull({
      github,
      core,
      owner: context.repo.owner,
      repo: context.repo.repo,
      prNumber: payload?.pull_request?.number,
      botLogin: env.BOT_LOGIN,
    }));
  const reviewed =
    onReview && !ownReview && reviewState !== 'approved' && payload?.review?.user?.type !== 'Bot'
      ? await readReviewBasis({
          pr: payload?.pull_request?.number,
          reviewCommit: payload?.review?.commit_id,
          reviewer: payload?.review?.user?.login,
          ...labelReaders({ github, context }),
        })
      : null;
  if (reviewed?.error) {
    core.setFailed(reviewed.error);
    return null;
  }
  if (reviewed) return routeLabelled({ github, core, context, env, basis: reviewed, asker: 'A review' });

  const decision = await routeCommand({
    eventName,
    onIssue,
    threadRootId,
    onReview,
    reviewState,
    body,
    trigger: env.TRIGGER,
    disabledCommands,
    loadConfig: readConfig,
  });

  core.setOutput('review', decision.review ? 'true' : 'false');
  core.setOutput('implement', decision.implement ? 'true' : 'false');
  core.setOutput('test', decision.test ? 'true' : 'false');
  core.setOutput('help', decision.help ? 'true' : 'false');
  core.setOutput('command', COMMANDS.includes(decision.command) ? decision.command : '');
  core.setOutput('classify', 'false');
  core.setOutput('own_pull', 'false');
  core.setOutput('thread_root_id', threadRootId ?? '');
  core.setOutput('on_issue', onIssue ? 'true' : 'false');
  core.setOutput(
    'issue_number',
    String(dispatched.held ? dispatched.number : (payload?.issue?.number ?? payload?.pull_request?.number ?? '')),
  );

  const continued = eventName === 'workflow_dispatch';
  const request = continued ? null : afterTrigger(body, env.TRIGGER);
  const asked = continued ? null : afterTrigger(unquoted(body), env.TRIGGER);
  const requested = ownReview || continued || asked !== null;
  core.setOutput('requested', requested ? 'true' : 'false');
  const bare =
    request === null &&
    (await bareTarget({ github, core, context, payload, eventName, env, onIssue, threadRootId, body, readConfig, opened }));
  core.setOutput('write_access_commands', requested || bare ? await opened() : '');
  if (bare) {
    core.setOutput('own_pull', 'true');
    core.info(
      threadRootId
        ? 'This reply names no command and sits in a thread this flow\'s review opened, so it is classified.'
        : 'This comment names no command and sits on a pull request this flow opened, so it is classified.',
    );
  }
  if (request === null && !bare) return decision;

  if (String(env.LEGACY_ALLOWED_COMMANDS ?? '').trim() !== '') {
    core.info('The `allowed_commands` input was replaced and still carries a value; classifying nothing.');
    return decision;
  }

  if (!String(env.PROMPT_FILE ?? '').trim()) {
    if (String(env.CLASSIFIER_MODEL ?? '').trim()) {
      core.warning(
        'CLASSIFIER_MODEL names an arm but PROMPT_FILE names nowhere to write the prompt to, so this gate ' +
          'classified nothing and this run routes as it would have anyway.',
      );
    }
    return decision;
  }

  const target = await classifyTarget({
    github,
    core,
    owner: context.repo.owner,
    repo: context.repo.repo,
    prompt: bare ? body : request,
    disabledCommands,
    onIssue,
    threadRootId,
    bare,
    readConfig,
  });
  if (!target.classify) return decision;

  const answerable =
    String(env.OWNERS ?? '') !== 'absent' || (String(env.WRITE_ACCESS ?? '') === 'true' && (await opened()) !== '');
  if (!answerable) {
    core.info('Nobody can be authorized on this repository, so the comment is not classified.');
    return decision;
  }

  const arm = classifierModel(env.CLASSIFIER_MODEL);
  if (arm.error) {
    core.warning(`${arm.error}; nothing was classified and this run routes as it would have anyway.`);
    return decision;
  }

  fs.writeFileSync(
    env.PROMPT_FILE,
    renderCommandClassifierPrompt({
      comment: target.comment,
      surface: surfaceForComment({ onOwnPull: bare, onIssue, threadRootId }),
      disabledCommands,
    }),
  );
  core.setOutput('classify_model', arm.model);
  core.setOutput('classify_file', env.PROMPT_FILE);
  core.setOutput('classify', 'true');
  core.info(`Classifying the comment on ${arm.model}.`);
  return decision;
}

function settle({ core, env, readFile = (at) => fs.readFileSync(at, 'utf8') }) {
  const onIssue = env.ON_ISSUE === 'true';
  const onOwnPull = env.ON_OWN_PULL === 'true';
  const surface = surfaceForComment({ onOwnPull, onIssue, threadRootId: env.THREAD_ROOT_ID });
  const disabledCommands = env.DISABLED_COMMANDS;
  const fallback = { review: env.REVIEW === 'true', implement: env.IMPLEMENT === 'true', test: env.TEST === 'true' };
  const needsClarification = surface === 'pull';
  const clarify = () => {
    core.setOutput('verdict', CLARIFY_VERDICT);
    return publish({ review: false, implement: true, test: false });
  };

  const publish = (answer) => {
    core.setOutput('review', answer.review ? 'true' : 'false');
    core.setOutput('implement', answer.implement ? 'true' : 'false');
    core.setOutput('test', answer.test ? 'true' : 'false');
    return answer;
  };

  core.setOutput('verdict', '');
  core.setOutput('cost', '');
  core.setOutput('input_tokens', '');
  core.setOutput('output_tokens', '');

  let raw = '';
  try {
    raw = env.EXECUTION_FILE ? readFile(env.EXECUTION_FILE) : '';
  } catch (error) {
    core.warning(`the classifier log could not be read (${error.message}), so this run routes as it would have anyway.`);
    return publish(fallback);
  }

  const out = verdictFromExecution(raw, surface);
  const spend = out.spend;
  const { cost, said: spent } = renderClassifierSpend(env.CLASSIFY_MODEL, spend);
  core.info(spent);
  core.setOutput('cost', cost);
  core.setOutput('input_tokens', String(spend.inputTokens ?? ''));
  core.setOutput('output_tokens', String(spend.outputTokens ?? ''));
  core.setOutput('turns', String(spend.turns ?? ''));
  core.setOutput('duration', String(spend.durationS ?? ''));

  if (!out.available) {
    core.warning(`${out.reason}, so this run routes as it would have anyway.`);
    return publish(fallback);
  }

  const verdict = verdictOf(out.verdict, disabledCommands, surface);
  core.setOutput('verdict', verdict);
  if (verdict === NO_VERDICT) {
    if (needsClarification) {
      core.info('The comment does not name one available result, so this run asks what was intended and changes nothing.');
      return clarify();
    }
    core.info(
      onOwnPull
        ? 'The comment asks this flow for nothing, so nothing is published and nothing runs.'
        : 'The comment reads as no other flow\'s work, so the command it already resolved to decides.',
    );
    return publish(fallback);
  }
  if (verdict === NUDGE_VERDICT) {
    core.info('The comment reads as consent, which is named rather than classified; the implement flow says so.');
    return publish({ review: false, implement: true });
  }
  if (onOwnPull && ownerOf(verdict) !== 'implement') {
    core.info(`The comment reads as \`${verdict}\`, which no bare comment starts; the implement flow asks for the command.`);
    return publish({ review: false, implement: true, test: false });
  }

  core.info(`The comment reads as \`${verdict}\`.`);
  return publish(routeVerdict({ verdict, onIssue, disabledCommands }));
}

function settleAuthorization({ core, env }) {
  const command = namedCommand(env.VERDICT) || namedCommand(env.COMMAND);
  const answer = commandAuthorized(command, {
    codeowner: env.CODEOWNER,
    write: env.WRITE_ACCESS,
    writeAccessCommands: writeAccessNames(env.WRITE_ACCESS_COMMANDS),
  });

  const refusal = answer.undecided ? undecidedWriteAccess(command) : '';
  core.setOutput('command', command);
  core.setOutput('bar', answer.bar);
  core.setOutput('undecided', answer.undecided ? 'true' : 'false');
  core.setOutput('unreadable_write', refusal);
  core.setOutput('authorized', answer.read ? (answer.authorized ? 'true' : 'false') : '');

  if (refusal !== '') {
    core.warning(refusal);
    return answer;
  }
  core.info(
    answer.read
      ? `\`${command || '(none named)'}\` holds the ${answer.bar} bar here, and this request is ${answer.authorized ? '' : 'not '}authorized.`
      : 'no CODEOWNERS answer was read, so no bar was applied.',
  );
  return answer;
}

module.exports = {
  resolveRequester,
  route,
  routeCommand,
  routeVerdict,
  resolveSurface,
  resolveReview,
  settle,
  resolvedWriteCommands,
  settleAuthorization,
};
