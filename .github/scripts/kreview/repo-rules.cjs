const nodePath = require('node:path');

const { asAlert, safeEcho, scrubTrigger } = require('../lib/select-arm.cjs');
const { counted, describe, locate, safeText } = require('../lib/text.cjs');
const { neutralizeSections } = require('../lib/prompt-text.cjs');
const { ALLOWED_FLAGS, claimsAny, claimsAnyGlob, toGlobs, toPattern } = require('../lib/path-pattern.cjs');

const RULES_PATH = '.ksai/review-rules.md';
const PACKS_PATH = '.ksai/review-rules';
const MANIFEST_PATH = '.ksai/review-rules.json';
const MAX_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024;
const MAX_TOTAL_CEILING = 256 * 1024;
const MAX_PACKS = 16;
const MAX_PACKS_CEILING = 64;
const MAX_SOURCES = 32;
const MAX_SOURCES_CEILING = 128;
const DEFAULT_LIMITS = Object.freeze({ rules: MAX_PACKS, sources: MAX_SOURCES });
const MODES = Object.freeze(['auto', 'off']);

const PACK_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const HEADER_KEYS = Object.freeze(['match', 'flags', 'paths', 'source']);

const LIST_KEYS = Object.freeze(['paths', 'source']);

const MANIFEST_KEYS = Object.freeze(['name', 'description']);

const FENCE = /^---[ \t]*\n([^]*?)\n---[ \t]*(?:\n|$)/;

