import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import controlPlane from '../lib/control-plane.cjs';
import jsonSchema from '../lib/json-schema.cjs';
import { jobOf, linkId } from '../lib/link-protocol.mjs';
import OUTCOME_SCHEMA from '../lib/task-schemas/task-outcome-v1.json' with { type: 'json' };
import blockerModule from './blocker.cjs';
import planModule from './plan.cjs';
import trustedGit from './trusted-git.cjs';

const { blockerOf } = blockerModule;
const { planFilePathFor } = planModule;

export const FLOWS = Object.freeze(['implement', 'review', 'test', 'run']);
export const VERDICTS = Object.freeze(['pass', 'defect', 'ambiguous_requirement', 'infra_failure', 'insufficient_evidence']);
export const ENTRIES_MOST = 8;
export const FILES_MOST = 50;
const PATH_MOST = 512;
const BRANCH_MOST = 255;
const FINDINGS_MOST = 10_000;

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EFFECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = Object.freeze({ A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'added', T: 'modified' });
const CALL_MS = 30_000;

const prOf = (value) => {
  const pr = Number(String(value ?? '').trim());
  return Number.isSafeInteger(pr) && pr > 0 ? pr : null;
};
const shaOf = (value) => {
  const sha = String(value ?? '').trim();
  return SHA.test(sha) ? sha : null;
};

export function filesBetween(git, base, head) {
  if (!SHA.test(String(base)) || !SHA.test(String(head))) return null;
  const said = git(['diff', '--name-status', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '-M', base, head]);
  if (!said.ok) return null;
  const fields = String(said.stdout).split('\0').filter((one) => one !== '');
  const files = [];
  for (let at = 0; at < fields.length;) {
    const code = fields[at].charAt(0);
    const renamed = code === 'R' || code === 'C';
    const path = renamed ? fields[at + 2] : fields[at + 1];
    at += renamed ? 3 : 2;
    if (typeof path === 'string' && STATUSES[code]) files.push({ path, status: STATUSES[code] });
  }
  return { files: files.filter((one) => one.path.length <= PATH_MOST).slice(0, FILES_MOST), total: files.length };
}

const threadPr = (env) => prOf(env.PR_NUMBER) ?? prOf(env.REPORT_NUM);

function reviewOf(env) {
  let published;
  try {
    published = JSON.parse(String(env.REVIEW_PUBLISHED ?? ''));
  } catch {
    return null;
  }
  const reviewId = Number(published?.review_id);
  const findings = Number(published?.findings_total ?? 0);
  const pr = threadPr(env);
  const head = shaOf(env.REVIEW_HEAD_SHA);
  if (!pr || !head || !Number.isSafeInteger(reviewId) || reviewId <= 0) return null;
  return { kind: 'review', pr, head_sha: head, review_id: reviewId, findings: Number.isSafeInteger(findings) && findings >= 0 ? Math.min(findings, FINDINGS_MOST) : 0 };
}

function runOf(env, readBytes) {
  const conclusion = String(env.RUN_CONCLUSION ?? '').trim();
  const at = String(env.EXECUTION_FILE ?? '').trim();
  if (String(env.FLOW ?? '').trim() !== 'run' || !['success', 'failure'].includes(conclusion) || !at) return null;
  let bytes;
  try {
    bytes = readBytes(at);
  } catch {
    return null;
  }
  return { kind: 'run', conclusion, execution_sha256: createHash('sha256').update(bytes).digest('hex') };
}

function testOf(env, read) {
  const pr = threadPr(env);
  const head = shaOf(env.TEST_HEAD_SHA);
  const artifact = String(env.TEST_ARTIFACT_SHA256 ?? '').trim();
  if (!pr || !head || !SHA256.test(artifact) || !String(env.TEST_VERDICT_FILE ?? '').trim()) return null;
  let verdict;
  try {
    verdict = JSON.parse(read(String(env.TEST_VERDICT_FILE))).outcome;
  } catch {
    return null;
  }
  return VERDICTS.includes(verdict) ? { kind: 'test', pr, head_sha: head, verdict, artifact_sha256: artifact } : null;
}

