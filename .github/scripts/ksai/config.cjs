
const {
  COMMANDS,
  EVERY_COMMAND,
  HELP_COMMAND,
  PLAN_MODES,
  canonicalCommand,
  deliveredCommand,
  safeEcho,
  unknownCommandIn,
} = require('../lib/select-arm.cjs');
const { counted, safeText } = require('../lib/text.cjs');
const { BARE_MODES } = require('./bare.cjs');
const { MAX_GRACE_SECONDS, PRESERVE_MODES, STOP_MODES } = require('./halt.cjs');

const KEYS = Object.freeze([
  'aliases',
  'bare_comments',
  'write_access_commands',
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

const ALIAS_SHAPE = /^[a-z][a-z0-9-]*$/;

const MAX_ALIASES = 32;
const MAX_ALIAS_CHARS = 32;
const MAX_BYTES = 8 * 1024;

const NO_ALIASES = Object.freeze(Object.create(null));

const NO_HALT = Object.freeze(Object.create(null));

const stripBom = (text) => (text.codePointAt(0) === 0xfeff ? text.slice(1) : text);

function locate(message) {
  const text = String(message ?? '');
  const lineColumn = /line (\d+) column (\d+)/.exec(text);
  if (lineColumn) return ` at line ${lineColumn[1]}, column ${lineColumn[2]}`;
  const position = /position (\d+)/.exec(text);
  return position ? ` at position ${position[1]}` : '';
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

function parseConfig(text) {
  const raw = String(text ?? '');

  const bytes = Buffer.byteLength(raw, 'utf-8');
  if (bytes > MAX_BYTES) {
    return { error: `\`${CONFIG_PATH}\` is ${bytes} bytes, over the limit of ${MAX_BYTES}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (e) {
    return { error: `\`${CONFIG_PATH}\` is not valid JSON${locate(e.message)}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `\`${CONFIG_PATH}\` must hold a JSON object, got ${describe(parsed)}` };
  }

  const keys = Object.keys(parsed);
  const unknown = keys.find((key) => !KEYS.includes(key));
  if (unknown !== undefined) {
    return {
      error:
        `\`${CONFIG_PATH}\` carries an unrecognized key \`${safeEcho(unknown)}\`; the keys are ` +
        KEYS.map((key) => `\`${key}\``).join(' and '),
    };
  }

  let bareComments = '';
  if (keys.includes('bare_comments')) {
    const asked = parsed.bare_comments;
    if (typeof asked !== 'string') {
      return {
        error: `the \`bare_comments\` value in \`${CONFIG_PATH}\` must be a string; it names one of ${BARE_MODES.join(', ')}, got ${describe(asked)}`,
      };
    }
    bareComments = asked.trim().toLowerCase();
    if (!BARE_MODES.includes(bareComments)) {
      return {
        error: `the \`bare_comments\` value in \`${CONFIG_PATH}\` must be one of ${BARE_MODES.join(', ')}, got \`${safeEcho(asked)}\``,
      };
    }
  }

  let planning = '';
  if (keys.includes('plan_mode')) {
    const asked = parsed.plan_mode;
    if (typeof asked !== 'string') {
      return {
        error: `the \`plan_mode\` value in \`${CONFIG_PATH}\` must be a string; it names one of ${PLAN_MODES.join(', ')}, got ${describe(asked)}`,
      };
    }
    planning = asked.trim().toLowerCase();
    if (!PLAN_MODES.includes(planning)) {
      return {
        error: `the \`plan_mode\` value in \`${CONFIG_PATH}\` must be one of ${PLAN_MODES.join(', ')}, got \`${safeEcho(asked)}\``,
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
          error: `the \`${key}\` value in \`${CONFIG_PATH}\` must be a whole number of seconds from 0 to ${MAX_GRACE_SECONDS}, got ${describe(asked)}`,
        };
      }
      halt[spec.field] = asked;
      continue;
    }
    if (typeof asked !== 'string') {
      return {
        error: `the \`${key}\` value in \`${CONFIG_PATH}\` must be a string; it names one of ${spec.of.join(', ')}, got ${describe(asked)}`,
      };
    }
    const said = asked.trim().toLowerCase();
    if (!spec.of.includes(said)) {
      return {
        error: `the \`${key}\` value in \`${CONFIG_PATH}\` must be one of ${spec.of.join(', ')}, got \`${safeEcho(asked)}\``,
      };
    }
    halt[spec.field] = said;
  }

  const table = keys.includes('aliases') ? parsed.aliases : Object.create(null);
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return {
      error: `the \`aliases\` value in \`${CONFIG_PATH}\` must be a JSON object mapping a word to a command, got ${describe(table)}`,
    };
  }

  const names = Object.keys(table);
  if (names.length > MAX_ALIASES) {
    return { error: `\`${CONFIG_PATH}\` declares ${names.length} aliases, over the limit of ${MAX_ALIASES}` };
  }

  const aliases = Object.create(null);
  const claimed = new Map();

  for (const rawName of names) {
    const name = rawName.toLowerCase();

    if (name.length > MAX_ALIAS_CHARS) {
      return {
        error: `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` is ${name.length} characters, over the limit of ${MAX_ALIAS_CHARS}`,
      };
    }
    if (!ALIAS_SHAPE.test(name)) {
      return {
        error: `alias \`${safeEcho(rawName)}\` in \`${CONFIG_PATH}\` is not a word a comment could name; use lowercase letters, digits and hyphens`,
      };
    }

    if (COMMANDS.includes(canonicalCommand(name))) {
      return {
        error: `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` is already a command, so it cannot be remapped to another one`,
      };
    }

    if (name === EVERY_COMMAND) {
      return {
        error:
          `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` is the word \`write_access_commands\` reads as every ` +
          'command, so a list naming it would open everything rather than the command this maps to',
      };
    }

    const target = table[rawName];
    if (typeof target !== 'string') {
      return {
        error: `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` maps to ${describe(target)}; it must name one of ${COMMANDS.join(', ')}`,
      };
    }
    const command = canonicalCommand(target.trim());
    if (!COMMANDS.includes(command)) {
      return {
        error: `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` maps to \`${safeEcho(target)}\`, which is not one of ${COMMANDS.join(', ')}`,
      };
    }
    if (command === HELP_COMMAND || deliveredCommand(command)) {
      return {
        error:
          `alias \`${safeEcho(name)}\` in \`${CONFIG_PATH}\` maps to \`${safeEcho(command)}\`, which cannot be aliased; ` +
          'write the canonical command directly so an active run does not also read the alias as guidance',
      };
    }

    const clash = claimed.get(name);
    if (clash !== undefined) {
      return {
        error: `\`${CONFIG_PATH}\` declares \`${safeEcho(clash)}\` and \`${safeEcho(rawName)}\`, which are one alias once cased the way a comment is read`,
      };
    }
    claimed.set(name, rawName);
    aliases[name] = command;
  }

  let writeAccess = null;
  if (keys.includes('write_access_commands')) {
    const asked = parsed.write_access_commands;
    if (!Array.isArray(asked)) {
      return {
        error: `the \`write_access_commands\` value in \`${CONFIG_PATH}\` must be a JSON array of command names, got ${describe(asked)}`,
      };
    }
    const wrong = asked.find((entry) => typeof entry !== 'string');
    if (wrong !== undefined) {
      return {
        error: `\`write_access_commands\` in \`${CONFIG_PATH}\` holds ${describe(wrong)}; every entry names one of ${COMMANDS.join(', ')}`,
      };
    }
    writeAccess = [...new Set(asked.map((entry) => canonicalCommand(entry.trim())))];
    const unknownName = unknownCommandIn(writeAccess.filter((entry) => entry !== EVERY_COMMAND), {
      where: `\`write_access_commands\` in \`${CONFIG_PATH}\``,
      commandAliases: aliases,
    });
    if (unknownName !== null) return { error: unknownName };
  }

  for (const name of new Set([...Object.keys(aliases), ...KEYS])) {
    const structural = KEYS.includes(name) ? 1 : 0;
    const declared = name in aliases ? 1 : 0;
    const found = (raw.match(new RegExp(`"${name}"[ \t\r\n]*:`, 'gi')) ?? []).length;
    if (found <= structural + declared) continue;
    return {
      error: declared
        ? `\`${CONFIG_PATH}\` declares the alias \`${safeEcho(name)}\` ${found - structural} times, so all but one of them is ignored`
        : `\`${CONFIG_PATH}\` declares the \`${safeEcho(name)}\` key ${found} times, so all but one of those is ignored`,
    };
  }

  return {
    aliases: Object.freeze(aliases),
    bareComments,
    writeAccess: writeAccess === null ? null : Object.freeze(writeAccess),
    planning,
    halt: Object.freeze(halt),
  };
}

async function fetchConfig({ github, owner, repo, path }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path });
    return { data };
  } catch (err) {
    if (err.status === 404) return { missing: true };
    return {
      error: `cannot read \`${path}\` from ${owner}/${repo}; the token needs contents:read (${err.status ?? 'no status'}: ${safeText(err.message)})`,
    };
  }
}