const QUOTED = /^['"]|['"]$/;

const BALANCED = /^(['"])([^]*)\1$/;

const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/;

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

function unquote(value, label, key) {
  const balanced = BALANCED.exec(value);
  if (balanced) return { value: balanced[2].trim() };
  if (QUOTED.test(value)) {
    return {
      error: `\`${label}\` leaves a quote dangling on its \`${key}\`; quote both sides of an entry, or neither`,
    };
  }
  return { value };
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
  let listKey = null;
  for (const line of fenced[1].split('\n')) {
    if (line.trim() === '') continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (listKey === null) {
        foreign.push('');
        continue;
      }
      const read = unquote(item[1].trim(), label, listKey);
      if (read.error) return { error: read.error };
      if (read.value === '') {
        return { error: `\`${label}\` leaves an entry under \`${listKey}\` empty` };
      }
      header[listKey].push(read.value);
      continue;
    }
    if (/^[ \t]/.test(line)) {
      foreign.push('');
      listKey = null;
      continue;
    }
    listKey = null;
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
    if (LIST_KEYS.includes(key)) {
      if (value === '') {
        header[key] = [];
        listKey = key;
        continue;
      }
      if (value.startsWith('[')) {
        return {
          error:
            `\`${label}\` writes its \`${key}\` as a bracketed list; write one entry per line under ` +
            `\`${key}:\`${key === 'paths' ? ', or one line separated by commas' : ''}`,
        };
      }
      const read = unquote(value, label, key);
      if (read.error) return { error: read.error };
      header[key] = read.value;
      continue;
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
  const scoped = 'match' in header;
  const globbed = 'paths' in header;
  if (scoped && globbed) {
    return { error: `\`${label}\` names both \`paths\` and \`match\`; a pack scopes itself one way or the other` };
  }
  if (globbed) {
    if ('flags' in header) {
      return {
        error: `\`${label}\` names \`flags\` beside \`paths\`; \`flags\` belongs to \`match\`, and a glob folds case on its own`,
      };
    }
    const read = toGlobs(header.paths);
    if (read.error) return { error: `\`${label}\` has a \`paths\` this cannot use: ${read.error}` };
    return { scope: { globs: read.globs } };
  }
  if (!scoped) {
    if ('flags' in header) {
      return { error: `\`${label}\` names \`flags\` with no \`match\`, so nothing would use them` };
    }
    return { scope: null };
  }
  if ('flags' in header && !ALLOWED_FLAGS.test(header.flags)) {
    return { error: `\`${label}\` sets \`flags: ${safeText(header.flags)}\`; a pack takes \`i\` or nothing` };
  }
  const pattern = toPattern({ match: header.match, flags: header.flags });
  if (!pattern) {
    return { error: `\`${label}\` has a \`match\` this cannot compile; it is a regular expression` };
  }
  return { scope: { pattern } };
}

const scopeClaims = (scope, paths) =>
  scope?.pattern ? claimsAny(scope.pattern, paths) : claimsAnyGlob(scope?.globs, paths);


function resolveRuleCount(value) {
  const asked = String(value ?? '').trim();
  if (asked === '') return { rules: MAX_PACKS, sources: MAX_SOURCES };
  if (!/^[0-9]+$/.test(asked)) {
    return { error: `\`repo_rules_max_rules\` must be a whole number of rules, got \`${safeEcho(value)}\`` };
  }
  const rules = Number(asked);
  if (rules < MAX_PACKS) {
    return { error: `\`repo_rules_max_rules\` is ${rules}, below the ${MAX_PACKS} every review already gets` };
  }
  if (rules > MAX_PACKS_CEILING) {
    return { error: `\`repo_rules_max_rules\` is ${rules}, over the ceiling of ${MAX_PACKS_CEILING}` };
  }
  return { rules, sources: Math.min(MAX_SOURCES_CEILING, Math.max(MAX_SOURCES, rules * 2)) };
}

function resolveBudget(value) {
  const asked = String(value ?? '').trim();
  if (asked === '') return { bytes: MAX_TOTAL_BYTES };
  if (!/^[0-9]+$/.test(asked)) {
    return { error: `\`repo_rules_max_bytes\` must be a whole number of bytes, got \`${safeEcho(value)}\`` };
  }
  const bytes = Number(asked);
  if (bytes < MAX_TOTAL_BYTES) {
    return { error: `\`repo_rules_max_bytes\` is ${bytes}, below the ${MAX_TOTAL_BYTES} every review already gets` };
  }
  if (bytes > MAX_TOTAL_CEILING) {
    return { error: `\`repo_rules_max_bytes\` is ${bytes}, over the ceiling of ${MAX_TOTAL_CEILING}` };
  }
  return { bytes };
}

const RULES_REMEDY = [
  'Nothing was reviewed. Fix `review-rules.md` in `.ksai/` on the default branch, or set the',
  '`repo_rules` input to `off`, then ask again',
].join('\n');

const INPUT_REMEDY = [
  'Nothing was reviewed. No rules file is at fault and `repo_rules: off` does not bypass this.',
  'Fix the named input where this workflow is called, then ask again',
].join('\n');

/** renderRulesRejection answers the comment a run publishes when it refused to review without the rules. */
function renderRulesRejection(error, trigger, remedy = RULES_REMEDY) {
  return asAlert('WARNING', scrubTrigger([`**${error}**`, '', remedy].join('\n'), trigger));
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

function resolveFrom(base, target) {
  const wanted = String(target ?? '');
  if (wanted === '' || wanted.startsWith('/')) return null;
  const joined = nodePath.posix.normalize(nodePath.posix.join(base, wanted));
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  return joined;
}

const resolveBeside = (from, target) => resolveFrom(nodePath.posix.dirname(from), target);

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

async function readPack({ github, owner, repo, entry, budget }) {
  const where = `${owner}/${repo}`;
  const label = entry.path;

  const found = await fetchOne({ github, owner, repo, path: entry.path });
  if (found.error) return { error: found.error };
  if (found.missing) {
    return { error: `\`${label}\` was listed under \`${PACKS_PATH}\` and cannot be read back` };
  }

  let { data } = found;

  if (!Array.isArray(data) && data?.type === 'symlink') {
    const target = resolveBeside(entry.path, data.target);
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

  if ('source' in split.header) {
    const read = await readSources({
      github,
      owner,
      repo,
      label: `\`${label}\``,
      budget,
      source: split.header.source,
      resolve: (target) => resolveBeside(entry.path, target),
    });
    if (read.error) return { error: read.error };
    return { pack: { name: entry.name, scope: compiled.scope, units: read.units } };
  }

  const parsed = parseRules(split.body, label);
  if (parsed.error) return { error: parsed.error };

  return {
    pack: {
      name: entry.name,
      scope: compiled.scope,
      units: [{ key: `path:${entry.path}`, path: entry.path, sha: String(data.sha ?? ''), rules: parsed.rules, bytes: parsed.bytes }],
    },
  };
}

async function readSources({ github, owner, repo, label, source, resolve, budget }) {
  const where = `${owner}/${repo}`;
  const wanted = (Array.isArray(source) ? source : [source]).filter((one) => String(one ?? '').trim() !== '');
  if (wanted.length === 0) {
    return { error: `${label} names a \`source\` with no file in it; name the file whose rules the review applies` };
  }
  const targets = [];
  const seen = new Set();
  for (const one of wanted) {
    const target = resolve(one);
    if (target === null) {
      return { error: `${label} names a \`source\` of \`${safeText(String(one))}\`, which is outside ${where}` };
    }
    if (seen.has(target)) {
      return { error: `${label} names \`${target}\` as a \`source\` twice` };
    }
    seen.add(target);
    targets.push(target);
  }

  if (budget) {
    for (const target of targets) {
      if (budget.read?.has(target) || budget.charged.has(target)) continue;
      if (budget.charged.size >= budget.sources) {
        return {
          error: `${label} takes the rules past ${counted(budget.sources, 'source file')}, which is all one review reads`,
        };
      }
      budget.charged.add(target);
    }
  }

  const units = [];
  for (const target of targets) {
    const already = budget?.read?.get(target);
    if (already) {
      units.push(already);
      continue;
    }
    const sourced = await fetchOne({ github, owner, repo, path: target });
    if (sourced.error) return { error: sourced.error };
    if (sourced.missing) {
      return { error: `${label} names a \`source\` of \`${target}\`, which is not on ${where}'s default branch` };
    }
    const read = inlineOf(sourced.data, target, where);
    if (read.error) return { error: read.error };
    const inner = parseHeader(read.text, target);
    if (inner.error) return { error: inner.error };
    if ('source' in inner.header) {
      return { error: `\`${target}\` names a \`source\` of its own; one hop is all a pack follows` };
    }
    const parsed = parseRules(inner.body, target);
    if (parsed.error) return { error: parsed.error };
    const unit = { key: `path:${target}`, path: target, sha: String(sourced.data.sha ?? ''), rules: parsed.rules, bytes: parsed.bytes };
    budget?.read?.set(target, unit);
    units.push(unit);
  }
  return { units };
}

const MANIFEST_TOP_KEYS = Object.freeze(['rules']);

const ENTRY_KEYS = Object.freeze(['name', 'paths', 'match', 'flags', 'source', 'rules']);

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}$/;

function parseManifest(raw, limits = DEFAULT_LIMITS) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? '').replace(/^﻿/, ''));
  } catch (e) {
    return { error: `\`${MANIFEST_PATH}\` is not valid JSON${locate(e.message)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `\`${MANIFEST_PATH}\` must hold a JSON object, got ${describe(parsed)}` };
  }
  const unknown = Object.keys(parsed).find((key) => !MANIFEST_TOP_KEYS.includes(key));
  if (unknown !== undefined) {
    return {
      error: `\`${MANIFEST_PATH}\` carries an unrecognized key \`${safeText(unknown)}\`; the key is \`${MANIFEST_TOP_KEYS.join('` and `')}\``,
    };
  }
  const rules = parsed.rules;
  if (!Array.isArray(rules)) {
    return { error: `the \`rules\` value in \`${MANIFEST_PATH}\` must be a JSON array of rules, got ${describe(rules)}` };
  }
  if (rules.length === 0) {
    return { error: `\`${MANIFEST_PATH}\` names no rules; delete the file, or name the rules the review must apply` };
  }
  if (rules.length > limits.rules) {
    return { error: `\`${MANIFEST_PATH}\` holds ${counted(rules.length, 'rule')}, over the limit of ${limits.rules}` };
  }

  const entries = [];
  const taken = new Map();
  for (const [index, entry] of rules.entries()) {
    const at = `rule ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `${at} in \`${MANIFEST_PATH}\` must be a JSON object, got ${describe(entry)}` };
    }
    let named = at;
    if ('name' in entry) {
      if (typeof entry.name !== 'string' || !NAME_SHAPE.test(entry.name)) {
        return {
          error: `the \`name\` of ${at} in \`${MANIFEST_PATH}\` must be a short label in letters, digits, spaces, \`.\`, \`-\` and \`_\``,
        };
      }
      named = `${at} (\`${entry.name}\`)`;
    }
    const wrong = Object.keys(entry).find((key) => !ENTRY_KEYS.includes(key));
    if (wrong !== undefined) {
      return {
        error: `${named} in \`${MANIFEST_PATH}\` carries an unrecognized key \`${safeText(wrong)}\`; a rule takes \`${ENTRY_KEYS.join('`, `')}\``,
      };
    }
    const sourced = 'source' in entry;
    const inline = 'rules' in entry;
    if (sourced === inline) {
      return {
        error: `${named} in \`${MANIFEST_PATH}\` names ${sourced ? 'both `source` and `rules`' : 'neither `source` nor `rules`'}; a rule points at a file or carries its own text`,
      };
    }
    if (sourced) {
      const source = Array.isArray(entry.source) ? entry.source : [entry.source];
      if (source.length === 0 || source.some((one) => typeof one !== 'string' || one.trim() === '')) {
        return { error: `the \`source\` of ${named} in \`${MANIFEST_PATH}\` names a path, or a JSON array of them` };
      }
    } else if (typeof entry.rules !== 'string' || entry.rules.trim() === '') {
      return { error: `the \`rules\` of ${named} in \`${MANIFEST_PATH}\` must be the text the review applies, got ${describe(entry.rules)}` };
    }
    const name = entry.name ?? at;
    if (taken.has(name)) {
      return {
        error:
          `${named} in \`${MANIFEST_PATH}\` is named \`${safeText(name)}\`, and so is ${taken.get(name)}; ` +
          'a name is how a rule is reported and staged, so two rules cannot share one',
      };
    }
    taken.set(name, named);
    entries.push({ entry, label: `${named} in \`${MANIFEST_PATH}\``, name });
  }
  return { entries };
}

