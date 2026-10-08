
const {
  COMMANDS,
  EVERY_COMMAND,
  HELP_COMMAND,
  PLAN_MODES,
  TEST_CONTRACT_PATH,
  canonicalCommand,
  deliveredCommand,
  safeEcho,
  unknownCommandIn,
} = require('../lib/select-arm.cjs');
const { readServedConfig } = require('../lib/served-config.cjs');
const { describe, locate, safeText, stripBom } = require('../lib/text.cjs');
const { BARE_MODES } = require('./bare.cjs');
const { MAX_GRACE_SECONDS, PRESERVE_MODES, STOP_MODES } = require('./halt.cjs');

const KEYS = Object.freeze([
  'bare_comments',
  'write_access_commands',
  'disabled_commands',
  'denied_paths',
  'require_plan_approval',
  'plan_mode',
  'stop_mode',
  'stop_grace_seconds',
  'stop_warn_seconds',
  'stop_preserve',
]);

const STOP_KEYS = Object.freeze(
  Object.assign(Object.create(null), {
    stop_mode: { field: 'mode', of: STOP_MODES },
    stop_preserve: { field: 'preserve', of: PRESERVE_MODES },
    stop_grace_seconds: { field: 'grace', of: null },
    stop_warn_seconds: { field: 'warn', of: null },
  }),
);

const CONFIG_PATH = '.ksai/ksai.json';

const LEGACY_CONFIG_PATH = '.ksai/muthur.json';

const MAX_BYTES = 8 * 1024;

