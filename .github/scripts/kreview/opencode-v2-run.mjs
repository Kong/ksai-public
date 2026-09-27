import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { conclusionOf, exitedOn } from '../lib/execution-log.mjs';
import { isolatedToolPhase, parsed, PROVIDER_TIMEOUTS } from '../lib/opencode.mjs';
import { answer, executionLog, reportedVersion, rootSessions, spending, V2_MASKED_HOMES, validateV2ProviderPolicyConfig, validateV2Version } from '../lib/opencode-v2.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { startProviderRelay } from './opencode-provider-relay.mjs';
import { clearKilled, finalizePtyMetrics, governedStageRun, keepReview, monitorProcess, reportExit, restartGoverned, runtimeSummary, sandboxArgs, since, singleRun, validateProviderPolicy } from './opencode-run.mjs';
import { completeStage, recoverReview, reviewSession } from './opencode-review.mjs';
import { ptyPilotEnabled } from './opencode-pty-core.mjs';
import { mcpServerCount, traceObserver } from './opencode-runtime.mjs';
import { toolIsolationProbe } from './opencode-tool-sandbox.mjs';
import { main as reduceLog } from './opencode-v2-log.mjs';
import { compactions, recordedCompletion, reviewAnswer, streamFailure, submitted, toolTiming } from './opencode-v2-review.mjs';
import { startRelay } from './otel-relay.mjs';

const PROVIDER_QUERIES = Object.freeze(['', '?beta=true']);

const STOP_GRACE_MS = 25_000;

export const MODEL_SPAN = 'http.client POST';

export const SPANS = Object.freeze([MODEL_SPAN, 'ServerProcess.start', 'PluginSupervisor.activate', 'SessionRunner.drain', 'SessionRunner.runStep', 'SessionStep.attempt', 'Tool.execute']);

const PROBE_TIMEOUT_MS = 60_000;

const driverOf = (env) => join(String(env.SCRIPTS ?? ''), 'kreview/opencode-v2-driver.mjs');

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

const said = (result) => `${result.stdout}${result.stderr}`.trim() || 'no output';

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
  if (version.status !== 0) return `opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no run was attempted: ${said(version)}`;
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
      run('bwrap', [...sandbox, process.execPath, driverOf(env), 'probe', String(host.port)], { env }),
      isolated ? run('bwrap', [...sandbox, isolated.command, ...isolated.args], { env }) : null,
    ]);
    if (network.status !== 0) return `the OpenCode 2 sandbox is not the private network it must be: ${said(network)}`;
    return nested === null || nested.status === 0 ? '' : `write-phase tools cannot enter their credential-free network namespace: ${said(nested)}`;
  } finally {
    await host.close();
  }
}

export function driverEnv(env, { resumeSession = '', finalize = false, pipeline = false, resultFile = '', resultKind = 'final', candidateIds = [] } = {}) {
  const governed = String(env.KSAI_GOVERNED_DIR ?? '') !== '';
  return {
    ...env,
    KSAI_AGENT: pipeline && !governed ? (finalize ? 'ksai-review-finish' : 'ksai-review-stage') : '',
    KSAI_RESUME_SESSION: governed ? '' : resumeSession || (env.FLOW === 'review' ? '' : String(env.OPENCODE_RESUME_SESSION ?? '').trim()),
    VARIANT: pipeline && finalize ? '' : String(env.VARIANT ?? '').trim(),
    KSAI_REVIEW_RESULT_FILE: resultFile,
    KSAI_REVIEW_RESULT_KIND: resultKind,
    KSAI_REVIEW_CANDIDATE_IDS: JSON.stringify(candidateIds),
  };
}

