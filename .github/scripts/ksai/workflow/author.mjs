import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../../lib/json.cjs';
import {
  buildPackage, conformancePackage, dryRunPackage, scaffoldPackage, validatePackage,
} from './authoring.mjs';

const USAGE = `usage:
  author.mjs scaffold <directory> --name <workflow> [--version <semver>]
  author.mjs validate <package>
  author.mjs dry-run <package> --stage <id> [--request <file>] [--candidate <file>] [--artifacts <directory>] [--out <file>]
  author.mjs conformance <package> [--fixtures <directory>]
  author.mjs build <package> --out <archive.tar> --source-repository <owner/name> --source-commit <full-sha> [--metadata <file>]`;

function argumentsOf(argv) {
  const [command, packageRoot, ...rest] = argv;
  if (!command || !packageRoot) throw new Error(USAGE);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`option ${flag} is duplicated`);
    options[name] = value;
  }
  return { command, packageRoot, options };
}

function only(options, names) {
  for (const name of Object.keys(options)) if (!names.includes(name)) throw new Error(`unknown option --${name}`);
}

function required(options, name) {
  if (!options[name]) throw new Error(`missing option --${name}`);
  return options[name];
}

/** Run the local workflow authoring command. */
export async function main(argv = process.argv.slice(2)) {
  const { command, packageRoot, options } = argumentsOf(argv);
  let result;
  if (command === 'scaffold') {
    only(options, ['name', 'version']);
    result = scaffoldPackage(packageRoot, { name: required(options, 'name'), version: options.version });
  } else if (command === 'validate') {
    only(options, []);
    result = validatePackage(packageRoot);
  } else if (command === 'dry-run') {
    only(options, ['stage', 'request', 'candidate', 'artifacts', 'out']);
    const stage = required(options, 'stage');
    const fixtures = resolve(packageRoot, 'tests');
    result = dryRunPackage(packageRoot, {
      stage,
      request: resolve(options.request ?? `${fixtures}/${stage}.request.json`),
      candidate: resolve(options.candidate ?? `${fixtures}/${stage}.candidate.json`),
      artifacts: resolve(options.artifacts ?? `${fixtures}/${stage}.artifacts`),
      out: options.out ? resolve(options.out) : undefined,
    });
  } else if (command === 'conformance') {
    only(options, ['fixtures']);
    result = await conformancePackage(packageRoot, { fixtures: resolve(options.fixtures ?? `${packageRoot}/tests`) });
  } else if (command === 'build') {
    only(options, ['out', 'metadata', 'source-repository', 'source-commit']);
    result = buildPackage(packageRoot, {
      out: required(options, 'out'), metadata: options.metadata,
      sourceRepository: required(options, 'source-repository'),
      sourceCommit: required(options, 'source-commit'),
    });
  } else {
    throw new Error(USAGE);
  }
  console.log(canonicalJson(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
