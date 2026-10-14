import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { isNativeStream, toolCalls } from '../lib/opencode-v2.mjs';

const require = createRequire(import.meta.url);
const { MAX_COMMAND_CHARS, MAX_TARGET_CHARS, MAX_VERIFICATION_COMMANDS } = require('../lib/write-record.cjs');

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

const SECRET = '<redacted>';
const URL_CREDENTIALS = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:]*(?::\S*)?@/g;
const SECRET_HEADER = /(\b(?:authorization|proxy-authorization|x-api-key|api-key|private-token|x-auth-token|cookie)\s*:\s*)(?:(?:bearer|basic|token)\s+)?[^"'\r\n]+/gi;
const WORD_START = String.raw`(?:^|[\s;&|(\`"'])`;
const CURL_ARGUMENTS = new RegExp(
  String.raw`(${WORD_START}(?:\S*/)?curl\b["']?)((?:"(?:\\.|[^"\\])*"|'[^']*'|\\\r?\n|[^;&|\n"'])*)`,
  'g',
);
const LINE_GAP = String.raw`(?:["']?(?:\s|\\\r?\n))`;
const FLAG_GAP = String.raw`(?:["']?(?:[\s=]|\\\r?\n))`;
const FLAG_START = String.raw`\s["']?`;
const COOKIE_FLAG = new RegExp(
  String.raw`(${FLAG_START}(?:-b|--cookie(?![\w-]))${FLAG_GAP}*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s'";&|]+)`,
  'g',
);
const CURL_SECRET_FLAG = new RegExp(
  String.raw`(${FLAG_START}--(?:oauth2-bearer|(?:proxy-)?tlspassword)(?![\w-])${FLAG_GAP}+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s'";&|]+)`,
  'g',
);
const CURL_CERT_FLAG = new RegExp(
  String.raw`(${FLAG_START}(?:-E|--(?:proxy-)?cert(?![\w-]))${FLAG_GAP}*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s'";&|]+)`,
  'g',
);
const CURL_PROXY_FLAG = new RegExp(
  String.raw`(${FLAG_START}(?:-x|--(?:pre)?proxy(?![\w-]))${FLAG_GAP}*["']?)(?![A-Za-z][A-Za-z0-9+.-]*://)([^\s:@'"/]+):[^\s@'"]*@`,
  'g',
);
const USER_FLAG = new RegExp(
  String.raw`((?:^|\s)["']?(?:-[uU]${FLAG_GAP}*|--(?:proxy-)?user${FLAG_GAP}+))` +
    String.raw`(?:'([^':]*):[^']*'|"([^":]*):(?:\\.|[^"\\])*"|([^\s:'"]*):(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s'"]+))`,
  'g',
);
const ID_PAIR = /^\d+:\d+$/;
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>`"']+)/g;
const SECRET_NAME = 'password|passwd|pass|pwd|secret|token|authorization|api[-_]?key|access[-_]?key|private[-_]?key|credentials?';
const SECRET_FIELD = new RegExp(
  `((?:^|[^A-Za-z0-9_-])["']?[A-Za-z0-9_-]*?(?:${SECRET_NAME})["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;&}"'|)]+)`,
  'gi',
);
const SECRET_FLAG = new RegExp(
  `(--(?:[A-Za-z0-9]+[-_])*(?:${SECRET_NAME})${LINE_GAP}+)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s;&|()<>\`]+)`,
  'gi',
);
const SECRET_WORD = new RegExp(
  `((?:^|[^A-Za-z0-9_-])["']?(?:[A-Za-z0-9]+[-_])*(?:${SECRET_NAME})${LINE_GAP}+)(?!--?[A-Za-z])("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;&}"'|)]+)`,
  'gi',
);
const STDIN_FLAG = String.raw`(?:--(?:password|token)-stdin|--with-token)\b`;
const STDIN_SECRET = new RegExp(STDIN_FLAG);
const SEGMENT = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\\\r?\n|[^;&|\n"'])*`;
const PIPE = String.raw`\|(?!\|)`;
const ECHO_ARGUMENTS = new RegExp(
  String.raw`(${WORD_START}(?:echo|printf)\b)(${SEGMENT})(?=${PIPE}(?:${SEGMENT}${PIPE})*${SEGMENT}${STDIN_FLAG})`,
  'g',
);
const HERE_STRING = /(<<<\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g;
const HERE_DOC = /(<<-?\s*(["']?)([A-Za-z_]\w*)\2[^\n]*\n)[\s\S]*?(\n[ \t]*\3[ \t]*(?:\n|$))/g;
const PASSWORD_ENV_NAME = /(?:_PWD|PASS(?:WORD|WD)?|AUTH)$/i;
const LOGIN_OPTIONS = String.raw`(?:\s+--?[A-Za-z][\w-]*(?:=\S+|\s+[^\s-]\S*)?)*`;
const PASSWORD_PROGRAM =
  String.raw`(?:mysql\w*|mariadb\w*|sshpass|mongo(?:sh|dump|restore|import|export)?|` +
  String.raw`(?:docker|podman|nerdctl)${LOGIN_OPTIONS}\s+login|helm${LOGIN_OPTIONS}\s+registry${LOGIN_OPTIONS}\s+login)`;
const AUTH_PROGRAM = String.raw`(?:redis-cli|valkey-cli)`;
const CONTINUED =
  String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|"(?!(?:\\[\s\S]|[^"\\])*")|'(?![^']*')|` +
  String.raw`\\(?:\r\n?|[^\r])|[^;&|\n"'\\])*?`;
const PASSWORD_FLAG = new RegExp(
  String.raw`(${WORD_START}(?:\S*/)?(?:${PASSWORD_PROGRAM}\b${CONTINUED}${FLAG_START}(?:-p|--pass(?:word)?(?![\w-]))|` +
    String.raw`${AUTH_PROGRAM}\b${CONTINUED}${FLAG_START}(?:-a|--pass(?:word)?(?![\w-])))${FLAG_GAP}*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s'";&|]+)`,
  'g',
);

function hiddenCertPassword(whole, flag, value) {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  const inner = quote ? value.slice(1, -1) : value;
  const colon = inner.indexOf(':');
  return colon < 0 ? whole : `${flag}${quote}${inner.slice(0, colon)}:${SECRET}${quote}`;
}

function curlSecrets(rest) {
  return rest
    .replace(COOKIE_FLAG, `$1${SECRET}`)
    .replace(USER_FLAG, hiddenUser)
    .replace(CURL_SECRET_FLAG, `$1${SECRET}`)
    .replace(CURL_CERT_FLAG, hiddenCertPassword)
    .replace(CURL_PROXY_FLAG, `$1$2:${SECRET}@`);
}

function hiddenUser(whole, flag, single, double, bare) {
  if (single !== undefined) return `${flag}'${single}:${SECRET}'`;
  if (double !== undefined) return `${flag}"${double}:${SECRET}"`;
  return `${flag}${bare}:${SECRET}`;
}

function hiddenArguments(whole, program, rest) {
  const kept = rest.trimEnd();
  return kept.trim() ? `${program} ${SECRET}${rest.slice(kept.length)}` : whole;
}

function stdinSecrets(line) {
  if (!STDIN_SECRET.test(line)) return line;
  return line
    .replace(ECHO_ARGUMENTS, hiddenArguments)
    .replace(HERE_STRING, `$1${SECRET}`)
    .replace(HERE_DOC, `$1${SECRET}$4`);
}

function fullCommand(value, secrets = []) {
  let line = String(value ?? '');
  for (const [, secret] of secrets) {
    if (String(secret).length >= 4) line = line.split(String(secret)).join(SECRET);
  }
  line = stdinSecrets(line)
    .replace(URL_CREDENTIALS, `$1${SECRET}@`)
    .replace(SECRET_HEADER, `$1${SECRET}`)
    .replace(CURL_ARGUMENTS, (whole, program, rest) => program + curlSecrets(rest))
    .replace(USER_FLAG, (whole, flag, ...rest) => (ID_PAIR.test(whole.slice(flag.length)) ? whole : hiddenUser(whole, flag, ...rest)))
    .replace(ASSIGNMENT, (whole, name) => (SECRET_ENV_NAME.test(name) || PASSWORD_ENV_NAME.test(name) ? `${name}=${SECRET}` : whole))
    .replace(SECRET_FIELD, `$1${SECRET}`)
    .replace(SECRET_FLAG, `$1${SECRET}`)
    .replace(PASSWORD_FLAG, `$1${SECRET}`)
    .replace(SECRET_WORD, `$1${SECRET}`);
  return bounded(redactEntropy(line), MAX_COMMAND_CHARS);
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

const exitOf = (call) => (Number.isSafeInteger(call.exit) && call.exit >= 0 ? call.exit : null);

const done = (calls) => calls.filter((call) => finished(call));

const kept = (calls) => done(calls).slice(0, MAX_VERIFICATION_COMMANDS);

function commandsIn(calls, secrets) {
  const held = kept(calls);
  return {
    commands: held.map((call) => [reportedCommand(call.command, secrets).command, exitOf(call)]),
    commands_capped: done(calls).length > held.length,
  };
}

function ranIn(calls, secrets) {
  return kept(calls).map((call) => ({ line: fullCommand(call.command, secrets), exit: exitOf(call) }));
}

export function writeRan(path, ran) {
  if (!path) return false;
  try {
    writeFileSync(path, `${JSON.stringify(ran)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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

export function verificationOf(options = {}) {
  return verifiedRun(options).verification;
}

export function verifiedRun({
  manifest = null,
  checksPath = null,
  eventsPath = null,
  merging = false,
  noChange = false,
  secrets = [],
} = {}) {
  const read = eventsAt(eventsPath);
  const shells = shellCalls(read.events);
  return {
    verification: verified({ manifest, checksPath, merging, noChange, secrets, read, shells }),
    ran: ranIn(shells, secrets),
  };
}

function verified({ manifest, checksPath, merging, noChange, secrets, read, shells }) {
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
