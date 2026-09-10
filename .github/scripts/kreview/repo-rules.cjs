const nodePath = require('node:path');

const { asAlert, safeEcho, scrubTrigger } = require('../lib/select-arm.cjs');
const { counted, safeText } = require('../lib/text.cjs');
const { neutralizeSections } = require('../lib/prompt-text.cjs');
const { ALLOWED_FLAGS, claimsAny, toPattern } = require('../lib/path-pattern.cjs');

const RULES_PATH = '.ksai/review-rules.md';
const PACKS_PATH = '.ksai/review-rules';
const MAX_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024;
const MAX_PACKS = 16;
const MODES = Object.freeze(['auto', 'off']);

const PACK_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const HEADER_KEYS = Object.freeze(['match', 'flags', 'source']);

const MANIFEST_KEYS = Object.freeze(['name', 'description']);

const FENCE = /^---[ \t]*\n([^]*?)\n---[ \t]*(?:\n|$)/;

const QUOTED = /^['"]|['"]$/;

const KEY_LINE = /^[A-Za-z][A-Za-z0-9_-]*[ \t]*:/;

/**
 * parseRules validates one repository's review-rules document and answers the text a prompt carries.
 *
 * Returns `{ rules }` or `{ error }`, and never both: an error path carrying a usable value is what
 * lets a caller that forgets to check it review with rules nobody validated.
 */
function parseRules(raw, label = RULES_PATH) {
  const bytes = Buffer.byteLength(String(raw ?? ''), 'utf-8');
  if (bytes > MAX_BYTES) {
    return { error: `\`${label}\` is ${bytes} bytes, over the limit of ${MAX_BYTES}` };
  }
  const rules = neutralizeSections(String(raw ?? '').replace(/\r\n/g, '\n')).trimEnd();
  if (rules.trim() === '') {
    return { error: `\`${label}\` holds no rules; delete the file, or write the rules the review must apply` };
  }
  return { rules, bytes: Buffer.byteLength(rules, 'utf-8') };
}

function parseHeader(raw, label) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/^﻿/, '');
  if (!text.startsWith('---')) return { header: {}, body: text };

  const fenced = FENCE.exec(text);
  if (!fenced) return { header: {}, body: text };
  const opening = fenced[1].split('\n').find((line) => line.trim() !== '') ?? '';
  if (!KEY_LINE.test(opening)) return { header: {}, body: text };

  const header = {};
  const foreign = [];
  for (const line of fenced[1].split('\n')) {
    if (line.trim() === '') continue;
    if (/^[ \t]/.test(line) || /^-[ \t]/.test(line)) {
      foreign.push('');
      continue;
    }
    const at = line.indexOf(':');
    if (at <= 0) {
      return { error: `\`${label}\` has \`${safeText(line.trim())}\` in its frontmatter, which is not \`key: value\`` };
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!HEADER_KEYS.includes(key)) {
      foreign.push(key);
      continue;
    }
    if (key in header) {
      return { error: `\`${label}\` names \`${key}\` twice in its frontmatter` };
    }
    if (QUOTED.test(value)) {
      return { error: `\`${label}\` quotes its \`${key}\`; write the value unquoted, or the quotes become part of it` };
    }
    header[key] = value;
  }

  const body = text.slice(fenced[0].length).replace(/^\n+/, '');
  if (foreign.length === 0) return { header, body };
  if (Object.keys(header).length === 0 && MANIFEST_KEYS.every((key) => foreign.includes(key))) {
    return { header: {}, body };
  }
  const named = foreign.filter(Boolean).map((key) => `\`${safeText(key)}\``).join(', ') || 'a block this reader cannot follow';
  return {
    error:
      `\`${label}\` mixes ${named} into a pack header; a pack takes \`${HEADER_KEYS.join('` and `')}\`, and a file whose ` +
      `frontmatter is a skill manifest (\`${MANIFEST_KEYS.join('` and `')}\`) is read whole with no scoping`,
  };
}

function patternOf(header, label) {
  if (!('match' in header)) {
    if ('flags' in header) {
      return { error: `\`${label}\` names \`flags\` with no \`match\`, so nothing would use them` };
    }
    return { pattern: null };
  }
  if ('flags' in header && !ALLOWED_FLAGS.test(header.flags)) {
    return { error: `\`${label}\` sets \`flags: ${safeText(header.flags)}\`; a pack takes \`i\` or nothing` };
  }
  const pattern = toPattern({ match: header.match, flags: header.flags });
  if (!pattern) {
    return { error: `\`${label}\` has a \`match\` this cannot compile; it is a regular expression` };
  }
  return { pattern };
}

/** renderRulesRejection answers the comment a run publishes when it refused to review without the rules. */
function renderRulesRejection(error, trigger) {
  return asAlert(
    'WARNING',
    scrubTrigger(
      [
        `**${error}**`,
        '',
        'Nothing was reviewed. Fix `review-rules.md` in `.ksai/` on the default branch, or set the',
        '`repo_rules` input to `off`, then ask again',
      ].join('\n'),
      trigger,
    ),
  );
}

