const { DEFAULT_TIMEOUT, answered, mask, reachedFor } = require('./control-plane.cjs');

const API_VERSION = 'report/v1';
const EVIDENCE_VERSION = 'evidence/v1';

const NO_REPORT_HEADER = 'Ksai-No-Report';
const NO_CONVERSATION_HEADER = 'Ksai-No-Conversation';

const HELD = '/v1/run/report/held';
const HEAD = '/v1/run/report/head';
const SAID = '/v1/run/report';
const EVIDENCE = '/v1/run/evidence';
const JOB_LOG = '/v1/run/evidence/job-log';
const PULL = '/v1/run/pull';
const RUNS = '/v1/run/runs';
const CONVERSATION = '/v1/run/conversation';

async function askControlPlane(route, body, { env, fetch, timeout, secret }, absentHeader = '') {
  const reached = await reachedFor({ env, fetch, timeout, secret });
  if (reached.why) return reached;
  const said = await answered(fetch, `${reached.base}${route}`, {
    token: reached.token,
    body: JSON.stringify(body),
    timeout,
  });
  if (said.status === 404 && absentHeader) {
    return said.headers?.get?.(absentHeader) === '1'
      ? { none: true }
      : { why: 'the control plane answered 404 without saying this work has no report' };
  }
  if (said.why) return { why: said.why };
  const { answer } = said;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return { why: 'the control plane answered with nothing this run could read' };
  }
  return { answer };
}

function asked({ kind, request, number, where }) {
  return {
    api_version: API_VERSION,
    ...(number === undefined || number === null ? {} : { number: Number(number) }),
    ...(where ? { where } : {}),
    [kind]: request,
  };
}

async function reported(route, body, options) {
  const said = await askControlPlane(route, body, options, NO_REPORT_HEADER);
  if (said.answer === undefined) {
    return {
      why: 'why' in said ? String(said.why ?? '') : '',
      none: 'none' in said && said.none === true,
      comment: 0,
      body: '',
      state: undefined,
    };
  }
  if (typeof said.answer.body !== 'string') {
    return { why: 'the control plane answered with nothing this run could post', none: false,
      comment: 0, body: '', state: undefined };
  }
  if (said.answer.state !== undefined && (!said.answer.state ||
      typeof said.answer.state !== 'object' || Array.isArray(said.answer.state))) {
    return { why: 'the control plane answered with an invalid report state', none: false,
      comment: 0, body: '', state: undefined };
  }
  return {
    why: '',
    none: false,
    comment: Number(said.answer.comment ?? 0),
    body: said.answer.body,
    state: said.answer.state,
  };
}

/**
 * @param {string} route
 */
const reporting = (route) =>
  /**
   * @param {{
   *   kind?: string,
   *   request?: unknown,
   *   number?: number | string | null,
   *   where?: string,
   *   env?: Record<string, string | undefined>,
   *   fetch?: typeof globalThis.fetch,
   *   timeout?: number,
   *   secret?: (token: string) => void,
   * }} [asking]
   */
  ({ kind, request, number, where, env = process.env, fetch = globalThis.fetch,
    timeout = DEFAULT_TIMEOUT, secret = mask } = {}) =>
    reported(route, asked({ kind, request, number, where }), { env, fetch, timeout, secret });

const heldReport = reporting(HELD);

const sayReport = reporting(SAID);

const headReport = ({ number = 0, sha = '', env = process.env, fetch = globalThis.fetch,
  timeout = DEFAULT_TIMEOUT, secret = mask } = {}) =>
  reported(HEAD, { api_version: API_VERSION, number: Number(number), head: String(sha ?? '') },
    { env, fetch, timeout, secret });

/**
 * @param {string} route
 * @param {(asking: *) => Record<string, unknown>} names
 */
const reading = (route, names) =>
  /**
   * @param {*} [asking]
   */
  (asking = {}) => {
    const { env = process.env, fetch = globalThis.fetch, timeout = DEFAULT_TIMEOUT, secret = mask } = asking;
    return askControlPlane(
      route,
      { api_version: EVIDENCE_VERSION, ...names(asking) },
      { env, fetch, timeout, secret },
    );
  };

const readEvidence = reading(EVIDENCE, ({ sha, pages }) => ({
  sha: String(sha ?? ''),
  ...(pages > 0 ? { pages } : {}),
}));

const readJobLog = reading(JOB_LOG, ({ jobId }) => ({ job_id: Number(jobId) }));

const readPull = reading(PULL, ({ number }) => ({ number: Number(number) }));

const readRunStates = reading(RUNS, ({ runs }) => ({ runs: runs.map(Number) }));

async function readConversation({ number = 0, env = process.env, fetch = globalThis.fetch,
  timeout = DEFAULT_TIMEOUT, secret = mask } = {}) {
  const said = await askControlPlane(CONVERSATION,
    { api_version: 'conversation/v1', number: Number(number) },
    { env, fetch, timeout, secret }, NO_CONVERSATION_HEADER);
  if (said.none) return { none: true };
  if (said.why) return { why: said.why };
  if (said.answer?.number !== Number(number) ||
      !said.answer.plan || typeof said.answer.plan !== 'object' || Array.isArray(said.answer.plan)) {
    return { why: 'the control plane answered with invalid plan state' };
  }
  return { state: said.answer };
}

module.exports = {
  headReport,
  heldReport,
  readEvidence,
  readJobLog,
  readPull,
  readRunStates,
  readConversation,
  sayReport,
};
