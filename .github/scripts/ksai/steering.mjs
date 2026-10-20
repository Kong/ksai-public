import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import taskRequest from '../lib/task-request.cjs';
import controlPlane from '../lib/control-plane.cjs';
import { writeOutputs } from '../lib/outputs.mjs';

const API_VERSION = 'ksai.konghq.com/run-steering/v1alpha1';
const SUBJECT_VERSION = 'ksai.konghq.com/steering-subject-map/v1alpha1';
const TRIAGE_VERSION = 'triage/v2';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECORD_ID = /^[0-9a-f]{32}$/;
const JOB_ID = /^job_[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,159}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_TEXT_BYTES = 16 << 10;
const MAX_ENVELOPE_BYTES = 1 << 20;
const MAX_FILES = 3000;
const MAX_LINES = 1_000_000_000;

export class SteeringRefused extends Error {
  constructor(why) {
    super(`the control-plane steering decision is unavailable: ${why}`);
    this.name = 'SteeringRefused';
  }
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function closed(value, required, optional, where) {
  if (!plain(value)) throw new SteeringRefused(`${where} is not an object`);
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((name) => !allowed.has(name));
  const missing = required.filter((name) => !Object.hasOwn(value, name));
  if (extra.length || missing.length) {
    throw new SteeringRefused(`${where} has an unknown or absent field`);
  }
  return value;
}

const digestOf = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function same(left, right, where) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new SteeringRefused(`the later envelope changes ${where}`);
  }
}

function executionModelOf(value, where) {
  return closed(value, ['effort', 'model', 'state'], ['reasonCode'], where);
}

function currentEnvelope(raw, digest, env) {
  if (!DIGEST.test(String(digest)) || digestOf(raw) !== digest) {
    throw new SteeringRefused('the current envelope does not match its dispatch digest');
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new SteeringRefused('the current envelope is not JSON');
  }
  envelope = closed(envelope, ['action', 'apiVersion', 'record', 'route', 'stage'], [], 'the current envelope');
  if (envelope.apiVersion !== API_VERSION) throw new SteeringRefused('the current envelope has an unknown version');
  const record = closed(
    envelope.record,
    ['id', 'previousDigest', 'repository', 'revision', 'sourceRevision', 'subject'],
    [],
    'the current record',
  );
  const subject = closed(record.subject, ['apiVersion', 'execution', 'origin'], [], 'the current subject');
  const stage = closed(envelope.stage, ['attempt', 'deadline', 'instance', 'job', 'lease'], [], 'the current stage');
  const route = closed(
    envelope.route,
    ['authorization', 'classification', 'command', 'executionModel', 'flow'],
    [],
    'the current route',
  );
  closed(route.authorization, ['basisDigest', 'reason', 'reasonCode', 'verdict'], [], 'the current authorization');
  closed(
    route.classification,
    ['input', 'model', 'promptRelease', 'reason', 'reasonCode', 'receiptDigest', 'state', 'verdict'],
    [],
    'the current classification',
  );
  const executionModel = executionModelOf(route.executionModel, 'the current execution model');
  const action = closed(envelope.action, ['execute', 'kind'], [], 'the current action');
  const execute = closed(action.execute, ['collection', 'mode'], [], 'the current execution');
  const collection = closed(
    execute.collection,
    ['contract', 'endpoint', 'kind', 'maxBytes', 'retry', 'timeoutSeconds'],
    [],
    'the current collection',
  );
  const retry = closed(collection.retry, ['delaySeconds', 'maxAttempts'], [], 'the current retry policy');
  const expected = {
    'review-triage': '/v1/triage/review',
    'write-triage': '/v1/triage/write',
  };
  const repository = String(env.GITHUB_REPOSITORY ?? '').toLowerCase();
  const attempt = String(env.WORKFLOW_ATTEMPT ?? '');
  if (!RECORD_ID.test(record.id) || record.id !== env.RECORD_ID || record.revision < 1 || !Number.isSafeInteger(record.revision)
    || (record.previousDigest !== '' && !DIGEST.test(record.previousDigest)) || !REPOSITORY.test(repository)
    || record.repository !== repository || !SHA.test(record.sourceRevision) || record.sourceRevision !== env.SOURCE_REVISION
    || subject.apiVersion !== SUBJECT_VERSION || !plain(subject.execution) || !plain(subject.origin)
    || !JOB_ID.test(stage.job) || stage.job !== env.WORKFLOW_JOB || stage.instance !== env.WORKFLOW_INSTANCE
    || !INTEGER.test(attempt) || stage.attempt !== Number(attempt) || stage.lease !== env.WORKFLOW_LEASE
    || executionModel.state !== 'not-selected' || executionModel.model !== null || executionModel.effort !== null
    || executionModel.reasonCode !== 'collection-required'
    || action.kind !== 'execute' || execute.mode !== 'collect' || expected[collection.kind] !== collection.endpoint
    || collection.contract !== TRIAGE_VERSION || collection.maxBytes !== 262144 || collection.timeoutSeconds !== 30
    || retry.maxAttempts !== 3 || JSON.stringify(retry.delaySeconds) !== '[1,3]') {
    throw new SteeringRefused('the current envelope does not bind this exact stage');
  }
  return envelope;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseNumstat(raw) {
  if (raw === '') return [];
  return raw.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf('\t');
    const second = line.indexOf('\t', first + 1);
    if (first < 1 || second < first + 2) throw new SteeringRefused('git returned an unreadable file summary');
    const additions = line.slice(0, first) === '-' ? 0 : Number(line.slice(0, first));
    const deletions = line.slice(first + 1, second) === '-' ? 0 : Number(line.slice(first + 1, second));
    const path = line.slice(second + 1);
    if (!Number.isSafeInteger(additions) || additions < 0 || !Number.isSafeInteger(deletions) || deletions < 0
      || additions > MAX_LINES || deletions > MAX_LINES || path === '' || path.startsWith('/') || path.includes('\\')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new SteeringRefused('git returned an invalid file summary');
    }
    return { path, additions, deletions };
  });
}

