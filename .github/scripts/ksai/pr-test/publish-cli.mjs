#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isHttpUrl, KINDS } from './contract.mjs';
import { renderReview, testerRecord } from './review.mjs';
import { validateVerdict, verificationRecord } from './verdict.mjs';
import { readHypotheses } from '../../lib/review-hypotheses.mjs';

const usage = `Usage: publish-cli [--run-dir <path>] [--pr <number>] [--head-sha <sha>] [--base-ref <ref>] [--base-sha <sha>] [--trigger-phrase <phrase>] [--stdout]

Reads .pr-test-verdict.json, criteria.json and environments.json from the run
directory, and writes review.md beside them. Exits 3 when the verdict is one this
publisher will not publish, which is a review that says so rather than silence.
`;

async function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const runDir = options['run-dir'] ?? join(workspace, '.ksai-run');
  const expectedPr = expectedPullRequest(options.pr);
  const expectedHead = expectedHeadSha(options['head-sha']);
  const expectedBase = expectedBaseRef(options['base-ref']);
  const expectedBaseSha = expectedBaseShaValue(options['base-sha']);

  const { verdict, problem } = await readVerdict(join(runDir, '.pr-test-verdict.json'));
  const criteria = await readJson(join(runDir, 'criteria.json')).catch(() => null);
  const environmentRecord = await readJson(join(runDir, 'environments.json')).catch(() => null);
  const criteriaProblems = validateCriteria(
    criteria,
    expectedPr,
    expectedHead,
    expectedBase,
    expectedBaseSha,
  );
  const environmentProblems = validateEnvironments(environmentRecord);
  const environments = Array.isArray(environmentRecord) ? environmentRecord : [];
  let hypotheses = null;
  try {
    hypotheses = readHypotheses(criteria?.hypotheses === undefined ? '' : JSON.stringify(criteria.hypotheses), {
      headSha: criteria?.pull_request?.head_sha, baseSha: criteria?.pull_request?.base_sha,
    });
  } catch (error) {
    criteriaProblems.push(`trusted hypothesis packet is invalid: ${error.message}`);
  }

  const problems = [
    ...(problem ? [problem] : validateVerdict(verdict, hypotheses)),
    ...criteriaProblems,
    ...environmentProblems,
  ];
  const verification = verificationRecord(verdict, hypotheses, problems);
  await writeFile(join(runDir, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', 'utf8');
  const spend = await readJson(join(runDir, 'spend.json')).catch(() => null);
  const rendered = renderReview({
    verdict: verdict ?? {},
    criteria,
    environments,
    problems,
    verification,
    triggerPhrase: typeof options['trigger-phrase'] === 'string' ? options['trigger-phrase'] : '',
  });
  const body = spend ? `${rendered}\n\n${testerRecord({ spend, verdict, criteria, problems })}` : rendered;

  const path = join(runDir, 'review.md');
  await writeFile(path, `${body}\n`, 'utf8');
  process.stdout.write(`${path}\n`);
  if (options.stdout) process.stdout.write(`\n${body}\n`);

  if (problems.length > 0) process.exitCode = 3;
}

async function readVerdict(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {
      verdict: null,
      problem: 'the tester wrote no verdict, so the run produced nothing to publish',
    };
  }

  try {
    return { verdict: JSON.parse(raw) };
  } catch (error) {
    return { verdict: null, problem: `the verdict is not valid JSON: ${error.message}` };
  }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const MAX_ENTRIES = 100;
const MAX_TEXT_CHARS = 2_000;
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const RECORD_KEYS = new Set([
  'name',
  'kind',
  'started_by',
  'ok',
  'detail',
  'health',
  'description',
  'pid',
  'selected_as',
]);
const HEALTH_KEYS = new Set(['url', 'ready', 'status', 'error']);
const TARGET_DESCRIPTION_KEYS = new Set(['task', 'command']);
const COMPOSE_DESCRIPTION_KEYS = new Set(['services', 'command']);
const SERVICE_KEYS = new Set(['service', 'state', 'ports']);
const PORT_KEYS = new Set(['URL', 'TargetPort', 'PublishedPort', 'Protocol']);

function expectedPullRequest(value) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`--pr must be a positive integer, got: ${value}`);
  return number;
}

function expectedHeadSha(value) {
  if (value === undefined) return null;
  if (!SHA.test(value)) throw new Error(`--head-sha must be a 40-character commit SHA, got: ${value}`);
  return value.toLowerCase();
}

