const FORBIDDEN_FLAGS = Object.freeze([
  '--model',
  '--effort',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--plugin-dir',
  '--add-dir',
  '--mcp-config',
  '--settings',
  '--agents',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--permission-mode',
  '--permission-prompt-tool',
  '--dangerously-skip-permissions',
]);

function carriesForbiddenFlag(extra) {
  return new RegExp(`(^|\\s)(${FORBIDDEN_FLAGS.join('|')})(=|\\s|$)`, 'i').test(String(extra ?? ''));
}

const EXTRA_ARGS_REFUSAL =
  'extra_claude_args must not contain flags that alter tool access, plugins, or system instructions';

function validateExtraArgs(extra) {
  return carriesForbiddenFlag(extra) ? EXTRA_ARGS_REFUSAL : null;
}

const READING_BASH =
  'Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git ls-tree:*),Bash(grep:*),Bash(rg:*),' +
  'Bash(cat:*),Bash(ls:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(date:*)';

const NEVER = 'NotebookEdit,WebFetch,WebSearch,CronCreate,CronDelete,CronList,ScheduleWakeup,SendMessage,Workflow';

const CREDENTIALED = 'Bash(git push:*),Bash(git push),Bash(git remote:*),Bash(git remote),Bash(gh:*),Bash(gh)';

const TOOL_POLICY = Object.freeze(
  Object.assign(Object.create(null), {
    plan: Object.freeze({
      allowed: `Agent,Task,Skill,Read,Write,Grep,Glob,${READING_BASH}`,
      disallowed: `Edit,${NEVER},Bash(git commit:*),Bash(git push:*),Bash(git add:*),Bash(git remote:*),Bash(gh:*),Bash(gh)`,
    }),
    revise: Object.freeze({
      allowed: `Agent,Task,Skill,Read,Write,Edit,Grep,Glob,${READING_BASH},Bash(git add:*),Bash(git commit:*),Bash(git status:*)`,
      disallowed: `${NEVER},${CREDENTIALED}`,
    }),
    step: Object.freeze({
      allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
      disallowed: `${NEVER},${CREDENTIALED}`,
    }),
    direct: Object.freeze({
      allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
      disallowed: `${NEVER},${CREDENTIALED}`,
    }),
    fix: Object.freeze({
      allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
      disallowed: `${NEVER},${CREDENTIALED}`,
    }),
    do: Object.freeze({
      allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
      disallowed: `${NEVER},${CREDENTIALED}`,
    }),
    'do-merge': Object.freeze({
      allowed: 'Agent,Task,Skill,Read,Write,Edit,Grep,Glob,Bash',
      disallowed:
        `${NEVER},${CREDENTIALED},Bash(git commit:*),Bash(git commit),Bash(git merge:*),Bash(git merge),` +
        'Bash(git rebase:*),Bash(git rebase),Bash(git reset:*),Bash(git reset),Bash(git am:*),Bash(git am)',
    }),
    review: Object.freeze({
      allowed: `Agent,Task,Read,Grep,Glob,${READING_BASH},Bash(go env:*),Bash(awk:*),Bash(sed:*)`,
      disallowed: `Write,Edit,Skill,${NEVER},Bash(git commit:*),Bash(git push:*),Bash(git add:*),Bash(git reset:*),Bash(git stash:*)`,
    }),
    test: Object.freeze({
      allowed: 'Read,Grep,Glob,Write,Bash',
      disallowed: `${NEVER},Skill,Agent,Task,Bash(gh:*),Bash(git commit:*),Bash(git push:*),Bash(git add:*)`,
    }),
  }),
);

function toolPolicy(phase) {
  return TOOL_POLICY[String(phase ?? '')] ?? null;
}

module.exports = {
  FORBIDDEN_FLAGS,
  carriesForbiddenFlag,
  validateExtraArgs,
  EXTRA_ARGS_REFUSAL,
  TOOL_POLICY,
  toolPolicy,
};