function reviewEvidence(envelope, env, run) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const pullRequest = Number(env.STAGE_PULL);
  const baseRef = String(env.REVIEW_BASE_REF ?? '');
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}'], workspace);
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1 || !SAFE_NAME.test(baseRef) || baseRef.includes('..')
    || head !== envelope.record.sourceRevision) {
    throw new SteeringRefused('the review checkout does not match its control-plane subject');
  }
  const base = run(['merge-base', `refs/remotes/origin/${baseRef}`, head], workspace);
  if (!SHA.test(base)) throw new SteeringRefused('the review checkout has no verified merge base');
  try {
    const files = parseNumstat(run(['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`], workspace));
    const count = Number(run(['rev-list', '--count', `${base}..${head}`], workspace));
    const lines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_LINES || files.length > MAX_LINES || lines > MAX_LINES) {
      throw new SteeringRefused('the review checkout exceeds the evidence limit');
    }
    const complete = files.length <= MAX_FILES;
    return {
      pull_request: pullRequest,
      base_sha: base,
      changed_files: files.length,
      commit_count: count,
      files: files.slice(0, MAX_FILES),
      files_complete: complete,
      files_error: complete ? '' : `the checkout has more than ${MAX_FILES} changed files`,
    };
  } catch (error) {
    if (error instanceof SteeringRefused) throw error;
    return {
      pull_request: pullRequest,
      base_sha: base,
      changed_files: 0,
      commit_count: 0,
      files: [],
      files_complete: false,
      files_error: String(error?.message ?? error).slice(0, 1024),
    };
  }
}

function targetOf(env) {
  const pull = Number(String(env.STAGE_PULL ?? ''));
  const issue = Number(String(env.STAGE_ISSUE ?? ''));
  const work = String(env.STAGE_WORK_REF ?? '');
  const targets = Number(Number.isSafeInteger(pull) && pull > 0) + Number(Number.isSafeInteger(issue) && issue > 0) + Number(work !== '');
  if (targets !== 1) throw new SteeringRefused('the write task does not have one control-plane subject');
  return {
    pull_request: Number.isSafeInteger(pull) && pull > 0 ? pull : 0,
    issue_number: Number.isSafeInteger(issue) && issue > 0 ? issue : 0,
    work_ref: work,
  };
}

function planEvidence(env) {
  const path = String(env.PLAN_PATH ?? '');
  if (path === '') return { present: false, path: '', digest: '' };
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new SteeringRefused('the control-plane plan path is unsafe');
  }
  const workspace = realpathSync(String(env.GITHUB_WORKSPACE ?? ''));
  const file = resolve(workspace, path);
  if (!file.startsWith(`${workspace}${sep}`) || !existsSync(file) || lstatSync(file).isSymbolicLink()
    || !lstatSync(file).isFile() || !realpathSync(file).startsWith(`${workspace}${sep}`)) {
    return { present: false, path: '', digest: '' };
  }
  return { present: true, path, digest: digestOf(readFileSync(file)) };
}

