import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { deliveriesAt, trustedRootAt } from '../governance/anchors.mjs';
import shipped from '../governance/trust.json' with { type: 'json' };
import { digest } from '../governance/artifacts.mjs';
import { MAX_CARRIED_TURNS } from '../governance/conversation.mjs';
import { linkTrust, verifyLinkCertificate } from '../governance/link-certificate.mjs';
import { STATUS_TOOL, TOOL_PREFIX_V2 } from '../governance/release.mjs';
import { bare, planToolsDigest, resumeTrust, verifyResumePermit } from '../governance/resume-permit.mjs';
import { adversarial } from '../ksai/implement-adversarial.mjs';
import implementPasses from '../ksai/implement-passes.cjs';
import { forgetDeliveries } from '../lib/channel-hook.mjs';
import controlPlane from '../lib/control-plane.cjs';
import modelCatalog from '../lib/model-catalog.cjs';
import { MODEL_SHAPE } from '../lib/select-arm.cjs';
import { ARTIFACTS, deliveriesUnder, digestOf, lockedOf } from '../lib/cp-prompts.mjs';
import { exitedOn } from '../lib/execution-log.mjs';
import { acknowledging } from '../lib/link-acknowledged.mjs';
import { jobOf, linkId } from '../lib/link-protocol.mjs';
import { linkClient, pollTransport, websocketTransport } from './link-client.mjs';
import { ordered } from '../ksai/progress.mjs';
import taskRequest from '../lib/task-request.cjs';
import { isolatedToolPhase, parsed, PROVIDER_TIMEOUTS, totals, UNCONTINUED } from '../lib/opencode.mjs';
import { answer, everything, executionLog, openCallOf, reportedVersion, rootSessions, SHELL_TIMEOUT_MS, spending, toolCalls, V2_MASKED_HOMES, validateV2Version } from '../lib/opencode-v2.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { annotation } from '../lib/text.cjs';
import requestIntent from '../lib/request-intent.cjs';
import selectArm from '../lib/select-arm.cjs';
import writeRecord from '../lib/write-record.cjs';
import watchdogLimits from '../lib/watchdog.cjs';
import { hypothesesOf } from '../lib/review-hypotheses.mjs';
import { reviewAnswerOf } from '../lib/review-output.cjs';
import { governedTools } from './governed-flow.mjs';
import { auditContext, verifyAudit } from './governed-review.mjs';
import reviewPipeline from './review-pipeline.cjs';
import { collectSecrets, scrub } from './secrets.cjs';
import { serveBounded } from './bounded-ask.mjs';
import { controlPlaneCheck, GUARD_CHECK, guardHost, guardToken, requestGate } from './guard-check.mjs';
import { startProviderRelay } from './opencode-provider-relay.mjs';
import { USAGE_ASK, usageCollector } from './usage-collector.mjs';
import { COUNTERS, callUsage } from './usage-counter.mjs';
import { usageFileOf } from './usage-source.mjs';
import { observationsIn } from './provider-observations.mjs';
import { monitorProcess, runtimeSummary, sandboxArgs, since } from './opencode-run.mjs';
import { mcpServerCount, traceObserver } from './opencode-runtime.mjs';
import { RESTORED_EXPORT, Unapplied, checkpointBaseOf, checkpointSaved, checkpointUpload, restoredFrom } from './link-checkpoint.mjs';
import { outcomeExpected } from './link-expect.mjs';
import { transcriptOf, transcriptSent } from './link-transcript.mjs';
import { published } from './link-publish.mjs';
import { toolIsolationProbe } from './opencode-tool-sandbox.mjs';
import { compactions, streamFailure, toolTiming } from './opencode-v2-review.mjs';
import { EXPORT_FILE, RESUME_ERROR, RESUME_EXPORT, SESSION_FILE, resumeError } from './opencode-v2-link.mjs';
import { main as writeConfig } from './opencode-v2-config.mjs';
import { main as reduceLog } from './opencode-v2-log.mjs';
import { startRelay } from './otel-relay.mjs';

