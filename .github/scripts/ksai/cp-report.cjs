const { DEFAULT_TIMEOUT, answered, mask, reachedFor } = require('../lib/control-plane.cjs');

const API_VERSION = 'report/v1';
const EVIDENCE_VERSION = 'evidence/v1';

const NO_REPORT_HEADER = 'Ksai-No-Report';

const HELD = '/v1/run/report/held';
const SAID = '/v1/run/report';
const EVIDENCE = '/v1/run/evidence';
const JOB_LOG = '/v1/run/evidence/job-log';
const PULL = '/v1/run/pull';
const RUNS = '/v1/run/runs';

async function askControlPlane(route, body, { env, fetch, timeout, secret }, absent = false) {
  const reached = await reachedFor({ env, fetch, timeout, secret });
  if (reached.why) return reached;
  const said = await answered(fetch, `${reached.base}${route}`, {
    token: reached.token,
    body: JSON.stringify(body),
    timeout,
  });
  if (said.status === 404 && absent) {
    return said.headers?.get?.(NO_REPORT_HEADER) === '1'
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
  const said = await askControlPlane(route, body, options, true);
  if (said.answer === undefined) return said;
  if (typeof said.answer.body !== 'string') {
    return { why: 'the control plane answered with nothing this run could post' };
  }
  return { comment: Number(said.answer.comment ?? 0), body: said.answer.body };
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

module.exports = {
  heldReport,
  readEvidence,
  readJobLog,
  readPull,
  readRunStates,
  sayReport,
};
