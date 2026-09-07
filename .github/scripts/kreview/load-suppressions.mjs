/**
 * Fetches one repo's committed suppression list from the private store and writes the validated
 * rules where the publisher can read them.
 *
 * This is the only step that holds an App key. GitHub cannot scope a repository token to one
 * directory, so a token that can read the suppression list can read the whole store — which is why
 * the credential lives here, in trusted code, and only the validated rules travel onward. The
 * installation token is minted in this process, scoped to that one repo and to reading contents,
 * never written to a step output or a file, and revoked before the process exits.
 *
 * Everything fails open. No App key, a network error, a 404, an unparseable line: each ends with an
 * empty rule set, which means the review posts every finding exactly as it does today.
 */

import { counted } from '../lib/text.cjs';
import { createSign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { parseRules } = require('./suppress.cjs');

const API = 'https://api.github.com';
const DEFAULT_STORE = '';
const DEFAULT_REF = 'main';

// owner/repo, exactly two segments and no whitespace.
const STORE_SHAPE = /^[^/\s]+\/[^/\s]+$/;

const listPath = (scope) => `suppressions/${scope}/learnings.jsonl`;

const b64url = (value) => Buffer.from(value).toString('base64url');

/*
 * A GitHub App JWT, signed here rather than fetched from an action so the private key never
 * becomes a step output. `iat` is backdated a minute because GitHub rejects a token issued in its
 * own future, and runner clocks drift; the 9-minute life is under GitHub's 10-minute maximum.
 */
function appJwt({ appId, privateKey, now }) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const claims = b64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }));
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey, 'base64url')}`;
}

async function call(fetchImpl, path, { token, method = 'GET', body = null, accept = 'application/vnd.github+json' }) {
  return fetchImpl(`${API}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'kreview/load-suppressions',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Returns `{ scope, rules, source, ok, error }`. `ok` is false when the list could not be read at
 * all, which is worth an alert but changes nothing about this review: `rules` is empty either
 * way, and an empty rule set suppresses nothing.
 */
