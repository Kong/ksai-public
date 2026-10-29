import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { deliveriesAt } from '../governance/anchors.mjs';
import shipped from '../governance/trust.json' with { type: 'json' };
import { digest } from '../governance/artifacts.mjs';
import { MAX_CARRIED_TURNS } from '../governance/conversation.mjs';
import { linkTrust, verifyLinkCertificate } from '../governance/link-certificate.mjs';
import { STATUS_TOOL, TOOL_PREFIX } from '../governance/release.mjs';
import { bare, planToolsDigest, resumeTrust, verifyResumePermit } from '../governance/resume-permit.mjs';
import { forgetDeliveries } from './channel-hook.mjs';
import controlPlane from '../lib/control-plane.cjs';
import { ARTIFACTS, deliveriesUnder, digestOf, lockedOf } from './cp-prompts.mjs';
import { exitedOn } from './execution-log.mjs';
import { acknowledging } from './link-acknowledged.mjs';
import { jobOf, linkId } from '../link/link-protocol.mjs';
import { linkClient, pollTransport, websocketTransport } from './link-client.mjs';
import taskRequest from '../lib/task-request.cjs';
import { isolatedToolPhase, parsed, PROVIDER_TIMEOUTS, totals, UNCONTINUED } from './opencode.mjs';
import { answer, everything, executionLog, openCallOf, reportedVersion, rootSessions, SHELL_TIMEOUT_MS, shellTimeoutMs as shellLimitMs, spending, toolCalls, validateV2Version } from './opencode-v2.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { reviewDeadlineAt, reviewTimeLeft } from '../lib/review-deadline.mjs';
import { annotation } from '../lib/text.cjs';
import watchdogLimits from './watchdog.cjs';
import { governedTools } from './governed-flow.mjs';
import { collectSecrets, scrub } from './secrets.cjs';
import { serveBounded } from './bounded-ask.mjs';
import { controlPlaneCheck, GUARD_CHECK, guardHost, guardToken, requestGate } from './guard-check.mjs';
import { startProviderRelay } from './opencode-provider-relay.mjs';
import { USAGE_ASK, usageCollector } from './usage-collector.mjs';
import { callUsage } from './usage-counter.mjs';
import { usageFileOf } from './usage-source.mjs';
import { observationsIn } from './provider-observations.mjs';
import { monitorProcess, runtimeSummary, sandboxArgs, since } from './opencode-run.mjs';
import { invocationIdentity, mcpServerCount, runtimeAttribution, traceObserver } from './opencode-runtime.mjs';
import { RESTORED_EXPORT, Unapplied, checkpointBaseOf, checkpointSaved, checkpointUpload, restoredFrom } from './link-checkpoint.mjs';
import { outcomeExpected } from './link-expect.mjs';
import { transcriptOf, transcriptSent } from './link-transcript.mjs';
import { toolIsolationProbe } from './opencode-tool-sandbox.mjs';
import { compactions, streamFailure, toolTiming } from './opencode-v2-review.mjs';
import { EXPORT_FILE, RESUME_ERROR, RESUME_EXPORT, SESSION_FILE, resumeError } from './opencode-v2-link.mjs';
import { main as writeConfig } from './opencode-v2-config.mjs';
import { main as reduceLog } from './opencode-v2-log.mjs';
import { startRelay } from './otel-relay.mjs';
import { assertPlanPolicy, policyTimeLeft, sessionPolicy, sessionPolicyEnv } from './link-session-policy.mjs';
import { GOVERNED_CAPABILITY, deliveryReport, isGoverned, layGovernedPlugin, pluginEntryOf, sessionDirOf, verifiedPlan } from './link-governed.mjs';

const REMINDER_ID = 'static.runtime.opencode-max-steps';
const KILL_GRACE_MS = 10_000;
const ENGINE_STOP_MS = 45_000;
const KILLED_EXIT = 137;
const CANCELLING = Object.freeze(['SIGINT', 'SIGTERM']);
const SOCKET_ROOT = '/tmp/ksai-';
const CANCELLED = 'the job was cancelled, so the run stopped itself and the engine was told it was not lost';
const { MAX_CEILING_MINUTES, SALVAGE_MARGIN_MINUTES, ceilingMinutes, wholeNumber } = watchdogLimits;
const SESSION_ENV = Object.freeze(['KSAI_SESSION_PLUGIN']);
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const JOB_INDEX = /^\d{1,4}$/;
const ATTEMPT_ID = /^\d{1,20}:\d{1,10}:[A-Za-z0-9_.~-]{1,40}:\d{1,10}$/;
const REPORTED_MOST = 256;
const STAGE_MOST = 32;
const UPDATE_MOST = 2000;
const RETRY_MOST = 1000;
const TOOL_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const RECEIPTS_MOST = 64;
const OBSERVED_PART_BYTES = 2359296;
const OBSERVED_MOST = 32 * 1024 * 1024;
export const HOST_INPUTS = Object.freeze(['DIFF_PATCH', 'DIFF_FILES', 'REPO', 'PR_NUMBER', 'BRANCH', 'BASE_SHA', 'CHECKPOINT_BASE_SHA', 'CHECKPOINT_PR_NUMBER', 'DENIED_PATHS']);
export const MODEL_SPAN = 'http.client POST';
export const SPANS = Object.freeze([MODEL_SPAN, 'ServerProcess.start', 'PluginSupervisor.activate', 'SessionRunner.drain', 'SessionRunner.runStep', 'SessionStep.attempt', 'Tool.execute']);

const PROBE_TIMEOUT_MS = 60_000;
const linkScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-link.mjs');
const driverScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-driver.mjs');
const preserveScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/link-preserve.mjs');
const checkpointScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/link-checkpoint.mjs');

function spendAttemptOf(env) {
  const job = String(env.GITHUB_JOB ?? '');
  const compact = job.length <= 40 ? job : `${job.slice(0, 27)}~${createHash('sha256').update(job).digest('hex').slice(0, 12)}`;
  const index = String(env.KSAI_JOB_INDEX ?? '').trim() || '0';
  const id = `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${compact}:${index}`;
  return ATTEMPT_ID.test(id) ? id : '';
}

export function spawned(command, args, { env = process.env, timeoutMs = PROBE_TIMEOUT_MS, launch = spawn } = {}) {
  return new Promise((done) => {
    const child = launch(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ status: 127, stdout, stderr: String(error?.message ?? error) });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      done({ status: exitedOn(status, signal), stdout, stderr });
    });
  });
}

const printed = (result) => `${result.stdout}${result.stderr}`.trim() || 'no output';

async function hostListener(listen = createServer) {
  const server = listen((socket) => socket.destroy());
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => ready(null));
  });
  const address = server.address();
  const close = () =>
    new Promise((done) => {
      server.close(() => done(null));
    });
  return { port: address && typeof address === 'object' ? address.port : 0, close };
}

export async function sandboxProblem(env, sandbox, run = spawned) {
  const version = await run('bwrap', [...sandbox, 'opencode', '--version'], { env });
  if (version.status !== 0) return `opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no session was started: ${printed(version)}`;
  try {
    validateV2Version(reportedVersion(version.stdout));
  } catch (error) {
    return error.message;
  }
  let isolated = null;
  if (isolatedToolPhase(env.OPENCODE_PHASE)) {
    try {
      isolated = toolIsolationProbe(env);
    } catch (error) {
      return `tool isolation could not be described: ${error.message}`;
    }
  }
  const host = await hostListener();
  try {
    const [network, nested] = await Promise.all([
      run('bwrap', [...sandbox, process.execPath, driverScript(env), 'probe', String(host.port)], { env }),
      isolated ? run('bwrap', [...sandbox, isolated.command, ...isolated.args], { env }) : null,
    ]);
    if (network.status !== 0) return `the OpenCode 2 sandbox is not the private network it must be: ${printed(network)}`;
    return nested === null || nested.status === 0 ? '' : `write-phase tools cannot enter their credential-free network namespace: ${printed(nested)}`;
  } finally {
    await host.close();
  }
}

