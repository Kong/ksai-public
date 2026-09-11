const RECORD_ID = /^[0-9a-f]{32}$/;

/**
 * COMMANDS is every command this runner answers, copied from `.github/scripts/lib/select-arm.cjs`
 * rather than imported: the module ships beside this action.yml, so a caller has it wherever it has
 * the action, and a parity test holds the copy to the original.
 */
export const COMMANDS = Object.freeze([
  'review', 'implement', 'approve', 'fix', 'revise', 'unlock', 'stop', 'pause', 'resume', 'help', 'test',
]);

const WHY_STATUS = Object.freeze({
  401: 'the control plane could not tell which run this is',
  404: 'the control plane holds no readable record for this run, or this repository is not enrolled with it',
  503: 'the control plane could not reach its records',
});

const unread = (why) => ({ read: false, command: '', why });

/**
 * bare reports whether an endpoint is an https URL with a host and nothing a request would carry
 * past its path. The token goes out in a header, so a query, a fragment or credentials would put the
 * read somewhere other than the control plane: a bare `https://` resolves `/run` as a host, and a
 * query string swallows the path the read appends.
 *
 * @param {string} endpoint
 */
function bare(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
}

/**
 * readRecord reads what the control plane decided for this run, and answers unread - with the reason
 * - for anything it cannot use, so the run carries on from its dispatch inputs.
 *
 * Every refusal is decided before the token is minted where it can be, so a malformed endpoint or id
 * spends no mint and sends nothing. The id is refused unless it is the shape the control plane mints,
 * because it goes into a URL path and a composed one would address something else. A command is
 * passed on only when this runner answers it, which is also what stops a value carrying a newline
 * from writing a second output.
 *
 * @param {{
 *   endpoint?: string,
 *   recordId?: string,
 *   audience?: string,
 *   env?: Record<string, string | undefined>,
 *   mint: (audience: string) => Promise<string>,
 *   secret?: (token: string) => void,
 *   fetch?: typeof globalThis.fetch,
 *   timeout?: number,
 * }} asked
 */
export async function readRecord({
  endpoint = '',
  recordId = '',
  audience = 'ksai-cp',
  env = process.env,
  mint,
  secret = () => {},
  fetch = globalThis.fetch,
  timeout = 10000,
}) {
  if (endpoint === '' || recordId === '') return unread('');
  if (!bare(endpoint)) return unread('the control plane endpoint is not a bare https URL');
  if (!RECORD_ID.test(recordId)) return unread('the record id is not one the control plane mints');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return unread('this job holds no id-token: write, so it cannot say which run it is');
  }

  let token = '';
  try {
    token = await mint(audience);
  } catch {
    return unread('the OIDC token could not be minted');
  }
  if (typeof token !== 'string' || token === '') {
    return unread('the OIDC token endpoint answered with no token');
  }
  secret(token);

  let served = /** @type {unknown} */ (null);
  try {
    const answer = await fetch(`${endpoint.replace(/\/+$/, '')}/run/${recordId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!answer.ok) {
      return unread(WHY_STATUS[/** @type {401|404|503} */ (answer.status)] ?? `the control plane answered ${answer.status}`);
    }
    served = await answer.json();
  } catch {
    return unread('the control plane could not be reached');
  }

  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    return unread('the control plane answered something other than a record');
  }

  const command = /** @type {Record<string, unknown>} */ (served).command;
  if (command === undefined) return { read: true, command: '', why: '' };
  if (typeof command !== 'string' || !COMMANDS.includes(command)) {
    return unread('the record names a command this runner does not answer');
  }
  return { read: true, command, why: '' };
}
