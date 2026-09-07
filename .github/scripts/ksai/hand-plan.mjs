import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { planFilePathFor } = require('./plan.cjs');
const { safeEcho } = require('./verify-chunk.cjs');
const { extractGivenPlan } = require('../lib/plan-given.cjs');
import { writeOutputs } from '../lib/outputs.mjs';

export function stageGivenPlan({
  request = null,
  branch = null,
  planDir = null,
  workspace = null,
  manifestPath = null,
  write = writeFileSync,
  makeDir = mkdirSync,
} = {}) {
  const given = extractGivenPlan(request);
  if (given.error) return { written: false, error: given.error };

  const planPath = planFilePathFor({ branch, dir: planDir });
  if (!planPath) {
    return {
      written: false,
      error:
        `I could not name a plan document for branch \`${safeEcho(String(branch ?? ''))}\` under ` +
        `\`${safeEcho(String(planDir ?? ''))}\`, so the handed-in plan was not written.`,
    };
  }

  const root = String(workspace ?? '');
  const document = path.resolve(root, planPath);
  const manifest = String(manifestPath ?? '').trim() || path.resolve(root, '.ksai-manifest.json');

  try {
    makeDir(path.dirname(document), { recursive: true });
    write(document, given.document);
    write(
      manifest,
      `${JSON.stringify({ status: 'ready', title: given.title, summary: given.summary, reason: '' }, null, 2)}\n`,
    );
  } catch (failed) {
    return { written: false, error: `the handed-in plan could not be written: ${safeEcho(String(failed?.message ?? failed))}` };
  }

  return { written: true, error: '', planPath };
}

export function main(env = process.env) {
  const result = stageGivenPlan({
    request: env.PROMPT,
    branch: env.BRANCH,
    planDir: env.PLAN_DIR,
    workspace: env.GITHUB_WORKSPACE,
    manifestPath: env.MANIFEST,
  });

  writeOutputs(env.GITHUB_OUTPUT, {
    written: result.written ? 'true' : 'false',
  });

  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  process.stdout.write(`Wrote the handed-in plan to ${result.planPath}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
