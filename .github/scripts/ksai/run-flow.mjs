import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import modelCatalog from '../lib/model-catalog.json' with { type: 'json' };
import { writeOutputs } from '../lib/outputs.mjs';

const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const GH_DENY = 'Bash(gh:*),Bash(gh)';

/**
 * PROFILES is what `flow: run` may touch, named once so a caller picks a bound instead of enumerating one.
 *
 * The lists are `claude-run`'s, in the Claude tool vocabulary `opencodePermissions` translates, so the two
 * actions grant one profile the same tools. `gh` is denied under every profile: this flow hands the model
 * no GitHub token, and a trusted step in the calling job owns anything that leaves the runner.
 */
export const PROFILES = Object.freeze({
  reviewer: Object.freeze({
    agent: true,
    phase: 'review',
    allowed:
      'Agent,Task,Skill,Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git ls-tree:*),Bash(git ls-files:*),Bash(git grep:*),Bash(grep:*),Bash(rg:*),Bash(cat:*),Bash(ls:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(wc:*)',
    disallowed: `Write,Edit,NotebookEdit,WebFetch,WebSearch,CronCreate,CronDelete,CronList,ScheduleWakeup,SendMessage,Workflow,Bash(git commit:*),Bash(git push:*),Bash(git add:*),Bash(git reset:*),${GH_DENY}`,
  }),
  fixer: Object.freeze({
    agent: true,
    phase: 'direct',
    allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
    disallowed: `NotebookEdit,WebFetch,WebSearch,CronCreate,CronDelete,CronList,ScheduleWakeup,SendMessage,Workflow,Bash(git push:*),Bash(git push),Bash(git remote:*),Bash(git remote),${GH_DENY}`,
  }),
  isolated: Object.freeze({ agent: false, phase: '', allowed: '', disallowed: '' }),
});

const listed = (value) =>
  String(value ?? '')
    .split(/[\n,]/)
    .map((one) => one.trim())
    .filter(Boolean);

const isFile = (path) => statSync(path).isFile();

/**
 * runPlan answers what a `flow: run` call runs, or throws naming the input that cannot be kept.
 *
 * A bound this path cannot honour is refused rather than dropped: the isolated profile reaches no agent,
 * so a tool list or a sandbox scope beside it would bound nothing while its caller believed otherwise.
 */
export function runPlan(env = {}, { exists = existsSync, regular = isFile } = {}) {
  const profile = String(env.PROFILE ?? '').trim();
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`profile: flow: run takes one of ${Object.keys(PROFILES).join(', ')}, got: ${profile || '(empty)'}`);
  }
  const shape = PROFILES[profile];

  const file = String(env.PROMPT_FILE ?? '').trim();
  if (!file) throw new Error('prompt_file: flow: run was given no prompt, so there is nothing to run');
  if (!exists(file) || !regular(file)) throw new Error(`prompt_file: ${file} is not a file this runner holds`);

  const asked = String(env.MODEL ?? '').trim();
  if (!asked) throw new Error('model: flow: run names no model, so one would be resolved here rather than by whoever priced the run');
  const alias = asked.toLowerCase();
  const model = Object.hasOwn(modelCatalog.aliases, alias) ? modelCatalog.aliases[alias] : asked;
  if (/[\s"]/.test(model)) throw new Error(`model: ${model} carries whitespace or a quote`);

  const effort = String(env.EFFORT ?? '').trim();
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort: must be one of ${EFFORTS.join(', ')}, got: ${effort}`);

  const extraAllowed = listed(env.EXTRA_ALLOWED);
  const extraDisallowed = listed(env.EXTRA_DISALLOWED);
  for (const [name, entries] of [
    ['extra_allowed_tools', extraAllowed],
    ['extra_disallowed_tools', extraDisallowed],
  ]) {
    for (const entry of entries) {
      if (entry.startsWith('-')) throw new Error(`${name}: ${entry} starts with a dash, which reads as a flag rather than a tool pattern`);
      if (entry.includes('"')) throw new Error(`${name}: ${entry} carries a double quote`);
    }
  }
  if (profile !== 'fixer' && extraAllowed.includes('Bash')) {
    throw new Error(`extra_allowed_tools: unqualified Bash under the ${profile} profile writes files through a redirection the profile denies`);
  }

  if (!shape.agent) {
    const bounds = {
      extra_allowed_tools: extraAllowed.length,
      extra_disallowed_tools: extraDisallowed.length,
      sandbox_allow_write: listed(env.SANDBOX_ALLOW_WRITE).length,
      sandbox_deny_write: listed(env.SANDBOX_DENY_WRITE).length,
      sandbox_deny_env: listed(env.SANDBOX_DENY_ENV).length,
    };
    const named = Object.entries(bounds)
      .filter(([, value]) => value)
      .map(([name]) => name);
    if (named.length) {
      throw new Error(`${named.join(', ')}: the isolated profile posts one message and holds no tools, so these would bound nothing. Drop them`);
    }
  }

  const outputs = {
    file,
    model,
    effort,
    profile,
    agent: String(shape.agent),
    phase: shape.phase,
    allowed_tools: [shape.allowed, ...extraAllowed].filter(Boolean).join(','),
    disallowed_tools: [shape.disallowed, ...extraDisallowed].filter(Boolean).join(','),
    result_transport: 'text',
  };
  return outputs;
}

export function main(env = process.env) {
  const output = String(env.GITHUB_OUTPUT ?? '');
  if (!output) throw new Error('GITHUB_OUTPUT names no file, so the plan would reach no step');
  writeOutputs(output, runPlan(env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
