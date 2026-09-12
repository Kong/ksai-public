const RECORD_ID = /^[0-9a-f]{32}$/;

/**
 * COMMANDS is every command this runner answers, copied from `.github/scripts/lib/select-arm.cjs`
 * rather than imported: the module ships beside this action.yml, so a caller has it wherever it has
 * the action, and a parity test holds the copy to the original.
 */
export const COMMANDS = Object.freeze([
  'review', 'implement', 'approve', 'fix', 'revise', 'unlock', 'stop', 'pause', 'resume', 'help', 'test',
]);

/**
 * TIMEOUT is how long one read may take, in milliseconds, before it counts as a failure that can pass.
 */
export const TIMEOUT = 10000;

/**
 * DELAYS is how long each retry of a failure that can pass waits, in milliseconds, unless the control
 * plane asks for longer, up to the longest of them.
 */
export const DELAYS = Object.freeze([2000, 4000, 8000, 15000, 30000, 30000]);

/**
 * BUDGET is the most time a run spends trying to read its record, in milliseconds, however long the
 * control plane asks it to wait: the reads and the waits between them stop there, which leaves the gate
 * job's five minutes room for the steps before the read. A control plane unreachable for longer fails
 * the run, which a person can start again; a run that carried on without its record cannot be taken
 * back.
 */
export const BUDGET = 150000;

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

export const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const REQUESTER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const GUIDANCE_MAX = 4096;

const WORK_ITEM_MAX = 16384;

const WHY_STATUS = Object.freeze({
  401: 'the control plane could not tell which run this is',
  404: 'the control plane holds no readable record for this run - another run may already have read it, it may have expired, or this repository may not be enrolled',
  503: 'the control plane could not reach its records',
});

const PR_SHAPE = /^[1-9][0-9]{0,9}$/;

const SHA_SHAPE = /^[0-9a-fA-F]{40}$/;

const LABEL_MAX = 50;

const hasControl = (text) => [...text].some((character) => {
  const point = character.codePointAt(0) ?? 0;
  return point < 32 || point === 127;
});

const text = (value) => (typeof value === 'string' ? value : '');

const stopped = (why) => new Error(`${why} - so this run starts nothing`);

const passing = (status) => status === 408 || status === 429 || status >= 500;

const rest = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const release = (answer) => Promise.resolve().then(() => answer.body?.cancel()).catch(() => {});

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
 * waitAsked reads a Retry-After the control plane gave in whole seconds, as milliseconds, or null.
 *
 * @param {{ headers?: { get(name: string): string | null } }} answer
 */
function waitAsked(answer) {
  const header = (answer.headers?.get('retry-after') ?? '').trim();
  return /^\d+$/.test(header) ? Number(header) * 1000 : null;
}

/**
 * attempt makes one read. It answers the served body, or the reason a failure that can pass gave and
 * the wait the control plane asked for, and throws on a refusal that would answer the same again. A
 * response it does not read is released first, so a retry does not hold its connection open.
 *
 * @param {{
 *   url: string,
 *   audience: string,
 *   mint: (audience: string) => Promise<string>,
 *   secret: (token: string) => void,
 *   fetch: typeof globalThis.fetch,
 *   timeout: number,
 * }} asked
 * @returns {Promise<{ served: unknown } | { retry: string, asked: number | null }>}
 */
async function attempt({ url, audience, mint, secret, fetch, timeout }) {
  let token = '';
  try {
    token = await mint(audience);
  } catch {
    return { retry: 'the OIDC token could not be minted', asked: null };
  }
  if (typeof token !== 'string' || token === '') {
    return { retry: 'the OIDC token endpoint answered with no token', asked: null };
  }
  secret(token);

  let answer;
  try {
    answer = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return { retry: 'the control plane could not be reached', asked: null };
  }

  const why = WHY_STATUS[/** @type {401|404|503} */ (answer.status)] ?? `the control plane answered ${answer.status}`;
  if (passing(answer.status)) {
    await release(answer);
    return { retry: why, asked: waitAsked(answer) };
  }
  if (!answer.ok) {
    await release(answer);
    throw stopped(why);
  }

  try {
    return { served: await answer.json() };
  } catch {
    return { retry: 'the control plane answered with a body that did not parse', asked: null };
  }
}

/**
 * recordFrom hands on what a served record decided, and throws on anything the runner could not use,
 * so nothing half-read is passed on.
 *
 * @param {unknown} served
 */
