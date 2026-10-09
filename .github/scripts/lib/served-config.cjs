const { DEFAULT_TIMEOUT, gotFrom, mask } = require('./control-plane.cjs');

const ROUTE = '/v1/run/config';
const AUTOFIX_ROUTE = '/v1/run/autofix/paths';
const CONFIG_FILE = '.ksai/ksai.toml';
const KSAI_ROOT = '.ksai/';
const COMMIT = /^[0-9a-f]{40}$/;
const CONTROL = /\p{Cc}/u;

const isKsaiPath = (path) =>
  typeof path === 'string' &&
  path.startsWith(KSAI_ROOT) &&
  !CONTROL.test(path) &&
  path.slice(KSAI_ROOT.length).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const isRepoPath = (path) =>
  typeof path === 'string' &&
  path !== '' &&
  !CONTROL.test(path) &&
  !path.includes('\\') &&
  path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git');

const isTable = (value) => value === null || (typeof value === 'object' && !Array.isArray(value));
const isAnswer = (value) => value !== null && isTable(value);

function servedFor(answer, scope) {
  if (!isAnswer(answer)) return { error: 'the control plane answered with something other than a JSON object' };
  if (answer.scope !== scope) return { error: `the control plane answered for ${JSON.stringify(answer.scope)}, not ${scope}` };
  if (answer.source !== '' && answer.source !== CONFIG_FILE) {
    return { error: `the control plane named ${JSON.stringify(answer.source)} as the config file` };
  }
  if (typeof answer.problem !== 'string') return { error: 'the control plane answered with no problem field' };
  if (typeof answer.checksum !== 'string') return { error: 'the control plane answered with no checksum' };
  const { guards = null, review = null, test = null } = answer;
  if (![guards, review, test].every((table) => isTable(table))) {
    return { error: 'the control plane answered with a table that is not a JSON object' };
  }
  return { served: { scope, source: answer.source, problem: answer.problem, checksum: answer.checksum, guards, review, test } };
}

async function readServedConfig({ env = process.env, fetchImpl = fetch, scope, ref = '', timeout = DEFAULT_TIMEOUT, secret = mask }) {
  if (ref !== '' && !COMMIT.test(ref)) return { error: `${JSON.stringify(ref)} is not a full commit sha` };
  const route = ref === '' ? ROUTE : `${ROUTE}?ref=${ref}`;
  const got = await gotFrom({ env, fetch: fetchImpl, route, timeout, secret });
  return got.why ? { error: got.why } : servedFor(got.answer, scope);
}

async function readServedAutofix({ env = process.env, fetchImpl = fetch, scope, timeout = DEFAULT_TIMEOUT, secret = mask }) {
  const got = await gotFrom({ env, fetch: fetchImpl, route: AUTOFIX_ROUTE, timeout, secret });
  if (got.why) return { error: got.why };
  if (!isAnswer(got.answer)) return { error: 'the control plane answered with something other than a JSON object' };
  if (got.answer.scope !== scope) return { error: `the control plane answered for ${JSON.stringify(got.answer.scope)}, not ${scope}` };
  const { policy = null } = got.answer;
  return isTable(policy) ? { policy } : { error: 'the control plane answered with a policy that is not a JSON object' };
}

async function readAutofixPolicy(reading) {
  const read = await readServedConfig(reading);
  if (read.error) return { error: read.error };
  if (read.served.source === '') return { served: null };
  if (read.served.problem !== '') return { error: `\`${read.served.source}\` ${read.served.problem}` };
  const got = await readServedAutofix(reading);
  return got.error ? { error: got.error } : { served: { policy: got.policy } };
}

module.exports = { AUTOFIX_ROUTE, KSAI_ROOT, ROUTE, isKsaiPath, isRepoPath, readAutofixPolicy, readServedConfig };
