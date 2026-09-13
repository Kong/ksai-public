
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { writeOutputs } from '../lib/outputs.mjs';

const require = createRequire(import.meta.url);
const { resolveKeyFrom, SITE_SHAPE } = require('./jira.cjs');

const SITE_REFUSAL =
  '`jira_site` is not a Jira site hostname, so the ticket key could not be written into the pull request ' +
  'body and every later step of this plan would read it as absent. Set it to the host alone, e.g. ' +
  'your-site.atlassian.net, with no scheme and no path.';

const UNCARRIED =
  'this run names a Jira work item and carries none. A work item reaches a run only in the record the ' +
  'control plane writes for it, after reading the ticket as the person who asked, so ask ksai from the ' +
  'work item in Jira and the run doing this work is handed it.';

const PUBLIC_REFUSAL =
  'this repository is public, and a Jira ticket read here would reach the run transcript this action uploads ' +
  'as a workflow artifact, which anyone can download. Set `jira_allow_public_repo: "true"` if that is ' +
  'acceptable for these projects.';

const MAX_TITLE = 200;

export function titleOf(carried, key) {
  const first = String(carried).split('\n', 1)[0].trim();
  const named = first.startsWith(`${key}: `) ? first.slice(key.length + 2) : first;
  return named.trim().slice(0, MAX_TITLE);
}

export async function main(env = process.env) {
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

  const file = path.join(env.RUNNER_TEMP || '/tmp', 'ksai-jira.json');

  const carried = String(env.WORK_ITEM ?? '').trim();
  if (!carried) return done({ error: UNCARRIED });

  const item = { key: resolved.key, title: titleOf(carried, resolved.key), body: carried };
  writeFileSync(file, JSON.stringify(item, null, 2));
  return done({ file, key: resolved.key, site });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