function bounded(value, where) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new SteeringRefused(`${where} exceeds the evidence limit`);
  }
  return text;
}

async function writeEvidence(env, readTask) {
  const task = await readTask({ env, endpoint: env.CONTROL_PLANE_ENDPOINT });
  const request = task?.ready?.comment?.text ?? '';
  const target = targetOf(env);
  const workKey = target.work_ref.startsWith('jira/') ? target.work_ref.slice(5) : target.work_ref;
  const jira = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(workKey) ? workKey : '';
  return {
    ...target,
    request: bounded(request, 'the accepted request'),
    ask: '',
    jira_key: jira,
    conversation: '',
    threads: '',
    checks: '',
    prior_red: false,
    major_bump: { state: 'unknown', summary: '' },
    plan: planEvidence(env),
  };
}

async function evidenceRequest(envelope, digest, env, run, readTask) {
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}'], String(env.GITHUB_WORKSPACE ?? ''));
  if (!SHA.test(head) || head !== envelope.record.sourceRevision) {
    throw new SteeringRefused('the checkout does not match the steering source revision');
  }
  const kind = envelope.action.execute.collection.kind;
  const evidence = kind === 'review-triage'
    ? reviewEvidence(envelope, env, run)
    : await writeEvidence(env, readTask);
  return {
    api_version: TRIAGE_VERSION,
    record_id: envelope.record.id,
    steering_revision: envelope.record.revision,
    steering_digest: digest,
    run_head_sha: head,
    head_sha: head,
    evidence,
  };
}