export { jobOf };

export const oneLine = (value) => clipped(String(value ?? '').replace(/\s+/g, ' ').trim(), 500);

function ceilingOf(env) {
  const asked = String(env.JOB_TIMEOUT_MINUTES ?? '').trim();
  return asked === '0' ? MAX_CEILING_MINUTES : ceilingMinutes(asked);
}

function deadlineOf(env, now) {
  const review = reviewTimeLeft(env, now);
  if (review !== null) {
    const left = review - ENGINE_STOP_MS;
    if (left <= 0) throw new Error('the bounded review has no model time before its stop and cleanup reserve');
    const halt = Number(env.KSAI_CHANNEL_KILL_AT) || 0;
    const bounded = halt > 0 ? Math.min(left, Math.max(0, halt - now)) : left;
    if (bounded <= 0) throw new Error('the bounded review was stopped before this session could start');
    return bounded;
  }
  const killAt = Number(env.KSAI_CHANNEL_KILL_AT) || 0;
  if (killAt > now) return killAt - now;
  const given = Number(env.KSAI_DEADLINE_MS) || 0;
  if (given > 0) return given;
  const ceiling = ceilingOf(env);
  if (ceiling === null) throw new Error(`job_timeout_minutes ${String(env.JOB_TIMEOUT_MINUTES ?? '').trim()} names no ceiling this job can run under`);
  const started = Number(env.KSAI_JOB_STARTED_AT_MS) || now;
  return (ceiling - SALVAGE_MARGIN_MINUTES) * 60_000 - ENGINE_STOP_MS - Math.max(0, now - started);
}

function breakersOf(env) {
  const failures = wholeNumber(String(env.MAX_CONSECUTIVE_FAILURES ?? '').trim() || '0');
  if (failures === null) throw new Error(`max_consecutive_tool_failures must be a non-negative integer, got '${env.MAX_CONSECUTIVE_FAILURES}'`);
  const repeats = wholeNumber(String(env.MAX_REPEATED_CALLS ?? '').trim() || '0');
  if (repeats === null) throw new Error(`max_repeated_tool_calls must be a non-negative integer, got '${env.MAX_REPEATED_CALLS}'`);
  if (repeats === 1) {
    throw new Error('max_repeated_tool_calls of 1 would stop every run at its first tool call, since one call is already a run of one. Use 0 to turn the check off, or 2 or more');
  }
  return { failures, repeats };
}

export function runFact(env, now = Date.now()) {
  const deadline = deadlineOf(env, now);
  const steps = Number(env.KSAI_GOVERNED_STEPS ?? 0);
  const flow = String(env.FLOW ?? '').trim();
  const breakers = breakersOf(env);
  const status = String(env.STATUS_UPDATES ?? '').trim();
  const number = Number(String(env.REPORT_NUM ?? '').trim());
  const index = String(env.KSAI_JOB_INDEX ?? '').trim() || '0';
  const charged = spendAttemptOf(env);
  const job = String(env.GITHUB_JOB ?? '').trim();
  return {
    flow,
    title: 'ksai',
    phase: String(env.OPENCODE_PHASE ?? '').trim(),
    model: String(env.MODEL ?? '').trim(),
    variant: String(env.VARIANT ?? '').trim(),
    steps: Number.isInteger(steps) && steps > 0 ? steps : 0,
    tools: governedTools(env),
    deadline_ms: Math.max(0, Math.floor(deadline)),
    shell_timeout_ms: shellLimitMs(env),
    ...(breakers.failures || breakers.repeats ? { breakers } : {}),
    ...(status ? { status } : {}),
    ...(Number.isSafeInteger(number) && number > 0 ? { number } : {}),
    ...(charged ? { spend_attempt: charged } : {}),
    ...(JOB.test(job) && JOB_INDEX.test(index) ? { job, job_index: Number(index) } : {}),
  };
}

export function factsAnswer(asked, known, { warn = (said) => console.log(said) } = {}) {
  const facts = [];
  const missing = [];
  for (const name of asked) {
    try {
      if (!Object.hasOwn(known, name)) throw new Error('this host holds no such fact');
      const value = known[name]();
      if (value === null || value === undefined) throw new Error('this host holds no value for the fact');
      facts.push({ name, value });
    } catch (error) {
      warn(annotation(`the ${name} fact could not be given: ${error?.message ?? error}`, 'warning'));
      missing.push(name);
    }
  }
  return { facts, missing };
}

const COMMIT = /^[0-9a-f]{40}$/;

