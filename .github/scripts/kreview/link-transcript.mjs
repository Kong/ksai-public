import { setTimeout as sleep } from 'node:timers/promises';

import controlPlane from '../lib/control-plane.cjs';
import { rootSessions, sessionOf } from '../lib/opencode-v2.mjs';
import { scrub, withEscaped } from './secrets.cjs';

export const LINE_BYTES = 500;
export const LINES_PER_CALL = 40;
export const CALL_BYTES = 32 * 1024;
export const SESSION_LINES = 200;
const LINE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SESSION = /^ses_[A-Za-z0-9]{1,64}$/;
const CALL_MS = 30_000;
const CONFLICT_TRIES = 3;
const CONFLICT_WAIT_MS = 2_000;
const encoder = new TextEncoder();

export function pieces(text, most = LINE_BYTES) {
  const said = [];
  let piece = '';
  let bytes = 0;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (bytes + size > most) {
      said.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += point;
    bytes += size;
  }
  if (piece) said.push(piece);
  return said;
}

export function transcriptOf(events, secrets = []) {
  const { roots } = rootSessions(events);
  const messages = new Map();
  for (const one of events) {
    if (one?.type !== 'session.text.ended' || typeof one.data?.text !== 'string' || !roots.has(sessionOf(one))) continue;
    const message = String(one.data.assistantMessageID ?? '');
    if (!messages.has(message)) messages.set(message, new Map());
    messages.get(message).set(Number(one.data.ordinal ?? 0), one.data.text);
  }
  const hidden = withEscaped(secrets);
  return [...messages].flatMap(([message, parts]) => [...parts].sort(([a], [b]) => a - b).flatMap(([ordinal, text]) => {
    const id = `${message}.${ordinal}`;
    if (!LINE_ID.test(id)) return [];
    const kept = scrub(text, hidden).replaceAll('\0', '');
    if (kept.trim() === '') return [];
    const pieced = pieces(kept);
    return pieced
      .map((piece, at) => ({ id: pieced.length === 1 ? id : `${id}.${at + 1}`, speaker: 'assistant', text: piece }))
      .filter((line) => line.text.trim() !== '');
  }));
}

export function batches(lines, base) {
  const calls = [];
  let held = [];
  const fits = (next) => next.length <= LINES_PER_CALL && encoder.encode(JSON.stringify({ ...base, lines: next })).length <= CALL_BYTES;
  for (const line of lines) {
    if (held.length && !fits([...held, line])) {
      calls.push(held);
      held = [];
    }
    held.push(line);
  }
  if (held.length) calls.push(held);
  return calls;
}

export async function transcriptSent({ endpoint, fetch, token, link, job, flow, session, lines, wait = sleep }) {
  if (!SESSION.test(session)) throw new Error('the session names no OpenCode session to keep a transcript of');
  const kept = lines.slice(-SESSION_LINES);
  const base = { job, link, flow, model_session_id: session };
  for (const held of batches(kept, base)) {
    for (let tried = 1; ; tried += 1) {
      const said = await controlPlane.answered(fetch, `${endpoint}/v1/run/work-sessions/transcript`, { token, body: JSON.stringify({ ...base, lines: held }), timeout: CALL_MS });
      if (!said.why) break;
      if (said.status === 404) return { sent: 0, left: 0, unserved: true };
      if (said.status !== 409 || tried >= CONFLICT_TRIES) throw new Error(`the control plane did not keep the transcript: ${said.why}`);
      await wait(CONFLICT_WAIT_MS * tried);
    }
  }
  return { sent: kept.length, left: lines.length - kept.length };
}