const REMINDER_ID = 'static.runtime.opencode-max-steps';
const KILL_GRACE_MS = 10_000;
const ENGINE_STOP_MS = 45_000;
const KILLED_EXIT = 137;
const CANCELLING = Object.freeze(['SIGINT', 'SIGTERM']);
const CANCELLED = 'the job was cancelled, so the run stopped itself and the engine was told it was not lost';
const { repairRequest } = implementPasses;
const { spendAttemptOf } = writeRecord;
const { MAX_CEILING_MINUTES, SALVAGE_MARGIN_MINUTES, ceilingMinutes, wholeNumber } = watchdogLimits;
const SESSION_ENV = Object.freeze(['KSAI_GOVERNED_STEPS']);
const JOB = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const JOB_INDEX = /^\d{1,4}$/;
const REPORTED_MOST = 256;
const STAGE_MOST = 32;
const UPDATE_MOST = 2000;
const TOOL_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const RECEIPTS_MOST = 64;
const OBSERVED_PART_BYTES = 2359296;
const OBSERVED_MOST = 32 * 1024 * 1024;
export const HOST_INPUTS = Object.freeze(['DIFF_PATCH', 'DIFF_FILES', 'REPO', 'PR_NUMBER', 'BRANCH', 'BASE_SHA', 'CHECKPOINT_BASE_SHA', 'CHECKPOINT_PR_NUMBER', 'DENIED_PATHS', 'GOVERNED_PLUGIN']);
export const MODEL_SPAN = 'http.client POST';
export const SPANS = Object.freeze([MODEL_SPAN, 'ServerProcess.start', 'PluginSupervisor.activate', 'SessionRunner.drain', 'SessionRunner.runStep', 'SessionStep.attempt', 'Tool.execute']);

const PROBE_TIMEOUT_MS = 60_000;
const linkScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-link.mjs');
const driverScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-driver.mjs');
const preserveScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/link-preserve.mjs');
const checkpointScript = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/link-checkpoint.mjs');

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

function catalogModel(env, wanted) {
  if (!wanted) return wanted;
  try {
    const at = String(env.KSAI_MODEL_CATALOG ?? '').trim();
    const { models } = JSON.parse(at === '' ? String(env.KSAI_MODEL_CATALOG_JSON ?? '') : readFileSync(at, 'utf8'));
    const found = models.find((one) => one?.runnable === true
      && [one.id, ...(Array.isArray(one.aliases) ? one.aliases : [])]
        .some((name) => String(name ?? '').toLowerCase() === wanted.toLowerCase()));
    const id = typeof found?.id === 'string' ? found.id : '';
    const aliased = [modelCatalog.aliases, modelCatalog.vendorAliases].some((names) => Object.hasOwn(names ?? {}, id.toLowerCase()));
    return MODEL_SHAPE.test(id) && !aliased ? id : wanted;
  } catch {
    return wanted;
  }
}

export function runFact(env, now = Date.now()) {
  const deadline = deadlineOf(env, now);
  const steps = Number(env.KSAI_GOVERNED_STEPS ?? 0);
  const flow = String(env.FLOW ?? '').trim();
  const plugin = String(env.GOVERNED_PLUGIN ?? '').trim();
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
    model: catalogModel(env, String(env.MODEL ?? '').trim()),
    variant: String(env.VARIANT ?? '').trim(),
    steps: Number.isInteger(steps) && steps > 0 ? steps : 0,
    tools: governedTools(env),
    deadline_ms: Math.max(0, Math.floor(deadline)),
    shell_timeout_ms: Number(env.KSAI_SHELL_TIMEOUT_MS) || SHELL_TIMEOUT_MS,
    ...(flow === 'review' ? { strategy: String(env.REVIEW_STRATEGY || 'baseline').trim() } : {}),
    ...(plugin ? { plugin } : {}),
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
    if (name === 'command') continue;
    try {
      if (!Object.hasOwn(known, name)) throw new Error('this host holds no such fact');
      facts.push({ name, value: known[name]() });
    } catch (error) {
      warn(annotation(`the ${name} fact could not be given: ${error?.message ?? error}`, 'warning'));
      missing.push(name);
    }
  }
  const command = asked.includes('run') || asked.includes('command') ? known.command?.() ?? null : null;
  if (command !== null) facts.push({ name: 'command', value: command });
  if (asked.includes('run') && !asked.includes('checkout') && Object.hasOwn(known, 'checkout')) facts.push({ name: 'checkout', value: known.checkout() });
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

