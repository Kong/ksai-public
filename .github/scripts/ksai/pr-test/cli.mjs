#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadContract, parseContract, selectEnvironments } from './contract.mjs';
import { collectCriteria } from './criteria.mjs';
import { provision, teardownAll, writeEnvironmentFile } from './provision.mjs';
import { writeDryVerdict, writeInfrastructureVerdict } from './trusted-verdict.mjs';

const usage = `Usage: pr-test <command> [options]

  contract                    validate .ksai/pr-test.json and list what it declares
  criteria --pr N             resolve the closing issues into CRITERIA.md
  up [--env a,b]              bring the selected environments up, write ENVIRONMENT.md
  down [--env a,b]            tear them down again
  dry-verdict                 write a verdict saying no tester ran, for a dry run
  infra-verdict               write an infrastructure verdict when setup prevents a test
  sweep                       start each declared environment on its own, in turn

Options:
  --run-dir <path>            where the run's files live (default <repo-root>/.ksai-run)
  --host <host>               host the published ports answer on (default localhost)
  --repo <owner/name>         repository for gh lookups (default $GITHUB_REPOSITORY)
  --repo-root <path>          the checkout under test (default $GITHUB_WORKSPACE)
  --contract <path>           the contract (default <repo-root>/.ksai/pr-test.json)
  --contract-base64 <value>   trusted base64-encoded contract for teardown
  --head-sha <sha>            exact pull request commit checked out for criteria
  --base-ref <ref>            exact pull request base ref resolved for criteria
  --base-sha <sha>            exact pull request base commit supplying the contract
`;

async function main(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);

  const repoRoot = options['repo-root'] ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const runDir = options['run-dir'] ?? join(repoRoot, '.ksai-run');
  await mkdir(runDir, { recursive: true });

  const context = {
    repoRoot,
    runDir,
    host: options.host ?? process.env.KSAI_TEST_HOST ?? 'localhost',
    projectName: `ksai-pr-test-${options.pr ?? 'local'}`,
  };

  const contractPath = options.contract ?? join(repoRoot, '.ksai', 'pr-test.json');
  const requested = options.env ? options.env.split(',').map((name) => name.trim()) : [];
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo && command === 'criteria') throw new Error('criteria needs --repo owner/name');

  switch (command) {
    case 'contract':
      return showContract(contractPath, requested);
    case 'criteria':
      return writeCriteria({ options, repo, runDir });
    case 'up':
      return bringUp({ contractPath, requested, context, runDir });
    case 'down':
      return takeDown({
        contractPath,
        contractBase64: options['contract-base64'],
        requested,
        context,
      });
    case 'dry-verdict':
      return printVerdict(await writeDryVerdict(runDir));
    case 'infra-verdict':
      return printVerdict(await writeInfrastructureVerdict(runDir));
    case 'sweep':
      return sweep({ contractPath, requested, context, runDir });
    default:
      process.stdout.write(usage);
      process.exitCode = command ? 1 : 0;
  }
}

async function showContract(contractPath, requested) {
  const contract = await loadContract(contractPath);
  const selected = selectEnvironments(contract, requested);
  process.stdout.write(`${contractPath} is valid.\n\nStart order:\n`);
  for (const entry of selected) process.stdout.write(`  ${entry.name} (${entry.kind})\n`);
  process.stdout.write(`\nDefaults: ${contract.default.join(', ')}\n`);
}

async function writeCriteria({ options, repo, runDir }) {
  if (!options.pr) throw new Error('criteria needs --pr N');
  if (!options['head-sha']) throw new Error('criteria needs --head-sha SHA');
  if (!options['base-ref']) throw new Error('criteria needs --base-ref REF');
  if (!options['base-sha']) throw new Error('criteria needs --base-sha SHA');
  const { record, path } = await collectCriteria({
    prNumber: options.pr,
    repo,
    runDir,
    headSha: options['head-sha'],
    baseRef: options['base-ref'],
    baseSha: options['base-sha'],
  });
  await writeFile(join(runDir, 'criteria.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`${path}\n`);
}

async function bringUp({ contractPath, requested, context, runDir }) {
  const contract = await loadContract(contractPath);

  const pids = {};
  const records = await provision({
    contract,
    requested,
    context,
    onRecord: async (record) => {
      if (!record.pid) return;
      pids[record.name] = record.pid;
      await writePidMap(pids, context);
    },
  });

  await writeFile(
    join(runDir, 'environments.json'),
    `${JSON.stringify(records, null, 2)}\n`,
    'utf8',
  );
  const path = await writeEnvironmentFile({ records, context, runDir });
  process.stdout.write(`${path}\n`);

  if (records.some((record) => !record.ok)) process.exitCode = 2;
}

async function takeDown({ contractPath, contractBase64, requested, context }) {
  const contract = contractBase64
    ? parseContract(decodeContract(contractBase64), 'trusted teardown contract')
    : await loadContract(contractPath);
  const pids = await readPidMap(context);

  for (const result of await teardownAll({ contract, requested, context: { ...context, pids } })) {
    process.stdout.write(
      `${result.name}: ${result.ok ? 'down' : `LEFT BEHIND (${result.error})`}\n`,
    );
  }
}

function decodeContract(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`trusted teardown contract is not valid base64 JSON: ${error.message}`, {
      cause: error,
    });
  }
}

async function sweep({ contractPath, requested, context, runDir }) {
  const contract = await loadContract(contractPath);
  const names = requested?.length ? requested : Object.keys(contract.environments);
  const records = [];

  for (const name of names) {
    process.stdout.write(`\n--- ${name} ---\n`);
    const started = await provision({ contract, requested: [name], context });
    records.push(...started.map((record) => ({ ...record, selected_as: name })));
    await teardownAll({
      contract,
      requested: [name],
      context: { ...context, pids: pidsOf(started) },
    });
  }

  await writeFile(
    join(runDir, 'environments.json'),
    `${JSON.stringify(records, null, 2)}\n`,
    'utf8',
  );
  await writeEnvironmentFile({ records, context, runDir });
  printVerdict(await writeDryVerdict(runDir, names));

  const broken = records.filter((record) => !record.ok);
  for (const record of records) {
    process.stdout.write(`${record.ok ? 'ok  ' : 'FAIL'} ${record.name} (${record.kind})\n`);
  }
  if (broken.length > 0) process.exitCode = 2;
}

const pidsOf = (records) =>
  Object.fromEntries(
    records.filter((record) => record.pid).map((record) => [record.name, record.pid]),
  );

const pidMapPath = (context) => join(process.env.RUNNER_TEMP ?? tmpdir(), `${context.projectName}.pids.json`);

const writePidMap = async (pids, context) =>
  writeFile(pidMapPath(context), `${JSON.stringify(pids, null, 2)}\n`, 'utf8');

async function readPidMap(context) {
  const raw = (await readJson(pidMapPath(context)).catch(() => null)) ?? {};
  const pids = {};
  for (const [name, pid] of Object.entries(raw)) {
    if (Number.isInteger(pid) && pid > 1) pids[name] = pid;
  }
  return pids;
}

const printVerdict = (path) => process.stdout.write(`${path}\n`);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
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
  process.stderr.write(`pr-test: ${error.message}\n`);
  process.exitCode = 1;
}
