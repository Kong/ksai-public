'use strict';

const { openPlanThreads } = require('./revise.cjs');
const { ANSWERED, threadState } = require('./threads.cjs');
const { marked } = require('./marker.cjs');
const { scrub } = require('./plan.cjs');
const { counted } = require('../lib/text.cjs');
const { renderedNotice } = require('../lib/cp-render.cjs');

const OVERRIDE_KIND = 'thread-overridden';

const RESOLVE = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const ANSWER = Object.freeze(
  Object.assign(Object.create(null), {
    waiting:
      'This plan was released while this thread was still waiting for an answer, so it is closed here. ' +
      'The release did not read it into the plan document. If the point still stands, say so and it will be ' +
      'picked up against the code.',
    answered:
      'This plan was released with this thread still open, so it is closed here. The answer above is ' +
      'the one the release went ahead on, and no further pass will revisit the plan document. If the point ' +
      'still stands, say so and it will be picked up against the code.',
  }),
);

function renderOverride({ answered = false, triggerPhrase = null, prNumber = null, command = null, ask = null } = {}) {
  return marked(scrub(ANSWER[answered === true ? 'answered' : 'waiting'], { triggerPhrase }), {
    kind: OVERRIDE_KIND,
    flow: 'implement',
    command,
    pr: prNumber,
    triggerPhrase,
    ask,
  });
}

function renderedOverride({ answered, triggerPhrase, prNumber, command, ask, env, fetch }) {
  return renderedNotice({
    notice: { kind: 'thread_overridden', answered },
    fields: { COMMAND: command, PR_NUMBER: prNumber, TRIGGER: triggerPhrase, KSAI_ASK: ask },
    local: () => ({ body: renderOverride({ answered, triggerPhrase, prNumber, command, ask }) }),
    what: 'the answer to this thread',
    env,
    fetch,
  });
}

async function resolveOverriddenThreads({
  github = null,
  core = null,
  owner = null,
  repo = null,
  prNumber = null,
  planFile = null,
  botLogin = null,
  triggerPhrase = null,
  command = null,
  ask = null,
  env = process.env,
  fetch = globalThis.fetch,
} = {}) {
  const open = await openPlanThreads({ github, owner, repo, prNumber, planFile, botLogin, includeAnswered: true });
  if (open.error) return { answered: 0, resolved: 0, notices: [open.error] };

  const override = { triggerPhrase, prNumber, command, ask, env, fetch };
  const said = {};
  const reply = (answeredThread) => {
    said[answeredThread] ??= renderedOverride({ ...override, answered: answeredThread });
    return said[answeredThread];
  };
  const notices = [];
  let answered = 0;
  let resolved = 0;

  for (const thread of open.threads) {
    const root = Number(thread?.rootCommentId);
    if (Number.isInteger(root) && root > 0) {
      try {
        await github.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: Number(prNumber),
          comment_id: root,
          body: await reply(threadState(thread, { botLogin }) === ANSWERED),
        });
        answered += 1;
      } catch (error) {
        notices.push(`thread ${root} could not be answered: ${error?.message ?? error}`);
      }
    }

    const id = String(thread?.id ?? '');
    if (id === '') {
      notices.push(`a thread on ${String(planFile)} carries no id, so it could not be resolved`);
      continue;
    }
    try {
      await github.graphql(RESOLVE, { threadId: id });
      resolved += 1;
    } catch (error) {
      notices.push(`thread ${id} could not be resolved: ${error?.message ?? error}`);
    }
  }

  core?.info?.(
    `${answered} of ${counted(open.threads.length, 'overridden thread')} answered and ${resolved} resolved on ` +
      `${String(planFile)}.`,
  );
  return { answered, resolved, notices };
}

module.exports = { resolveOverriddenThreads, renderOverride, OVERRIDE_KIND, RESOLVE };
