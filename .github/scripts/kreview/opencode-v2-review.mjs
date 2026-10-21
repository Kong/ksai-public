import { rootSessions, sessionOf, toolCalls } from './opencode-v2.mjs';

const SESSION = /^ses_[a-zA-Z0-9]+$/;

const TRANSPORT = new Set(['provider.transport', 'provider.timeout', 'provider.invalid-output']);

const TERMINAL = new Set(['session.execution.failed', 'session.step.failed']);

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
