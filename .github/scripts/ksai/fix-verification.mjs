import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { isNativeStream, toolCalls } from '../lib/opencode-v2.mjs';

const require = createRequire(import.meta.url);
const { MAX_VERIFICATION_COMMANDS } = require('../lib/write-record.cjs');

const MAX_TARGET_CHARS = 200;
const MAX_COMMAND_CHARS = 1024;

const bounded = (value, max) => [...String(value ?? '')].slice(0, max).join('');
const exact = (value, max) => {
  const held = String(value ?? '');
  return [...held].length <= max ? held : null;
};

const record = ({
  status,
  target = '',
  command = '',
  exit_status = null,
  reason,
  commands = [],
  commands_state = 'unavailable',
  commands_capped = false,
}) => ({
  status,
  target: bounded(target, MAX_TARGET_CHARS),
  command: bounded(command, MAX_COMMAND_CHARS),
  exit_status,
  reason,
  commands,
  commands_state,
  commands_capped,
});

const HIGH_ENTROPY = '<redacted:high-entropy>';
const ARGUMENTS = '<arguments redacted>';
const COMMAND = '<command redacted>';
const HIGH_ENTROPY_LITERAL = /[A-Za-z0-9+_]{24,}={0,2}/g;
const SECRET_ENV_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)(?:_|$)/i;
const SAFE_EXECUTABLE = /^[A-Za-z0-9_.+-]{1,120}$/;

const entropy = (value) => {
  const counts = new Map();
  for (const point of value) counts.set(point, (counts.get(point) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const frequency = count / value.length;
    total -= frequency * Math.log2(frequency);
  }
  return total;
};

const redactEntropy = (value) => String(value).replace(HIGH_ENTROPY_LITERAL, (candidate) =>
  new Set(candidate).size >= 10 && entropy(candidate) >= 3.5 ? HIGH_ENTROPY : candidate);

const containsKnownSecret = (value, secrets) => [...secrets]
  .filter(([name, secret]) => /^[A-Z][A-Z0-9_]{0,127}$/.test(String(name)) && String(secret).length >= 4)
  .some(([, secret]) => String(value ?? '').includes(String(secret)));

function commandShape(value) {
  let rest = String(value ?? '').trimStart();
  let hasHiddenPrefix = false;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>`\\]+)\s+/;
  while (assignment.test(rest)) {
    hasHiddenPrefix = true;
    rest = rest.replace(assignment, '');
  }
  const match = rest.match(/^([A-Za-z0-9_./+-]{1,120})(?=$|[\s;&|()<>`])/u);
  if (!match) return { executable: '', hasArguments: false };
  const executable = match[1].replace(/^.*\//, '');
  const hasArguments = hasHiddenPrefix || rest.slice(match[1].length).trim() !== '';
  return { executable, hasArguments };
}

export function commandSecrets(env = {}) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && String(value ?? '').length >= 4)
    .map(([name, value]) => [name, String(value)]);
}

function reportedCommand(value, secrets) {
  const shape = commandShape(value);
  if (!shape.executable) return { command: COMMAND };
  if (!SAFE_EXECUTABLE.test(shape.executable) || containsKnownSecret(shape.executable, secrets) ||
      redactEntropy(shape.executable) !== shape.executable) {
    return { command: COMMAND };
  }
  const suffix = shape.hasArguments ? ` ${ARGUMENTS}` : '';
  return { command: `${shape.executable}${suffix}` };
}

function checksAt(path) {
  if (!path) return { required: false, names: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const unreadable = parsed?.unreadable != null || parsed?.statusesUnreadable != null;
    const failingTotal = Number(parsed?.failingTotal ?? 0) + Number(parsed?.statusesTotal ?? 0);
    const names = [];
    const commands = new Map();
    const add = (name, command = null) => {
      const boundedName = exact(name, MAX_TARGET_CHARS);
      if (boundedName === null || boundedName === '') return;
      if (!names.includes(boundedName)) names.push(boundedName);
      const boundedCommand = exact(command, MAX_COMMAND_CHARS);
      if (boundedCommand !== null && boundedCommand !== '') {
        if (!(commands.get(boundedName) ?? []).length) commands.set(boundedName, [boundedCommand]);
      } else if (!commands.has(boundedName)) {
        commands.set(boundedName, []);
      }
    };
    for (const entry of Array.isArray(parsed?.failing) ? parsed.failing : []) add(entry?.name, entry?.failedCommand);
    for (const entry of Array.isArray(parsed?.statuses) ? parsed.statuses : []) add(entry?.context);
    return { required: unreadable || (Number.isFinite(failingTotal) && failingTotal > 0), names, commands, unreadable };
  } catch {
    return { required: true, names: [], commands: new Map(), unreadable: true };
  }
}

function eventsAt(path) {
  if (!path) return { events: [], error: 'events-unavailable', commands_state: 'unavailable' };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { events: [], error: 'events-unavailable', commands_state: 'unavailable' };
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { events, error: 'events-incomplete', commands_state: 'incomplete' };
    }
  }
  return { events, commands_state: 'complete' };
}

