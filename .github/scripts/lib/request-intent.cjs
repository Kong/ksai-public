'use strict';

const bare = (fields) => Object.freeze(Object.assign(Object.create(null), fields));

const RECEIPTS = bare({
  review: bare({
    pull: 'review it',
    thread: 'review the pull request, focused on it',
  }),
  implement: bare({ issue: 'plan and implement it' }),
  approve: bare({ review: 'release the approved implementation plan' }),
  fix: bare({
    issue: 'plan and implement it',
    pull: 'do the work it asks for on this branch',
    thread: 'address it',
    review: 'address the feedback in it',
  }),
  revise: bare({
    pull: 'revise the implementation plan to answer the review feedback',
    thread: 'revise the implementation plan to answer it',
    review: 'revise the implementation plan to answer it',
  }),
  unlock: bare({ thread: 'resolve it and make the requested change' }),
  resume: bare({ pull: 'continue the paused implementation plan' }),
  test: bare({ pull: 'test it against its acceptance criteria' }),
});

const WHERE = bare({
  issue: 'this issue',
  pull: 'this pull request',
  thread: 'this review thread',
  review: 'this submitted review',
});

const EXPLICIT_SOURCE = 'explicit';

const ASSIGNED_SOURCE = 'assigned';

const LABEL_SOURCE = 'label';

const labelNamed = (label) => {
  const shown = String(label ?? '').replaceAll('`', "'").trim();
  return shown === '' ? 'a label' : `the \`${shown}\` label`;
};

const READ = bare({
  [EXPLICIT_SOURCE]: (where) => `Read your comment on ${where} as a request to`,
  classifier: (where) => `Read your comment on ${where}, which named no command, as a request to`,
  context: (where) => `Read ${where} as a request to`,
  assigned: (where) => `Assigned as a reviewer on ${where}, to`,
  continuation: (where) => `Carried on from the run before this one on ${where}, to`,
  [LABEL_SOURCE]: (where, { label = '' } = {}) => `Asked for by ${labelNamed(label)} on ${where}, to`,
});

const SOURCES = Object.freeze(Object.keys(READ));

function receiptOf(command, surface, source = 'context', detail = {}) {
  const bySurface = RECEIPTS[String(command ?? '')];
  const namedSurface = String(surface ?? '');
  const receipt = bySurface?.[namedSurface] ?? (namedSurface === 'review' ? bySurface?.pull : undefined);
  if (typeof receipt !== 'string') return '';
  const where = WHERE[namedSurface] ?? WHERE.pull;
  const read = READ[String(source ?? '')] ?? READ.context;
  return `${read(where, detail)} ${receipt}`;
}

function sourceOf({
  continuation = false,
  classified = false,
  named = false,
  commented = true,
  uncommented = 'context',
} = {}) {
  if (continuation === true || String(continuation) === 'true') return 'continuation';
  if (String(commented) !== 'true') return SOURCES.includes(uncommented) ? uncommented : 'context';
  if (classified === true) return 'classifier';
  return named === true ? EXPLICIT_SOURCE : 'context';
}

module.exports = { receiptOf, sourceOf, EXPLICIT_SOURCE, ASSIGNED_SOURCE, LABEL_SOURCE, SOURCES };
