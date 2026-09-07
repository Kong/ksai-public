import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { accountFrom, actorTrailers, fetchActor } = require('./jira-identity.cjs');
const { warn } = require('./warn.cjs');

export async function main(env = process.env, { fetchImpl = fetch } = {}) {
  const done = ({ coAuthor = '', releasedBy = '', displayName = '', error = '' }) => {
    if (error) warn(error);
    writeOutputs(env.GITHUB_OUTPUT, {
      co_author: coAuthor,
      released_by: releasedBy,
      display_name: displayName,
    });
    return 0;
  };

  const accountId = accountFrom({ accountId: env.ACCOUNT_ID, releaseRef: env.RELEASE_REF });
  if (accountId === '') return done({});

  const { actor, error } = await fetchActor({
    cloudId: env.JIRA_CLOUD_ID,
    accountId,
    clientId: env.JIRA_CLIENT_ID,
    clientSecret: env.JIRA_CLIENT_SECRET,
    fetchImpl,
  });
  if (!actor) {
    return done({ error: `the Jira account that released this plan could not be read, so nothing credits it: ${error}` });
  }

  const { name, coAuthor, releasedBy } = actorTrailers(actor);
  if (releasedBy === '') {
    return done({ error: `Jira named no display name for ${accountId}, so nothing credits it` });
  }
  return done({ coAuthor, releasedBy, displayName: name });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