export function commandFact(env) {
  const command = selectArm.canonicalCommand(String(env.KSAI_ROUTE_COMMAND ?? '').trim());
  const source = String(env.KSAI_ROUTE_SOURCE ?? '').trim();
  if (!selectArm.COMMANDS.includes(command) || !requestIntent.SOURCES.includes(source)) return null;
  return JSON.stringify({ command, source });
}

export function usageOf(session, model, segment) {
  const { usage } = totals(spending(segment));
  const count = (value) => Math.max(0, Math.round(Number(value) || 0));
  return {
    session, model, input: count(usage.input_tokens), output: count(usage.output_tokens),
    cache_read: count(usage.cache_read_input_tokens), cache_write: count(usage.cache_creation_input_tokens),
  };
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

const shellTimeout = (input, limit) => {
  const asked = Number(input?.timeout);
  return asked > 0 ? Math.min(Math.ceil(asked), limit) : limit;
};

export function progressOf(session, segment, reported, secrets = [], shellTimeoutMs = SHELL_TIMEOUT_MS, open = new Map()) {
  const calls = [];
  let status = null;
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
      status = { stage: clipped(scrub(call.input.stage, secrets), STAGE_MOST), update: clipped(scrub(call.input.update, secrets), UPDATE_MOST) };
    }
  }
  const { usage } = totals(spending(segment));
  const shared = {
    session,
    tokens: { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_write: usage.cache_creation_input_tokens },
    subagents: rootSessions(segment).children.size,
  };
  const reports = [];
  for (let at = 0; at === 0 || at < calls.length; at += REPORTED_MOST) reports.push({ ...shared, calls: calls.slice(at, at + REPORTED_MOST) });
  return status ? [...reports.slice(0, -1), { ...reports.at(-1), status }] : reports;
}

const rendering = (request) => {
  const parsedRequest = JSON.parse(request);
  return { request, promptId: String(parsedRequest.prompt_id ?? ''), sink: String(parsedRequest.sink ?? '') };
};

const CAPABILITIES = `;ksai-stage-correction-v1;${GUARD_CHECK.capability};ksai-render-schema-digest-v1`;

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

export function renderForEngine(render, schemaDigest) {
  if (schemaDigest) return render.request;
  const request = JSON.parse(render.request);
  if (!Object.hasOwn(request, 'schema_digest')) return render.request;
  delete request.schema_digest;
  return JSON.stringify(request);
}

export const askedRender = (named, flow) => (named ? { promptId: named.prompt_id, sink: named.sink } : { promptId: flow.promptId, sink: flow.sink });

export function stagesFact(env) {
  const held = JSON.parse(readFileSync(`${String(env.PROMPT_FILE ?? '')}.pipeline.json`, 'utf8'));
  const scoping = held.scoping ? { ...held.scoping, scopes: held.scoping.scopes.map(({ context: _context, patch: _patch, ...scope }) => scope) } : null;
  return JSON.stringify({ prior: String(held.prior ?? ''), scoping, identity: held.identity ?? {} });
}