async function readManifest({ github, owner, repo, budget, limits }) {
  const found = await fetchOne({ github, owner, repo, path: MANIFEST_PATH });
  if (found.error) return { error: found.error };
  if (found.missing) return { packs: [], present: false };

  const inline = inlineOf(found.data, MANIFEST_PATH, `${owner}/${repo}`);
  if (inline.error) return { error: inline.error };

  const read = parseManifest(inline.text, limits);
  if (read.error) return { error: read.error };

  const named = new Set();
  for (const { entry, label } of read.entries) {
    if (!('source' in entry)) continue;
    for (const one of Array.isArray(entry.source) ? entry.source : [entry.source]) {
      const target = resolveFrom('.', one);
      if (target === null) {
        return { error: `${label} names a \`source\` of \`${safeText(String(one))}\`, which is outside ${owner}/${repo}` };
      }
      named.add(target);
    }
  }
  if (named.size > limits.sources) {
    return {
      error: `\`${MANIFEST_PATH}\` names ${counted(named.size, 'source file')}, over the limit of ${limits.sources}`,
    };
  }

  const sha = String(found.data.sha ?? '');
  const packs = [];
  for (const { entry, label, name } of read.entries) {
    const compiled = patternOf(entry, label);
    if (compiled.error) return { error: compiled.error };

    if ('rules' in entry) {
      const parsed = parseRules(entry.rules, label);
      if (parsed.error) return { error: parsed.error };
      packs.push({
        name,
        scope: compiled.scope,
        units: [{ key: `rule:${name}`, path: `${MANIFEST_PATH} (${name})`, sha, rules: parsed.rules, bytes: parsed.bytes }],
      });
      continue;
    }

    const sourced = await readSources({
      github,
      owner,
      repo,
      label,
      budget,
      source: entry.source,
      resolve: (target) => resolveFrom('.', target),
    });
    if (sourced.error) return { error: sourced.error };
    packs.push({ name, scope: compiled.scope, units: sourced.units });
  }

  return { packs, present: true };
}