export function checkoutFact(env, run = spawnSync) {
  const at = String(env.GITHUB_WORKSPACE ?? '').trim();
  if (!at) throw new Error('a linked run names no workspace, so it cannot say which commit it works at');
  const said = run('git', ['-C', at, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  const head = String(said.stdout ?? '').trim();
  if (said.status !== 0 || !COMMIT.test(head)) throw new Error(`the workspace checkout has no commit git can name, so this run cannot say which commit it works at (git exited ${said.status ?? said.signal})`);
  const started = String(env.COMMIT_ID ?? '').trim();
  if (started !== '' && !COMMIT.test(started)) throw new Error('this run was started for a commit that is not a full lowercase commit id, so its checkout cannot be checked against it');
  if (started !== '' && started !== head) throw new Error(`the workspace checkout is at ${head}, and this run was started for ${started}, so it does not run on another commit than it names`);
  return JSON.stringify({ head_sha: head });
}

export function freshDeliveries(governedDir, delivered, whole = false) {
  const { deliveries } = deliveriesUnder({ files: [deliveriesAt(governedDir)], root: governedDir, whole });
  const fresh = deliveries.filter((one) => !delivered.has(JSON.stringify(one)));
  for (const one of fresh) delivered.add(JSON.stringify(one));
  const batches = [];
  for (let at = 0; at < fresh.length; at += RECEIPTS_MOST) batches.push({ deliveries: fresh.slice(at, at + RECEIPTS_MOST) });
  return batches;
}

export function freshObservations(env, observed, warn = (line) => console.log(line), answered = false) {
  const said = [];
  for (const { one, body } of observationsIn(env, observed, answered)) {
    observed.add(one.id);
    const record = {
      id: one.id, mode: one.mode, request_digest: one.request_digest, prompt_digest: one.prompt_digest, model: one.model,
      status: one.status, request_bytes: one.request_bytes, ...(one.continuation_digest ? { continuation_digest: one.continuation_digest } : {}),
    };
    if (body.length > OBSERVED_MOST) {
      warn(annotation(`provider observation ${one.id} is ${body.length} bytes, past the ${OBSERVED_MOST} the control plane takes, so the run cannot succeed`, 'warning'));
      said.push({ ...record, body: '', body_bytes: body.length, withheld: true });
      continue;
    }
    if (body.length <= OBSERVED_PART_BYTES) {
      said.push({ ...record, body: body.toString('base64') });
      continue;
    }
    const parts = Math.ceil(body.length / OBSERVED_PART_BYTES);
    const whole = { body_bytes: body.length, body_sha256: createHash('sha256').update(body).digest('hex') };
    for (let part = 0; part < parts; part += 1) {
      said.push({ ...record, body: body.subarray(part * OBSERVED_PART_BYTES, (part + 1) * OBSERVED_PART_BYTES).toString('base64'), part, parts, ...whole });
    }
  }
  return said;
}

const toolOf = (name) => (TOOL_SHAPE.test(name) ? name : String(name).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'unknown');

const clipped = (value, most) => [...String(value ?? '')].slice(0, most).join('');

const ordered = (value) => {
  try {
    return JSON.stringify(value, (_key, held) =>
      held && typeof held === 'object' && !Array.isArray(held)
        ? Object.fromEntries(Object.keys(held).sort().map((key) => [key, held[key]]))
        : held,
    );
  } catch {
    return null;
  }
};

const shellTimeout = (input, limit) => {
  const asked = Number(input?.timeout);
  if (asked > 0) return Math.min(Math.ceil(asked), limit);
  return input?.timeout === 0 || input?.background === true ? limit : Math.min(SHELL_TIMEOUT_MS, limit);
};

export function progressOf(session, segment, reported, secrets = [], shellTimeoutMs = SHELL_TIMEOUT_MS, open = new Map()) {
  const { usage } = totals(spending(segment));
  const shared = {
    session,
    tokens: { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_write: usage.cache_creation_input_tokens },
    subagents: rootSessions(segment).children.size,
  };
  const reports = [];
  let calls = [];
  const report = (status) => {
    for (let at = 0; at === 0 || at < calls.length; at += REPORTED_MOST) reports.push({ ...shared, calls: calls.slice(at, at + REPORTED_MOST) });
    if (status) reports.push({ ...reports.pop(), status });
    calls = [];
  };
  for (const call of toolCalls(segment, open)) {
    const ended = call.status === 'completed' || call.status === 'error';
    const key = `${call.session_id}\u0000${call.id}`;
    if (ended) open.delete(key);
    else open.set(key, openCallOf(call));
    if (!ended && !Number.isFinite(call.called)) continue;
    const state = ended ? 'ended' : 'started';
    const was = reported.get(key);
    if (was === state || was === 'ended') continue;
    reported.set(key, state);
    const input = ordered(call.input);
    const began = Number.isFinite(call.called) ? call.called : call.started;
    calls.push({
      tool: toolOf(call.tool), fingerprint: digest(`${call.tool}\u0000${input ?? `\u0000${key}`}`), failed: call.status === 'error', id: digest(key), state,
      ...(Number.isFinite(began) ? { began_ms: Math.max(0, Math.floor(began)) } : {}),
      ...(call.tool === 'shell' ? { timeout_ms: shellTimeout(call.input, shellTimeoutMs) } : {}),
    });
    if (call.tool === STATUS_TOOL && call.status === 'completed' && typeof call.input?.update === 'string') {
      report({ stage: clipped(scrub(call.input.stage, secrets), STAGE_MOST), update: clipped(scrub(call.input.update, secrets), UPDATE_MOST) });
    }
  }
  if (calls.length > 0 || reports.length === 0) report(null);
  const waiting = waitingOf(segment);
  return waiting ? [...reports.slice(0, -1), { ...reports.at(-1), waiting }] : reports;
}

export const sentProgress = (report, waitsTaken) => (waitsTaken ? report : Object.fromEntries(Object.entries(report).filter(([name]) => name !== 'waiting')));

export function waitingOf(segment) {
  let waiting = null;
  for (const event of segment) {
    if (event?.type === 'session.retry.scheduled') {
      const attempt = Number(event.data?.attempt);
      waiting = Number.isInteger(attempt) && attempt >= 2
        ? { reason: event.data?.error?.type === 'provider.rate-limit' ? 'rate-limit' : 'provider', attempt: Math.min(attempt, RETRY_MOST) }
        : null;
    } else if (event?.type !== 'session.step.started') {
      waiting = null;
    }
  }
  return waiting;
}

const rendering = (request) => {
  const parsedRequest = JSON.parse(request);
  return { request, promptId: String(parsedRequest.prompt_id ?? ''), sink: String(parsedRequest.sink ?? '') };
};

const CAPABILITIES = `;ksai-stage-correction-v1;${GUARD_CHECK.capability};ksai-render-schema-digest-v1;ksai-progress-waiting-v1;${GOVERNED_CAPABILITY}`;
const GUARD_BOUNDS = Object.freeze({ requestMost: GUARD_CHECK.bytesMost + (1 << 20), answerMost: GUARD_CHECK.answerMost });

export function capableRunner(runner) {
  return {
    ...runner,
    name: `${String(runner.name ?? '').slice(0, 200 - CAPABILITIES.length)}${CAPABILITIES}`,
  };
}

export function renderFact(env) {
  const at = String(env.REQUEST_FILE ?? '').trim();
  if (!at) throw new Error('a linked run was started with no render request');
  return rendering(readFileSync(at, 'utf8'));
}

export const askedRender = (named, flow) => (named ? { promptId: named.prompt_id, sink: named.sink } : { promptId: flow.promptId, sink: flow.sink });

export function stageRead(segment, said) {
  const failure = streamFailure(segment)?.kind ?? '';
  const [result] = executionLog({ events: segment, exitCode: 0, said });
  const usage = spending(segment).length ? JSON.stringify({ ...result.usage, cost_usd: result.total_cost_usd, num_turns: result.num_turns }) : '';
  return { failure, usage };
}

export function keptAnswer(env, events, conclusion, outputs, worked) {
  const answerFile = `${events}.answer`;
  if (!worked && existsSync(answerFile)) return { OPENCODE_ANSWER_FILE: answerFile };
  if (!worked?.answer) return {};
  const said = worked.answer;
  writeFileSync(answerFile, scrub(String(said ?? ''), collectSecrets(env)));
  return { OPENCODE_ANSWER_FILE: answerFile };
}

const linkDirOf = sessionDirOf;

const PLUGINS_UNDER = '_ksai';

export const skillsOf = (workspace, plugin) => join(workspace, PLUGINS_UNDER, 'plugins', plugin, 'skills');

function unlinkedTo(workspace, at) {
  for (let dir = dirname(at); dir.startsWith(join(workspace, PLUGINS_UNDER)); dir = dirname(dir)) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`the plan's plugin files would be laid through the link at ${dir}`);
  }
}

function layPlugin(workspace, plan, plugin) {
  const files = plan.statics.filter((one) => one.destination && !isGoverned(one));
  if (!files.length) return;
  const { version } = plan.prompt.catalog;
  const locked = lockedOf(Buffer.from(plan.prompt.catalog.lock, 'base64'), version);
  for (const one of files) {
    const entry = locked.get(one.id);
    const governs = PLUGIN_NAME.test(plugin) && one.destination.startsWith(`plugins/${plugin}/`) && !one.destination.split('/').includes('..');
    if (!governs || !entry || entry.dynamic || entry.body_digest !== digestOf(one.body) || !(entry.destinations ?? []).includes(one.destination)) {
      throw new Error(`the plan lays ${one.destination} down, which prompt release ${version} does not record for the ${plugin || 'no'} plugin`);
    }
  }
  if (!workspace) throw new Error(`the plan lays the ${plugin} plugin down, and the run names no workspace to lay it in`);
  for (const one of files) {
    const at = join(workspace, PLUGINS_UNDER, one.destination);
    unlinkedTo(workspace, at);
    if (existsSync(at) && !lstatSync(at).isSymbolicLink() && readFileSync(at, 'utf8') === one.body) continue;
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    unlinkedTo(workspace, at);
    const laid = `${at}.${process.pid}.laid`;
    writeFileSync(laid, one.body, { mode: 0o600 });
    renameSync(laid, at);
  }
}