function recordFrom(served) {
  if (served === null || typeof served !== 'object' || Array.isArray(served)) {
    throw stopped('the control plane answered something other than a record');
  }

  const {
    command, label, pr, head_sha: headSha, requester, model, effort, guidance, work_item: workItem,
  } = /** @type {Record<string, unknown>} */ (served);
  if (command !== undefined && (typeof command !== 'string' || !COMMANDS.includes(command))) {
    throw stopped('the record names a command this runner does not answer');
  }
  if (label !== undefined && (typeof label !== 'string' || label === '' || label.length > LABEL_MAX || hasControl(label))) {
    throw stopped('the record names a label GitHub could not hold');
  }
  if (pr !== undefined && (typeof pr !== 'string' || !PR_SHAPE.test(pr))) {
    throw stopped('the record names a pull request that is not a number');
  }
  if (headSha !== undefined && (typeof headSha !== 'string' || !SHA_SHAPE.test(headSha))) {
    throw stopped('the record names a head that is not a commit');
  }
  if (requester !== undefined && (typeof requester !== 'string' || !REQUESTER.test(requester))) {
    throw stopped('the record names a requester that is not a GitHub login');
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL.test(model))) {
    throw stopped('the record names a model this workflow will not pass on');
  }
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.includes(effort))) {
    throw stopped('the record names an effort this workflow will not pass on');
  }
  if (guidance !== undefined && (typeof guidance !== 'string' || !sayable(guidance, GUIDANCE_MAX))) {
    throw stopped('the record carries guidance this workflow will not pass on');
  }
  if (workItem !== undefined && (typeof workItem !== 'string' || !sayable(workItem, WORK_ITEM_MAX))) {
    throw stopped('the record carries a work item this workflow will not pass on');
  }
  return {
    read: true,
    command: text(command),
    label: text(label),
    pr: text(pr),
    head_sha: text(headSha).toLowerCase(),
    requester: text(requester),
    model: text(model),
    effort: text(effort),
    guidance: text(guidance),
    workItem: text(workItem),
  };
}

function sayable(value, limit) {
  if (value.length > limit) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * readRecord reads what the control plane decided for this run. A dispatch naming no record skips the
 * read; one naming a record is read, or this throws with the reason, and nothing falls back to the
 * dispatch inputs.
 *
 * The control plane binds a record to the run that first reads it, and sends a dispatch whose answer
 * was lost again under the same record. A run that carried on without reading it could be the second
 * run of that dispatch, doing the work twice, or a run answering a different question than the one
 * decided - so a record that cannot be read stops the run whatever the reason.
 *
 * A failure that can pass - the token mint, the network, a body that did not parse, a 408, a 429 or a
 * 5xx - is tried again on the delays given, waiting longer where the control plane asks to, up to the
 * longest delay, and never past the budget: each read is cut to the time left, and a wait that would
 * run past it stops the run instead. A refusal that would answer the same again throws at once, and
 * every refusal is decided before a token is minted where it can be.
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
 *   delays?: readonly number[],
 *   sleep?: (ms: number) => Promise<void>,
 *   note?: (why: string, wait: number) => void,
 *   budget?: number,
 *   now?: () => number,
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
  timeout = TIMEOUT,
  delays = DELAYS,
  sleep = rest,
  note = () => {},
  budget = BUDGET,
  now = Date.now,
}) {
  if (recordId === '') {
    return {
      read: false,
      command: '',
      label: '',
      pr: '',
      head_sha: '',
      requester: '',
      model: '',
      effort: '',
      guidance: '',
      workItem: '',
    };
  }
  if (endpoint === '') throw stopped('the dispatch names a record but this workflow names no control plane endpoint');
  if (!bare(endpoint)) throw stopped('the control plane endpoint is not a bare https URL');
  if (!RECORD_ID.test(recordId)) throw stopped('the record id is not one the control plane mints');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw stopped('this job holds no id-token: write, so it cannot say which run it is');
  }

  const asked = { url: `${endpoint.replace(/\/+$/, '')}/run/${recordId}`, audience, mint, secret, fetch };
  const longest = Math.max(0, ...delays);
  const started = now();
  const tries = async (left) => {
    const outcome = await attempt({ ...asked, timeout: Math.max(1, Math.min(timeout, budget - (now() - started))) });
    if ('served' in outcome) return recordFrom(outcome.served);
    if (left.length === 0) {
      throw stopped(`${outcome.retry}, on the last of ${delays.length + 1} attempts`);
    }
    const wait = Math.min(Math.max(left[0], outcome.asked ?? 0), longest);
    if (now() - started + wait >= budget) {
      throw stopped(`${outcome.retry}, and the ${Math.round(budget / 1000)}s allowed to read the record ran out`);
    }
    note(outcome.retry, wait);
    await sleep(wait);
    return tries(left.slice(1));
  };
  return tries(delays);
}