export function shellCalls(events) {
  if (isNativeStream(events)) {
    return toolCalls(events)
      .filter((call) => call.tool === 'shell')
      .map((call) => ({
        command: String(call.input?.command ?? ''),
        status: call.status,
        exit: call.metadata?.exit,
        started: call.started,
        called: call.called,
        ended: call.ended,
      }));
  }
  return events
    .filter((event) => event?.type === 'tool_use' && event?.part?.tool === 'bash')
    .map((event) => ({
      command: String(event?.part?.state?.input?.command ?? ''),
      status: event?.part?.state?.status,
      exit: event?.part?.state?.metadata?.exit,
    }));
}

const finished = (call) => ['completed', 'error'].includes(call.status);

function commandsIn(calls, secrets) {
  const commands = [];
  let capped = false;
  for (const call of calls) {
    if (!finished(call)) continue;
    if (commands.length >= MAX_VERIFICATION_COMMANDS) {
      capped = true;
      continue;
    }
    const shown = reportedCommand(call.command, secrets);
    commands.push([shown.command, Number.isSafeInteger(call.exit) && call.exit >= 0 ? call.exit : null]);
  }
  return { commands, commands_capped: capped };
}

const withCommands = (fields, collected, secrets) => record({
  ...fields,
  command: fields.command ? reportedCommand(fields.command, secrets).command : '',
  ...collected,
});

const isCommit = (call) => /(?:^|[\s;&|()])git(?:\s+-[^\s]+)*\s+commit(?:\s|$)/.test(call.command);

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

// Native events can arrive out of order; timestamps preserve execution order.
const completedBefore = (candidate, commit, candidateIndex, commitIndex) => {
  if (finite(candidate.ended) && finite(commit.started)) return Number(candidate.ended) <= Number(commit.started);
  return candidateIndex < commitIndex;
};

const latest = (calls, native) => {
  if (!native || calls.length === 0 || !calls.every((one) => finite(one.ended))) return calls.at(-1);
  return calls.reduce((last, one) => (Number(one.ended) > Number(last.ended) ? one : last));
};

const firstCommit = (calls, native) => {
  if (!native || calls.length === 0 || !calls.every((one) => finite(one.started))) return calls[0];
  return calls.reduce((first, one) => (Number(one.started) < Number(first.started) ? one : first));
};

export function verificationOf({
  manifest = null,
  checksPath = null,
  eventsPath = null,
  merging = false,
  noChange = false,
  secrets = [],
} = {}) {
  const read = eventsAt(eventsPath);
  const shells = shellCalls(read.events);
  const collected = { ...commandsIn(shells, secrets), commands_state: read.commands_state };
  const result = (fields) => withCommands(fields, collected, secrets);
  const checks = checksAt(checksPath);
  if (!checks.required) {
    if (merging) return result({ status: 'not-applicable', reason: 'merge-run' });
    if (noChange) return result({ status: 'not-applicable', reason: 'no-change' });
    return result({ status: 'not-applicable', reason: 'no-target' });
  }

  const target = exact(manifest?.verification?.target, MAX_TARGET_CHARS);
  const command = exact(manifest?.verification?.command, MAX_COMMAND_CHARS);
  if (checks.unreadable && !checks.names.includes(target ?? '')) {
    return result({ status: 'unverified', target: manifest?.verification?.target, command, reason: 'checks-unreadable' });
  }
  if (merging || noChange) {
    return result({ status: 'unverified', target, command, reason: 'target-not-reproduced' });
  }
  if (target === null) {
    return result({ status: 'unverified', target: manifest?.verification?.target, command, reason: 'target-too-long' });
  }
  if (!target) return result({ status: 'unverified', command, reason: 'target-missing' });
  if (!checks.names.includes(target)) {
    return result({ status: 'unverified', target, command, reason: 'target-unknown' });
  }
  if (command === null) {
    return result({
      status: 'unverified', target, command: manifest?.verification?.command, reason: 'command-too-long',
    });
  }
  if (!command) return result({ status: 'unverified', target, reason: 'command-missing' });

  if (read.error) return result({ status: 'unverified', target, command, reason: read.error });

  const calls = shells.filter((one) => finished(one) && one.command === command);
  if (calls.length === 0) {
    return result({ status: 'unverified', target, command, reason: 'command-not-seen' });
  }

  const native = isNativeStream(read.events);
  const call = latest(calls, native);
  const { exit } = call;
  if (!Number.isSafeInteger(exit) || exit < 0) {
    return result({ status: 'unverified', target, command, reason: 'exit-unavailable' });
  }

  const commit = firstCommit(shells.filter((one) => isCommit(one)), native);
  const commitAt = commit ? shells.indexOf(commit) : -1;
  if (exit !== 0) {
    return result({ status: 'failed', target, command, exit_status: exit, reason: 'target-failed' });
  }
  if (commitAt === -1) {
    return result({ status: 'unverified', target, command, exit_status: exit, reason: 'commit-not-seen' });
  }
  const beforeCommit = calls.filter((one) => completedBefore(one, commit, shells.indexOf(one), commitAt));
  const verifiedBeforeCommit = latest(beforeCommit, native);
  if (!verifiedBeforeCommit || verifiedBeforeCommit.exit !== 0) {
    return result({ status: 'failed', target, command, exit_status: exit, reason: 'command-after-commit' });
  }
  if (!(checks.commands?.get(target) ?? []).includes(command)) {
    return result({ status: 'unverified', target, command, exit_status: 0, reason: 'target-command-unbound' });
  }
  return result({ status: 'verified', target, command, exit_status: 0, reason: 'target-passed' });
}

export function writeVerification(path, verification) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(verification)}\n`, { mode: 0o600 });
}