async function readPacks({ github, owner, repo, budget, limits }) {
  const found = await fetchOne({ github, owner, repo, path: PACKS_PATH });
  if (found.error) return { error: found.error };
  if (found.missing) return { packs: [], present: false };

  const { data } = found;
  if (!Array.isArray(data)) {
    return { error: `\`${PACKS_PATH}\` in ${owner}/${repo} is a file; a directory is what holds rule packs` };
  }

  const entries = [...data].sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  if (entries.length > limits.rules) {
    return { error: `\`${PACKS_PATH}\` holds ${entries.length} entries, over the limit of ${limits.rules}` };
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
    const read = await readPack({ github, owner, repo, budget, entry: { name, path: `${PACKS_PATH}/${name}` } });
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
async function loadRepoRules({ github, core, owner, repo, mode, trigger, changedFiles, maxBytes, maxRules }) {
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
  const refuseInput = (error) => {
    outputs.rejection = renderRulesRejection(error, trigger, INPUT_REMEDY);
    return { outputs, failure: error };
  };

  const budgetRead = resolveBudget(maxBytes);
  if (budgetRead.error) return refuseInput(budgetRead.error);
  const ceiling = budgetRead.bytes;

  const limits = resolveRuleCount(maxRules);
  if (limits.error) return refuseInput(limits.error);

  const wanted = String(mode ?? '').trim().toLowerCase();
  if (!MODES.includes(wanted)) {
    return refuseInput(`\`repo_rules\` must be \`${MODES.join('` or `')}\`, got \`${safeEcho(mode)}\``);
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
      scope: null,
      units: [{ key: `path:${RULES_PATH}`, path: RULES_PATH, sha: String(found.data.sha ?? ''), rules: parsed.rules, bytes: parsed.bytes }],
    });
  }

  const budget = { charged: new Set(), read: new Map(), sources: limits.sources };
  const listed = await readManifest({ github, owner, repo, budget, limits });
  if (listed.error) return stop(listed.error);

  const read = await readPacks({ github, owner, repo, budget, limits });
  if (read.error) return stop(read.error);

  const groups = [...listed.packs, ...read.packs];
  const paths = (Array.isArray(changedFiles) ? changedFiles : []).filter((entry) => typeof entry === 'string' && entry !== '');
  const scoped = groups.filter((pack) => pack.scope !== null);
  if (scoped.length > 0 && paths.length === 0) {
    const where = listed.packs.some((pack) => pack.scope !== null) ? MANIFEST_PATH : PACKS_PATH;
    return stop(
      `\`${where}\` holds ${counted(scoped.length, 'rule')} scoped by path, and this run has no changed-file list to match them against`,
    );
  }

  const sizeOf = (pack) => pack.units.reduce((total, unit) => total + unit.bytes, 0);
  const shaOf = (pack) => (pack.units.length === 1 ? pack.units[0].sha : '');
  const applied = staged.map((pack) => ({ name: pack.name, sha: shaOf(pack), bytes: sizeOf(pack), matched: true }));
  for (const pack of groups) {
    const matched = pack.scope === null || scopeClaims(pack.scope, paths);
    applied.push({ name: pack.name, sha: shaOf(pack), bytes: sizeOf(pack), matched });
    if (matched) staged.push(pack);
  }
  if (read.present || listed.present) outputs.packs = JSON.stringify(applied);

  if (staged.length === 0) {
    core.info(
      read.present || listed.present
        ? `No rule under ${PACKS_PATH}/ or in ${MANIFEST_PATH} claims a changed file, so this review applies no repository rules.`
        : `No ${RULES_PATH} on ${owner}/${repo}'s default branch, so this review applies no repository rules.`,
    );
    return { outputs, failure: null };
  }

  const units = [];
  const seen = new Set();
  for (const pack of staged) {
    for (const unit of pack.units) {
      if (seen.has(unit.key)) continue;
      seen.add(unit.key);
      units.push(unit);
    }
  }

  const only = units.length === 1 ? units[0] : null;
  const rendered = only
    ? only.rules
    : neutralizeSections(units.map((unit) => `# ${unit.path}\n\n${unit.rules}`).join('\n\n'));
  const total = Buffer.byteLength(rendered, 'utf-8');
  if (total > ceiling) {
    return stop(
      `${counted(units.length, 'rule source')} match this diff and hold ${total} bytes together, over the limit of ${ceiling}; ` +
        (ceiling < MAX_TOTAL_CEILING
          ? `scope them more tightly with \`paths\`, or raise \`repo_rules_max_bytes\` up to ${MAX_TOTAL_CEILING}`
          : 'scope them more tightly with `paths`'),
    );
  }

  outputs.rules = rendered;
  outputs.path = units.map((unit) => unit.path).join(', ');
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
  MANIFEST_PATH,
  MAX_BYTES,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_CEILING,
  MAX_PACKS_CEILING,
  MAX_SOURCES_CEILING,
  resolveBudget,
  resolveRuleCount,
  MAX_PACKS,
  MODES,
  parseRules,
  parseHeader,
  parseManifest,
  renderRulesRejection,
});