function validatePlan(execute, advanced) {
  const phase = closed(execute.phase, ['after', 'approval', 'name', 'pass', 'planStep'], [], 'the run phase');
  const approval = closed(phase.approval, ['id', 'state'], [], 'the phase approval');
  const model = closed(execute.model, ['effort', 'id'], [], 'the run model');
  const runtime = closed(execute.runtime, ['engine'], [], 'the run runtime');
  const policy = closed(
    execute.policy,
    ['allowedTools', 'deniedTools', 'packageProfile', 'policyDigest', 'profile'],
    [],
    'the run policy',
  );
  const prompt = closed(execute.prompt, ['id', 'sink'], ['priorFindings', 'reviewRules'], 'the run prompt');
  const executionModel = advanced.route.executionModel;
  if (!SAFE_NAME.test(model.id) || !SAFE_NAME.test(model.effort) || runtime.engine !== 'opencode-2'
    || !SAFE_NAME.test(policy.profile) || !Array.isArray(policy.allowedTools) || !Array.isArray(policy.deniedTools)
    || !SAFE_NAME.test(policy.packageProfile) || !DIGEST.test(policy.policyDigest)
    || policy.allowedTools.length === 0 || policy.deniedTools.length === 0
    || policy.allowedTools.some((tool) => typeof tool !== 'string' || tool === '')
    || policy.deniedTools.some((tool) => typeof tool !== 'string' || tool === '')
    || !SAFE_NAME.test(prompt.id) || !SAFE_NAME.test(prompt.sink) || !SAFE_NAME.test(phase.name)
    || !SAFE_NAME.test(phase.pass) || !['complete', 'await-approval', 'dispatch-successor'].includes(phase.after)
    || !['not-required', 'released'].includes(approval.state)
    || (approval.state === 'not-required' && approval.id !== '')
    || executionModel.state !== 'selected' || executionModel.model !== model.id || executionModel.effort !== model.effort) {
    throw new SteeringRefused('the later envelope has an incomplete run plan');
  }
  if (phase.planStep !== null) {
    const step = closed(phase.planStep, ['digest', 'id', 'index', 'path'], [], 'the run plan step');
    if (!SAFE_NAME.test(step.id) || !Number.isSafeInteger(step.index) || step.index < 0 || !DIGEST.test(step.digest)
      || step.path === '' || step.path.startsWith('/') || step.path.includes('\\')) {
      throw new SteeringRefused('the later envelope has an invalid plan step');
    }
  }
  return {
    run: true,
    complete: false,
    notice: '',
    model: model.id,
    effort: model.effort,
    promptId: prompt.id,
    promptSink: prompt.sink,
    profile: policy.profile,
    phase: phase.name,
    allowedTools: policy.allowedTools.join(','),
    disallowedTools: policy.deniedTools.join(','),
  };
}

function laterEnvelope(value, current, digest) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new SteeringRefused('the later envelope exceeds its byte limit');
  }
  const advanced = closed(value, ['action', 'apiVersion', 'record', 'route', 'stage'], [], 'the later envelope');
  const record = closed(
    advanced.record,
    ['id', 'previousDigest', 'repository', 'revision', 'sourceRevision', 'subject'],
    [],
    'the later record',
  );
  if (advanced.apiVersion !== API_VERSION || record.revision !== current.record.revision + 1
    || record.previousDigest !== digest || record.id !== current.record.id || record.repository !== current.record.repository
    || record.sourceRevision !== current.record.sourceRevision) {
    throw new SteeringRefused('the later envelope does not bind the current envelope');
  }
  same(record.subject, current.record.subject, 'the task subject');
  same(advanced.stage, current.stage, 'the stage lease');
  const route = closed(
    advanced.route,
    ['authorization', 'classification', 'command', 'executionModel', 'flow'],
    [],
    'the later route',
  );
  const executionModel = executionModelOf(route.executionModel, 'the later execution model');
  same(route.classification, current.route.classification, 'the route classification');
  same(route.authorization, current.route.authorization, 'the route authorization');
  if (route.flow !== current.route.flow || route.command !== current.route.command) {
    throw new SteeringRefused('the later envelope changes the task route');
  }
  const action = closed(advanced.action, ['kind'], ['execute', 'publish_notice', 'stand_down'], 'the later action');
  if (action.kind === 'publish_notice' || action.kind === 'stand_down') {
    const field = action.kind === 'publish_notice' ? 'publish_notice' : 'stand_down';
    if (Object.keys(action).some((name) => name !== 'kind' && name !== field)
      || executionModel.state !== 'not-selected' || executionModel.model !== null || executionModel.effort !== null
      || executionModel.reasonCode !== (action.kind === 'publish_notice' ? 'notice' : 'stand-down')) {
      throw new SteeringRefused('the later envelope has an inconsistent no-run action');
    }
    const notice = closed(action[field], [], ['reason', 'reasonCode'], `the ${field} action`);
    return { run: false, complete: true, notice: bounded(notice.reason ?? notice.reasonCode ?? action.kind, 'the action notice') };
  }
  if (action.kind !== 'execute' || !plain(action.execute) || Object.keys(action).some((name) => name !== 'kind' && name !== 'execute')
    || executionModel.state !== 'selected' || typeof executionModel.model !== 'string'
    || typeof executionModel.effort !== 'string' || executionModel.reasonCode !== undefined) {
    throw new SteeringRefused('the later envelope has an unknown action');
  }
  const execute = closed(
    action.execute,
    ['mode', 'model', 'phase', 'policy', 'prompt', 'review', 'runtime', 'write'],
    [],
    'the later execution',
  );
  if (execute.mode !== 'run' || !((plain(execute.review) && execute.write === null)
    || (execute.review === null && plain(execute.write)))) {
    throw new SteeringRefused('the later envelope has no single run contract');
  }
  return validatePlan(execute, advanced);
}