async function fetchOne({ github, owner, repo, path }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path });
    return { data };
  } catch (err) {
    if (err.status === 404) return { missing: true };
    const detail = `(${err.status ?? 'no status'}: ${safeText(err.message)})`;
    const blame =
      typeof err.status === 'number' && err.status < 500
        ? `the token needs contents:read ${detail}`
        : `GitHub could not answer, and the retries are exhausted ${detail}`;
    return { error: `cannot read \`${path}\` from ${owner}/${repo}; ${blame}` };
  }
}

function resolveLink(from, target) {
  const wanted = String(target ?? '');
  if (wanted === '' || wanted.startsWith('/')) return null;
  const joined = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(from), wanted));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  return joined;
}

const inlineOf = (data, label, where) => {
  if (Array.isArray(data) || data?.encoding !== 'base64' || typeof data.content !== 'string') {
    return { error: `\`${label}\` in ${where} is not an inline file, so its rules cannot be read` };
  }
  if (typeof data.size === 'number' && data.size > MAX_BYTES) {
    return { error: `\`${label}\` is ${data.size} bytes, over the limit of ${MAX_BYTES}` };
  }
  const decoded = Buffer.from(data.content, 'base64');
  if (decoded.length > MAX_BYTES) {
    return { error: `\`${label}\` is ${decoded.length} bytes, over the limit of ${MAX_BYTES}` };
  }
  return { text: decoded.toString('utf-8') };
};

async function readPack({ github, owner, repo, entry }) {
  const where = `${owner}/${repo}`;
  const label = entry.path;

  const found = await fetchOne({ github, owner, repo, path: entry.path });
  if (found.error) return { error: found.error };
  if (found.missing) {
    return { error: `\`${label}\` was listed under \`${PACKS_PATH}\` and cannot be read back` };
  }

  let { data } = found;

  if (!Array.isArray(data) && data?.type === 'symlink') {
    const target = resolveLink(entry.path, data.target);
    if (target === null) {
      return { error: `\`${label}\` is a symlink to \`${safeText(String(data.target ?? ''))}\`, which is outside ${where}` };
    }
    const linked = await fetchOne({ github, owner, repo, path: target });
    if (linked.error) return { error: linked.error };
    if (linked.missing) {
      return { error: `\`${label}\` is a symlink to \`${target}\`, which is not on ${where}'s default branch` };
    }
    if (!Array.isArray(linked.data) && linked.data?.type === 'symlink') {
      return { error: `\`${label}\` is a symlink to \`${target}\`, which is a symlink itself; one hop is all this follows` };
    }
    data = linked.data;
  }

  const inline = inlineOf(data, label, where);
  if (inline.error) return { error: inline.error };

  const split = parseHeader(inline.text, label);
  if (split.error) return { error: split.error };

  const compiled = patternOf(split.header, label);
  if (compiled.error) return { error: compiled.error };

  let body = split.body;
  let sha = String(data.sha ?? '');
  if ('source' in split.header) {
    const target = resolveLink(entry.path, split.header.source);
    if (target === null) {
      return { error: `\`${label}\` names a \`source\` of \`${safeText(split.header.source)}\`, which is outside ${where}` };
    }
    const sourced = await fetchOne({ github, owner, repo, path: target });
    if (sourced.error) return { error: sourced.error };
    if (sourced.missing) {
      return { error: `\`${label}\` names a \`source\` of \`${target}\`, which is not on ${where}'s default branch` };
    }
    const read = inlineOf(sourced.data, target, where);
    if (read.error) return { error: read.error };
    const inner = parseHeader(read.text, target);
    if (inner.error) return { error: inner.error };
    if ('source' in inner.header) {
      return { error: `\`${target}\` names a \`source\` of its own; one hop is all a pack follows` };
    }
    body = inner.body;
    sha = String(sourced.data.sha ?? '');
  }

  const parsed = parseRules(body, label);
  if (parsed.error) return { error: parsed.error };

  return {
    pack: {
      name: entry.name,
      path: entry.path,
      sha,
      pattern: compiled.pattern,
      rules: parsed.rules,
      bytes: parsed.bytes,
    },
  };
}