export function layGoverned(root, session, plan, { plugin = '', promptId = '', carried = null, workspace = '' } = {}) {
  const dir = linkDirOf(root, session);
  mkdirSync(join(dir, ARTIFACTS.tools), { recursive: true, mode: 0o700 });
  layPlugin(workspace, plan, plugin);
  const statics = new Map(plan.statics.map((one) => [one.id, one.body]));
  writeFileSync(join(dir, ARTIFACTS.prompt), plan.prompt.text, { mode: 0o600 });
  if (carried) writeFileSync(join(dir, ARTIFACTS.original), plan.resume.original.text, { mode: 0o600 });
  for (const name of plan.tools) {
    const body = statics.get(`${TOOL_PREFIX}${name}`);
    if (body === undefined) throw new Error(`the plan governs the ${name} tool and carries no definition of it`);
    writeFileSync(join(dir, ARTIFACTS.tools, `${name}.json`), body, { mode: 0o600 });
  }
  if (plan.steps > 0) writeFileSync(join(dir, ARTIFACTS.reminder), statics.get(REMINDER_ID) ?? '', { mode: 0o600 });
  writeFileSync(join(dir, ARTIFACTS.expect), JSON.stringify({
    ...(promptId ? { promptId } : {}), finalDigest: digest(Buffer.from(plan.prompt.text, 'utf8')), model: plan.model.id, ...(plan.steps > 0 ? { steps: plan.steps } : {}),
    ...(carried ? { carried } : {}),
  }), { mode: 0o600 });
  return dir;
}

export class ResumeRefused extends Error {}

export function stoppable(held) {
  held.stopped = new Promise((resolve) => {
    held.stop = resolve;
  });
  return held;
}

export const untilKilled = (held, waited) => Promise.race([waited, held.stopped]);

const childExited = (child) => child.exitCode !== null || child.signalCode != null;