const ESCAPED_KEY = /"(?:[^"\\]|\\.)*\\u[0-9a-fA-F]{4}(?:[^"\\]|\\.)*"\s*:/;

const DENIED_PATH = /^(?!\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._@+-]+)*\/?$/;

const NO_HALT = Object.freeze(Object.create(null));

function parseConfig(text, named = `\`${CONFIG_PATH}\``) {
  const raw = String(text ?? '');

  const bytes = Buffer.byteLength(raw, 'utf-8');
  if (bytes > MAX_BYTES) {
    return { error: `${named} is ${bytes} bytes, over the limit of ${MAX_BYTES}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (e) {
    return { error: `${named} is not valid JSON${locate(e.message)}` };
  }

  if (ESCAPED_KEY.test(raw)) {
    return { error: `${named} writes a key with a \\u escape, which hides a repeated key; write every key plainly` };
  }

  return configFrom(parsed, named, raw);
}

function configFrom(parsed, named, raw = '') {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${named} must hold a JSON object, got ${describe(parsed)}` };
  }
  const keys = Object.keys(parsed);
  const unknown = keys.find((key) => !KEYS.includes(key));
  if (unknown !== undefined) {
    return {
      error:
        `${named} carries an unrecognized key \`${safeEcho(unknown)}\`; the keys are ` +
        KEYS.map((key) => `\`${key}\``).join(' and '),
    };
  }

  let bareComments = '';
  if (keys.includes('bare_comments')) {
    const asked = parsed.bare_comments;
    if (typeof asked !== 'string') {
      return {
        error: `the \`bare_comments\` value in ${named} must be a string; it names one of ${BARE_MODES.join(', ')}, got ${describe(asked)}`,
      };
    }
    bareComments = asked.trim().toLowerCase();
    if (!BARE_MODES.includes(bareComments)) {
      return {
        error: `the \`bare_comments\` value in ${named} must be one of ${BARE_MODES.join(', ')}, got \`${safeEcho(asked)}\``,
      };
    }
  }

  let planning = '';
  if (keys.includes('plan_mode')) {
    const asked = parsed.plan_mode;
    if (typeof asked !== 'string') {
      return {
        error: `the \`plan_mode\` value in ${named} must be a string; it names one of ${PLAN_MODES.join(', ')}, got ${describe(asked)}`,
      };
    }
    planning = asked.trim().toLowerCase();
    if (!PLAN_MODES.includes(planning)) {
      return {
        error: `the \`plan_mode\` value in ${named} must be one of ${PLAN_MODES.join(', ')}, got \`${safeEcho(asked)}\``,
      };
    }
  }

  const halt = Object.create(null);
  for (const [key, spec] of Object.entries(STOP_KEYS)) {
    if (!keys.includes(key)) continue;
    const asked = parsed[key];
    if (spec.of === null) {
      if (!Number.isSafeInteger(asked) || asked < 0 || asked > MAX_GRACE_SECONDS) {
        return {
          error: `the \`${key}\` value in ${named} must be a whole number of seconds from 0 to ${MAX_GRACE_SECONDS}, got ${describe(asked)}`,
        };
      }
      halt[spec.field] = asked;
      continue;
    }
    if (typeof asked !== 'string') {
      return {
        error: `the \`${key}\` value in ${named} must be a string; it names one of ${spec.of.join(', ')}, got ${describe(asked)}`,
      };
    }
    const said = asked.trim().toLowerCase();
    if (!spec.of.includes(said)) {
      return {
        error: `the \`${key}\` value in ${named} must be one of ${spec.of.join(', ')}, got \`${safeEcho(asked)}\``,
      };
    }
    halt[spec.field] = said;
  }

  let writeAccess = null;
  if (keys.includes('write_access_commands')) {
    const asked = parsed.write_access_commands;
    if (!Array.isArray(asked)) {
      return {
        error: `the \`write_access_commands\` value in ${named} must be a JSON array of command names, got ${describe(asked)}`,
      };
    }
    const wrong = asked.find((entry) => typeof entry !== 'string');
    if (wrong !== undefined) {
      return {
        error: `\`write_access_commands\` in ${named} holds ${describe(wrong)}; every entry names one of ${COMMANDS.join(', ')}`,
      };
    }
    writeAccess = [...new Set(asked.map((entry) => canonicalCommand(entry.trim())))];
    const unknownName = unknownCommandIn(writeAccess.filter((entry) => entry !== EVERY_COMMAND), {
      where: `\`write_access_commands\` in ${named}`,
    });
    if (unknownName !== null) return { error: unknownName };
  }

  let disabled = null;
  if (keys.includes('disabled_commands')) {
    const asked = parsed.disabled_commands;
    if (!Array.isArray(asked) || asked.some((entry) => typeof entry !== 'string')) {
      return {
        error: `the \`disabled_commands\` value in ${named} must be a JSON array of command names, got ${describe(asked)}`,
      };
    }
    disabled = [...new Set(asked.map((entry) => canonicalCommand(entry.trim())))];
    const standing = disabled.find((command) => command === HELP_COMMAND || deliveredCommand(command));
    if (standing !== undefined) {
      return {
        error: `\`disabled_commands\` in ${named} names \`${safeEcho(standing)}\`, which is always answered and cannot be turned off`,
      };
    }
    const unknownName = unknownCommandIn(disabled, { where: `\`disabled_commands\` in ${named}` });
    if (unknownName !== null) return { error: unknownName };
  }

  let denied = null;
  if (keys.includes('denied_paths')) {
    const asked = parsed.denied_paths;
    if (!Array.isArray(asked) || asked.some((entry) => typeof entry !== 'string' || !DENIED_PATH.test(entry.trim()))) {
      return {
        error: `the \`denied_paths\` value in ${named} must be a JSON array of repository paths using letters, digits and ._@+- with no glob, got ${describe(asked)}`,
      };
    }
    denied = [...new Set(asked.map((entry) => entry.trim()))];
  }

  let approval = null;
  if (keys.includes('require_plan_approval')) {
    if (typeof parsed.require_plan_approval !== 'boolean') {
      return {
        error: `the \`require_plan_approval\` value in ${named} must be true or false, got ${describe(parsed.require_plan_approval)}`,
      };
    }
    approval = parsed.require_plan_approval;
  }

  for (const name of KEYS) {
    const found = (raw.match(new RegExp(`"${name}"[ \t\r\n]*:`, 'gi')) ?? []).length;
    if (found > 1) {
      return { error: `${named} declares the \`${safeEcho(name)}\` key ${found} times, so all but one of those is ignored` };
    }
  }

  return {
    bareComments,
    writeAccess: writeAccess === null ? null : Object.freeze(writeAccess),
    disabledCommands: disabled === null ? null : Object.freeze(disabled),
    deniedPaths: denied === null ? null : Object.freeze(denied),
    requirePlanApproval: approval,
    planning,
    halt: Object.freeze(halt),
  };
}

async function fetchConfig({ github, owner, repo, path, ref = '' }) {
  const at = String(ref ?? '').trim();
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path, ...(at === '' ? {} : { ref: at }) });
    return { data };
  } catch (err) {
    if (err.status === 404) return { missing: true };
    return {
      error: `cannot read \`${path}\` from ${owner}/${repo}; the token needs contents:read (${err.status ?? 'no status'}: ${safeText(err.message)})`,
    };
  }
}

async function declaresTesterContract({ github, core, owner, repo, prNumber, env = process.env, fetchImpl = fetch }) {
  const pull_number = Number(prNumber);
  if (!Number.isInteger(pull_number) || pull_number <= 0) {
    core.warning(
      `no pull request number to read the test contract for, got: ${safeEcho(prNumber)}; the tester ` +
        'decides for itself whether the base branch declares one.',
    );
    return true;
  }

  let base = '';
  let baseCommit = '';
  try {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number });
    base = String(data?.base?.ref ?? '').trim();
    baseCommit = String(data?.base?.sha ?? '').trim();
  } catch (err) {
    core.warning(
      `cannot read the base branch of ${owner}/${repo}#${pull_number} (${err.status ?? 'no status'}: ` +
        `${safeText(err.message)}); the tester decides for itself whether it declares \`${TEST_CONTRACT_PATH}\`.`,
    );
    return true;
  }
  if (base === '') {
    core.warning(
      `${owner}/${repo}#${pull_number} names no base branch, so the tester decides for itself whether one ` +
        `declares \`${TEST_CONTRACT_PATH}\`.`,
    );
    return true;
  }

  const read = await readServedConfig({ env, fetchImpl, scope: `${owner}/${repo}`, ref: baseCommit });
  if (read.error) {
    core.warning(
      `the control plane did not serve the config file tables of ${owner}/${repo} at ${safeEcho(base)} (${read.error}); the ` +
        'tester decides for itself whether the project declares a test contract.',
    );
    return true;
  }
  const { served } = read;
  if (served.source !== '') {
    const declared = served.problem !== '' || Object.keys(served.test?.environments ?? {}).length > 0;
    core.info(
      declared
        ? `${served.source} on ${safeEcho(base)} declares a [test] table, so a test request has a contract to run.`
        : `${served.source} on ${safeEcho(base)} declares no [test] environment, so there is nothing for the tester to start.`,
    );
    return declared;
  }

  const found = await fetchConfig({ github, owner, repo, path: TEST_CONTRACT_PATH, ref: base });
  if (found.error) {
    core.warning(`${found.error}; the tester decides for itself whether ${safeEcho(base)} declares one.`);
    return true;
  }
  if (found.missing) {
    core.info(`${safeEcho(base)} declares no ${TEST_CONTRACT_PATH}, so there is nothing for the tester to start.`);
    return false;
  }
  core.info(`${safeEcho(base)} declares ${TEST_CONTRACT_PATH}, so a test request has a contract to run.`);
  return true;
}