async function readPacks({ github, owner, repo }) {
  const found = await fetchOne({ github, owner, repo, path: PACKS_PATH });
  if (found.error) return { error: found.error };
  if (found.missing) return { packs: [], present: false };

  const { data } = found;
  if (!Array.isArray(data)) {
    return { error: `\`${PACKS_PATH}\` in ${owner}/${repo} is a file; a directory is what holds rule packs` };
  }

  const entries = [...data].sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  if (entries.length > MAX_PACKS) {
    return { error: `\`${PACKS_PATH}\` holds ${entries.length} entries, over the limit of ${MAX_PACKS}` };
  }

  const packs = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? '');
    if (entry?.type === 'dir') {
      return { error: `\`${PACKS_PATH}/${safeText(name)}\` is a directory; rule packs are not read recursively` };
    }
    if (!PACK_SHAPE.test(name)) {
      return {
        error: `\`${PACKS_PATH}/${safeText(name)}\` is not a rule pack; every entry is a \`.md\` file named in letters, digits, \`.\`, \`-\` and \`_\``,
      };
    }
    const read = await readPack({ github, owner, repo, entry: { name, path: `${PACKS_PATH}/${name}` } });
    if (read.error) return { error: read.error };
    packs.push(read.pack);
  }

  return { packs, present: true };
}

/**
 * loadRepoRules reads `.ksai/review-rules.md` from the default branch and stages it for the review.
 *
 * Answers the step outputs, plus `failure` when the run must stop before a model is called.
 */
async function loadRepoRules({ github, core, owner, repo, mode, trigger, changedFiles }) {
  const outputs = {
    rules: '',
    path: RULES_PATH,
    sha: '',
    bytes: '',
    packs: '',
    enabled: 'false',
    mode: '',
    rejection: '',
  };
  const stop = (error) => {
    outputs.rejection = renderRulesRejection(error, trigger);
    return { outputs, failure: error };
  };

  const wanted = String(mode ?? '').trim().toLowerCase();
  if (!MODES.includes(wanted)) {
    return stop(`\`repo_rules\` must be \`${MODES.join('` or `')}\`, got \`${safeEcho(mode)}\``);
  }
  outputs.mode = wanted;
  if (wanted === 'off') {
    core.info(`repo_rules is off, so ${RULES_PATH} is not read and this review applies no repository rules.`);
    return { outputs, failure: null };
  }

  const staged = [];

  const found = await fetchOne({ github, owner, repo, path: RULES_PATH });
  if (found.error) return stop(found.error);
  if (!found.missing) {
    const inline = inlineOf(found.data, RULES_PATH, `${owner}/${repo}`);
    if (inline.error) return stop(inline.error);
    const parsed = parseRules(inline.text);
    if (parsed.error) return stop(parsed.error);
    staged.push({
      name: RULES_PATH,
      path: RULES_PATH,
      sha: String(found.data.sha ?? ''),
      rules: parsed.rules,
      bytes: parsed.bytes,
      matched: true,
    });
  }

  const read = await readPacks({ github, owner, repo });
  if (read.error) return stop(read.error);

  const paths = (Array.isArray(changedFiles) ? changedFiles : []).filter((entry) => typeof entry === 'string' && entry !== '');
  const scoped = read.packs.filter((pack) => pack.pattern !== null);
  if (scoped.length > 0 && paths.length === 0) {
    return stop(
      `\`${PACKS_PATH}\` holds ${counted(scoped.length, 'pack')} scoped by \`match\`, and this run has no changed-file list to match them against`,
    );
  }

  const applied = staged.map((pack) => ({ name: pack.name, sha: pack.sha, bytes: pack.bytes, matched: true }));
  for (const pack of read.packs) {
    const matched = pack.pattern === null || claimsAny(pack.pattern, paths);
    applied.push({ name: pack.name, sha: pack.sha, bytes: pack.bytes, matched });
    if (matched) staged.push(pack);
  }
  if (read.present) outputs.packs = JSON.stringify(applied);

  if (staged.length === 0) {
    core.info(
      read.present
        ? `No rule pack under ${PACKS_PATH}/ claims a changed file, so this review applies no repository rules.`
        : `No ${RULES_PATH} on ${owner}/${repo}'s default branch, so this review applies no repository rules.`,
    );
    return { outputs, failure: null };
  }

  const only = staged.length === 1 ? staged[0] : null;
  const rendered = only ? only.rules : staged.map((pack) => `# ${pack.path}\n\n${pack.rules}`).join('\n\n');
  const total = Buffer.byteLength(rendered, 'utf-8');
  if (total > MAX_TOTAL_BYTES) {
    return stop(
      `${counted(staged.length, 'rule pack')} match this diff and hold ${total} bytes together, over the limit of ${MAX_TOTAL_BYTES}; scope them more tightly with \`match\``,
    );
  }

  outputs.rules = rendered;
  outputs.path = staged.map((pack) => pack.path).join(', ');
  outputs.sha = only ? only.sha : '';
  outputs.bytes = String(total);
  outputs.enabled = 'true';

  core.info(`Loaded ${counted(total, 'byte')} of review rules from ${outputs.path}.`);
  return { outputs, failure: null };
}

module.exports = loadRepoRules;
Object.assign(module.exports, {
  RULES_PATH,
  PACKS_PATH,
  MAX_BYTES,
  MAX_TOTAL_BYTES,
  MAX_PACKS,
  MODES,
  parseRules,
  parseHeader,
  renderRulesRejection,
});