export async function main(env = process.env, { run = spawned, launch = spawn, startProvider = startProviderRelay, startTelemetry = startRelay, monitor = monitorProcess, governed = {} } = {}) {
  const home = String(env.OPENCODE_HOME ?? '');
  for (const name of ['config', 'cache', 'state']) mkdirSync(join(home, name), { recursive: true });
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  clearKilled(env.KSAI_KILLED_FILE);
  writeFileSync(events, '');
  writeOutputs(env.GITHUB_OUTPUT, { execution_file: execution });

  const runnerTemp = String(env.RUNNER_TEMP ?? '');
  if (!runnerTemp) {
    console.log('::error::an OpenCode 2 run needs RUNNER_TEMP for its relay sockets and results');
    return 1;
  }
  const resultTransport = env.FLOW === 'review' ? String(env.REVIEW_RESULT_TRANSPORT ?? '').trim() || 'tool' : 'text';
  if (!['text', 'tool'].includes(resultTransport)) {
    console.log(`::error::the ${resultTransport} review result transport has no OpenCode 2 equivalent`);
    return 1;
  }
  try {
    validateProviderPolicy(home, env.OPENCODE_VERSION, { validVersion: validateV2Version, validConfig: validateV2ProviderPolicyConfig });
  } catch (error) {
    console.log(`::error::${error.message}`);
    return 1;
  }

  const scratch = mkdtempSync(join(runnerTemp, 'opencode-v2-'));
  chmodSync(scratch, 0o700);
  const sockets = join(scratch, 'relays');
  mkdirSync(sockets, { mode: 0o700 });
  const resultDir = resultTransport === 'tool' ? join(scratch, 'results') : '';
  if (resultDir) mkdirSync(resultDir, { mode: 0o700 });
  const ptyMetrics = ptyPilotEnabled(env) ? join(scratch, 'pty-metrics.json') : '';
  if (ptyMetrics) {
    writeFileSync(ptyMetrics, '{"version":1,"leaked_process_count":null}\n', { mode: 0o600 });
    env.KSAI_PTY_METRICS_FILE = ptyMetrics;
  }
  let telemetry = null;
  let provider = null;
  const closed = async () => {
    await telemetry?.close();
    await provider?.close();
  };
  const released = async () => {
    await closed();
    rmSync(scratch, { recursive: true, force: true });
  };
  const traces = traceObserver({ arm: String(env.MODEL ?? '').trim(), model: MODEL_SPAN, mcp: '' });
  try {
    telemetry = await startTelemetry({ env, socket: join(sockets, 'otel.sock'), spans: SPANS, observe: traces.observe });
  } catch (error) {
    console.log(`::warning::runtime telemetry could not start (${error?.message}), so span timings are unavailable`);
  }
  try {
    provider = await startProvider({ env, socket: join(sockets, 'provider.sock'), stallMs: PROVIDER_TIMEOUTS.headerTimeout, queries: [...PROVIDER_QUERIES] });
  } catch (error) {
    console.log(`::error::the trusted provider relay could not start: ${error?.message ?? error}`);
    await released();
    return 1;
  }
  const sandboxEnv = {
    ...env,
    KSAI_REVIEW_RESULT_DIR: resultDir,
    KSAI_OTEL_RELAY: '',
    KSAI_PROVIDER_RELAY: '',
    KSAI_PROVIDER_SOCKET: join(sockets, 'provider.sock'),
    KSAI_TOKEN_DIR: '',
    KSAI_TOKEN_FILE: '',
    KSAI_COMPACTION_FILE: '',
  };
  let sandbox;
  try {
    sandbox = sandboxArgs(sandboxEnv, undefined, undefined, undefined, V2_MASKED_HOMES, sockets);
  } catch (error) {
    console.log(`::error::the OpenCode 2 sandbox could not be described: ${error.message}`);
    await released();
    return 1;
  }
  const problem = await sandboxProblem(sandboxEnv, sandbox, run);
  if (problem) {
    console.log(`::error::${problem}`);
    await released();
    return 1;
  }
  console.log(`sandboxed opencode ${env.OPENCODE_VERSION} on a private network`);

  const out = openSync(events, 'w');
  let code = 0;
  let deadlineExpired = false;
  const metrics = [];
  let configuredMcp = null;
  try {
    configuredMcp = mcpServerCount(JSON.parse(readFileSync(String(env.OPENCODE_CONFIG ?? ''), 'utf8')));
  } catch {}
  const summary = () => ({ ...runtimeSummary(metrics, configuredMcp), span_source: 'unauthenticated-unix-socket', compaction_source: 'unauthenticated-event-feed', event_source: 'unauthenticated-event-feed' });
  let runtime = summary();
  try {
    const pipeline = env.FLOW === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
    let resultSequence = 0;
    const invoke = async ({ prompt, timeoutMs = 0, resumeSession = '', finalize = false, resultKind = 'final', candidateIds = [] }) => {
      const offset = statSync(events).size;
      const resultFile = resultDir ? join(resultDir, `${(resultSequence += 1)}.json`) : '';
      const began = Date.now();
      telemetry?.beginObservation();
      const finishTrace = traces.begin(began);
      const ran = launch('bwrap', [...sandbox, process.execPath, driverOf(env), 'run'], {
        env: driverEnv(env, { resumeSession, finalize, pipeline, resultFile, resultKind, candidateIds }),
        stdio: ['pipe', out, 'inherit'],
      });
      const stopMonitoring = monitor(ran.pid);
      let hardStop = null;
      let timedOut = false;
      ran.stdin.on('error', () => {});
      const timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            ran.stdin.write(`${JSON.stringify({ stop: 'deadline' })}\n`);
            hardStop = setTimeout(() => ran.kill('SIGKILL'), STOP_GRACE_MS);
          }, timeoutMs)
        : null;
      ran.stdin.write(`${JSON.stringify({ prompt })}\n`);
      const status = await new Promise((ended) => {
        ran.once('error', () => ended(127));
        ran.once('close', (value, signal) => ended(exitedOn(value, signal)));
      });
      ran.stdin.destroy();
      if (timeout) clearTimeout(timeout);
      if (hardStop) clearTimeout(hardStop);
      const ended = Date.now();
      const segment = parsed(since(events, offset));
      metrics.push({
        invocation: metrics.length + 1,
        exit_code: status,
        total_ms: Math.max(0, ended - began),
        ...compactions(segment, began),
        ...finishTrace(ended),
        ...stopMonitoring(),
        ...toolTiming(segment, began, ended),
      });
      const submission = resultTransport === 'tool' ? submitted({ file: resultFile, events: segment, kind: resultKind, candidateIds }) : null;
      const last = answer(segment);
      const [result] = executionLog({ events: segment, exitCode: status, said: last });
      const recorded = pipeline && status === 0 ? recordedCompletion(segment) : {};
      return {
        code: status,
        text: submission?.text ?? recorded.text ?? (env.FLOW === 'review' && !pipeline ? reviewAnswer(segment) : last),
        submission,
        completion: recorded.completion,
        session_id: [...rootSessions(segment).roots][0],
        failure: streamFailure(segment),
        timed_out: timedOut,
        usage: spending(segment).length ? { ...result.usage, cost_usd: result.total_cost_usd, num_turns: result.num_turns } : null,
      };
    };
    const governing = String(env.KSAI_GOVERNED_DIR ?? '') !== '';
    const budget = { remaining: 1 };
    const restart = governing ? restartGoverned(env, provider) : null;
    const prompt = readFileSync(String(env.PROMPT_FILE ?? ''), 'utf8');
    const recovering = async (options) => {
      const result = await recoverReview({ ...options, flow: env.FLOW, invoke, budget, restart });
      for (const attempt of result.attempts) writeSync(out, `${JSON.stringify({ type: 'ksai_review_attempt', ...attempt })}\n`);
      return result;
    };
    const governedStage = pipeline && governing ? await governedStageRun(env, recovering, prompt, governed, (dir) => provider.govern(dir)) : null;
    const flow = (options) =>
      governedStage
        ? governedStage(options)
        : pipeline ? completeStage({ ...options, resultTransport, invoke: recovering }) : env.FLOW === 'review' ? recovering(options) : invoke(options);
    if (pipeline) {
      Object.assign(env, await reviewSession({ env, events, prompt, run: flow, resumable: !governedStage }));
      code = Number(env.OPENCODE_REVIEW_EXIT);
    } else {
      const ran = await singleRun({ env, prompt, run: flow, resultTransport });
      ({ code, deadlineExpired } = ran);
      keepReview(env, events, ran.kept);
    }
  } catch (error) {
    code = 1;
    console.log(`::error::the model runner failed (${error?.message ?? error}); reducing and redacting the partial stream`);
  } finally {
    runtime = summary();
    try {
      writeSync(out, `${JSON.stringify({ type: 'ksai_runtime', runtime })}\n`);
    } catch (error) {
      console.log(`::warning::runtime measurements could not be recorded (${error?.message})`);
    }
    closeSync(out);
  }
  reportExit(env, code, deadlineExpired);
  if (ptyMetrics) finalizePtyMetrics(ptyMetrics);
  await closed();
  let reduced = 1;
  try {
    reduced = reduceLog({ ...env, OPENCODE_EXIT: String(code), OPENCODE_EVENTS_FILE: events, OPENCODE_EXECUTION_FILE: execution, OPENCODE_RUNTIME_METRICS: JSON.stringify(runtime) });
  } catch (error) {
    console.log(`::warning::the opencode event stream reducer failed (${error?.message ?? error})`);
  }
  rmSync(scratch, { recursive: true, force: true });
  if (reduced !== 0) {
    console.log('::error::the opencode event stream could not be reduced to an execution log, so this run reports nothing it spent');
    return 1;
  }
  writeOutputs(env.GITHUB_OUTPUT, {
    pipeline_file: env.REVIEW_PIPELINE_FILE || '',
    children_file: '',
    hypotheses_file: env.REVIEW_HYPOTHESES_FILE || '',
    conclusion: conclusionOf(execution),
  });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
