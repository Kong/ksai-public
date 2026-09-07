
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { resolveKeyFrom, fetchIssue, LABEL_SHAPE, SITE_SHAPE } = require('./jira.cjs');

const SITE_REFUSAL =
  '`jira_site` is not a Jira site hostname, so the ticket key could not be written into the pull request ' +
  'body and every later step of this plan would read it as absent. Set it to the host alone, e.g. ' +
  'your-site.atlassian.net, with no scheme and no path.';

const LABEL_REFUSAL =
  'no `jira_trigger_label` is configured, so nothing bounds who may start a run from a ticket. The project ' +
  'allowlist says which projects may be read; the label says who asked, and a `workflow_dispatch` naming a ' +
  'ticket carries neither on its own. Set it to the label your Jira poller adds';

const PUBLIC_REFUSAL =
  'this repository is public, and a Jira ticket read here would reach the run transcript this action uploads ' +
  'as a workflow artifact, which anyone can download. Set `jira_allow_public_repo: "true"` if that is ' +
  'acceptable for these projects.';

export async function main(env = process.env, { fetchImpl = fetch } = {}) {
  const done = ({ file = '', key = '', site = '', error = '' }) => {
    if (error) process.stderr.write(`${error}\n`);
    writeOutputs(env.GITHUB_OUTPUT, {
      file,
      key,
      site,
      error,
    });
    return 0;
  };

  const resolved = resolveKeyFrom(env);

  if (resolved.none) return done({});
  if (resolved.error) return done({ error: resolved.error });

  const site = String(env.JIRA_SITE ?? '')
    .trim()
    .toLowerCase();
  if (!SITE_SHAPE.test(site)) return done({ error: SITE_REFUSAL });

  if (env.IS_PRIVATE !== 'true' && env.JIRA_ALLOW_PUBLIC !== 'true') {
    return done({ error: PUBLIC_REFUSAL });
  }

  const label = String(env.JIRA_LABEL ?? '').trim();
  if (!LABEL_SHAPE.test(label)) return done({ error: LABEL_REFUSAL });

  const read = await fetchIssue({
    cloudId: env.JIRA_CLOUD_ID,
    key: resolved.key,
    clientId: env.JIRA_CLIENT_ID,
    clientSecret: env.JIRA_CLIENT_SECRET,
    fetchImpl,
  });
  if (read.error) return done({ error: read.error });
  if (!(read.issue?.labels ?? []).includes(label)) {
    return done({ error: `${resolved.key} does not carry the \`${label}\` label, so nothing here asked for this work.` });
  }

  const file = path.join(env.RUNNER_TEMP || '/tmp', 'ksai-jira.json');
  writeFileSync(file, JSON.stringify(read.issue, null, 2));
  return done({ file, key: resolved.key, site });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
