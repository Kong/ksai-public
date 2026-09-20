'use strict';

const { neutralCut } = require('../lib/prompt-text.cjs');
const { finalResult } = require('./classify.cjs');
const { wasEdited } = require('./approval.cjs');
const { isOwnLogin } = require('./threads.cjs');
const { SINKS, renderRequest } = require('../lib/render-request.cjs');

const VERDICTS = Object.freeze(['agree', 'disagree', 'unclear']);

const UNCLEAR = 'unclear';

const DISAGREE = 'disagree';

const MAX_THREADS = 10;

const MAX_COMMENTS = 8;

const MAX_COMMENT_CHARS = 600;

const OPEN = '--- THREAD';

const cut = (value) => neutralCut(value, MAX_COMMENT_CHARS);

const SPEAKERS = Object.freeze({ bot: 'the bot', reviewer: 'the reviewer', person: 'a person' });

const speakerOf = (comment, botLogin, isRoot) => (isOwnLogin(comment?.login, botLogin) ? 'bot' : isRoot ? 'reviewer' : 'person');

function transcriptMessages(thread, { botLogin = null } = {}) {
  const all = (thread?.comments ?? [])
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => !wasEdited(comment));
  return all.slice(Math.max(0, all.length - MAX_COMMENTS)).map(({ comment, index }) => ({ speaker: speakerOf(comment, botLogin, index === 0), body: cut(comment?.body) }));
}

/** threadTranscript renders one thread as the few lines a reader needs to tell agreement from pushback. */
function threadTranscript(thread, { botLogin = null } = {}) {
  return transcriptMessages(thread, { botLogin })
    .map(({ speaker, body }) => `[${SPEAKERS[speaker]}] ${body}`)
    .join('\n');
}

function disputeRenderRequest(threads, { botLogin = null, model = '' } = {}) {
  return renderRequest({
    promptId: 'runtime.dispute',
    sink: SINKS.classifier,
    model: String(model ?? ''),
    inputs: [
      {
        name: 'transcripts',
        value: (threads ?? []).slice(0, MAX_THREADS).map((thread, index) => ({ number: index + 1, messages: transcriptMessages(thread, { botLogin }) })),
      },
    ],
  });
}

/** renderDisputePrompt asks a cheap model whether each thread's last word accepts the answer it got. */
function renderDisputePrompt(threads, { botLogin = null } = {}) {
  const shown = (threads ?? []).slice(0, MAX_THREADS);
  const lines = [
    `Answer with one line per thread below, in order, each line exactly "<number> <word>", where <word> is one`,
    `of: ${VERDICTS.join(', ')}. Nothing else - no punctuation, no explanation, no quotes.`,
    '',
    'Each thread below is a conversation on a pull request. A bot answered a review comment, and somebody wrote',
    'back after that answer. Say whether what they wrote accepts the answer or pushes back on it.',
    '',
    'Rules:',
    '- Judge the words written, never whether the code change was right.',
    '- Accepting, thanking, or saying it looks good is agree.',
    '- Rejecting it, asking for something different, or asking a question about it is disagree.',
    '- Anything you cannot tell from the words is unclear.',
    `- Answer ${UNCLEAR} rather than guessing.`,
    '',
  ];
  shown.forEach((thread, index) => {
    lines.push(`${OPEN} ${index + 1} ---`, threadTranscript(thread, { botLogin }), `${OPEN} ${index + 1} END ---`, '');
  });
  return lines.join('\n');
}

/** disputeVerdicts answers one verdict per thread asked about, in order, unclear wherever it cannot tell. */
function disputeVerdicts(raw, count) {
  const said = String(raw ?? '').toLowerCase();
  const answers = new Map();
  for (const [, number, word] of said.matchAll(/(?:^|\n)\s*(\d+)[).:\s-]+([a-z]+)/g)) {
    if (!answers.has(number) && VERDICTS.includes(word)) answers.set(number, word);
  }
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) =>
    answers.get(String(index + 1)) ?? UNCLEAR,
  );
}

/** disputeFromExecution reads the verdicts out of a classifier run's execution log. */
function disputeFromExecution(raw, count) {
  const { result } = finalResult(raw);
  return disputeVerdicts(typeof result?.result === 'string' ? result.result : '', count);
}


module.exports = {
  DISAGREE,
  MAX_THREADS,
  UNCLEAR,
  VERDICTS,
  disputeFromExecution,
  disputeRenderRequest,
  disputeVerdicts,
  renderDisputePrompt,
  threadTranscript,
};