export async function loadSuppressions({
  appId,
  privateKey,
  store = DEFAULT_STORE,
  ref = DEFAULT_REF,
  scope,
  fetchImpl = fetch,
  now = Date.now(),
  warn = (_message) => {},
}) {
  const path = listPath(scope);
  const source = { store, ref, path };
  const empty = (error) => ({ scope, rules: [], source, ok: false, error });

  if (!appId || !privateKey) return empty('no App key for the suppression store');
  // Both are checked the same way. The store is spliced into three request paths and its repo half
  // names the repo the token is minted for, so a malformed one sends a mint request for `[null]` and
  // then reports a mint failure, which points a reader at GitHub instead of at the input.
  if (!STORE_SHAPE.test(String(store ?? ''))) return empty(`suppression store ${JSON.stringify(store)} is not owner/repo`);
  if (!STORE_SHAPE.test(String(scope ?? ''))) return empty(`reviewed repository ${JSON.stringify(scope)} is not owner/repo`);

  let jwt;
  try {
    jwt = appJwt({ appId, privateKey, now });
  } catch (e) {
    warn(`Could not sign the App JWT: ${e.message}`);
    return empty('jwt');
  }

  let token = null;
  try {
    const installation = await call(fetchImpl, `/repos/${store}/installation`, { token: jwt });
    if (!installation.ok) {
      warn(`The App is not installed on ${store} (${installation.status}); posting every finding.`);
      return empty(`installation lookup ${installation.status}`);
    }
    const { id } = await installation.json();

    // Narrow the token to the one repo and to reading contents, so this credential cannot do
    // more than the step needs even in the window before it is revoked.
    const minted = await call(fetchImpl, `/app/installations/${id}/access_tokens`, {
      token: jwt,
      method: 'POST',
      body: { repositories: [store.split('/')[1]], permissions: { contents: 'read' } },
    });
    if (!minted.ok) {
      warn(`Could not mint a store token (${minted.status}); posting every finding.`);
      return empty(`token mint ${minted.status}`);
    }
    // A 2xx whose body does not parse - a truncated response, a proxy answering with HTML - would
    // otherwise throw past the assignment, leaving the revoke below with nothing to revoke and no
    // word about a token GitHub did issue. The token value is unknowable at that point, so saying
    // so is the only remedy available; it self-expires within GitHub's one-hour ceiling.
    const mintBody = await minted.json().catch(() => null);
    token = typeof mintBody?.token === 'string' ? mintBody.token : null;
    if (!token) {
      warn('The mint response carried no readable token; it cannot be revoked and will expire on its own.');
      return empty('token mint body');
    }

    const contents = await call(fetchImpl, `/repos/${store}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      token,
      accept: 'application/vnd.github.raw+json',
    });
    // No file is the normal state for a repo that has never suppressed anything, so it is not a
    // failure: an absent list and an empty list mean the same thing.
    if (contents.status === 404) return { scope, rules: [], source, ok: true, error: null };
    if (!contents.ok) {
      warn(`Could not read ${store}/${path} (${contents.status}); posting every finding.`);
      return empty(`contents ${contents.status}`);
    }

    const rules = parseRules(await contents.text(), { scope, warn });
    return { scope, rules, source, ok: true, error: null };
  } catch (e) {
    warn(`Could not load the suppression list: ${e.message}; posting every finding.`);
    return empty(e.message);
  } finally {
    // Best effort by design: a token GitHub will expire on its own in an hour is not worth
    // failing a completed review over. It is still worth saying out loud when the token is
    // still live — and since fetch resolves for a 4xx or 5xx, the status is the only signal
    // that says so.
    if (token) {
      try {
        const revoked = await call(fetchImpl, '/installation/token', { token, method: 'DELETE' });
        if (!revoked.ok) warn(`Could not revoke the store token (${revoked.status}); it expires on its own.`);
      } catch (e) {
        warn(`Could not revoke the store token: ${e.message}`);
      }
    }
  }
}

/*
 * A workflow-command annotation, escaped the way GitHub documents it.
 *
 * The runner reads a command to the end of the line, so a newline inside the message would end this
 * one and let whatever follows be parsed as another command. Messages here quote entries from the
 * store, and a JSON string can hold a real newline, so the escape is not optional. `%` goes first or
 * it would double-escape the sequences added after it.
 */
const annotate = (message) =>
  `::warning::${String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`;

async function main() {
  const bundlePath = process.env.KREVIEW_SUPPRESSIONS_BUNDLE;
  if (!bundlePath) {
    process.stdout.write(annotate('KREVIEW_SUPPRESSIONS_BUNDLE is unset; nothing to write.'));
    return;
  }

  const bundle = await loadSuppressions({
    appId: process.env.KREVIEW_SUPPRESSIONS_APP_ID,
    privateKey: process.env.KREVIEW_SUPPRESSIONS_PRIVATE_KEY,
    store: process.env.KREVIEW_SUPPRESSIONS_STORE || DEFAULT_STORE,
    ref: process.env.KREVIEW_SUPPRESSIONS_REF || DEFAULT_REF,
    scope: process.env.KREVIEW_REVIEWED_REPO,
    warn: (message) => process.stdout.write(annotate(message)),
  });

  writeFileSync(bundlePath, JSON.stringify(bundle));
  process.stdout.write(
    `Loaded ${counted(bundle.rules.length, 'suppression rule')} for ${bundle.scope} from ${bundle.source.store}/${bundle.source.path}` +
      `${bundle.ok ? '' : ` (unavailable: ${bundle.error})`}\n`,
  );
}

// An unexpected throw here leaves no bundle behind, which the publisher reads as "no rules" —
// the same fail-open outcome as an empty list. The calling step is continue-on-error for the same
// reason: a store outage must not turn a completed review red.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