async function loadKsaiConfig({ github, core, owner, repo }) {
  let path = CONFIG_PATH;
  let found = await fetchConfig({ github, owner, repo, path });
  if (found.missing) {
    path = LEGACY_CONFIG_PATH;
    found = await fetchConfig({ github, owner, repo, path });
  }
  if (found.error) return { error: found.error };
  if (found.missing) {
    core.info(`No ${CONFIG_PATH} on ${owner}/${repo}'s default branch; only ${COMMANDS.join(', ')} are recognized.`);
    return { aliases: NO_ALIASES, bareComments: '', writeAccess: null, planning: '', halt: NO_HALT };
  }
  const { data } = found;
  if (path === LEGACY_CONFIG_PATH) {
    core.warning(
      `${owner}/${repo} still configures its command aliases at ${LEGACY_CONFIG_PATH}. That path is read for now ` +
        `and will stop being read; rename the file to ${CONFIG_PATH}.`,
    );
  }

  if (Array.isArray(data) || data?.encoding !== 'base64' || typeof data.content !== 'string') {
    return { error: `\`${path}\` in ${owner}/${repo} is not an inline file, so its aliases cannot be read` };
  }

  if (typeof data.size === 'number' && data.size > MAX_BYTES) {
    return { error: `\`${path}\` is ${data.size} bytes, over the limit of ${MAX_BYTES}` };
  }

  const parsed = parseConfig(Buffer.from(data.content, 'base64').toString('utf-8'));
  if (parsed.error) return { error: parsed.error };

  const count = Object.keys(parsed.aliases).length;
  const narrowed = [
    parsed.bareComments ? `\`bare_comments: ${parsed.bareComments}\`` : '',
    parsed.writeAccess === null ? '' : `\`write_access_commands: ${parsed.writeAccess.join(', ') || '(none)'}\``,
  ].filter(Boolean);
  const also = narrowed.length === 0 ? '' : `, and ${narrowed.join(' and ')}`;
  core.info(`Loaded ${counted(count, 'command alias', 'command aliases')} from ${path} at ${safeEcho(data.sha)}${also}.`);
  return {
    aliases: parsed.aliases,
    bareComments: parsed.bareComments,
    writeAccess: parsed.writeAccess,
    planning: parsed.planning,
    halt: parsed.halt,
  };
}

module.exports = loadKsaiConfig;
Object.assign(module.exports, {
  CONFIG_PATH,
  KEYS,
  LEGACY_CONFIG_PATH,
  ALIAS_SHAPE,
  MAX_ALIASES,
  MAX_ALIAS_CHARS,
  MAX_BYTES,
  NO_ALIASES,
  parseConfig,
  safeText,
});
