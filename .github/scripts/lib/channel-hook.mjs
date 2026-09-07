import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_DRAIN, MAX_ERRORS, clockNote, deadlineNote, dueMark, marks, render, stopHeld, stopNote, stopReason, usableNonce } from '../ksai/channel.mjs';

const SUBAGENT_EVENT = 'SubagentStart';

const STOP_EVENT = 'PreToolUse';

const STOP_KIND = 'stop';

const STOP_FILE = 'stop.json';

const AGENT_SHAPE = /[^A-Za-z0-9_-]/g;

const agentKey = (value) => (String(value ?? '').replace(AGENT_SHAPE, '') || 'main').slice(0, 64);

export const RUN_DIR = 'run';

export const runDir = (stateDir) => join(stateDir, RUN_DIR);

const note = (stateDir, said) => {
  const mine = runDir(stateDir);
  try {
    mkdirSync(join(mine, 'error-slots'), { recursive: true });
  } catch {
    return false;
  }
  let slot = '';
  for (let index = 0; index < MAX_ERRORS; index += 1) {
    const candidate = join(mine, 'error-slots', `${index}.claim`);
    if (claim(candidate)) {
      slot = candidate;
      break;
    }
  }
  if (slot === '') return false;
  try {
    appendFileSync(join(mine, 'errors.log'), `${said}\n`);
    return true;
  } catch {
    try {
      unlinkSync(slot);
    } catch {}
    return false;
  }
};

const tick = (stateDir, agent, name) => claim(join(runDir(stateDir), 'ticks', `${name}-${agentKey(agent)}.claim`));

