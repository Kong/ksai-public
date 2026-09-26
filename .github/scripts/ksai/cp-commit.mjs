import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { answered, reachedFor } = require('../lib/control-plane.cjs');

export const COMMIT_TIMEOUT = 90_000;

const OID = /^[0-9a-f]{40}$/;

const text = (value) => (typeof value === 'string' ? value : '');

const maskOnStderr = (token) => process.stderr.write(`::add-mask::${token}\n`);

export async function askToCommit({
  input, env = process.env, fetch = globalThis.fetch, timeout = COMMIT_TIMEOUT, secret = maskOnStderr,
}) {
  const reached = await reachedFor({ env, fetch, timeout, secret });
  if (reached.why) return { why: reached.why };

  const said = await answered(fetch, `${reached.base}/run/commit`, {
    token: reached.token,
    body: JSON.stringify({ ...input, job: text(env.GITHUB_JOB) }),
    timeout,
    signal: reached.signal,
    said: true,
  });
  if (said.why) return { why: said.why };

  const { oid, tree, signature, author } = said.answer ?? {};
  if (!OID.test(text(oid)) || text(tree) === '' || text(signature) === '' || text(author) === '') {
    return { why: 'the control plane answered a commit this could not read' };
  }
  return { commit: { oid, tree: { oid: tree }, signature: { state: signature } }, author };
}

export async function main(argv = process.argv, env = process.env, fetch = globalThis.fetch) {
  let input;
  try {
    input = JSON.parse(readFileSync(argv[2], 'utf8'))?.variables?.input;
  } catch {
    input = null;
  }
  const said = input ? await askToCommit({ input, env, fetch }) : { why: 'the commit to ask for could not be read' };
  process.stdout.write(`${JSON.stringify(said)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
