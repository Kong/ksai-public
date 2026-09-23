import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { writeOutputs } from '../../lib/outputs.mjs';
import { runGitHub } from './exec.mjs';
import { VERDICT_FILE } from './staging.mjs';

const require = createRequire(import.meta.url);
const { usingControlPlane } = require('../../lib/control-plane.cjs');
const { writerFor } = require('../../lib/cp-effects.cjs');

export const HEADING = '## Adversarial pull request test';

const PUBLISH_CLI = fileURLToPath(new URL('./publish-cli.mjs', import.meta.url));

const GH_TIMEOUT_MS = 60_000;

const noRefs = () => ({ base: '', baseSha: '', head: '' });

const text = (value) => (typeof value === 'string' ? value : '');

const lines = (...rows) => rows.map((row) => `${row}\n`).join('');

export function readJson(path = '') {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path = '') {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function testedRefs(criteria = null) {
  const pull = criteria?.pull_request ?? {};
  return { head: text(pull.head_sha), base: text(pull.base), baseSha: text(pull.base_sha) };
}

export function verdictOutcome(verdict = null) {
  return typeof verdict?.outcome === 'string' ? verdict.outcome : 'unknown';
}

export async function pullRefs({ pr = '', repo = '', gh = runGitHub } = {}) {
  const result = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'baseRefName,baseRefOid,headRefOid'], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `gh pr view ${pr} failed`);
  const pull = JSON.parse(result.stdout);
  return { base: text(pull.baseRefName), baseSha: text(pull.baseRefOid), head: text(pull.headRefOid) };
}

export function reviewToPost({ body = '', rendered = '', tested = noRefs(), current = noRefs(), runUrl = '' } = {}) {
  const label = (value) => value || 'unknown';
  const testedHead = `Tested head: \`${label(tested.head)}\`.`;
  const testedBase = `Tested base: \`${label(tested.base)}\` at \`${label(tested.baseSha)}\`.`;
  const currentHead = `Current head: \`${label(current.head)}\`.`;
  const currentBase = `Current base: \`${label(current.base)}\` at \`${label(current.baseSha)}\`.`;
  let posted = body;
  let outcome = rendered || 'rejected';

  const known = Boolean(tested.head && tested.base && tested.baseSha);
  const moved =
    known &&
    (tested.head !== current.head || tested.base !== current.base || tested.baseSha !== current.baseSha);

  if (posted === '') {
    posted = known
      ? lines(HEADING, '', 'The run failed before it produced a verdict.', '', testedHead, testedBase)
      : lines(
          HEADING,
          '',
          'The run failed before it produced a verdict, and left no complete record of the head and base ' +
            'it tested. Its log says why.',
          '',
          currentHead,
          currentBase,
        );
    outcome = 'rejected';
  }

  if (moved) {
    posted = lines(
      HEADING,
      '',
      'The tested head or base no longer matches the pull request. This result was not published.',
      '',
      testedHead,
      currentHead,
      testedBase,
      currentBase,
    );
    outcome = 'rejected';
  } else if (!known && body !== '') {
    posted = lines(
      HEADING,
      '',
      'This result was not published because the run left no complete record of the head and base it ' +
        'tested. Its log says why.',
      '',
      currentHead,
      currentBase,
    );
    outcome = 'rejected';
  }

  return { body: `${posted}\n<sub>Run: ${runUrl}</sub>\n`, outcome };
}

export async function render(env = process.env, { gh = runGitHub, spawn = spawnSync } = {}) {
  try {
    const refs = await pullRefs({ pr: env.PR, repo: env.REPO, gh }).catch(() => noRefs());
    const published = spawn(
      process.execPath,
      [
        PUBLISH_CLI,
        '--run-dir', String(env.RUN_DIR ?? ''),
        '--pr', String(env.PR ?? ''),
        '--head-sha', refs.head,
        '--base-ref', refs.base,
        '--base-sha', refs.baseSha,
        '--trigger-phrase', String(env.PHRASE ?? ''),
        ...(usingControlPlane(env) ? ['--verify-only'] : []),
      ],
      { stdio: 'inherit' },
    );
    if (published.status !== 0) return 'rejected';
    return verdictOutcome(readJson(join(String(env.RUN_DIR ?? ''), VERDICT_FILE)));
  } catch {
    return 'rejected';
  }
}

export async function post(env = process.env, { gh = runGitHub, fetch = globalThis.fetch } = {}) {
  const runDir = String(env.RUN_DIR ?? '');
  if (usingControlPlane(env)) {
    const testReview = {
      verdict: readJson(join(runDir, VERDICT_FILE)),
      criteria: readJson(join(runDir, 'criteria.json')),
      environments: readJson(join(runDir, 'environments.json')),
      verification: readJson(join(runDir, 'verification.json')),
      spend: readJson(join(runDir, 'spend.json')),
      rendered_outcome: String(env.RENDERED_OUTCOME ?? ''),
      source_run: Number(env.SOURCE_RUN),
      trigger_phrase: String(env.PHRASE ?? ''),
    };
    const published = await writerFor({ env, fetch }).publishTestReview({ number: env.PR, testReview });
    return published.outcome;
  }
  const path = join(runDir, 'review.md');
  const current = await pullRefs({ pr: env.PR, repo: env.REPO, gh });
  const decided = reviewToPost({
    body: readText(path),
    rendered: env.RENDERED_OUTCOME,
    tested: testedRefs(readJson(join(runDir, 'criteria.json'))),
    current,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.REPO}/actions/runs/${env.SOURCE_RUN}`,
  });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, decided.body);
  const commented = await gh(['pr', 'comment', String(env.PR), '--repo', String(env.REPO), '--body-file', path], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (commented.code !== 0) throw new Error(commented.stderr.trim() || `gh pr comment ${env.PR} failed`);
  if (commented.stdout.trim()) console.log(commented.stdout.trim());
  return decided.outcome;
}

const COMMANDS = new Map([
  ['render', render],
  ['post', post],
]);

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const command = COMMANDS.get(String(argv[0] ?? ''));
  if (!command) throw new Error(`name a command: ${[...COMMANDS.keys()].join(' or ')}`);
  const outcome = await command(env, deps);
  writeOutputs(env.GITHUB_OUTPUT, {
    outcome,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
