import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DELIMITER = 'KSAI_HEADERS_EOF';

export const ATTRIBUTION = Object.freeze([
  { name: 'X-Caller-Name', of: () => 'KSAI' },
  { name: 'X-Initiated-By', of: () => 'KSAI' },
  { name: 'X-Ksai-Repo', of: ({ repository = '' } = {}) => repository },
  { name: 'X-Ksai-Team', of: ({ team = '' } = {}) => team },
  { name: 'X-Ksai-Federation-Rule', of: ({ federationRule = '' } = {}) => federationRule },
  { name: 'X-Ksai-Service-Account', of: ({ serviceAccount = '' } = {}) => serviceAccount },
  { name: 'X-Ksai-Workflow', of: ({ workflow = '' } = {}) => workflow },
  { name: 'X-Ksai-Run-Id', of: ({ runId = '' } = {}) => runId },
  { name: 'X-Ksai-Actor', of: ({ actor = '' } = {}) => actor },
  { name: 'X-Ksai-Action', of: ({ action = '' } = {}) => action },
  { name: 'X-Ksai-Model', of: ({ model = '' } = {}) => model },
  { name: 'X-Ksai-Effort', of: ({ effort = '' } = {}) => effort },
  { name: 'Ai-Cost-Repository', of: ({ repository = '' } = {}) => repository },
  { name: 'Ai-Cost-Initiated-By', of: () => 'KSAI' },
]);

export function attributionOf(call = {}) {
  const headers = Object.create(null);
  for (const header of ATTRIBUTION) headers[header.name] = String(header.of(call) ?? '');
  return headers;
}

export function headerBlock(call = {}) {
  return Object.entries(attributionOf(call))
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`${name} carries a line break, which would start a header of its own`);
      return `${name}: ${value}\n`;
    })
    .join('');
}

export function callOf(env = {}) {
  return {
    repository: env.REPO,
    team: env.TEAM,
    federationRule: env.FEDERATION_RULE,
    serviceAccount: env.SERVICE_ACCOUNT,
    workflow: env.WORKFLOW,
    runId: env.RUN_ID,
    actor: env.ACTOR,
    action: env.ACTION,
    model: env.MODEL,
    effort: env.EFFORT,
  };
}

export function main(env = process.env) {
  const output = String(env.GITHUB_OUTPUT ?? '');
  if (!output) throw new Error('GITHUB_OUTPUT names no file, so the headers would reach no step');
  appendFileSync(output, `value<<${DELIMITER}\n${headerBlock(callOf(env))}${DELIMITER}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::the cost-attribution headers were not written: ${error.message}`);
    process.exitCode = 1;
  }
}