async function testerContract({ github, core, owner, repo, prNumber, env = process.env, fetchImpl = fetch }) {
  const declared = await declaresTesterContract({ github, core, owner, repo, prNumber, env, fetchImpl });
  core.setOutput('missing', declared ? 'false' : 'true');
  return declared;
}

function servedGuards({ served, core, owner, repo }) {
  if (served.problem !== '') return { error: `\`${served.source}\` in ${owner}/${repo} ${served.problem}` };
  const parsed = configFrom(served.guards ?? {}, `the guards of \`${served.source}\``);
  if (parsed.error) return parsed;
  core.info(`Loaded the guards of ${served.source} as the control plane served them, at checksum ${safeEcho(served.checksum)}.`);
  return parsed;
}

async function loadKsaiConfig({ github, core, owner, repo, env, fetchImpl }) {
  const read = await readServedConfig({ env, fetchImpl, scope: `${owner}/${repo}` });
  if (read.error) {
    return { error: `the control plane did not serve the config file tables of ${owner}/${repo}: ${read.error}`, unread: true };
  }
  if (read.served.source !== '') return servedGuards({ served: read.served, core, owner, repo });
  return loadLegacyKsaiConfig({ github, core, owner, repo });
}

async function loadLegacyKsaiConfig({ github, core, owner, repo }) {
  let path = CONFIG_PATH;
  let found = await fetchConfig({ github, owner, repo, path });
  if (found.missing) {
    path = LEGACY_CONFIG_PATH;
    found = await fetchConfig({ github, owner, repo, path });
  }
  if (found.error) return { error: found.error, unread: true };
  if (found.missing) {
    core.info(`No ${CONFIG_PATH} on ${owner}/${repo}'s default branch, so no guard narrows this run.`);
    return {
      bareComments: '',
      writeAccess: null,
      disabledCommands: null,
      deniedPaths: null,
      requirePlanApproval: null,
      planning: '',
      halt: NO_HALT,
    };
  }
  const { data } = found;
  if (path === LEGACY_CONFIG_PATH) {
    core.warning(
      `${owner}/${repo} still configures its guards at ${LEGACY_CONFIG_PATH}. That path is read for now ` +
        `and will stop being read; rename the file to ${CONFIG_PATH}.`,
    );
  }

  if (Array.isArray(data) || data?.encoding !== 'base64' || typeof data.content !== 'string') {
    return { error: `\`${path}\` in ${owner}/${repo} is not an inline file, so its guards cannot be read` };
  }

  if (typeof data.size === 'number' && data.size > MAX_BYTES) {
    return { error: `\`${path}\` is ${data.size} bytes, over the limit of ${MAX_BYTES}` };
  }

  const parsed = parseConfig(Buffer.from(data.content, 'base64').toString('utf-8'));
  if (parsed.error) return { error: parsed.error };

  const narrowed = [
    parsed.bareComments ? `\`bare_comments: ${parsed.bareComments}\`` : '',
    parsed.writeAccess === null ? '' : `\`write_access_commands: ${parsed.writeAccess.join(', ') || '(none)'}\``,
  ].filter(Boolean);
  const also = narrowed.length === 0 ? '' : `, with ${narrowed.join(' and ')}`;
  core.info(`Loaded the guards from ${path} at ${safeEcho(data.sha)}${also}.`);
  return {
    bareComments: parsed.bareComments,
    writeAccess: parsed.writeAccess,
    disabledCommands: parsed.disabledCommands,
    deniedPaths: parsed.deniedPaths,
    requirePlanApproval: parsed.requirePlanApproval,
    planning: parsed.planning,
    halt: parsed.halt,
  };
}

module.exports = Object.assign(loadKsaiConfig, {
  CONFIG_PATH,
  KEYS,
  LEGACY_CONFIG_PATH,
  MAX_BYTES,
  TEST_CONTRACT_PATH,
  declaresTesterContract,
  loadLegacyKsaiConfig,
  parseConfig,
  safeText,
  testerContract,
});
