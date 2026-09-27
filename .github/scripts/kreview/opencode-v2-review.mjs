import { createRequire } from 'node:module';

import { answer, everything, rootSessions, sessionOf, toolCalls } from '../lib/opencode-v2.mjs';

const require = createRequire(import.meta.url);
const { reviewAnswerOf } = require('../lib/review-output.cjs');
const result = require('./review-result.cjs');

const SESSION = /^ses_[a-zA-Z0-9]+$/;

const TRANSPORT = new Set(['provider.transport', 'provider.timeout', 'provider.invalid-output']);

const TERMINAL = new Set(['session.execution.failed', 'session.step.failed']);

export const reviewAnswer = (events) => reviewAnswerOf(answer(events), everything(events));

function lastRootStep(events, roots) {
  return events.findLast((event) => event?.type === 'session.step.ended' && roots.has(sessionOf(event)));
}

function spokeIn(events, messageID) {
  return events.some(
    (event) =>
      event?.data?.assistantMessageID === messageID &&
      (event.type === 'session.text.ended' || String(event.type).startsWith('session.tool.')),
  );
}

export function streamFailure(events) {
  const { roots } = rootSessions(events);
  const failed = events.findLast((event) => TERMINAL.has(event?.type) && roots.has(sessionOf(event)));
  const succeeded = events.findLast((event) => event?.type === 'session.execution.succeeded' && roots.has(sessionOf(event)));
  if (failed && events.lastIndexOf(failed) > events.lastIndexOf(succeeded ?? null)) {
    const session = sessionOf(failed);
    if (!SESSION.test(session)) return null;
    const { type, status } = failed.data?.error ?? {};
    const code = Number(status);
    if (TRANSPORT.has(String(type))) return { kind: 'transport-closed', session_id: session };
    if (String(type) === 'provider.internal' || (Number.isInteger(code) && code >= 500 && code <= 599)) {
      return { kind: 'gateway-unavailable', session_id: session };
    }
    return null;
  }
  const step = lastRootStep(events, roots);
  if (!step) return null;
  const spent = step.data?.finish === 'stop' && Number(step.data?.tokens?.output) > 0;
  const session = sessionOf(step);
  return spent && !spokeIn(events, step.data?.assistantMessageID) && SESSION.test(session) ? { kind: 'empty-turn', session_id: session } : null;
}

const QUOTA = new Set(['session.execution.failed', 'session.step.failed', 'session.retry.scheduled']);

export function gatewayDiagnostics(events) {
  return events
    .filter((event) => QUOTA.has(event?.type))
    .map((event) => Number(event.data?.error?.status))
    .filter((status) => Number.isInteger(status) && status >= 400 && status <= 599)
    .slice(-8)
    .map((status) => ({ status, headers: {} }));
}

export function recordedCompletion(events) {
  const { roots } = rootSessions(events);
  const step = lastRootStep(events, roots);
  const session = sessionOf(step);
  const message = String(step?.data?.assistantMessageID ?? '');
  if (!SESSION.test(session) || !/^msg_[a-zA-Z0-9]+$/.test(message)) return { completion: { status: 'unavailable' } };
  const mine = events.filter((event) => event?.data?.assistantMessageID === message && sessionOf(event) === session);
  const texts = mine
    .filter((event) => event.type === 'session.text.ended' && typeof event.data?.text === 'string')
    .sort((a, b) => Number(a.data.ordinal ?? 0) - Number(b.data.ordinal ?? 0))
    .map((event) => event.data.text);
  const text = texts.join('\n');
  const parts = Object.create(null);
  const count = (name) => {
    parts[name] = (parts[name] || 0) + 1;
  };
  for (const event of mine) {
    if (event.type === 'session.text.ended') count('text');
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') count('tool');
    if (event.type === 'session.step.started') count('step-start');
    if (event.type === 'session.step.ended') count('step-finish');
  }
  return { text: text || null, completion: { status: 'recorded', message_id: message, parts, text_bytes: Buffer.byteLength(text) } };
}

export function submitted({ file, events, kind, candidateIds = [] }) {
  const calls = toolCalls(events)
    .filter((call) => call.tool === result.TOOL_NAME)
    .map((call) => ({ status: call.status, submission: call.input?.submission, sessionID: call.session_id }));
  return result.submittedCalls({ file, calls, kind, candidateIds });
}

export function toolTiming(events, beganAt, endedAt) {
  const calls = toolCalls(events);
  for (const call of calls) {
    const start = Math.round(call.started);
    if (!Number.isSafeInteger(start) || start < beganAt || start > endedAt) return { first_tool_ms: null, tool_calls: null };
  }
  let first = Infinity;
  for (const call of calls) if (call.started < first) first = Math.round(call.started);
  return { first_tool_ms: calls.length ? first - beganAt : null, tool_calls: calls.length };
}

export function compactions(events, beganAt) {
  const ended = events.filter((event) => event?.type === 'session.compaction.ended' && Number.isSafeInteger(event.created));
  return { compaction_count: ended.length, compactions: ended.map((event) => ({ session_id: sessionOf(event), offset_ms: Math.max(0, event.created - beganAt) })) };
}

export function childrenMeasured(events) {
  const { children } = rootSessions(events);
  const delegated = toolCalls(events).filter((call) => call.tool === 'subagent').length;
  return { sessions: children.size, missing: Math.max(0, delegated - children.size) };
}