export async function stopReviewSessions(sessions, { schedule = setTimeout, unschedule = clearTimeout } = {}) {
  await Promise.allSettled([...sessions.values()].map((held) => {
    held.killed = true;
    held.stop?.();
    const child = held.child;
    if (!child || childExited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      const grace = schedule(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      child.once('close', () => {
        unschedule(grace);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }));
}

export function stopAtPolicy(policy, held, { now = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let stopping = null;
  const timer = schedule(() => {
    stopping = stopReviewSessions(new Map([['session', held]]), { schedule, unschedule });
  }, policyTimeLeft(policy, now(), ENGINE_STOP_MS));
  return { clear: () => unschedule(timer), wait: () => stopping };
}

export function answerBounded(text) {
  const cut = String(text ?? '').slice(0, 1_000_000);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export const endedSaid = (conclusion, said) => annotation(said, conclusion === 'stopped' ? 'notice' : 'error');

export async function closedThenDrained(held, exit, drain) {
  const killed = held.killed === true;
  await untilKilled(held, drain());
  return { exit, killed };
}

export function sessionEnd({ exit, killed, refused = '', unaccounted = '' }) {
  if (refused) return { exit: 1, conclusion: 'failed', resume_error: refused };
  if (unaccounted) return { exit: Math.max(1, Math.min(255, exit)), conclusion: killed ? 'killed' : 'failed' };
  return { exit: Math.min(255, Math.max(0, exit)), conclusion: conclusionOf(exit, killed) };
}

export function refusedResumeIn(dir) {
  try {
    const said = readFileSync(join(dir, RESUME_ERROR), 'utf8');
    return said ? resumeError(said) : '';
  } catch {
    return '';
  }
}

export function carriedPlan(plan, { resumes, restored, endpoint, pinned, env, job, link }) {
  if (!plan.resume && !resumes) return null;
  if (!plan.resume) throw new ResumeRefused('the engine started this session to resume a checkpoint and sent a plan that carries no permit');
  if (!resumes) throw new ResumeRefused('the plan carries a permit to resume, and the engine started this session to resume nothing');
  let verified;
  try {
    verified = verifyResumePermit(plan.resume.permit, resumeTrust(endpoint, pinned), {
      repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job, link,
      model: plan.model.id, variant: plan.variant ?? '', toolsDigest: planToolsDigest(plan),
      continuation: digest(Buffer.from(plan.prompt.text, 'utf8')), original: digest(Buffer.from(String(plan.resume.original?.text ?? ''), 'utf8')),
    });
  } catch (error) {
    throw new ResumeRefused(error.message);
  }
  if (verified.checkpoint !== resumes) throw new ResumeRefused('the permit names another checkpoint than the one this session resumes');
  let bytes;
  try {
    bytes = readFileSync(restored);
  } catch (error) {
    throw new ResumeRefused(`the restored export could not be read: ${error.code ?? error.message}`);
  }
  if (bytes.length !== verified.export.bytes || createHash('sha256').update(bytes).digest('hex') !== verified.export.sha256) {
    throw new ResumeRefused('the restored export is not the one the permit names');
  }
  return verified;
}

export const continuedBy = (plan, permit) => (permit?.carried.earlier ? digest(Buffer.from(plan.prompt.text, 'utf8')) : '');

export function conversationOf(held, conclusion) {
  const settled = held?.settled;
  if (!settled || !held.conversation || conclusion !== 'succeeded' || settled.turns > MAX_CARRIED_TURNS) return { resumable: false };
  return { resumable: true, history_sha256: bare(settled.history), turns: settled.turns, ...held.conversation };
}

export function keptSession(dir, root, session) {
  let id = '';
  try {
    id = readFileSync(join(dir, SESSION_FILE), 'utf8').trim();
  } catch {
    return {};
  }
  if (!/^ses_[A-Za-z0-9]{1,64}$/.test(id)) return {};
  let body;
  try {
    body = readFileSync(join(dir, EXPORT_FILE));
  } catch {
    return { opencode_session: id };
  }
  if (!body.length) return { opencode_session: id };
  const at = linkDirOf(root, session);
  mkdirSync(at, { recursive: true, mode: 0o700 });
  writeFileSync(join(at, EXPORT_FILE), body, { mode: 0o600 });
  return { opencode_session: id, export: { sha256: digest(body), bytes: body.length } };
}

export const WORKED_EXPORT = 'worked.export.json';

export function keepWorked(root, session) {
  const from = session ? join(linkDirOf(root, session), EXPORT_FILE) : '';
  if (!from || !existsSync(from)) return '';
  const at = join(root, 'link', WORKED_EXPORT);
  copyFileSync(from, at);
  return at;
}

export function readOn(file, held) {
  const text = since(file, held.read);
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  held.read += Buffer.byteLength(complete);
  held.seen.push(...parsed(complete));
  return held.seen;
}

export const conclusionOf =(code, killed) => (killed ? 'killed' : code === 0 ? 'succeeded' : code === 143 ? 'interrupted' : 'failed');

function listening(path) {
  const plugins = new Map();
  const arrivals = [];
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.once('line', (said) => {
      let hello;
      try {
        hello = JSON.parse(said);
      } catch {
        socket.destroy();
        return;
      }
      if (hello?.type !== 'hello' || typeof hello.session !== 'string' || typeof hello.key !== 'string') {
        socket.destroy();
        return;
      }
      const plugin = { socket, session: hello.session, key: Buffer.from(hello.key, 'base64'), listeners: [] };
      plugins.set(hello.session, plugin);
      lines.on('line', (next) => {
        try {
          const message = JSON.parse(next);
          for (const listener of plugin.listeners) listener(message);
        } catch {}
      });
      for (const arrived of arrivals.splice(0)) arrived(plugin);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve({
        arrived: (handler) => arrivals.push(handler),
        close: () => new Promise((done) => {
          server.close(() => done(null));
        }),
      });
    });
  });
}

export function childRunner(launch, env, scratch) {
  return async (script, extra, name, outName = 'CHECKPOINT_OUT') => {
    const file = join(scratch, name);
    rmSync(file, { force: true });
    const exit = await new Promise((resolve) => {
      const child = launch(process.execPath, [script], { env: { ...env, ...extra, [outName]: file }, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', () => resolve(-1));
      child.once('close', (code) => resolve(code));
    });
    try {
      return { exit, said: JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      return { exit, said: null };
    }
  };
}

export async function main(env = process.env, {
  launch = spawn, mintFor = controlPlane.minter, startProvider = startProviderRelay, startTelemetry = startRelay,
  pinned = shipped, dial = '', fetch = globalThis.fetch, monitor = monitorProcess, probe = sandboxProblem, cancelled = new AbortController().signal,
  socketRoot = SOCKET_ROOT,
} = {}) {
  const root = mkdtempSync(socketRoot);
  chmodSync(root, 0o700);
  try {
    return await linkHost(env, root, { launch, mintFor, startProvider, startTelemetry, pinned, dial, fetch, monitor, probe, cancelled });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function linkHost(env, root, { launch, mintFor, startProvider, startTelemetry, pinned, dial, fetch, monitor, probe, cancelled }) {
  const runnerTemp = String(env.RUNNER_TEMP ?? '');
  const endpoint = String(env.KSAI_CP_ENDPOINT ?? '').trim();
  const governedDir = String(env.KSAI_GOVERNED_DIR ?? '').trim();
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  if (!runnerTemp || !endpoint || !governedDir || !events || !execution) {
    console.log('::error::a linked run needs RUNNER_TEMP, KSAI_CP_ENDPOINT, KSAI_GOVERNED_DIR, EVENTS_FILE and EXECUTION_FILE');
    return 1;
  }
  let job;
  let render;
  let run;
  let reviewDue;
  try {
    job = jobOf(env);
    render = renderFact(env);
    run = runFact(env);
    reviewDue = reviewDeadlineAt(env);
  } catch (error) {
    console.log(annotation(error.message));
    return 1;
  }
  const link = linkId({ repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job });
  let usage = null;
  try {
    usage = usageCollector({ path: usageFileOf(runnerTemp, link), scope: { link, job, flow: run.flow }, send: (kind, id, body) => client.send(kind, id, body) });
  } catch (error) {
    console.log(annotation(`this run's usage counter could not be opened, so it does not link: ${error?.message ?? error}`));
    return 1;
  }
  let checkout;
  try {
    checkout = checkoutFact(env);
  } catch (error) {
    console.log(annotation(error.message));
    return 1;
  }
  const startedAt = JSON.parse(checkout).head_sha;
  const checkpointBase = checkpointBaseOf(env, startedAt);
  writeFileSync(events, '');
  writeOutputs(env.GITHUB_OUTPUT, { execution_file: execution });
  if (String(env.OPENCODE_RESUME_SESSION ?? '').trim()) console.log(`::warning::${UNCONTINUED}.`);

  const scratch = mkdtempSync(join(runnerTemp, 'ksai-link-'));
  chmodSync(scratch, 0o700);
  const sockets = join(root, 'relays');
  mkdirSync(sockets, { mode: 0o700 });
  const relayEnv = { ...env, KSAI_PROVIDER_OBSERVATIONS: 'true' };
  let telemetry = null;
  let provider = null;
  const traces = traceObserver({ arm: String(env.MODEL ?? '').trim(), model: MODEL_SPAN, mcp: '' });
  const attribution = runtimeAttribution();
  const metrics = [];
  try {
    telemetry = await startTelemetry({
      env: relayEnv, socket: join(sockets, 'otel.sock'), spans: SPANS,
      observe: (signal, payload) => {
        traces.observe(signal, payload);
        attribution.observe(signal, payload);
      },
    });
  } catch (error) {
    console.log(annotation(`runtime telemetry could not start (${error?.message}), so span timings are unavailable`, 'warning'));
  }
  try {
    provider = await startProvider({
      env: relayEnv, socket: join(sockets, 'provider.sock'), stallMs: PROVIDER_TIMEOUTS.headerTimeout, queries: ['', '?beta=true'],
      measure: attribution.measure,
      counted: (session, model, relayed) => usage?.counted(session, model, callUsage({ ...relayed, model })),
      admit: (session, model) => usage?.admit(session, model) ?? '',
    });
  } catch (error) {
    console.log(annotation(`the trusted provider relay could not start: ${error?.message ?? error}`));
    await telemetry?.close();
    rmSync(scratch, { recursive: true, force: true });
    return 1;
  }
  const mint = mintFor({ env, fetch, signal: undefined, holds: undefined });
  const guardCheck = controlPlaneCheck({ endpoint, fetchImpl: fetch, token: guardToken({ mintFor, env, fetchImpl: fetch }) });
  const guarding = guardHost({ provider, check: guardCheck });
  let guardSocket = null;
  let plugins = null;
  try {
    guardSocket = await serveBounded(join(sockets, 'guard.sock'), guarding.handle, {
      ...GUARD_BOUNDS, within: GUARD_CHECK.readWithinMs, refused: guarding.refused,
    });
    plugins = await listening(join(sockets, 'link.sock'));
  } catch (error) {
    console.log(annotation(`the link host could not listen for its sessions: ${error?.message ?? error}`));
    guardSocket?.close();
    await provider.close();
    await telemetry?.close();
    rmSync(scratch, { recursive: true, force: true });
    return 1;
  }
  const out = openSync(events, 'a');
  let settled = null;
  let reduced = 1;
  const settle = (conclusion, outputs) => {
    const error = String(outputs.error ?? '');
    if (settled?.error === error) return;
    if (settled === null) {
      const runtime = {
        ...runtimeSummary(metrics, configuredMcp), span_source: 'unauthenticated-unix-socket', compaction_source: 'unauthenticated-event-feed', event_source: 'unauthenticated-event-feed',
      };
      appendFileSync(events, `${JSON.stringify({ type: 'ksai_runtime', runtime })}\n`);
      settled = { runtime };
    }
    settled.error = error;
    if (error) appendFileSync(events, `${JSON.stringify({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.engine', message: clipped(error, 500) } } })}\n`);
    Object.assign(env, keptAnswer(env, events, conclusion, outputs, sessions.get(String(outputs.worked ?? ''))));
    const code = conclusion === 'success' || conclusion === 'stopped' ? 0 : 1;
    try {
      reduced = reduceLog({ ...env, OPENCODE_EXIT: String(code), OPENCODE_STOPPED: String(conclusion === 'stopped'), OPENCODE_EVENTS_FILE: events, OPENCODE_EXECUTION_FILE: execution, OPENCODE_RUNTIME_METRICS: JSON.stringify(settled.runtime) });
    } catch (failure) {
      reduced = 1;
      console.log(annotation(`the opencode event stream reducer failed (${failure?.message ?? failure})`, 'warning'));
    }
  };

  const reach = dial || endpoint;
  const sessions = new Map();
  const probed = new Map();
  let certificate = null;
  let restoredCheckpoint = null;
  let configuredMcp = null;
  let resolveDone;
  const finished = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const cancel = () => resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: CANCELLED }], reason: 'cancelled' });
  cancelled.addEventListener('abort', cancel, { once: true });
  let reviewExpired = false;
  let reviewInterrupted = false;
  let reviewStopping = null;
  const expireReview = async () => {
    reviewExpired = true;
    if (sessions.size && [...sessions.values()].every((held) => held.child && childExited(held.child))) return;
    reviewInterrupted = true;
    await stopReviewSessions(sessions);
    resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: 'the original bounded review deadline left no model time after the stop and cleanup reserve' }], reason: 'deadline' });
  };
  const reviewTimer = reviewDue === null ? null : setTimeout(() => {
    reviewStopping = expireReview();
  }, Math.max(0, reviewDue - Date.now() - ENGINE_STOP_MS));

  const acknowledged = acknowledging(runnerTemp);
  let waitsTaken = false;
  const client = linkClient({
    endpoint,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    job,
    transports: { websocket: websocketTransport(reach, { asks: USAGE_ASK }), poll: pollTransport(reach, job, { fetch, asks: USAGE_ASK }) },
    mint: () => mint('ksai-cp'),
    verifyCertificate: (cert, expected) => {
      const verified = verifyLinkCertificate(cert, linkTrust(endpoint, pinned), expected);
      certificate = cert;
      return verified;
    },
    runner: capableRunner({ name: String(env.RUNNER_NAME ?? 'unknown'), os: String(env.RUNNER_OS ?? 'unknown'), arch: String(env.RUNNER_ARCH ?? 'unknown') }),
    jobStartedAt: Number(env.KSAI_JOB_STARTED_AT_MS) || Date.now(),
    log: (line) => console.log(line),
    onAcked: (message) => {
      acknowledged(message);
      usage?.acked(message);
    },
    onWelcome: (body) => {
      usage?.welcomed(body);
      waitsTaken = body?.progress?.waiting === true;
    },
    onTick: () => {
      usage?.tick();
      let live = '';
      for (const [session, held] of sessions) {
        if (held.child && held.child.exitCode === null) {
          reportProgress(session, held);
          live = session;
        }
      }
      if (live) reportKept(live, true);
    },
    onLapse: () => resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: 'the link to the engine lapsed, so the run stopped itself' }], reason: 'lease' }),
    onEnded: (error) => resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: error.message }], reason: 'failed' }),
    onPlugin: (session, frame, message) => {
      const held = sessions.get(session);
      if (!held) return;
      if (message.kind === 'plan') {
        const plan = message.body;
        let dir;
        let verified;
        try {
          assertPlanPolicy(held.policy, plan);
          const unadmitted = usage?.admit(session, plan.model.id) ?? '';
          if (unadmitted) throw new Error(unadmitted);
          const permit = carriedPlan(plan, {
            resumes: held.resumes, restored: join(governedDir, 'link', RESTORED_EXPORT), endpoint, pinned, env, job, link: client.link,
          });
          verified = verifiedPlan(plan, {
            env, endpoint, pinned, governedDir, asked: { promptId: held.promptId, sink: held.sink }, carried: permit?.carried ?? null,
          });
          const workspace = String(env.GITHUB_WORKSPACE ?? '');
          dir = layGoverned(governedDir, session, plan, { plugin: held.laying ?? '', promptId: held.promptId, carried: permit?.carried ?? null, workspace });
          layGovernedPlugin(dir, plan, verified, {
            workspace, link: held.dir, asks: held.asks, flow: run.flow, content: { socket: join(sockets, 'guard.sock'), request_most: GUARD_BOUNDS.requestMost, answer_most: GUARD_BOUNDS.answerMost },
          });
          held.conversation = {
            render_sha256: permit?.carried.original ?? digest(Buffer.from(plan.prompt.text, 'utf8')), model: plan.model.id, variant: plan.variant ?? '',
            tools_sha256: bare(planToolsDigest(plan)),
          };
          held.continuation = continuedBy(plan, permit);
        } catch (error) {
          if (error instanceof ResumeRefused) {
            console.log(annotation(`session ${session} will not go on in its carried conversation, so the control plane starts it afresh: ${error.message}`, 'warning'));
            held.resumeError = resumeError(error);
          } else {
            console.log(annotation(`session ${session} was handed a plan this host will not lay down: ${error.message}`));
            deliveryReport(governedDir)('refused', error.message);
          }
          held.killed = true;
          held.child?.kill('SIGKILL');
          return;
        }
        held.prompt = join(dir, ARTIFACTS.prompt);
        provider.govern(dir, session, deliveryReport(governedDir, verified));
        if (plan.guard) provider.guard(requestGate({ required: plan.guard.required === true, check: guardCheck }));
      }
      if (held.plugin) held.plugin.socket.write(`${JSON.stringify({ type: 'frame', frame })}\n`);
      else held.waiting.push(frame);
    },
    onMessage: (message) => {
      handle(message).catch((error) => {
        console.log(annotation(`${message.kind} could not be handled: ${error?.message ?? error}`, 'warning'));
        if (message.kind === 'task') client.send('task.result', message.id, { ok: false, outputs: [], error: clipped(error?.message ?? error, 4000) });
      });
    },
  });

  const delivered = new Set();
  const observed = new Set();
  const secrets = collectSecrets(env);
  const say = (line) => console.log(line);
  const reportKept = (session, live) => {
    try {
      for (const receipt of freshDeliveries(governedDir, delivered, live)) client.send('receipt', undefined, receipt);
    } catch (error) {
      if (!live) say(annotation(`the prompts session ${session} was delivered could not be read: ${error?.message ?? error}`, 'warning'));
    }
    try {
      for (const seen of freshObservations(env, observed, say, live)) client.send('observation', undefined, seen);
    } catch (error) {
      if (!live) say(annotation(`what session ${session} sent the provider could not be read: ${error?.message ?? error}`, 'warning'));
    }
  };
  const reportRecords = (session) => {
    reportKept(session, false);
  };
  const usageDelivered = async () => {
    await Promise.race([provider.drained(), finished]);
    await Promise.race([usage.delivered(() => client.ping()), finished]);
  };

  const reportProgress = (session, held) => {
    if (!held.plugin) return;
    for (const report of progressOf(session, readOn(events, held), held.reported, secrets, held.policy.shell_timeout_ms, held.open)) client.send('progress', undefined, sentProgress(report, waitsTaken));
  };

  const uploads = [];
  const keepTranscript = async (session, model, segment) => {
    const lines = transcriptOf(segment, secrets);
    if (!lines.length) return;
    try {
      const { left, unserved } = await transcriptSent({ endpoint, fetch, token: await mint('ksai-cp'), link: client.link, job, flow: run.flow, session: model, lines });
      if (unserved) console.log(annotation(`the control plane keeps no transcript of session ${session}`, 'notice'));
      if (left) console.log(annotation(`session ${session} said ${left} more lines than a transcript keeps, so only its last ones were kept`, 'notice'));
    } catch (error) {
      console.log(annotation(`the transcript of session ${session} was not kept: ${error?.message ?? error}`, 'warning'));
    }
  };

  let expected = null;
  let accepted = null;
  const startSession = async ({ session, phase, render: named, policy: namedPolicy, restarts, resumes, env: given = [] }) => {
    if (reviewExpired) throw new Error('the original bounded review deadline stopped this stage');
    deadlineOf(env, Date.now());
    const policy = sessionPolicy(namedPolicy);
    policyTimeLeft(policy, Date.now(), ENGINE_STOP_MS);
    accepted ??= taskRequest.heldByLink({ env, endpoint, job, link: client.link, seen: env.KSAI_TASK_REQUEST, fetch }).catch((error) => {
      resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: error.message }], reason: 'failed' });
      throw error;
    });
    await accepted;
    if (String(env.KSAI_OUTCOME_EXPECTED ?? '').trim() === 'true') {
      expected ??= mint('ksai-cp').then((token) => outcomeExpected({ endpoint, fetch, token, job, link: client.link, flow: run.flow }));
      await expected;
    }
    if (restarts) forgetDeliveries(String(env.KSAI_CHANNEL_DIR ?? ''));
    const allowed = Object.fromEntries(given.filter((one) => SESSION_ENV.includes(one.name)).map((one) => [one.name, one.value]));
    const asked = askedRender(named, render);
    const laying = String(allowed.KSAI_SESSION_PLUGIN ?? '');
    if (laying && !PLUGIN_NAME.test(laying)) throw new Error(`session ${session} names the plugin ${JSON.stringify(laying.slice(0, 64))}, which is no plugin name`);
    const held = stoppable({
      plugin: null, laying, waiting: [], policy, offset: statSync(events).size, read: 0, seen: [], child: null, killed: false, promptId: asked.promptId, sink: asked.sink,
      reported: new Map(), open: sessions.get(session)?.open ?? new Map(), resumes,
    });
    sessions.set(session, held);
    held.deadlineStop = stopAtPolicy(policy, held);
    await untilKilled(held, usage.ready());
    if (held.killed) throw new Error('the session policy deadline stopped this stage');
    const dir = mkdtempSync(join(scratch, 'session-'));
    chmodSync(dir, 0o700);
    held.dir = dir;
    const asks = mkdtempSync(join(root, 's-'));
    chmodSync(asks, 0o700);
    held.asks = asks;
    if (resumes) {
      if (resumes !== restoredCheckpoint) throw new ResumeRefused('this attempt restored no checkpoint the session could resume');
      try {
        copyFileSync(join(governedDir, 'link', RESTORED_EXPORT), join(dir, RESUME_EXPORT));
        chmodSync(join(dir, RESUME_EXPORT), 0o600);
      } catch (error) {
        throw new ResumeRefused(`the restored export could not be bound into the session: ${error.code ?? error.message}`);
      }
    }
    const config = join(dir, 'opencode.json');
    const skills = laying ? skillsOf(String(env.GITHUB_WORKSPACE ?? ''), laying) : '';
    if (skills) mkdirSync(skills, { recursive: true, mode: 0o700 });
    const sessionEnv = sessionPolicyEnv(policy, {
      ...env,
      OPENCODE_CONFIG: config,
      OPENCODE_PHASE: phase,
      OPENCODE_SKILLS: skills,
      KREVIEW_PLUGIN_ROOT: '',
      KSAI_LINK_DIR: dir,
      KSAI_LINK_ASKS: asks,
      KSAI_LINK_SESSION: session,
      KSAI_CHANNEL_KILL_AT: '0',
      KSAI_CHANNEL_ARMED_AT: '0',
      KSAI_CHANNEL_NONCE: '',
      ...allowed,
      KSAI_GOVERNED_PLUGIN: pluginEntryOf(governedDir, session),
      KSAI_TRUST_PINS: JSON.stringify(pinned),
      KSAI_PROVIDER_RELAY: '',
      KSAI_PROVIDER_SOCKET: join(sockets, 'provider.sock'),
      KSAI_OTEL_RELAY: '',
    });
    policyTimeLeft(policy, Date.now(), ENGINE_STOP_MS);
    if (writeConfig(sessionEnv) !== 0) throw new Error(`the OpenCode config for session ${session} could not be written`);
    configuredMcp = mcpServerCount(JSON.parse(readFileSync(config, 'utf8')));
    const sandbox = sandboxArgs(sessionEnv, undefined, undefined, undefined, sockets);
    const isolation = isolatedToolPhase(phase);
    if (!probed.has(isolation)) probed.set(isolation, probe(sessionEnv, sandbox));
    const problem = await probed.get(isolation);
    if (problem) throw new Error(problem);
    plugins.arrived(function arrived(plugin) {
      if (plugin.session !== session) {
        plugins.arrived(arrived);
        return;
      }
      held.plugin = plugin;
      plugin.listeners.push((said) => {
        if (said.type === 'frame') client.relay(session, said.frame);
      });
      plugin.socket.write(`${JSON.stringify({ type: 'link', link: client.link, job, cert: certificate })}\n`);
      for (const frame of held.waiting.splice(0)) plugin.socket.write(`${JSON.stringify({ type: 'frame', frame })}\n`);
      client.send('session.started', `session/${session}/started`, { session, plugin_key: plugin.key.toString('base64') });
    });
    if (held.killed) {
      client.send('session.ended', `session/${session}/ended`, { session, ...sessionEnd({ exit: KILLED_EXIT, killed: true, refused: held.resumeError }) });
      return;
    }
    if (reviewExpired) throw new Error('the original bounded review deadline stopped this stage');
    deadlineOf(env, Date.now());
    policyTimeLeft(policy, Date.now(), ENGINE_STOP_MS);
    held.offset = statSync(events).size;
    held.read = held.offset;
    const began = Date.now();
    telemetry?.beginObservation();
    const finishTrace = traces.begin(began);
    const finishAttribution = attribution.begin(began);
    held.child = launch('bwrap', [...sandbox, process.execPath, linkScript(env)], { env: sessionEnv, stdio: ['ignore', out, 'inherit'] });
    const stopMonitoring = monitor(held.child.pid);
    held.child.once('close', async (code, signal) => {
      held.deadlineStop.clear();
      const exited = exitedOn(code, signal);
      const ended = Date.now();
      const segment = parsed(since(events, held.offset));
      metrics.push({
        invocation: metrics.length + 1, exit_code: exited, total_ms: Math.max(0, ended - began),
        ...invocationIdentity(session),
        ...compactions(segment, began), ...finishTrace(ended), ...stopMonitoring(), ...toolTiming(segment, began, ended),
        attribution: finishAttribution(ended, toolCalls(segment)),
      });
      reportProgress(session, held);
      const { exit, killed } = await closedThenDrained(held, exited, usageDelivered);
      reportRecords(session);
      const kept = keptSession(dir, governedDir, session);
      const handed = held.resumeError ?? refusedResumeIn(dir);
      const replayed = handed || !held.prompt ? '' : provider.carryRefused(dirname(held.prompt));
      const refused = handed || (replayed ? resumeError(`the governor refused the carried history: ${replayed}`) : '');
      if (replayed) appendFileSync(events, `${JSON.stringify({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.resume', message: refused } } })}\n`);
      const unaccounted = usage.ending().error;
      if (unaccounted) {
        console.log(annotation(`session ${session} ended with usage the control plane cannot take: ${unaccounted}`));
        appendFileSync(events, `${JSON.stringify({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.usage', message: clipped(unaccounted, 500) } } })}\n`);
      }
      const ending = sessionEnd({ exit, killed, refused, unaccounted });
      held.conclusion = ending.conclusion;
      held.settled = provider.settled();
      const carried = ending.resume_error ? {} : kept;
      client.send('session.ended', `session/${session}/ended`, { session, ...ending, ...carried });
      if (carried.opencode_session) uploads.push(keepTranscript(session, carried.opencode_session, segment));
    });
  };

  const childSaid = childRunner(launch, env, scratch);

  const handle = async (message) => {
    const { kind, id, body } = message;
    if (kind === 'need' && body.credential) {
      client.send('credential', id, { token: await mint('ksai-cp') });
      return;
    }
    if (kind === 'need') {
      const known = { run: () => JSON.stringify(run), render: () => render.request, checkout: () => checkout };
      client.send('facts', id, factsAnswer(body.facts, known));
      return;
    }
    if (kind === 'session.start') {
      try {
        await startSession(body);
      } catch (error) {
        console.log(annotation(`session ${body.session} could not start: ${error?.message ?? error}`));
        sessions.get(body.session)?.deadlineStop?.clear();
        if (!sessions.has(body.session)) sessions.set(body.session, { plugin: null, waiting: [], offset: statSync(events).size, child: null, killed: false });
        client.send('session.ended', `session/${body.session}/ended`, {
          session: body.session, exit: 1, conclusion: 'failed', ...(error instanceof ResumeRefused ? { resume_error: resumeError(error) } : {}),
        });
      }
      return;
    }
    const arg = (name) => String(body.args?.find((one) => one.name === name)?.value ?? '');
    if (kind === 'task' && body.name === 'answer') {
      const held = sessions.get(arg('session'));
      const segment = held ? parsed(since(events, held.offset)) : [];
      const said = answerBounded(answer(segment));
      if (held) Object.assign(held, { answer: said, whole: everything(segment) });
      const read = stageRead(segment, said);
      const outputs = [
        ...(said ? [{ name: 'answer', value: said }] : []),
        ...(read.failure ? [{ name: 'failure', value: read.failure }] : []),
        ...(read.usage ? [{ name: 'usage', value: read.usage }] : []),
      ];
      client.send('task.result', id, { ok: said.trim() !== '', outputs });
      return;
    }
    if (kind === 'task' && body.name === 'checkpoint') {
      const session = arg('session');
      const exported = readFileSync(join(linkDirOf(governedDir, session), EXPORT_FILE));
      const { exit, said } = await childSaid(checkpointScript(env), { CHECKPOINT_MODE: 'snapshot', CHECKPOINT_HEAD: startedAt }, 'checkpoint.json');
      if (exit !== 0 || !said || said.error) throw new Error(`the work could not be read: ${said?.error ?? `the checkpoint task exited ${exit}`}`);
      const upload = checkpointUpload({
        exported, patch: Buffer.from(said.patch, 'base64'), head: said.head, base: checkpointBase, parent: arg('parent'),
        promptVersion: arg('prompt_version'), link: client.link, job, flow: run.flow, secrets: collectSecrets(env),
        conversation: conversationOf(sessions.get(session), sessions.get(session)?.conclusion),
      });
      const saved = await checkpointSaved({
        endpoint, fetch, token: () => mint('ksai-cp'), upload, continuation: sessions.get(session)?.continuation ?? '', note: (dropped) => console.log(annotation(dropped, 'warning')),
      });
      client.send('task.result', id, { ok: true, outputs: [{ name: 'checkpoint', value: saved }] });
      return;
    }
    if (kind === 'task' && body.name === 'restore') {
      const outputs = await restoredFrom({
        endpoint, fetch, token: () => mint('ksai-cp'), link: client.link, job, flow: run.flow, promptVersion: arg('prompt_version'), base: checkpointBase,
        apply: async (patch, head) => {
          const patchFile = join(scratch, 'restore.patch');
          writeFileSync(patchFile, patch, { mode: 0o600 });
          const { exit, said } = await childSaid(checkpointScript(env), { CHECKPOINT_MODE: 'apply', CHECKPOINT_PATCH: patchFile, CHECKPOINT_HEAD: head }, 'restore.json');
          if (exit === 0 && said?.unapplied) throw new Unapplied(said.error);
          if (exit !== 0 || !said || said.error) throw new Error(`the checkpoint could not be restored: ${said?.error ?? `the restore task exited ${exit}`}`);
        },
        keep: (exported) => {
          const at = join(governedDir, 'link', RESTORED_EXPORT);
          if (exported === null) {
            rmSync(at, { force: true });
            return;
          }
          mkdirSync(join(governedDir, 'link'), { recursive: true, mode: 0o700 });
          writeFileSync(at, exported, { mode: 0o600 });
        },
      });
      const said = (name) => outputs.find((one) => one.name === name)?.value;
      restoredCheckpoint = said('status') === 'restored' ? said('checkpoint') : null;
      client.send('task.result', id, { ok: true, outputs });
      return;
    }
    if (kind === 'task' && body.name === 'preserve') {
      const { exit, said: kept } = await childSaid(preserveScript(env), { PRESERVE_STOPPED: arg('stopped'), PRESERVE_HARD: arg('hard'), PRESERVE_KILLED: arg('killed') }, 'preserve.json', 'PRESERVE_OUT');
      if (exit !== 0 || !kept) {
        client.send('task.result', id, { ok: false, outputs: [], error: `the stopped run's work could not be kept: the preserve task exited ${exit}` });
        return;
      }
      client.send('task.result', id, {
        ok: true, outputs: [{ name: 'preserved', value: String(kept.preserved ?? '') }, { name: 'preserve_reason', value: String(kept.reason ?? '') }, { name: 'preserve_tree', value: String(kept.tree ?? '') }],
      });
      return;
    }
    if (kind === 'task') {
      client.send('task.result', id, { ok: false, outputs: [], error: `this host runs no ${body.name} task` });
      return;
    }
    if (kind === 'kill') {
      const held = sessions.get(body.session);
      if (!held) return;
      held.killed = true;
      held.stop?.();
      if (!held.child) return;
      held.child.kill('SIGTERM');
      setTimeout(() => held.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      return;
    }
    if (kind === 'usage.source.answer') {
      usage?.answered(body);
      return;
    }
    if (kind === 'done') resolveDone({ ...body, reason: 'done' });
  };

  const linking = client.start();
  const received = await finished;
  if (reviewTimer !== null) clearTimeout(reviewTimer);
  await reviewStopping;
  const ended = reviewInterrupted ? { ...received, conclusion: 'failure', outputs: [...received.outputs, { name: 'error', value: 'the original bounded review deadline stopped this stage' }] } : received;
  const counted = usage?.ending();
  const settledOk = ended.conclusion === 'success' || ended.conclusion === 'stopped';
  const done = !counted?.error ? ended : settledOk
    ? { ...ended, conclusion: 'failure', outputs: [...ended.outputs, { name: 'error', value: counted.error }] }
    : { ...ended, outputs: [...ended.outputs, { name: 'warning', value: counted.error }] };
  await Promise.allSettled(uploads);
  cancelled.removeEventListener('abort', cancel);
  for (const held of sessions.values()) {
    held.deadlineStop?.clear();
    await held.deadlineStop?.wait();
    if (held.child && held.child.exitCode === null) {
      held.killed = true;
      held.child.kill('SIGKILL');
    }
  }
  await client.close(done.reason);
  await linking.catch(() => {});
  await plugins.close();
  await telemetry?.close();
  await new Promise((resolve) => { guardSocket.close(() => resolve()); });
  await provider?.close();

  const outputs = Object.fromEntries(done.outputs.map((one) => [one.name, one.value]));
  const code = done.conclusion === 'success' || done.conclusion === 'stopped' ? 0 : 1;
  settle(done.conclusion, outputs);
  closeSync(out);
  rmSync(scratch, { recursive: true, force: true });
  for (const warned of done.outputs.filter((one) => one.name === 'warning')) console.log(annotation(warned.value, 'warning'));
  if (outputs.error) console.log(endedSaid(done.conclusion, outputs.error));
  writeOutputs(env.GITHUB_OUTPUT, {
    conclusion: code === 0 ? 'success' : 'failure',
    events_file: events,
    stopped: ended.conclusion === 'stopped' ? 'true' : '',
    stopped_by: oneLine(outputs.stopped_by || (ended.conclusion === 'stopped' ? 'halt' : '')),
    stopped_because: oneLine(outputs.stopped_because),
    error: oneLine(outputs.error),
    ceiling: String(ceilingOf(env) ?? ''),
    model_never_asked: provider?.asked?.() === false ? 'true' : '',
    preserved: oneLine(outputs.preserved),
    preserve_reason: oneLine(outputs.preserve_reason),
    preserve_tree: String(outputs.preserve_tree ?? ''),
  });
  keepWorked(governedDir, outputs.worked);
  return reduced === 0 ? code : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cancelling = new AbortController();
  for (const signal of CANCELLING) process.once(signal, () => cancelling.abort());
  process.exitCode = await main(process.env, { cancelled: cancelling.signal });
}
