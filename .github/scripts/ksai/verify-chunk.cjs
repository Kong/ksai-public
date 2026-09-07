
const fs = require('node:fs');
const path = require('node:path');

const { MAX_FILES: MAX_INSTRUCTION_FILES, expandDenied } = require('./instructions.cjs');
const { GIT_CONFIG_OVERRIDES, directGit, gitArgs, gitEnv, gitVia } = require('./trusted-git.cjs');
const { stageMerge } = require('./stage.cjs');
const { counted } = require('../lib/text.cjs');

const COMMIT_TYPES = Object.freeze(['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'ci', 'build', 'style', 'revert']);

const BRANCH_SHAPE = new RegExp(`^(${COMMIT_TYPES.join('|')})\\/issue-[0-9]+-[a-z0-9-]{1,60}$`);

const JIRA_BRANCH_SHAPE = new RegExp(
  `^(${COMMIT_TYPES.join('|')})\\/jira-[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}-[a-z0-9-]{1,60}$`,
);

const FLOW_BRANCH_SHAPE = new RegExp(`${BRANCH_SHAPE.source}|${JIRA_BRANCH_SHAPE.source}`);

const EXISTING_BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,200}$/;

const BRANCH_GRAMMARS = Object.freeze(
  Object.assign(Object.create(null), {
    'flow-named': Object.freeze({ pattern: FLOW_BRANCH_SHAPE, forbid: Object.freeze([]) }),
    'human-named': Object.freeze({ pattern: EXISTING_BRANCH_SHAPE, forbid: Object.freeze(['..']) }),
  }),
);

const DEFAULT_BRANCH_GRAMMAR = 'flow-named';

const MAX_DIRECT_COMMITS = 20;

function matchesBranchGrammar(branch, grammarName = DEFAULT_BRANCH_GRAMMAR) {
  const grammar = Object.prototype.hasOwnProperty.call(BRANCH_GRAMMARS, grammarName)
    ? BRANCH_GRAMMARS[grammarName]
    : null;
  if (!grammar) return false;
  const value = String(branch ?? '');
  return grammar.pattern.test(value) && !grammar.forbid.some((sequence) => value.includes(sequence));
}

const SHA_SHAPE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

const DENIED_PATH_FLOOR = Object.freeze([
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.github/workflows',
  '.github/actions',
  '.claude',
  '.ksai',
  '.mcp.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.env',
  'bunfig.toml',
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
]);

const DENIED_PREFIX_FLOOR = Object.freeze(['.env.']);

const COMMIT_DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-renames', '--ignore-submodules=none', '--name-only', '-z']);
const WORKTREE_DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-renames', '--ignore-submodules=dirty', '--name-only', '-z']);

function safeEcho(value) {
  const scrubbed = String(value ?? '').replace(/[^A-Za-z0-9._/-]/g, '?');
  return scrubbed.length > 60 ? `${scrubbed.slice(0, 60)}…` : scrubbed;
}

function normalizeDeniedPaths(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const entries = [];
  for (const item of raw) {
    const entry = String(item ?? '')
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (entry) entries.push(entry);
  }
  return entries;
}

const PLAN_ONLY_PHASES = Object.freeze(['plan', 'revise']);

const HUMAN_BRANCH_PHASES = Object.freeze(['fix', 'do', 'unlock']);

const grammarFor = (phase) =>
  (HUMAN_BRANCH_PHASES.includes(String(phase ?? '')) ? 'human-named' : DEFAULT_BRANCH_GRAMMAR);

const soleWritable = (phase, planFile) =>
  (PLAN_ONLY_PHASES.includes(String(phase ?? '')) ? String(planFile ?? '') : null);

function deniedFor({ workdir = null, baseSha = null, deniedPaths = null, planDir = null, onlyPath = null } = {}) {
  const sole = String(onlyPath ?? '').trim();
  const denied = [
    ...new Set([
      ...DENIED_PATH_FLOOR,
      ...normalizeDeniedPaths(deniedPaths),
      ...(sole === '' ? normalizeDeniedPaths(planDir) : []),
    ]),
  ];
  const said = (entries) => [
    ...entries.map((entry) => shownEntry(entry)),
    ...DENIED_PREFIX_FLOOR.map((prefix) => shownPrefix(prefix)),
  ];
  const at = String(workdir ?? '').trim();
  const ref = String(baseSha ?? '').trim();
  if (!at || !SHA_SHAPE.test(ref)) return { denied, stated: said(denied), truncated: false, unreadable: false };

  const git = directGit(at);
  const nested = git(['ls-tree', '-r', '--name-only', '-z', ref]);
  if (!nested.ok) return { denied, stated: said(denied), truncated: false, unreadable: true };
  const roots = [
    ...denied,
    ...splitZ(nested.stdout).filter(
      (file) => /\.mdx?$/i.test(file) && file !== path.posix.basename(file) && anyDepthFile(file, denied),
    ),
  ];

  const expanded = expandDenied(roots, (entry) => {
    const shown = git(['show', `${ref}:${entry}`]);
    return shown.ok ? shown.stdout : null;
  });
  return { denied: expanded.denied, stated: said(expanded.denied), truncated: expanded.truncated, unreadable: false };
}

const ANY_DEPTH_FLOOR = Object.freeze([
  'CLAUDE.md',
  'AGENTS.md',
  '.claude',
  '.env',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  '.mcp.json',
]);

const anyDepth = (entry) => ANY_DEPTH_FLOOR.includes(entry);

const shownEntry = (entry) => (anyDepth(entry) ? `**/${entry}` : entry);

const shownPrefix = (prefix) => `**/${prefix}*`;

function anyDepthFile(file, denied) {
  const name = path.posix.basename(file);
  return anyDepth(name) && denied.includes(name) ? name : null;
}

function anyDepthEntry(file, denied) {
  for (const segment of String(file).split('/')) {
    if (anyDepth(segment) && denied.includes(segment)) return segment;
  }
  return null;
}

function deniedMatch(file, denied) {
  for (const entry of denied) {
    if (file === entry || file.startsWith(`${entry}/`)) return entry;
  }
  const nested = anyDepthEntry(file, denied);
  if (nested) return shownEntry(nested);
  for (const prefix of DENIED_PREFIX_FLOOR) {
    if (file.startsWith(prefix) || path.posix.basename(file).startsWith(prefix)) return shownPrefix(prefix);
  }
  return null;
}

function aheadOf({ from = null, to = 'HEAD', git = null } = {}) {
  for (const value of [from, to]) {
    const shown = String(value ?? '');
    if (!SHA_SHAPE.test(shown) && shown !== 'HEAD') {
      return { ok: false, count: null, reason: `\`${safeEcho(shown)}\` is not a commit sha` };
    }
  }
  const result = typeof git === 'function' ? git(['rev-list', '--count', `${from}..${to}`]) : null;
  const count = Number.parseInt(String(result?.stdout ?? '').trim(), 10);
  if (!result?.ok || !Number.isInteger(count)) {
    return { ok: false, count: null, reason: 'git could not count the commits - see the workflow run' };
  }
  return { ok: true, count, reason: '' };
}

function noChangeLeftBehind({ from = null, git = null } = {}) {
  const ahead = aheadOf({ from, git });
  if (!ahead.ok) return { ok: false, unreadable: true, reason: ahead.reason };
  if (ahead.count !== 0) {
    return { ok: false, unreadable: false, reason: `left ${counted(ahead.count, 'commit')} on the branch` };
  }
  const tracked = git(['diff', ...WORKTREE_DIFF_FLAGS, 'HEAD']);
  if (!tracked?.ok) {
    return { ok: false, unreadable: true, reason: 'the state of the workspace could not be read' };
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked?.ok) {
    return { ok: false, unreadable: true, reason: 'the state of the workspace could not be read' };
  }
  const leftover = splitZ(tracked.stdout)[0] ?? splitZ(untracked.stdout)[0];
  if (leftover) {
    return { ok: false, unreadable: false, reason: `left uncommitted changes to \`${safeEcho(leftover)}\`` };
  }
  return { ok: true, unreadable: false, reason: '' };
}

function splitZ(stdout) {
  return String(stdout ?? '')
    .split('\0')
    .filter(Boolean);
}

const deny = (reason) => ({ ok: false, reason });

function deniedRefusal(expanded, baseSha) {
  if (expanded.unreadable) {
    return `the tree at ${baseSha} could not be listed, so the instruction files this push may not touch are not known; nothing was pushed`;
  }
  if (expanded.truncated) {
    return `the instruction files import more than ${MAX_INSTRUCTION_FILES} others, which is more than this flow will follow; nothing was pushed`;
  }
  return '';
}

function openTree({ cwd = null, branch = null, branchGrammar = DEFAULT_BRANCH_GRAMMAR, manifestPath = null } = {}) {
  const workdir = String(cwd ?? '');
  if (!workdir) return deny('no workspace directory was given to verify.');

  const grammarName = String(branchGrammar ?? '');
  if (!Object.prototype.hasOwnProperty.call(BRANCH_GRAMMARS, grammarName)) {
    return deny(`\`${safeEcho(grammarName)}\` is not a branch grammar this flow knows.`);
  }
  const branchName = String(branch ?? '');
  if (!branchName) return deny('the manifest named no branch.');
  if (!matchesBranchGrammar(branchName, grammarName)) {
    return deny(
      grammarName === DEFAULT_BRANCH_GRAMMAR
        ? `branch \`${safeEcho(branchName)}\` is not a valid step branch name; refusing to push it.`
        : `branch \`${safeEcho(branchName)}\` is not a usable branch name; refusing to push it.`,
    );
  }

  const manifestInput = String(manifestPath ?? '');
  if (!manifestInput) return deny('no manifest path was given to verify.');

  const git = directGit(workdir);
  if (!git.policy.ok) return deny(git.policy.reason);
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) return deny('the workspace is not a git repository.');

  let manifestRel;
  try {
    const root = fs.realpathSync(top.stdout.trim());
    if (root !== fs.realpathSync(workdir)) {
      return deny('the workspace directory is not the root of the repository.');
    }
    manifestRel = path.relative(root, path.resolve(root, manifestInput));
  } catch {
    return deny('the manifest path could not be resolved inside the workspace.');
  }
  if (!manifestRel || manifestRel.startsWith('..') || path.isAbsolute(manifestRel)) {
    return deny('the manifest path is outside the repository.');
  }

  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
  const tipSha = tip.stdout.trim();
  if (!tip.ok || !SHA_SHAPE.test(tipSha)) {
    return deny(`branch \`${branchName}\` does not exist locally.`);
  }

  const head = git(['symbolic-ref', '--quiet', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== `refs/heads/${branchName}`) {
    return deny(`the workspace is not checked out on \`${branchName}\`.`);
  }

  return { ok: true, workdir, branchName, manifestRel, tipSha, git };
}

const CONFLICT_MARKER = '^(<<<<<<<|>>>>>>>) ';

function verifyMerge({
  cwd = null,
  branch = null,
  remoteSha = null,
  mergedSha = null,
  manifestPath = null,
  deniedPaths = null,
  planDir = null,
} = {}) {
  const opened = openTree({ cwd, branch, branchGrammar: 'human-named', manifestPath });
  if (!opened.ok) return opened;
  const { workdir, branchName, manifestRel, tipSha, git } = opened;

  const base = String(remoteSha ?? '').trim();
  const incoming = String(mergedSha ?? '').trim();
  if (!SHA_SHAPE.test(base)) return deny(`the remote tip \`${safeEcho(base)}\` is not a full commit sha.`);
  if (!SHA_SHAPE.test(incoming)) return deny(`the merged base \`${safeEcho(incoming)}\` is not a full commit sha.`);
  if (tipSha !== base) {
    return deny(
      `branch \`${branchName}\` is at ${tipSha.slice(0, 12)} where the checkout left ${base.slice(0, 12)}; a merge ` +
        'this flow resolves is committed by a trusted step, so the run must leave the branch where it found it.',
    );
  }

  const at = git(['rev-parse', '--git-path', 'MERGE_HEAD']);
  let recorded = [];
  try {
    recorded = fs
      .readFileSync(path.resolve(workdir, at.stdout.trim()), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return deny('the workspace holds no merge to resolve, so there is nothing for this flow to commit.');
  }
  if (!at.ok || recorded.length !== 1) {
    return deny(
      `the workspace is merging ${counted(recorded.length, 'commit')}, and this flow commits a merge of exactly ` +
        'one: the branch it checked out and the base branch a trusted step merged into it.',
    );
  }

  const held = git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  const merging = held.stdout.trim();
  if (!held.ok || !SHA_SHAPE.test(merging) || merging !== recorded[0]) {
    return deny('the workspace holds no merge to resolve, so there is nothing for this flow to commit.');
  }
  if (merging !== incoming) {
    return deny(
      `the workspace is merging ${merging.slice(0, 12)} where this run started ${incoming.slice(0, 12)}; the ` +
        'second parent is the commit a trusted step recorded and nothing else.',
    );
  }

  const expanded = deniedFor({ workdir, baseSha: base, deniedPaths, planDir, onlyPath: null });
  const unknown = deniedRefusal(expanded, base);
  if (unknown) return deny(unknown);

  const staged = stageMerge(git, [manifestRel]);
  if (!staged.ok) return deny(`${staged.reason}.`);

  const behind = git(['diff', ...WORKTREE_DIFF_FLAGS, '--', `:(exclude,top,literal)${manifestRel}`]);
  if (!behind.ok) return deny('the state of the resolved tree could not be read, so nothing was pushed.');
  const [unstaged] = splitZ(behind.stdout);
  if (unstaged) {
    return deny(`\`${safeEcho(unstaged)}\` is not staged, so the resolution could not be captured in full.`);
  }

  const unmerged = git(['ls-files', '-u', '-z']);
  if (!unmerged.ok) return deny('git could not read which paths are still unmerged.');
  const [stillOpen] = splitZ(unmerged.stdout);
  if (stillOpen) {
    const named = stillOpen.split('\t').at(-1) ?? stillOpen;
    return deny(`\`${safeEcho(named)}\` is still unmerged, so the resolution is not finished.`);
  }

  const carried = git(['ls-files', '--cached', '-z', '--', `:(top,literal)${manifestRel}`]);
  if (!carried.ok) return deny('git could not check whether the manifest is staged.');
  if (splitZ(carried.stdout).length) {
    return deny(`the manifest file \`${safeEcho(manifestRel)}\` is staged for the commit; refusing to push.`);
  }

  const written = git(['write-tree']);
  const resolvedTree = written.stdout.trim();
  if (!written.ok || !SHA_SHAPE.test(resolvedTree)) {
    return deny('the resolved tree could not be written, so nothing was pushed.');
  }

  const plain = git(['merge-tree', '--write-tree', '--name-only', '-z', base, incoming]);
  const replayed = String(plain.stdout).split('\0');
  const mergedTree = String(replayed[0] ?? '').trim();
  if (!SHA_SHAPE.test(mergedTree) || (plain.status !== 0 && plain.status !== 1)) {
    return deny(
      'git could not replay the merge on its own, so what this run decided cannot be told apart from what it ' +
        'carried; nothing was pushed.',
    );
  }
  const conflicted = [];
  for (const entry of replayed.slice(1)) {
    if (entry === '') break;
    conflicted.push(entry);
  }

  const decided = git(['diff', ...COMMIT_DIFF_FLAGS, mergedTree, resolvedTree]);
  if (!decided.ok) return deny('git could not list what this run decided in the merge.');
  const files = splitZ(decided.stdout);
  for (const file of files) {
    const hit = deniedMatch(file, expanded.denied);
    if (hit) return deny(`the resolution changes \`${safeEcho(file)}\`, which this flow may not touch.`);
  }

  const swept = new Set([...conflicted, ...files]);
  if (swept.size) {
    const left = git(['grep', '--cached', '-a', '-l', '-z', '-E', '-e', CONFLICT_MARKER]);
    if (!left.ok && left.status !== 1) {
      return deny('git could not check the merge for leftover conflict markers, so nothing was pushed.');
    }
    const marked = splitZ(left.stdout).find((file) => swept.has(file));
    if (marked) {
      return deny(`\`${safeEcho(marked)}\` still carries a conflict marker, so the resolution is not finished.`);
    }
  }

  return { ok: true, tree: resolvedTree, mergedTree, decided: files, mergedSha: incoming, baseSha: base };
}

function verifyChunk({
  cwd = null,
  branch = null,
  baseRef = null,
  remoteSha = null,
  manifestPath = null,
  deniedPaths = null,
  planDir = null,
  onlyPath = null,
  branchGrammar = DEFAULT_BRANCH_GRAMMAR,
  maxCommits = 1,
} = {}) {
  const opened = openTree({ cwd, branch, branchGrammar, manifestPath });
  if (!opened.ok) return opened;
  const { workdir, branchName, manifestRel, tipSha, git } = opened;

  const wantedRemoteSha = String(remoteSha ?? '').trim();
  const wantedBaseRef = String(baseRef ?? '').trim();
  if (!wantedRemoteSha && !wantedBaseRef) {
    return deny('neither a base ref nor a remote sha was given, so there is nothing to measure the commit against.');
  }

  let baseSha;
  let baseLabel;
  if (wantedRemoteSha) {
    if (!SHA_SHAPE.test(wantedRemoteSha)) {
      return deny(`the remote tip \`${safeEcho(wantedRemoteSha)}\` is not a full commit sha.`);
    }
    const object = git(['rev-parse', '--verify', '--quiet', `${wantedRemoteSha}^{commit}`]);
    if (!object.ok || object.stdout.trim() !== wantedRemoteSha) {
      return deny(`the remote tip \`${safeEcho(wantedRemoteSha)}\` is not in this clone, so the push cannot be checked.`);
    }
    baseSha = wantedRemoteSha;
    baseLabel = wantedRemoteSha.slice(0, 12);
  } else {
    if (!REF_SHAPE.test(wantedBaseRef) || wantedBaseRef.includes('..')) {
      return deny(`the base ref \`${safeEcho(wantedBaseRef)}\` is not a usable ref name.`);
    }
    const resolved = git(['rev-parse', '--verify', '--quiet', `${wantedBaseRef}^{commit}`]);
    baseSha = resolved.stdout.trim();
    if (!resolved.ok || !SHA_SHAPE.test(baseSha)) {
      return deny(`the base ref \`${safeEcho(wantedBaseRef)}\` does not resolve to a commit.`);
    }
    baseLabel = safeEcho(wantedBaseRef);
  }

  const ancestor = git(['merge-base', '--is-ancestor', baseSha, tipSha]);
  if (!ancestor.ok) {
    if (ancestor.status !== 1) return deny(`git could not compare \`${branchName}\` with \`${baseLabel}\`.`);
    return wantedRemoteSha
      ? deny(`branch \`${branchName}\` does not contain \`${baseLabel}\`, so pushing it would discard commits already on the remote.`)
      : deny(`branch \`${branchName}\` has diverged from \`${baseLabel}\`.`);
  }

  const range = aheadOf({ from: baseSha, to: tipSha, git });
  if (!range.ok) return deny(`git could not count the commits on \`${branchName}\`.`);
  const ahead = range.count;
  const allowed = Number.isSafeInteger(maxCommits) && maxCommits >= 1 ? maxCommits : 0;
  if (allowed === 0) return deny(`\`${safeEcho(String(maxCommits))}\` is not a number of commits this flow can allow.`);
  if (ahead === 0) return deny(`branch \`${branchName}\` has no new commit ahead of \`${baseLabel}\`.`);
  if (ahead > allowed) {
    return deny(
      allowed === 1
        ? `branch \`${branchName}\` has ${ahead} new commits ahead of \`${baseLabel}\`; a step must be exactly one commit.`
        : `branch \`${branchName}\` has ${ahead} new commits ahead of \`${baseLabel}\`, over the ${allowed} this phase may push.`,
    );
  }

  const history = git([
    'log',
    '--max-count=1',
    '--format=%H',
    '--all',
    '--not',
    baseSha,
    '--',
    `:(top,literal)${manifestRel}`,
  ]);
  if (!history.ok) return deny('git could not check whether the manifest entered history.');
  if (history.stdout.trim()) {
    return deny(`the manifest file \`${safeEcho(manifestRel)}\` entered git history; refusing to push.`);
  }

  const expanded = deniedFor({ workdir, baseSha, deniedPaths, planDir, onlyPath });
  const unknown = deniedRefusal(expanded, baseSha);
  if (unknown) return deny(unknown);

  const sole = String(onlyPath ?? '').trim();
  if (onlyPath !== null && sole === '') return deny('the one path this commit may change was given as empty.');

  const walked = git(['rev-list', '--reverse', `${baseSha}..${tipSha}`]);
  if (!walked.ok) return deny(`git could not list the commits on \`${branchName}\`.`);
  const commits = walked.stdout.split('\n').map((line) => line.trim()).filter((line) => SHA_SHAPE.test(line));
  if (commits.length !== ahead) return deny(`git listed ${commits.length} commits on \`${branchName}\` where it counted ${ahead}.`);

  let from = baseSha;
  for (const commit of commits) {
    const changed = git(['diff', ...COMMIT_DIFF_FLAGS, from, commit]);
    if (!changed.ok) return deny(`git could not list the files changed on \`${branchName}\`.`);
    for (const file of splitZ(changed.stdout)) {
      if (sole !== '' && file !== sole) {
        return deny(`the commit changes \`${safeEcho(file)}\`, and this phase may change only \`${safeEcho(sole)}\`.`);
      }
      const hit = deniedMatch(file, expanded.denied);
      if (hit) return deny(`the commit changes \`${safeEcho(file)}\`, which this flow may not touch.`);
    }
    from = commit;
  }

  const dirty = git(['diff', ...WORKTREE_DIFF_FLAGS, tipSha]);
  if (!dirty.ok) return deny('git could not read the state of the workspace.');
  const modified = splitZ(dirty.stdout);
  if (modified.length) {
    return deny(`the workspace still has uncommitted changes to \`${safeEcho(modified[0])}\`.`);
  }

  const others = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (!others.ok) return deny('git could not list the untracked files in the workspace.');
  for (const file of splitZ(others.stdout)) {
    if (file === manifestRel) continue;
    return deny(`the workspace still has an uncommitted new file \`${safeEcho(file)}\`.`);
  }

  return { ok: true, sha: tipSha };
}

module.exports = {
  BRANCH_SHAPE,
  JIRA_BRANCH_SHAPE,
  FLOW_BRANCH_SHAPE,
  EXISTING_BRANCH_SHAPE,
  BRANCH_GRAMMARS,
  DEFAULT_BRANCH_GRAMMAR,
  grammarFor,
  MAX_DIRECT_COMMITS,
  matchesBranchGrammar,
  COMMIT_TYPES,
  GIT_CONFIG_OVERRIDES,
  gitArgs,
  gitEnv,
  gitVia,
  aheadOf,
  noChangeLeftBehind,
  DENIED_PATH_FLOOR,
  DENIED_PREFIX_FLOOR,
  ANY_DEPTH_FLOOR,
  anyDepthEntry,
  anyDepthFile,
  safeEcho,
  normalizeDeniedPaths,
  deniedFor,
  soleWritable,
  deniedMatch,
  openTree,
  CONFLICT_MARKER,
  verifyMerge,
  verifyChunk,
};