export async function askControlPlane({ env, endpoint, collection, body, fetchImpl = fetch, pause = delay }) {
  const timeout = collection.timeoutSeconds * 1000;
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, 'utf8') > collection.maxBytes) {
    throw new SteeringRefused('the evidence request exceeds the control-plane limit');
  }
  const reached = await controlPlane.reachedFor({
    env,
    endpoint,
    fetch: fetchImpl,
    timeout,
    holds: timeout * collection.retry.maxAttempts + collection.retry.delaySeconds.reduce((sum, value) => sum + value * 1000, 0),
    secret: controlPlane.mask,
  });
  if (reached.why) throw new SteeringRefused(reached.why);
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await pause(collection.retry.delaySeconds[attempt - 2] * 1000);
    const said = await controlPlane.answered(
      fetchImpl,
      `${reached.base}${collection.endpoint}`,
      { token: reached.token, body: encoded, timeout },
    );
    if (!said.why) return said.answer;
    const temporary = said.status === undefined || said.status === 408 || said.status === 429 || said.status >= 500;
    if (!temporary || attempt >= collection.retry.maxAttempts) throw new SteeringRefused(said.why);
  }
}

export async function resolveSteering({
  env = process.env,
  read = readFileSync,
  run = git,
  readTask = taskRequest.readTaskRequest,
  ask = askControlPlane,
} = {}) {
  const raw = read(String(env.STEERING_FILE ?? ''), 'utf8');
  const digest = String(env.STEERING_DIGEST ?? '');
  const current = currentEnvelope(raw, digest, env);
  const request = await evidenceRequest(current, digest, env, run, readTask);
  const advanced = await ask({
    env,
    endpoint: env.CONTROL_PLANE_ENDPOINT,
    collection: current.action.execute.collection,
    body: request,
  });
  return { request, advanced, plan: laterEnvelope(advanced, current, digest) };
}

export async function main(env = process.env) {
  if (!String(env.GITHUB_OUTPUT ?? '') || !String(env.RUNNER_TEMP ?? '')) {
    throw new SteeringRefused('the runner names no output or temporary directory');
  }
  const answer = await resolveSteering({ env });
  const file = join(env.RUNNER_TEMP, 'ksai-run-steering.json');
  writeFileSync(file, JSON.stringify(answer.advanced), { mode: 0o600 });
  writeOutputs(env.GITHUB_OUTPUT, {
    run: String(answer.plan.run),
    complete: String(answer.plan.complete),
    notice: answer.plan.notice,
    model: answer.plan.model ?? '',
    effort: answer.plan.effort ?? '',
    prompt_id: answer.plan.promptId ?? '',
    prompt_sink: answer.plan.promptSink ?? '',
    profile: answer.plan.profile ?? '',
    phase: answer.plan.phase ?? '',
    allowed_tools: answer.plan.allowedTools ?? '',
    disallowed_tools: answer.plan.disallowedTools ?? '',
    steering_file: file,
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
