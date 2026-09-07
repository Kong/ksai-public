import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveKeyFrom } = require('./jira.cjs');
const { report } = require('./jira-write.cjs');
const { warningFor } = require('./warn.cjs');

function reasonOf(env, read) {
  const direct = String(env.REASON ?? '').trim();
  if (direct) return direct;
  const at = String(env.REASON_FILE ?? '').trim();
  if (!at) return '';
  try {
    return read(at, 'utf8');
  } catch {
    return '';
  }
}

export async function main(env = process.env, { fetchImpl = fetch, log = console.log, read = readFileSync } = {}) {
  const warn = warningFor(log);

  const resolved = resolveKeyFrom(env);
  if (resolved.none) return 0;
  if (resolved.error) {
    warn(resolved.error);
    return 0;
  }

  const out = await report({
    cloudId: env.JIRA_CLOUD_ID,
    key: resolved.key,
    event: env.EVENT,
    prUrl: env.PR_URL,
    reason: reasonOf(env, read),
    actor: env.ACTOR,
    transitionTo: env.JIRA_TRANSITION,
    clientId: env.JIRA_CLIENT_ID,
    clientSecret: env.JIRA_CLIENT_SECRET,
    fetchImpl,
  });
  for (const problem of out.problems) warn(`Jira write-back on ${resolved.key}: ${problem}`);
  log(`jira ${resolved.key}: commented=${out.commented}, status=${out.transitioned || '(unchanged)'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