export function outcomeEntries(env, { git = () => ({ ok: false }), read = (at) => readFileSync(at, 'utf8'), readBytes = (at) => readFileSync(at) } = {}) {
  const entries = [];
  const pr = prOf(env.PR_NUMBER);
  const phase = String(env.PHASE ?? '').trim();
  const planned = shaOf(env.PLAN_HEAD_SHA);
  const path = planned && ['plan', 'revise'].includes(phase) ? planFilePathFor({ branch: env.BRANCH, dir: env.PLAN_DIR }) : null;
  if (pr && planned && path && path.length <= PATH_MOST) entries.push({ kind: 'plan', pr, path, head_sha: planned });
  const pushed = shaOf(env.COMMIT_HEAD_SHA);
  const branch = String(env.BRANCH ?? '').trim();
  if (pr && pushed && branch && branch.length <= BRANCH_MOST) {
    const changed = filesBetween(git, String(env.BASE_SHA ?? '').trim(), pushed);
    entries.push({ kind: 'commit', pr, branch, head_sha: pushed, ...(changed ? { files_total: changed.total, files: changed.files } : {}) });
  }
  const opened = pushed ?? planned ?? shaOf(env.DRAFT_HEAD_SHA);
  const state = env.PR_READY === 'true' ? 'ready' : env.PR_OPENED === 'true' ? 'draft' : '';
  const effect = String(env.PR_EFFECT_ID ?? '').trim();
  if (pr && opened && state) entries.push({ kind: 'pull_request', pr, state, head_sha: opened, ...(EFFECT.test(effect) ? { effect_id: effect } : {}) });
  const review = reviewOf(env);
  if (review) entries.push(review);
  const test = testOf(env, read);
  if (test) entries.push(test);
  const ran = runOf(env, readBytes);
  if (ran) entries.push(ran);
  return entries.slice(0, ENTRIES_MOST);
}

export function outcomeBody(env, entries, options) {
  const flow = String(env.FLOW ?? '').trim();
  const phase = String(env.PHASE ?? '').trim();
  if (!FLOWS.includes(flow)) throw new Error(`the run names flow ${JSON.stringify(flow)}, which reports no outcome`);
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(phase)) throw new Error(`the run names phase ${JSON.stringify(phase)}, which reports no outcome`);
  const job = jobOf(env);
  const link = linkId({ repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job });
  const blocked = env.BLOCKED === 'true' && env.STOPPED !== 'true';
  const status = env.PUBLISH_FAILED === 'true' ? 'failed' : entries.length ? 'published' : blocked ? 'blocked' : 'nothing';
  const blocker = status === 'blocked' ? blockerOf(env, options) : '';
  const body = { job, link, flow, phase, status, ...(blocker ? { blocker } : {}), published: entries };
  const problems = jsonSchema.validateSchema(OUTCOME_SCHEMA, body, 'outcome');
  if (problems.length) throw new Error(`this run's outcome breaks its schema: ${problems.slice(0, 3).join('; ')}`);
  return body;
}

const CONFLICT_TRIES = 6;
const CONFLICT_WAIT_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const passing = (status) => status === 409 || status === undefined || status === 429 || status >= 500;

export async function outcomeSent({ endpoint, fetch, token, body, wait = sleep }) {
  const sending = JSON.stringify(body);
  for (let tried = 1; ; tried += 1) {
    const said = await controlPlane.answered(fetch, `${endpoint}/v1/run/tasks/outcome`, { token, body: sending, timeout: CALL_MS });
    if (!said.why) return { sent: true };
    if (!passing(said.status) || tried >= CONFLICT_TRIES) {
      throw new Error(`the control plane did not keep this run's outcome: ${said.why}${tried > 1 ? ` after ${tried} tries` : ''}`);
    }
    await wait(CONFLICT_WAIT_MS * tried);
  }
}

export async function main(env = process.env, { fetch = globalThis.fetch, reach = controlPlane.reachedFor, git = trustedGit.directGit(String(env.GITHUB_WORKSPACE ?? '')), log = (line) => console.log(line) } = {}) {
  const body = outcomeBody(env, outcomeEntries(env, { git }));
  const reached = await reach({ env, fetch, timeout: CALL_MS, secret: controlPlane.mask });
  if (reached.why) throw new Error(reached.why);
  await outcomeSent({ endpoint: reached.base, fetch, token: reached.token, body });
  log(`reported this run's outcome: ${body.status}, ${body.published.map((one) => one.kind).join(', ') || 'nothing published'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.log(`::error::this run's outcome was not reported, so the control plane holds no receipt of what it published: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
