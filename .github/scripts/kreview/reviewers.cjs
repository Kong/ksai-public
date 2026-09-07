const fs = require('node:fs');
const path = require('node:path');

/*
 * `audit-quirks.md` is the one context field whose name is not its filename. Null-prototype because
 * the key is a filename off a checkout and `ALIASES['constructor']` answers with a function on a
 * plain object, which would make a bad value rejected by luck rather than by missing.
 */
const FIELD_OF = Object.assign(Object.create(null), { 'audit-quirks': 'stack_quirks' });

const SKILL_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const SUFFIX = '-code-review';

const MANDATE = 'reviewer.md';

/** fieldOf answers the context-field name a knowledge file is passed under. */
function fieldOf(base) {
  return FIELD_OF[base] ?? base.replaceAll('-', '_');
}

/** reviewerOf names the mandate a skill reviews under, which is the skill's own name. */
function reviewerOf(skill) {
  return skill.endsWith(SUFFIX) ? `${skill.slice(0, -SUFFIX.length)}-code-reviewer` : '';
}

/**
 * sharedFields answers the context fields every reviewer mandate names, which live beside the skills
 * rather than inside one.
 *
 * Enumerated for the same reason the per-skill catalogs are: every mandate declares
 * `review_instructions` and `format_policy` with a `${CLAUDE_PLUGIN_ROOT}` default, and a prompt that
 * lists neither leaves the model to resolve a placeholder it was told to ignore. A review that runs
 * without its format policy still posts, so nothing fails - it just tags findings by guesswork.
 */
function sharedFields(pluginRoot, { fs: io = fs } = {}) {
  const dir = path.join(String(pluginRoot ?? ''), 'resources');
  let files = [];
  try {
    files = io.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ name: fieldOf(file.slice(0, -'.md'.length)), path: path.join(dir, file) }));
}

/**
 * resolveReviewers answers the mandate and knowledge files a run's triage routing names.
 *
 * The knowledge files are enumerated off the checkout rather than declared here. A hand-kept list is
 * right when written and quietly wrong the first time a skill gains a catalog, and the failure is
 * silent: the review runs without the file and reports success.
 *
 * A named skill that does not resolve is refused rather than skipped. Triage draws these names from a
 * fixed allowlist in the trusted action, so an unresolvable one means the plugin checkout is not what
 * this action thinks it is - and a review that quietly drops its own mistake catalog looks exactly
 * like one that found nothing.
 */
function resolveReviewers(skills, pluginRoot, { fs: io = fs } = {}) {
  const named = String(skills ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const root = String(pluginRoot ?? '');
  const reviewers = [];
  const refused = [];

  for (const skill of named) {
    if (!SKILL_SHAPE.test(skill) || reviewerOf(skill) === '') {
      refused.push(`\`${skill}\` is not a kreview skill name`);
      continue;
    }
    const agent = reviewerOf(skill);
    const agentPath = path.join(root, 'skills', skill, MANDATE);
    if (!io.existsSync(agentPath)) {
      refused.push(`\`${skill}\` carries no ${MANDATE}, so ${agentPath} does not exist`);
      continue;
    }
    let files = [];
    try {
      files = io.readdirSync(path.join(root, 'skills', skill));
    } catch {
      refused.push(`\`${skill}\` has no directory under ${path.join(root, 'skills')}`);
      continue;
    }
    /*
     * `SKILL.md` is the standalone process and `reviewer.md` is the mandate itself, so neither is a
     * catalog. Passing the mandate to itself as a context field would have it read its own file.
     */
    const fields = files
      .filter((file) => file.endsWith('.md') && file !== 'SKILL.md' && file !== MANDATE)
      .sort()
      .map((file) => ({
        name: fieldOf(file.slice(0, -'.md'.length)),
        path: path.join(root, 'skills', skill, file),
      }));
    reviewers.push({ skill, agent, agentPath, fields });
  }

  return { reviewers, refused };
}

/**
 * availableReviewers answers every reviewer the checked-out plugin carries.
 *
 * Read only where triage named nothing, which is triage off or triage failed rather than triage
 * having no opinion. The routing it would have done still has to happen somewhere, so the prompt
 * lists what exists and the model picks - the behaviour that was there before triage was.
 *
 * Only a directory whose name is a skill name is offered. Handing every entry under `skills/` to the
 * resolver made a `README.md` beside them, or a directory named without the suffix, refuse - and a
 * refusal fails the step, so one stray file would have broken every unrouted review. Triage routes
 * nothing for a JS or YAML diff, so unrouted is the common path rather than the edge. The refusal
 * that matters is kept: a real skill directory whose agent file is gone still stops the run.
 */
function availableReviewers(pluginRoot, { fs: io = fs } = {}) {
  const root = String(pluginRoot ?? '');
  let skills = [];
  try {
    skills = io
      .readdirSync(path.join(root, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => SKILL_SHAPE.test(name) && name.endsWith(SUFFIX))
      .sort();
  } catch {
    return { reviewers: [], refused: [] };
  }
  return resolveReviewers(skills.join(','), root, { fs: io });
}

/**
 * bodyOf answers a file's text, or null where it cannot be read.
 *
 * Injection rather than a path is what removes a tool call from the head of every run: the trusted
 * step writes the prompt, so splicing costs no model output at all and moves input the run was going
 * to read anyway. Only what is always needed is injected - a catalog is consulted selectively and
 * stays a path.
 */
function bodyOf(at, { fs: io = fs } = {}) {
  try {
    /*
     * Empty answers null like an unreadable file does. A 0-byte mandate reads fine, ships as an empty
     * pair of tags, and the review then runs with no severity rubric and no hunt list while every step
     * reports success - which is the failure this guard exists for, not a narrower one.
     */
    const text = io.readFileSync(at, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

module.exports = { resolveReviewers, availableReviewers, sharedFields, bodyOf, reviewerOf, fieldOf, SKILL_SHAPE };