export function stageRead(segment, said) {
  const failure = streamFailure(segment)?.kind ?? '';
  const [result] = executionLog({ events: segment, exitCode: 0, said });
  const usage = spending(segment).length ? JSON.stringify({ ...result.usage, cost_usd: result.total_cost_usd, num_turns: result.num_turns }) : '';
  return { failure, usage, packet: (said && reviewPipeline.packet(said)) || null };
}

export function keptReview(env, events, outputs) {
  if (!outputs.review || !outputs.ledger) return {};
  const secrets = collectSecrets(env);
  const ledger = JSON.parse(outputs.ledger);
  const reviewFile = `${events}.review.json`;
  const ledgerFile = `${events}.pipeline.json`;
  writeFileSync(reviewFile, scrub(outputs.review, secrets));
  writeFileSync(ledgerFile, scrub(outputs.ledger, secrets));
  const hypotheses = hypothesesOf(ledger);
  const hypothesesFile = hypotheses ? `${events}.hypotheses.json` : '';
  if (hypotheses) writeFileSync(hypothesesFile, scrub(JSON.stringify(hypotheses), secrets));
  return { OPENCODE_REVIEW_EXIT: ledger.coverage === 'complete' ? '0' : '1', OPENCODE_REVIEW_FILE: reviewFile, REVIEW_PIPELINE_FILE: ledgerFile, REVIEW_HYPOTHESES_FILE: hypothesesFile };
}

export function keptAnswer(env, events, conclusion, outputs, worked) {
  const kept = keptReview(env, events, outputs);
  if (kept.OPENCODE_REVIEW_FILE) return kept;
  const review = String(env.FLOW ?? '').trim() === 'review';
  if (review && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY)) return {};
  const answerFile = `${events}.answer`;
  if (!worked && existsSync(answerFile)) return { OPENCODE_REVIEW_FILE: answerFile };
  if (!review && !worked?.answer) return {};
  const said = !worked || (review && conclusion !== 'success') ? '' : review ? reviewAnswerOf(worked.answer ?? null, worked.whole ?? null) : worked.answer;
  writeFileSync(answerFile, scrub(String(said ?? ''), collectSecrets(env)));
  return { OPENCODE_REVIEW_FILE: answerFile };
}

const linkDirOf = (root, session) => join(root, 'link', session.replace(/[^A-Za-z0-9._-]/g, '_'));

export const skillsOf = (root, session, plugin) => join(linkDirOf(root, session), 'plugins', plugin, 'skills');

function layPlugin(dir, plan, plugin) {
  const files = plan.statics.filter((one) => one.destination);
  if (!files.length) return;
  const { version } = plan.prompt.catalog;
  const locked = lockedOf(Buffer.from(plan.prompt.catalog.lock, 'base64'), version);
  for (const one of files) {
    const entry = locked.get(one.id);
    const governs = plugin && one.destination.startsWith(`plugins/${plugin}/`) && !one.destination.split('/').includes('..');
    if (!governs || !entry || entry.dynamic || entry.body_digest !== digestOf(one.body) || !(entry.destinations ?? []).includes(one.destination)) {
      throw new Error(`the plan lays ${one.destination} down, which prompt release ${version} does not record for the ${plugin || 'no'} plugin`);
    }
  }
  for (const one of files) {
    const at = join(dir, one.destination);
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    writeFileSync(at, one.body, { mode: 0o600 });
  }
}

