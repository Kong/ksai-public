export const CHILD_LIMIT = 16;
export const EXPORT_BYTES = 8 * 1024 * 1024;

export function childSessions(events) {
  const sessions = new Map();
  let missing = 0;
  for (const event of events) {
    if (event?.type !== 'tool_use' || event.part?.tool !== 'task') continue;
    const metadata = event.part.state?.metadata;
    const id = metadata?.sessionId;
    const parent = event.sessionID;
    if (typeof id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(id) || typeof parent !== 'string' || metadata.parentSessionId !== parent) missing += 1;
    else sessions.set(id, { id, parent });
  }
  return { sessions: [...sessions.values()].slice(0, CHILD_LIMIT), missing: missing + Math.max(0, sessions.size - CHILD_LIMIT) };
}

export function childEvents(exported, { id, parent }) {
  if (exported?.info?.id !== id || exported.info.parentID !== parent || !Array.isArray(exported.messages)) throw new Error('child export does not belong to this review');
  const events = new Map();
  for (const message of exported.messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== 'step-finish') continue;
      if (part.sessionID !== id || typeof part.id !== 'string' || !part.tokens || typeof part.cost !== 'number') throw new Error('child export has incomplete usage');
      events.set(part.id, { type: 'step_finish', part });
    }
  }
  if (!events.size) throw new Error('child export has no measured steps');
  return [...events.values()];
}

export function exportChildren(events, read) {
  const found = childSessions(events);
  const record = { sessions: [], events: [], missing: found.missing, failures: [] };
  for (const session of found.sessions) {
    try {
      const raw = read(session.id);
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > EXPORT_BYTES) throw new Error('child export exceeds its bound');
      const exported = JSON.parse(raw);
      const usage = childEvents(exported, session);
      record.events.push(...usage);
      record.sessions.push(exported);
    } catch (error) {
      record.missing += 1;
      const known = ['child export failed', 'child export exceeds its bound', 'child export does not belong to this review', 'child export has incomplete usage', 'child export has no measured steps'];
      record.failures.push({ id: session.id, reason: error instanceof SyntaxError ? 'invalid JSON export' : known.includes(error.message) ? error.message : 'child export unreadable' });
    }
  }
  return record;
}

export function sessionEvents(session) {
  const events = new Map();
  for (const message of session.messages ?? []) {
    for (const part of message.parts ?? []) {
      const timestamp = message.info?.time?.created;
      if (part.type === 'step-finish') {
        events.set(`${part.id}:start`, { type: 'step_start', timestamp, part });
        events.set(part.id, { type: 'step_finish', timestamp: message.info?.time?.completed ?? timestamp, part });
      }
      if (part.type === 'tool') events.set(part.id, { type: 'tool_use', timestamp, part });
    }
  }
  return [...events.values()].sort((a, b) => (a.part.state?.time?.start ?? a.timestamp ?? 0) - (b.part.state?.time?.start ?? b.timestamp ?? 0));
}