function expectedBaseRef(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new Error(`--base-ref must be a nonempty ref on one line, got: ${value}`);
  }
  return value;
}

function expectedBaseShaValue(value) {
  if (value === undefined) return null;
  if (!SHA.test(value)) throw new Error(`--base-sha must be a 40-character commit SHA, got: ${value}`);
  return value.toLowerCase();
}

function validateCriteria(criteria, expectedPr, expectedHead, expectedBase, expectedBaseSha) {
  if (!isObject(criteria)) return ['the acceptance criteria record is missing or is not an object'];
  const problems = [];
  if (!isObject(criteria.pull_request)) {
    problems.push('criteria.pull_request is not an object');
  } else {
    const number = criteria.pull_request.number;
    if (!Number.isInteger(number) || number < 1) {
      problems.push('criteria.pull_request.number is not a positive integer');
    } else if (expectedPr !== null && number !== expectedPr) {
      problems.push(`the criteria belong to pull request #${number}, not #${expectedPr}`);
    }
    const head = criteria.pull_request.head_sha;
    if (!SHA.test(head ?? '')) {
      problems.push('criteria.pull_request.head_sha is not a 40-character commit SHA');
    } else if (expectedHead !== null && head.toLowerCase() !== expectedHead) {
      problems.push(`the criteria belong to commit ${head}, not the current head ${expectedHead}`);
    }
    const base = criteria.pull_request.base;
    if (checkString(base, 'criteria.pull_request.base', problems)) {
      if (/[\r\n]/.test(base)) {
        problems.push('criteria.pull_request.base is not a ref on one line');
      } else if (expectedBase !== null && base !== expectedBase) {
        problems.push(`the criteria belong to base ref ${base}, not the current base ref ${expectedBase}`);
      }
    }
    const baseSha = criteria.pull_request.base_sha;
    if (!SHA.test(baseSha ?? '')) {
      problems.push('criteria.pull_request.base_sha is not a 40-character commit SHA');
    } else if (expectedBaseSha !== null && baseSha.toLowerCase() !== expectedBaseSha) {
      problems.push(
        `the criteria belong to base commit ${baseSha}, not the current base commit ${expectedBaseSha}`,
      );
    }
  }
  if (!Array.isArray(criteria.issues)) {
    problems.push('criteria.issues is not an array');
    return problems;
  }
  if (criteria.issues.length > MAX_ENTRIES) {
    problems.push(`criteria.issues contains more than ${MAX_ENTRIES} entries`);
    return problems;
  }
  for (const [index, issue] of criteria.issues.entries()) {
    const where = `criteria.issues[${index}]`;
    if (!isObject(issue)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (checkString(issue.repo, `${where}.repo`, problems) && !REPOSITORY.test(issue.repo)) {
      problems.push(`${where}.repo is not an owner/repository name`);
    }
    if (!Number.isInteger(issue.number) || issue.number < 1) {
      problems.push(`${where}.number is not a positive integer`);
    }
    if (typeof issue.readable !== 'boolean') problems.push(`${where}.readable is not a boolean`);
    if (issue.readable) checkString(issue.title, `${where}.title`, problems);
  }
  return problems;
}

function validateEnvironments(environments) {
  if (!Array.isArray(environments)) return ['the environment record is missing or is not a list'];
  if (environments.length === 0) return ['the environment record is empty'];
  if (environments.length > MAX_ENTRIES) {
    return [`the environment record contains more than ${MAX_ENTRIES} entries`];
  }
  const problems = [];
  for (const [index, environment] of environments.entries()) {
    if (!isObject(environment)) {
      problems.push(`environments[${index}] is not an object`);
      continue;
    }
    checkEnvironment(environment, index, problems);
  }
  return problems;
}

function checkEnvironment(environment, index, problems) {
  const where = `environments[${index}]`;
  checkKeys(environment, RECORD_KEYS, where, problems);
  checkBareName(environment.name, `${where}.name`, problems);
  checkString(environment.started_by, `${where}.started_by`, problems);
  if (!KINDS.includes(environment.kind)) problems.push(`${where}.kind is not a supported environment kind`);
  if (typeof environment.ok !== 'boolean') problems.push(`${where}.ok is not a boolean`);
  checkOptionalString(environment.detail, `${where}.detail`, problems, { required: true });
  checkHealth(environment.health, where, problems);
  checkDescription(environment.description, environment.kind, where, problems);
  if (environment.pid !== null && (!Number.isInteger(environment.pid) || environment.pid < 1)) {
    problems.push(`${where}.pid must be null or a positive integer`);
  }
  if (environment.selected_as !== undefined) {
    checkBareName(environment.selected_as, `${where}.selected_as`, problems);
  }
}

function checkHealth(health, parent, problems) {
  const where = `${parent}.health`;
  if (health === null) return;
  if (!isObject(health)) {
    problems.push(`${where} must be null or an object`);
    return;
  }
  checkKeys(health, HEALTH_KEYS, where, problems);
  if (checkString(health.url, `${where}.url`, problems) && !isHttpUrl(health.url)) {
    problems.push(`${where}.url is not an HTTP or HTTPS URL`);
  }
  if (typeof health.ready !== 'boolean') problems.push(`${where}.ready is not a boolean`);
  if (health.ready) {
    if (!Number.isInteger(health.status) || health.status < 100 || health.status > 599) {
      problems.push(`${where}.status must be an HTTP status when ready`);
    }
    if (health.error !== undefined) problems.push(`${where}.error is only allowed when readiness failed`);
  } else {
    if (health.status !== null) problems.push(`${where}.status must be null when readiness failed`);
    checkString(health.error, `${where}.error`, problems);
  }
}

function checkDescription(description, kind, parent, problems) {
  const where = `${parent}.description`;
  if (description === null) return;
  if (!isObject(description)) {
    problems.push(`${where} must be null or an object`);
    return;
  }
  if (kind === 'docker-compose') {
    checkKeys(description, COMPOSE_DESCRIPTION_KEYS, where, problems);
    checkString(description.command, `${where}.command`, problems);
    checkServices(description.services, where, problems);
    return;
  }
  checkKeys(description, TARGET_DESCRIPTION_KEYS, where, problems);
  checkBareName(description.task, `${where}.task`, problems);
  checkString(description.command, `${where}.command`, problems);
}

function checkServices(services, parent, problems) {
  const where = `${parent}.services`;
  if (!Array.isArray(services)) {
    problems.push(`${where} must be an array`);
    return;
  }
  if (services.length > MAX_ENTRIES) {
    problems.push(`${where} contains more than ${MAX_ENTRIES} entries`);
    return;
  }
  for (const [index, service] of services.entries()) {
    const item = `${where}[${index}]`;
    if (!isObject(service)) {
      problems.push(`${item} is not an object`);
      continue;
    }
    checkKeys(service, SERVICE_KEYS, item, problems);
    checkString(service.service, `${item}.service`, problems);
    checkString(service.state, `${item}.state`, problems);
    checkPorts(service.ports, item, problems);
  }
}

function checkPorts(ports, parent, problems) {
  const where = `${parent}.ports`;
  if (!Array.isArray(ports)) {
    problems.push(`${where} must be an array`);
    return;
  }
  if (ports.length > MAX_ENTRIES) {
    problems.push(`${where} contains more than ${MAX_ENTRIES} entries`);
    return;
  }
  for (const [index, port] of ports.entries()) {
    const item = `${where}[${index}]`;
    if (!isObject(port)) {
      problems.push(`${item} is not an object`);
      continue;
    }
    checkKeys(port, PORT_KEYS, item, problems);
    checkOptionalString(port.URL, `${item}.URL`, problems, { required: true });
    checkOptionalString(port.Protocol, `${item}.Protocol`, problems, { required: true });
    for (const field of ['TargetPort', 'PublishedPort']) {
      if (!Number.isInteger(port[field]) || port[field] < 0 || port[field] > 65_535) {
        problems.push(`${item}.${field} is not a valid port`);
      }
    }
  }
}

function checkKeys(value, allowed, where, problems) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(`${where} has unknown key ${key}`);
  }
}

function checkString(value, where, problems) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_CHARS) {
    problems.push(`${where} is not a bounded nonempty string`);
    return false;
  }
  return true;
}

function checkBareName(value, where, problems) {
  if (checkString(value, where, problems) && !BARE_NAME.test(value)) {
    problems.push(`${where} is not a bare name`);
  }
}

function checkOptionalString(value, where, problems, { required }) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS) {
    problems.push(`${where} is not a bounded string`);
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`publish-cli: ${error.message}\n`);
  process.exitCode = 1;
}
