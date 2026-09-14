import { readFileSync, writeFileSync } from 'node:fs';

const MAX_TARGET_CHARS = 200;
const MAX_COMMAND_CHARS = 1024;

const bounded = (value, max) => [...String(value ?? '')].slice(0, max).join('');
const exact = (value, max) => {
  const held = String(value ?? '');
  return [...held].length <= max ? held : null;
};

const record = ({ status, target = '', command = '', exit_status = null, reason }) => ({
  status,
  target: bounded(target, MAX_TARGET_CHARS),
  command: bounded(command, MAX_COMMAND_CHARS),
  exit_status,
  reason,
});

function checksAt(path) {
  if (!path) return { required: false, names: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const failingTotal = Number(parsed?.failingTotal ?? 0) + Number(parsed?.statusesTotal ?? 0);
    const names = [
      ...(Array.isArray(parsed?.failing) ? parsed.failing.map((entry) => entry?.name) : []),
      ...(Array.isArray(parsed?.statuses) ? parsed.statuses.map((entry) => entry?.context) : []),
    ]
      .map((name) => exact(name, MAX_TARGET_CHARS))
      .filter((name) => name !== null && name !== '');
    return { required: Number.isFinite(failingTotal) && failingTotal > 0, names };
  } catch {
    return { required: true, names: [], unreadable: true };
  }
}

function eventsAt(path) {
  if (!path) return { error: 'events-unavailable' };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { error: 'events-unavailable' };
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { error: 'events-incomplete' };
    }
  }
  return { events };
}

const isCommit = (event) => {
  if (event?.type !== 'tool_use' || event?.part?.tool !== 'bash') return false;
  const command = String(event?.part?.state?.input?.command ?? '');
  return /(?:^|[\s;&|()])git(?:\s+-[^\s]+)*\s+commit(?:\s|$)/.test(command);
};

export function verificationOf({ manifest = null, checksPath = null, eventsPath = null, merging = false } = {}) {
  if (merging) return record({ status: 'not-applicable', reason: 'merge-run' });

  const checks = checksAt(checksPath);
  if (!checks.required) return record({ status: 'not-applicable', reason: 'no-target' });

  const target = exact(manifest?.verification?.target, MAX_TARGET_CHARS);
  const command = exact(manifest?.verification?.command, MAX_COMMAND_CHARS);
  if (checks.unreadable) return record({ status: 'unverified', target, command, reason: 'checks-unreadable' });
  if (target === null) {
    return record({ status: 'unverified', target: manifest?.verification?.target, command, reason: 'target-too-long' });
  }
  if (!target) return record({ status: 'unverified', command, reason: 'target-missing' });
  if (!checks.names.includes(target)) return record({ status: 'unverified', target, command, reason: 'target-unknown' });
  if (command === null) {
    return record({ status: 'unverified', target, command: manifest?.verification?.command, reason: 'command-too-long' });
  }
  if (!command) return record({ status: 'unverified', target, reason: 'command-missing' });

  const read = eventsAt(eventsPath);
  if (read.error) return record({ status: 'unverified', target, command, reason: read.error });

  const calls = read.events.filter(
    (event) =>
      event?.type === 'tool_use' &&
      event?.part?.tool === 'bash' &&
      ['completed', 'error'].includes(event?.part?.state?.status) &&
      String(event?.part?.state?.input?.command ?? '') === command,
  );
  if (calls.length === 0) return record({ status: 'unverified', target, command, reason: 'command-not-seen' });

  const call = calls.at(-1);
  const exit = call?.part?.state?.metadata?.exit;
  if (!Number.isSafeInteger(exit) || exit < 0) {
    return record({ status: 'unverified', target, command, reason: 'exit-unavailable' });
  }

  const callAt = read.events.lastIndexOf(call);
  const commitAt = read.events.findIndex(isCommit);
  if (exit !== 0) return record({ status: 'failed', target, command, exit_status: exit, reason: 'target-failed' });
  if (commitAt === -1) {
    return record({ status: 'unverified', target, command, exit_status: exit, reason: 'commit-not-seen' });
  }
  if (isCommit(call) || (commitAt !== -1 && callAt > commitAt)) {
    return record({ status: 'failed', target, command, exit_status: exit, reason: 'command-after-commit' });
  }
  return record({ status: 'unverified', target, command, exit_status: 0, reason: 'target-command-unbound' });
}

export function writeVerification(path, verification) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(verification)}\n`, { mode: 0o600 });
}
