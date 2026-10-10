import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { KSAI_ROOT, isKsaiPath, readServedConfig } from '../../lib/served-config.cjs';
import { gitArgs } from '../trusted-git.cjs';
import { CONTRACT_VERSION, parseContract } from './contract.mjs';

export function composeFiles(test) {
  return Object.values(test?.environments ?? {})
    .filter((environment) => environment?.kind === 'docker-compose' && typeof environment.file === 'string')
    .map((environment) => environment.file);
}

const said = (child) => {
  const chunks = [];
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString('utf8').trim();
};

async function keepBaseKsai(root, base, into) {
  const listed = spawnSync('git', gitArgs(root, ['ls-tree', '-z', '--format=%(objecttype)', base, '--', '.ksai']), { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-tree failed: ${String(listed.stderr).trim()}`);
  if (listed.stdout.split('\0')[0] !== 'tree') return;
  mkdirSync(into, { recursive: true });
  const archive = spawn('git', gitArgs(root, ['archive', '--format=tar', base, '--', '.ksai']), { stdio: ['ignore', 'pipe', 'pipe'] });
  const tar = spawn('tar', ['-x', '-C', into], { stdio: ['pipe', 'ignore', 'pipe'] });
  const [archiveSaid, tarSaid] = [said(archive), said(tar)];
  const [, [archived], [unpacked]] = await Promise.all([
    pipeline(archive.stdout, tar.stdin).catch(() => {}),
    once(archive, 'close'),
    once(tar, 'close'),
  ]);
  if (archived !== 0) throw new Error(`git archive could not read .ksai at ${base}: ${archiveSaid()}`);
  if (unpacked !== 0) throw new Error(`tar could not unpack .ksai from ${base}: ${tarSaid()}`);
  const kept = join(into, '.ksai');
  for (const entry of readdirSync(kept, { recursive: true, withFileTypes: true })) {
    const link = join(entry.parentPath, entry.name);
    const target = entry.isSymbolicLink() ? resolve(entry.parentPath, readlinkSync(link)) : kept;
    if (target !== kept && !target.startsWith(`${kept}${sep}`)) rmSync(link);
  }
}

export async function main({ env = process.env, root = '.', ...reading } = {}) {
  if (!env.DEST) throw new Error('DEST names no directory to restore the test contract into');
  if (!env.BASE_SHA) throw new Error('BASE_SHA names no commit to read the test contract at');
  const scope = String(env.GITHUB_REPOSITORY ?? '');
  const read = await readServedConfig({ env, scope, ref: env.BASE_SHA, ...reading });
  if (read.error) throw new Error(`the control plane did not serve the test contract of ${scope}: ${read.error}`);
  const { served } = read;
  if (served.source === '') return false;
  if (served.problem !== '') throw new Error(`\`${served.source}\` in ${scope} ${served.problem}`);
  if (served.test === null) throw new Error(`\`${served.source}\` in ${scope} declares no [test] table`);
  const contract = { ...served.test, version: CONTRACT_VERSION };
  parseContract(contract, `the [test] table of \`${served.source}\``);
  const outside = composeFiles(contract).find((file) => !isKsaiPath(file));
  if (outside !== undefined) throw new Error(`\`${served.source}\` names ${JSON.stringify(outside)} as a compose file outside ${KSAI_ROOT}`);
  await keepBaseKsai(root, env.BASE_SHA, join(env.DEST, 'kept'));
  mkdirSync(env.DEST, { recursive: true });
  writeFileSync(join(env.DEST, 'pr-test.json'), `${JSON.stringify(contract, null, 2)}\n`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