function claim(path) {
  try {
    writeFileSync(path, '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function clockNotes({ stateDir, killAt, armedAt, flow, event, agent, now }) {
  if (!Number.isFinite(killAt) || !Number.isFinite(armedAt) || killAt <= armedAt) return [];
  const remaining = Math.floor((killAt - now) / 1000);
  if (remaining <= 0) return [];
  const stated = deadlineNote(killAt, flow);
  const opening =
    stated !== '' && tick(stateDir, agent, 'deadline') ? [stated] : [];
  if (event === SUBAGENT_EVENT) return [...opening, clockNote(remaining, flow)];
  const mark = dueMark(marks((killAt - armedAt) / 1000), remaining);
  if (mark === null) return opening;
  return tick(stateDir, agent, String(mark)) ? [...opening, clockNote(remaining, flow)] : opening;
}

export function stopWaiting(stateDir) {
  try {
    return stopHeld(readFileSync(join(stateDir, STOP_FILE), 'utf-8'));
  } catch {
    return stopHeld('');
  }
}

function record(stateDir, now, event, kinds) {
  try {
    appendFileSync(
      join(runDir(stateDir), 'delivered.jsonl'),
      `${JSON.stringify({ at: new Date(now).toISOString(), event, kinds })}\n`,
    );
  } catch {
    note(stateDir, 'a delivery could not be recorded');
  }
}

const stopFrom = (waiting) => {
  const deadline = Number(waiting?.deadline);
  const dated = Number.isFinite(deadline);
  return {
    text: String(waiting?.text ?? ''),
    deadline: dated ? deadline : 0,
    hold: waiting?.hold === true,
    hard: waiting?.hard === true || !dated,
  };
};

const waitingNames = (stateDir) => {
  try {
    return readdirSync(join(stateDir, 'inbox'))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
};

const consume = (stateDir, name) => claim(join(runDir(stateDir), 'consumed', name));

export function pendingStop(stateDir, read = readFileSync) {
  const latched = stopWaiting(stateDir);
  if (latched.text !== '') return latched;
  const names = waitingNames(stateDir);
  if (names === null) return latched;
  for (const name of names.toReversed()) {
    let waiting = null;
    try {
      waiting = JSON.parse(read(join(stateDir, 'inbox', name), 'utf-8'));
    } catch {
      continue;
    }
    if (String(waiting?.kind ?? 'message') !== STOP_KIND) continue;
    if (String(waiting?.text ?? '') === '') continue;
    return stopFrom(waiting);
  }
  return latched;
}

export function inboxNotes(stateDir) {
  const taken = [];
  const names = waitingNames(stateDir);
  if (names === null) return taken;
  const unread = names.filter((name) => !existsSync(join(runDir(stateDir), 'consumed', name)));
  for (const name of unread.slice(0, MAX_DRAIN)) {
    let waiting = null;
    try {
      waiting = JSON.parse(readFileSync(join(stateDir, 'inbox', name), 'utf-8'));
    } catch {
      if (consume(stateDir, name)) note(stateDir, `${name} could not be read as a record`);
      continue;
    }
    if (!consume(stateDir, name)) continue;
    const text = String(waiting?.text ?? '');
    if (text === '') continue;
    const kind = String(waiting?.kind ?? 'message');
    if (kind === STOP_KIND) continue;
    taken.push({ kind, text });
  }
  return taken;
}

export function collect(options) {
  const onParent = options.event !== SUBAGENT_EVENT && agentKey(options.agent) === 'main';
  return [
    ...clockNotes(options).map((text) => ({ kind: 'clock', text })),
    ...(onParent ? inboxNotes(options.stateDir) : []),
  ];
}

function openRunDir(stateDir) {
  for (const name of ['ticks', 'consumed']) {
    try {
      mkdirSync(join(runDir(stateDir), name), { recursive: true });
    } catch {
      return false;
    }
  }
  return true;
}

export function main(argv = process.argv.slice(2), read = () => readFileSync(0, 'utf-8'), now = Date.now) {
  const clock = typeof now === 'function' ? now : () => now;
  let currentAt = Number(clock());
  const [stateDir, killAtMs, armedAtMs, flow, nonce, warnSeconds] = argv;
  if (!stateDir || !isAbsolute(stateDir)) return '';
  let input = {};
  try {
    input = JSON.parse(read());
  } catch {
    return '';
  }
  const event = String(input?.hook_event_name ?? '');
  if (event === '') return '';
  if (!usableNonce(nonce)) {
    note(stateDir, 'no note was read: this run drew no usable token, so nothing may be published under one');
    return '';
  }
  openRunDir(stateDir);
  if (event === STOP_EVENT) {
    const stop = pendingStop(stateDir);
    currentAt = Number(clock());
    const left = Math.ceil((Number(stop.deadline) - currentAt) / 1000);
    if (stop.text !== '' && (stop.hard || left <= 0)) {
      const refusal = stopReason(stop.text, nonce);
      if (refusal !== '') {
        if (tick(stateDir, input?.agent_id, 'stop')) {
          record(stateDir, currentAt, event, [STOP_KIND]);
        }
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: refusal },
        });
      }
    }
    if (stop.text !== '' && left > 0) {
      const said = stopNote(stop.text, left, flow);
      const warn = Math.floor(Number(warnSeconds));
      const key = Number.isFinite(warn) && warn > 0 && left <= warn ? `warn-${warn}` : 'told';
      const first = tick(stateDir, input?.agent_id, `stop-${key}`);
      if (said !== '' && first) {
        record(stateDir, currentAt, event, [STOP_KIND]);
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: event, additionalContext: render([said], nonce) },
        });
      }
    }
  }
  let notes = [];
  try {
    notes = collect({
      stateDir,
      killAt: Number(killAtMs),
      armedAt: Number(armedAtMs),
      flow,
      event,
      agent: input?.agent_id,
      now: currentAt,
    });
  } catch (error) {
    note(stateDir, `the notes for ${event} could not be collected: ${error}`);
    return '';
  }
  const body = render(
    notes.map((entry) => entry.text),
    nonce,
  );
  if (body === '') return '';
  record(stateDir, currentAt, event, notes.map((entry) => entry.kind));
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let said = '';
  try {
    said = main();
  } catch {
    said = '';
  }
  if (said !== '') process.stdout.write(said);
}
