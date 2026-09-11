import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const RESERVED = new Set(['.git', '.ksai', '_ksai']);

export const VERDICT_FILE = '.pr-test-verdict.json';

const statOf = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const regular = (path) => statOf(path)?.isFile() === true;

const fresh = (dest) => {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
};

export const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function resolveRunDir(workspace = '', runDir = '') {
  const root = realpathSync(workspace);
  if (statOf(`${root}/${runDir}`)) throw new Error(`run_dir must not already exist in the pull request tree: ${runDir}`);

  let current = root;
  for (const segment of runDir.split('/')) {
    current = `${current}/${segment}`;
    const held = statOf(current);
    if (held?.isSymbolicLink()) throw new Error(`run_dir may not contain symlink components: ${runDir}`);
    if (held && !held.isDirectory()) throw new Error(`run_dir contains a non-directory component: ${runDir}`);
  }
  mkdirSync(current, { recursive: true });

  const run = realpathSync(current);
  if (!`${run}/`.startsWith(`${root}/`)) throw new Error(`run_dir resolves outside the workspace: ${runDir}`);
  if (RESERVED.has(run.slice(root.length + 1).split('/')[0])) {
    throw new Error(`run_dir resolves inside a reserved top-level directory: ${runDir}`);
  }
  return { dir: run, verdict: `${run}/${VERDICT_FILE}` };
}

export function stageFile(source = '', dest = '', file = '', missing = '') {
  fresh(dest);
  if (!regular(source)) throw new Error(missing);
  copyFileSync(source, join(dest, file));
  return { dir: dest };
}

export function stageVerdict({ run = '', spend = '', dest = '' } = {}) {
  fresh(dest);
  const outcome = { dir: dest, present: 'false', staged: 'false', sha256: '' };
  const source = `${run}/${VERDICT_FILE}`;
  if (regular(source)) {
    const staged = join(dest, VERDICT_FILE);
    copyFileSync(source, staged);
    Object.assign(outcome, { present: 'true', staged: 'true', sha256: sha256Of(staged) });
  }
  if (regular(spend)) {
    copyFileSync(spend, join(dest, 'spend.json'));
    outcome.staged = 'true';
  }
  return outcome;
}

export function verifyVerdict(verdict = '', sha256 = '') {
  if (!regular(verdict) || sha256Of(verdict) !== sha256) throw new Error('the staged verdict changed during teardown');
}
