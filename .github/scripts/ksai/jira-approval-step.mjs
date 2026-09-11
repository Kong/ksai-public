import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { resolveKeyFrom } = require('./jira.cjs');
const { resolveJiraApproval, phaseToken } = require('./jira-approval.cjs');
const { jiraForBranch } = require('./phase.cjs');

export async function main(env = process.env, { fetchImpl = fetch } = {}) {
  const done = ({ accountId = '', at = '', refused = '', error = '' }) => {
    if (error) process.stderr.write(`${error}\n`);
    writeOutputs(env.GITHUB_OUTPUT, {
      account_id: accountId,
      refused,
      error,
      phase_token: accountId === '' ? '' : phaseToken({ accountId, at }),
    });
    return 0;
  };

  const resolved = resolveKeyFrom(env);
  if (resolved.none) return done({});
  if (resolved.error) return done({ error: resolved.error });
  const branchKey = jiraForBranch(env.BRANCH);
  if (branchKey === null) return done({});
  if (resolved.key !== branchKey) {
    return done({
      error:
        `this pull request names Jira ticket \`${resolved.key}\` and its branch was cut for \`${branchKey}\`, ` +
        'so no Jira approval was read from either',
    });
  }

  const out = await resolveJiraApproval({
    cloudId: env.JIRA_CLOUD_ID,
    key: resolved.key,
    label: env.JIRA_APPROVE_LABEL,
    group: env.JIRA_APPROVER_GROUP,
    clientId: env.JIRA_CLIENT_ID,
    clientSecret: env.JIRA_CLIENT_SECRET,
    fetchImpl,
  });

  if (out.none) return done({});
  if (out.error) return done({ error: out.error });
  if (out.refused) return done({ refused: out.refused });
  return done({ accountId: out.accountId, at: out.at });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