export function layGoverned(root, session, plan, { plugin = '', promptId = '', carried = null } = {}) {
  const dir = linkDirOf(root, session);
  mkdirSync(join(dir, ARTIFACTS.tools), { recursive: true, mode: 0o700 });
  layPlugin(dir, plan, plugin);
  const statics = new Map(plan.statics.map((one) => [one.id, one.body]));
  writeFileSync(join(dir, ARTIFACTS.prompt), plan.prompt.text, { mode: 0o600 });
  if (carried) writeFileSync(join(dir, ARTIFACTS.original), plan.resume.original.text, { mode: 0o600 });
  for (const name of plan.tools) {
    const body = statics.get(`${TOOL_PREFIX_V2}${name}`);
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

export function usageCountersOf(env) {
  const asked = String(env.KSAI_USAGE_COUNTERS ?? '').trim();
  if (asked === '' || asked === COUNTERS) return { collecting: asked === COUNTERS, error: '' };
  return { collecting: false, error: `KSAI_USAGE_COUNTERS asks for ${JSON.stringify(asked.slice(0, 64))}, and this runner counts usage only as ${COUNTERS}, so it refuses rather than report the legacy way while claiming to count` };
}

export function stoppable(held) {
  held.stopped = new Promise((resolve) => {
    held.stop = resolve;
  });
  return held;
}

export const untilKilled = (held, waited) => Promise.race([waited, held.stopped]);

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
} = {}) {
  const runnerTemp = String(env.RUNNER_TEMP ?? '');
  const endpoint = String(env.KSAI_CP_ENDPOINT ?? '').trim();
  const governedDir = String(env.KSAI_GOVERNED_DIR ?? '').trim();
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  if (!runnerTemp || !endpoint || !governedDir || !events || !execution) {
    console.log('::error::a linked run needs RUNNER_TEMP, KSAI_CP_ENDPOINT, KSAI_GOVERNED_DIR, EVENTS_FILE and EXECUTION_FILE');
    return 1;
  }
  const { collecting, error: uncountable } = usageCountersOf(env);
  if (uncountable) {
    console.log(annotation(uncountable));
    return 1;
  }
  let job;
  let render;
  let run;
  let schemaDigest = false;
  try {
    job = jobOf(env);
    render = renderFact(env);
    run = runFact(env);
  } catch (error) {
    console.log(annotation(error.message));
    return 1;
  }
  let usage = null;
  if (collecting) {
    const link = linkId({ repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job });
    try {
      usage = usageCollector({ path: usageFileOf(runnerTemp, link), scope: { link, job, flow: run.flow }, send: (kind, id, body) => client.send(kind, id, body) });
    } catch (error) {
      console.log(annotation(`this run's usage counter could not be opened, so it does not link: ${error?.message ?? error}`));
      return 1;
    }
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
  const sockets = join(scratch, 'relays');
  mkdirSync(sockets, { mode: 0o700 });
  const relayEnv = { ...env, KSAI_PROVIDER_OBSERVATIONS: 'true', KSAI_PROMPT_RENDERING: 'cp' };
  let telemetry = null;
  let provider = null;
  const traces = traceObserver({ arm: String(env.MODEL ?? '').trim(), model: MODEL_SPAN, mcp: '' });
  const metrics = [];
  try {
    telemetry = await startTelemetry({ env: relayEnv, socket: join(sockets, 'otel.sock'), spans: SPANS, observe: traces.observe });
  } catch (error) {
    console.log(annotation(`runtime telemetry could not start (${error?.message}), so span timings are unavailable`, 'warning'));
  }
  try {
    provider = await startProvider({
      env: relayEnv, socket: join(sockets, 'provider.sock'), stallMs: PROVIDER_TIMEOUTS.headerTimeout, queries: ['', '?beta=true'],
      counted: collecting ? (session, model, relayed) => usage?.counted(session, model, callUsage({ ...relayed, model })) : null,
      admit: collecting ? (session, model) => usage?.admit(session, model) ?? '' : null,
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
  const guardSocket = await serveBounded(join(sockets, 'guard.sock'), guarding.handle, {
    requestMost: GUARD_CHECK.bytesMost + (1 << 20), answerMost: GUARD_CHECK.answerMost, within: GUARD_CHECK.readWithinMs, refused: guarding.refused,
  });
  const plugins = await listening(join(sockets, 'link.sock'));
  const out = openSync(events, 'a');
  let settled = null;
  let reduced = 1;
  let shown = { published: '', record_dir: '' };
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
  const audits = new Map();
  const policies = new Map();
  const probed = new Map();
  const recorded = {};
  let certificate = null;
  let restoredCheckpoint = null;
  let configuredMcp = null;
  let resolveDone;
  const finished = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const cancel = () => resolveDone({ conclusion: 'failure', outputs: [{ name: 'error', value: CANCELLED }], reason: 'cancelled' });
  cancelled.addEventListener('abort', cancel, { once: true });

  const acknowledged = acknowledging(runnerTemp);
  const client = linkClient({
    endpoint,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    job,
    transports: { websocket: websocketTransport(reach, { asks: collecting ? USAGE_ASK : {} }), poll: pollTransport(reach, job, { fetch, asks: collecting ? USAGE_ASK : {} }) },
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
      schemaDigest = body.render?.schema_digest === true;
      usage?.welcomed(body);
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
        const unadmitted = usage?.admit(session, plan.model.id) ?? '';
        if (unadmitted) {
          console.log(annotation(unadmitted));
          held.killed = true;
          held.child?.kill('SIGKILL');
          return;
        }
        let dir;
        try {
          const permit = carriedPlan(plan, {
            resumes: held.resumes, restored: join(governedDir, 'link', RESTORED_EXPORT), endpoint, pinned, env, job, link: client.link,
          });
          dir = layGoverned(governedDir, session, plan, { plugin: run.plugin, promptId: held.promptId, carried: permit?.carried ?? null });
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
          }
          held.killed = true;
          held.child?.kill('SIGKILL');
          return;
        }
        held.prompt = join(dir, ARTIFACTS.prompt);
        provider.govern(dir, session);
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
  const reportRecords = (session, held) => {
    if (!usage || usage.legacy()) client.send('usage', undefined, usageOf(session, run.model, parsed(since(events, held.offset))));
    reportKept(session, false);
  };
  const usageDelivered = async () => {
    if (!usage) return;
    await Promise.race([provider.drained(), finished]);
    await Promise.race([usage.delivered(() => client.ping()), finished]);
  };

  const reportProgress = (session, held) => {
    if (!held.plugin) return;
    for (const report of progressOf(session, readOn(events, held), held.reported, secrets, run.shell_timeout_ms, held.open)) client.send('progress', undefined, report);
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
  const startSession = async ({ session, phase, render: named, restarts, resumes, env: given = [] }) => {
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
    if (audits.has(session)) verifyAudit(env, audits.get(session));
    const asked = askedRender(named, render);
    const held = stoppable({ plugin: null, waiting: [], offset: statSync(events).size, read: 0, seen: [], child: null, killed: false, promptId: asked.promptId, reported: new Map(), open: sessions.get(session)?.open ?? new Map(), resumes });
    sessions.set(session, held);
    if (usage) await untilKilled(held, usage.ready());
    const policy = policies.get(session) ?? policies.get(restarts ?? '') ?? {};
    const dir = mkdtempSync(join(scratch, 'session-'));
    chmodSync(dir, 0o700);
    held.dir = dir;
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
    const skills = run.plugin ? skillsOf(governedDir, session, run.plugin) : '';
    if (skills) mkdirSync(skills, { recursive: true, mode: 0o700 });
    const sessionEnv = {
      ...env,
      OPENCODE_CONFIG: config,
      OPENCODE_MODEL: run.model,
      OPENCODE_PHASE: phase,
      OPENCODE_SKILLS: skills,
      KREVIEW_PLUGIN_ROOT: '',
      REVIEW_RESULT_TRANSPORT: 'text',
      KSAI_LINK_DIR: dir,
      KSAI_LINK_SESSION: session,
      KSAI_CHANNEL_KILL_AT: '0',
      KSAI_CHANNEL_ARMED_AT: '0',
      KSAI_CHANNEL_NONCE: '',
      KSAI_GOVERNED_TOOLS: run.tools.join(','),
      KSAI_GOVERNED_STEPS: String(run.steps),
      ...policy,
      ...allowed,
      KSAI_TRUSTED_ROOT: trustedRootAt(governedDir),
      KSAI_RENDER_PROMPT_ID: asked.promptId,
      KSAI_RENDER_SINK: asked.sink,
      KSAI_TRUST_PINS: JSON.stringify(pinned),
      KSAI_PROVIDER_RELAY: '',
      KSAI_PROVIDER_SOCKET: join(sockets, 'provider.sock'),
      KSAI_OTEL_RELAY: '',
      KSAI_TOKEN_DIR: '',
      KSAI_TOKEN_FILE: '',
    };
    if (writeConfig(sessionEnv) !== 0) throw new Error(`the OpenCode config for session ${session} could not be written`);
    configuredMcp = mcpServerCount(JSON.parse(readFileSync(config, 'utf8')));
    const sandbox = sandboxArgs(sessionEnv, undefined, undefined, undefined, V2_MASKED_HOMES, sockets);
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
    held.offset = statSync(events).size;
    held.read = held.offset;
    const began = Date.now();
    telemetry?.beginObservation();
    const finishTrace = traces.begin(began);
    held.child = launch('bwrap', [...sandbox, process.execPath, linkScript(env)], { env: sessionEnv, stdio: ['ignore', out, 'inherit'] });
    const stopMonitoring = monitor(held.child.pid);
    held.child.once('close', async (code, signal) => {
      const exited = exitedOn(code, signal);
      const ended = Date.now();
      const segment = parsed(since(events, held.offset));
      metrics.push({
        invocation: metrics.length + 1, exit_code: exited, total_ms: Math.max(0, ended - began),
        ...compactions(segment, began), ...finishTrace(ended), ...stopMonitoring(), ...toolTiming(segment, began, ended),
      });
      reportProgress(session, held);
      const { exit, killed } = await closedThenDrained(held, exited, usageDelivered);
      reportRecords(session, held);
      const kept = keptSession(dir, governedDir, session);
      const handed = held.resumeError ?? refusedResumeIn(dir);
      const replayed = handed || !held.prompt ? '' : provider.carryRefused(dirname(held.prompt));
      const refused = handed || (replayed ? resumeError(`the governor refused the carried history: ${replayed}`) : '');
      if (replayed) appendFileSync(events, `${JSON.stringify({ type: 'ksai.error', created: Date.now(), data: { error: { type: 'ksai.resume', message: refused } } })}\n`);
      const unaccounted = usage?.ending().error ?? '';
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
      const known = { run: () => JSON.stringify(run), render: () => renderForEngine(render, schemaDigest), stages: () => stagesFact(env), command: () => commandFact(env), checkout: () => checkout };
      client.send('facts', id, factsAnswer(body.facts, known));
      return;
    }
    if (kind === 'session.start') {
      try {
        await startSession(body);
      } catch (error) {
        console.log(annotation(`session ${body.session} could not start: ${error?.message ?? error}`));
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
        ...(arg('read') === 'stage' && read.packet ? [{ name: 'packet', value: JSON.stringify(read.packet) }] : []),
      ];
      client.send('task.result', id, { ok: said.trim() !== '', outputs });
      return;
    }
    if (kind === 'task' && body.name === 'render-audit') {
      const after = sessions.get(arg('after'));
      if (!after?.prompt) throw new Error(`session ${arg('after')} left no prompt to audit it against`);
      const described = auditContext({ ...env, REVIEW_PROMPT_FILE: after.prompt });
      audits.set(arg('session'), { inputs: [{ name: 'audit_context', value: described }] });
      client.send('task.result', id, { ok: true, outputs: [{ name: 'context', value: JSON.stringify(described) }] });
      return;
    }
    if (kind === 'task' && body.name === 'render-adversarial') {
      const origin = sessions.get(arg('origin'));
      if (!origin?.prompt) throw new Error(`session ${arg('origin')} left no prompt for an independent run to read it against`);
      const said = adversarial({ ...env, PHASE: run.phase, PROMPT_FILE: origin.prompt });
      if (!said.request_file) {
        client.send('task.result', id, { ok: true, outputs: [{ name: 'request', value: '' }] });
        return;
      }
      const reading = { OPENCODE_ALLOWED: said.allowed_tools, OPENCODE_DISALLOWED: said.disallowed_tools };
      const tools = governedTools({ ...env, ...reading });
      policies.set(arg('session'), { ...reading, KSAI_GOVERNED_TOOLS: tools.join(',') });
      Object.assign(recorded, { DIFF_FILE: said.diff_file, CHANGED_FILES_FILE: said.changed_files_file });
      client.send('task.result', id, {
        ok: true, outputs: [{ name: 'request', value: readFileSync(said.request_file, 'utf8') }, { name: 'phase', value: 'review' }, { name: 'tools', value: tools.join(',') }],
      });
      return;
    }
    if (kind === 'task' && body.name === 'render-repair') {
      const origin = sessions.get(arg('origin'));
      const after = sessions.get(arg('after'));
      if (!origin?.prompt || !after) throw new Error(`no independent run of session ${arg('origin')} left findings to repair`);
      const { request, needed } = repairRequest({ ...env, ...recorded, PHASE: run.phase, PROMPT_FILE: origin.prompt }, after.answer ?? '');
      client.send('task.result', id, {
        ok: true, outputs: [{ name: 'request', value: needed ? JSON.stringify(request) : '' }, { name: 'phase', value: run.phase }, { name: 'tools', value: run.tools.join(',') }],
      });
      return;
    }
    if (kind === 'task' && body.name === 'publish') {
      const args = Object.fromEntries((body.args ?? []).map((one) => [one.name, one.value]));
      settle(args.conclusion, args);
      const said = await published(env, { execution, events, args, recordDir: join(runnerTemp, 'kreview-suppression'), fetch });
      shown = { published: said.summary, record_dir: said.recordDir };
      client.send('task.result', id, {
        ok: true, outputs: [{ name: 'record', value: said.record }, { name: 'pr', value: said.pr }, { name: 'suppression', value: said.suppression }],
      });
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
  const ended = await finished;
  const counted = usage?.ending();
  const settledOk = ended.conclusion === 'success' || ended.conclusion === 'stopped';
  const done = !counted?.error ? ended : settledOk
    ? { ...ended, conclusion: 'failure', outputs: [...ended.outputs, { name: 'error', value: counted.error }] }
    : { ...ended, outputs: [...ended.outputs, { name: 'warning', value: counted.error }] };
  await Promise.allSettled(uploads);
  cancelled.removeEventListener('abort', cancel);
  for (const held of sessions.values()) {
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
    conclusion: code === 0 ? 'success' : 'failure', answer_file: '', children_file: '', pipeline_file: env.REVIEW_PIPELINE_FILE || '', hypotheses_file: env.REVIEW_HYPOTHESES_FILE || '',
    stopped: ended.conclusion === 'stopped' ? 'true' : '',
    stopped_by: oneLine(outputs.stopped_by || (ended.conclusion === 'stopped' ? 'halt' : '')),
    stopped_because: oneLine(outputs.stopped_because),
    error: oneLine(outputs.error),
    ceiling: String(ceilingOf(env) ?? ''),
    model_never_asked: provider?.asked?.() === false ? 'true' : '',
    preserved: oneLine(outputs.preserved),
    preserve_reason: oneLine(outputs.preserve_reason),
    preserve_tree: String(outputs.preserve_tree ?? ''),
    published: shown.published,
    record_dir: shown.record_dir,
  });
  keepWorked(governedDir, outputs.worked);
  return reduced === 0 ? code : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cancelling = new AbortController();
  for (const signal of CANCELLING) process.once(signal, () => cancelling.abort());
  process.exitCode = await main(process.env, { cancelled: cancelling.signal });
}
