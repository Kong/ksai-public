'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { claimsAnyGlob, toGlobs } = require('../lib/path-pattern.cjs');
const { directGit } = require('./trusted-git.cjs');

const POLICY_PATH = '.ksai/autofix-paths.json';
const VERSION = 1;
const MAX_RULES = 100;
const MAX_GLOBS = 200;
const MAX_PATHS = 2000;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_PATTERN_CHARS = 4096;
const SHA_SHAPE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

const PROTECTED_PATHS = Object.freeze([
  '.circleci/**',
  '.travis.yml',
  '.cirrus.yml',
  '.drone.yml',
  '.drone.yaml',
  '.gitlab/**',
  '.gitlab-ci.yml',
  '.github/scripts/**',
  '.buildkite/**',
  '.husky/**',
  '.githooks/**',
  '**/.githooks/**',
  '.git-hooks/**',
  '**/.git-hooks/**',
  'githooks/**',
  '**/githooks/**',
  'git-hooks/**',
  '**/git-hooks/**',
  '**/hooks/**',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
  '.pre-commit-hooks.yaml',
  '.pre-commit-hooks.yml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  'azure-pipelines.yml',
  'appveyor.yml',
  'appveyor.yaml',
  'bitbucket-pipelines.yml',
  'buildspec.yml',
  'buildspec.yaml',
  'Jenkinsfile',
  '**/Jenkinsfile',
  'Makefile',
  '**/Makefile',
  'Justfile',
  '**/Justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
  '**/Taskfile.yml',
  '**/Taskfile.yaml',
  'CMakeLists.txt',
  '**/CMakeLists.txt',
  'configure',
  '**/configure',
  'configure.ac',
  '**/configure.ac',
  'meson.build',
  '**/meson.build',
  'WORKSPACE',
  'WORKSPACE.bazel',
  'MODULE.bazel',
  '.bazelrc',
  '**/.bazelrc',
  '**/BUILD',
  '**/BUILD.bazel',
  'Dockerfile',
  '**/Dockerfile',
  'Dockerfile.*',
  '**/Dockerfile.*',
  'compose*.yml',
  'compose*.yaml',
  '**/compose*.yml',
  '**/compose*.yaml',
  'package.json',
  '**/package.json',
  'package-lock.json',
  '**/package-lock.json',
  'npm-shrinkwrap.json',
  '**/npm-shrinkwrap.json',
  'yarn.lock',
  '**/yarn.lock',
  'pnpm-lock.yaml',
  '**/pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  '**/bun.lock',
  '**/bun.lockb',
  'go.mod',
  'go.sum',
  'go.work',
  'go.work.sum',
  '**/go.mod',
  '**/go.sum',
  '**/go.work',
  '**/go.work.sum',
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/build.rs',
  '.cargo/config',
  '.cargo/config.toml',
  '**/.cargo/config',
  '**/.cargo/config.toml',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'requirements*.txt',
  'requirements*.in',
  '**/pyproject.toml',
  '**/poetry.lock',
  '**/uv.lock',
  '**/requirements*.txt',
  '**/requirements*.in',
  'constraints*.txt',
  '**/constraints*.txt',
  'environment.yml',
  'environment.yaml',
  '**/environment.yml',
  '**/environment.yaml',
  'Pipfile',
  'Pipfile.lock',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/setup.py',
  '**/setup.cfg',
  '**/tox.ini',
  '**/noxfile.py',
  'Gemfile',
  'Gemfile.lock',
  'Rakefile',
  '**/Gemfile',
  '**/Gemfile.lock',
  '**/Rakefile',
  'composer.json',
  'composer.lock',
  '**/composer.json',
  '**/composer.lock',
  'mix.exs',
  'mix.lock',
  '**/mix.exs',
  '**/mix.lock',
  'pom.xml',
  '**/pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '**/build.gradle',
  '**/build.gradle.kts',
  'gradle.lockfile',
  '**/gradle.lockfile',
  'settings.gradle',
  'settings.gradle.kts',
  '**/settings.gradle',
  '**/settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  '**/gradlew',
  '**/gradlew.bat',
  'gradle/wrapper/**',
  '**/gradle/wrapper/**',
  'mvnw',
  'mvnw.cmd',
  '**/mvnw',
  '**/mvnw.cmd',
  '.mvn/**',
  '**/.mvn/**',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  '**/deno.json',
  '**/deno.jsonc',
  '**/deno.lock',
  'Package.swift',
  'Package.resolved',
  '**/Package.swift',
  '**/Package.resolved',
  'pubspec.yaml',
  'pubspec.lock',
  '**/pubspec.yaml',
  '**/pubspec.lock',
  '*.csproj',
  '*.fsproj',
  '*.vbproj',
  '*.sln',
  '*.slnx',
  '**/*.csproj',
  '**/*.fsproj',
  '**/*.vbproj',
  '**/*.sln',
  '**/*.slnx',
  'Directory.Build.props',
  'Directory.Build.targets',
  'Directory.Packages.props',
  '**/Directory.Build.props',
  '**/Directory.Build.targets',
  '**/Directory.Packages.props',
  'packages.lock.json',
  'packages.config',
  '**/packages.lock.json',
  '**/packages.config',
  'global.json',
  '**/global.json',
  'NuGet.config',
  'nuget.config',
  '**/NuGet.config',
  '**/nuget.config',
  'flake.nix',
  'flake.lock',
  '**/flake.nix',
  '**/flake.lock',
  'mise.toml',
  '.mise.toml',
  '.tool-versions',
  '**/mise.toml',
  '**/.mise.toml',
  '**/.tool-versions',
  '.terraform.lock.hcl',
  '**/.terraform.lock.hcl',
  'Chart.yaml',
  'Chart.lock',
  '**/Chart.yaml',
  '**/Chart.lock',
  '.gitattributes',
  '**/.gitattributes',
  'buf.gen.yaml',
  'buf.gen.yml',
  '**/buf.gen.yaml',
  '**/buf.gen.yml',
  'buf.yaml',
  'buf.work.yaml',
  '**/buf.yaml',
  '**/buf.work.yaml',
  'sqlc.yaml',
  'sqlc.yml',
  '**/sqlc.yaml',
  '**/sqlc.yml',
  'codegen.yml',
  'codegen.yaml',
  '**/codegen.yml',
  '**/codegen.yaml',
  '.openapi-generator-ignore',
  '**/.openapi-generator-ignore',
]);

const protectedGlobs = toGlobs(PROTECTED_PATHS).globs;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => `${JSON.stringify(value)}\n`;
const fail = (reason) => ({ ok: false, reason });

function strictClaimsAnyGlob(globs, paths) {
  if (!globs || !Array.isArray(globs.include) || globs.include.length === 0) return false;
  for (const file of Array.isArray(paths) ? paths : []) {
    if (typeof file !== 'string' || file === '') continue;
    if (!globs.include.some((glob) => path.matchesGlob(file, glob))) continue;
    if (globs.exclude.some((glob) => path.matchesGlob(file, glob))) continue;
    return true;
  }
  return false;
}

function safePath(value) {
  const file = String(value ?? '');
  if (
    file === '' ||
    file.length > MAX_PATTERN_CHARS ||
    file.startsWith('/') ||
    file.startsWith('-') ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return '';
  }
  return file;
}

function uniquePaths(values) {
  const paths = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const file = safePath(value);
    if (!file) return fail(`\`${String(value ?? '').slice(0, 80)}\` is not a repository-relative path`);
    if (seen.has(file)) continue;
    seen.add(file);
    paths.push(file);
    if (paths.length > MAX_PATHS) return fail(`the change scope names more than ${MAX_PATHS} paths`);
  }
  paths.sort();
  return { ok: true, paths };
}

function globsFrom(value, field) {
  const parsed = toGlobs(value);
  if (parsed.error) return fail(`${field} ${parsed.error}`);
  const count = parsed.globs.include.length + parsed.globs.exclude.length;
  if (count > MAX_GLOBS) return fail(`${field} names more than ${MAX_GLOBS} globs`);
  if ([...parsed.globs.include, ...parsed.globs.exclude].some((glob) => glob.length > MAX_PATTERN_CHARS)) {
    return fail(`${field} contains a glob longer than ${MAX_PATTERN_CHARS} characters`);
  }
  return { ok: true, globs: parsed.globs };
}

function parsePolicy(body) {
  if (body === '') return { ok: true, policy: { version: VERSION, protected: { include: [], exclude: [] }, relations: [] } };
  if (Buffer.byteLength(body, 'utf8') > MAX_POLICY_BYTES) return fail(`${POLICY_PATH} is larger than ${MAX_POLICY_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail(`${POLICY_PATH} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(`${POLICY_PATH} must be an object`);
  const keys = Object.keys(parsed).sort();
  if (keys.some((key) => !['protected', 'relations', 'version'].includes(key))) return fail(`${POLICY_PATH} has an unknown field`);
  if (parsed.version !== VERSION) return fail(`${POLICY_PATH} must have version ${VERSION}`);
  if (!Array.isArray(parsed.relations)) return fail(`${POLICY_PATH} must contain a relations list`);
  if (parsed.relations.length > MAX_RULES) return fail(`${POLICY_PATH} has more than ${MAX_RULES} relations`);

  let protectedPaths = { include: [], exclude: [] };
  if (Object.hasOwn(parsed, 'protected')) {
    const protectedRule = globsFrom(parsed.protected, 'protected');
    if (!protectedRule.ok) return protectedRule;
    protectedPaths = protectedRule.globs;
  }
  const relations = [];
  let totalGlobs = protectedPaths.include.length + protectedPaths.exclude.length;
  for (const [index, relation] of parsed.relations.entries()) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      return fail(`${POLICY_PATH} relation ${index + 1} must be an object`);
    }
    const relationKeys = Object.keys(relation).sort();
    if (relationKeys.some((key) => !['allow', 'allowProtected', 'from'].includes(key))) {
      return fail(`${POLICY_PATH} relation ${index + 1} has an unknown field`);
    }
    if (!Object.hasOwn(relation, 'from') || !Object.hasOwn(relation, 'allow')) {
      return fail(`${POLICY_PATH} relation ${index + 1} must name from and allow globs`);
    }
    const from = globsFrom(relation.from, `relation ${index + 1} from`);
    if (!from.ok) return from;
    const allow = globsFrom(relation.allow, `relation ${index + 1} allow`);
    if (!allow.ok) return allow;
    let allowProtected = { include: [], exclude: [] };
    if (Object.hasOwn(relation, 'allowProtected')) {
      const protectedRule = globsFrom(relation.allowProtected, `relation ${index + 1} allowProtected`);
      if (!protectedRule.ok) return protectedRule;
      allowProtected = protectedRule.globs;
    }
    totalGlobs +=
      from.globs.include.length +
      from.globs.exclude.length +
      allow.globs.include.length +
      allow.globs.exclude.length +
      allowProtected.include.length +
      allowProtected.exclude.length;
    if (totalGlobs > MAX_GLOBS) return fail(`${POLICY_PATH} names more than ${MAX_GLOBS} globs`);
    relations.push({ from: from.globs, allow: allow.globs, allowProtected });
  }
  return { ok: true, policy: { version: VERSION, protected: protectedPaths, relations } };
}

function treeFile(git, ref, file) {
  const listed = git(['ls-tree', '-z', ref, '--', `:(top,literal)${file}`]);
  if (!listed.ok) return fail(`git could not inspect \`${file}\``);
  const rows = String(listed.stdout ?? '').split('\0').filter(Boolean);
  if (rows.length === 0) return { ok: true, mode: '' };
  if (rows.length !== 1) return fail(`git returned an ambiguous entry for \`${file}\``);
  const tab = rows[0].indexOf('\t');
  const fields = tab === -1 ? [] : rows[0].slice(0, tab).split(' ');
  return fields.length === 3 ? { ok: true, mode: fields[0] } : fail(`git returned an invalid entry for \`${file}\``);
}

function isProtectedChange({ file, git, baseSha, treeish }) {
  if (claimsAnyGlob(protectedGlobs, [file])) return { ok: true, protected: true, reason: 'protected path' };
  const before = treeFile(git, baseSha, file);
  if (!before.ok) return before;
  const after = treeFile(git, treeish, file);
  if (!after.ok) return after;
  if (['120000', '160000'].includes(before.mode) || ['120000', '160000'].includes(after.mode)) {
    return { ok: true, protected: true, reason: 'link or submodule' };
  }
  if (after.mode === '100755' && before.mode !== '100755') {
    return { ok: true, protected: true, reason: 'new executable' };
  }
  return { ok: true, protected: false, reason: '' };
}

function allowedBy(scope, file, { protectedPath = false } = {}) {
  const allowed = scope?.allowed;
  const regular = Array.isArray(allowed?.exact) && allowed.exact.includes(file);
  const expanded = strictClaimsAnyGlob(allowed?.patterns, [file]);
  const explicitlyProtected = strictClaimsAnyGlob(allowed?.protectedPatterns, [file]);
  return protectedPath ? explicitlyProtected : regular || expanded || explicitlyProtected;
}

function validateScope(scope, expected = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return fail('the trusted change scope is missing');
  const unsigned = { ...scope };
  delete unsigned.digest;
  if (scope.version !== VERSION || scope.digest !== digest(canonical(unsigned))) {
    return fail('the trusted change scope is invalid');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== null && value !== undefined && String(scope[key] ?? '') !== String(value)) {
      return fail(`the trusted change scope does not match this ${key}`);
    }
  }
  if (!['fix', 'do'].includes(scope.phase) || !SHA_SHAPE.test(scope.head) || !SHA_SHAPE.test(scope.base)) {
    return fail('the trusted change scope has invalid bindings');
  }
  if (!SHA_SHAPE.test(scope.originalTree)) return fail('the trusted change scope has no original tree');
  const exact = uniquePaths(scope.allowed?.exact);
  if (!exact.ok) return exact;
  for (const [label, value] of [
    ['patterns', scope.allowed?.patterns],
    ['protectedPatterns', scope.allowed?.protectedPatterns],
    ['protected', scope.protected],
  ]) {
    if (!value || !Array.isArray(value.include) || !Array.isArray(value.exclude)) {
      return fail(`the trusted change scope has invalid ${label}`);
    }
    const entries = [...value.include, ...value.exclude.map((glob) => `!${glob}`)];
    if (entries.length > 0) {
      const reread = globsFrom(entries, label);
      if (!reread.ok) return reread;
    }
  }
  return { ok: true, scope };
}

function readScope(file, expected = {}) {
  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(String(file ?? ''), 'utf8'));
  } catch {
    return fail('the trusted change scope could not be read');
  }
  return validateScope(scope, expected);
}

function diffPaths(git, base, head) {
  const diff = git(['diff', '--no-ext-diff', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', `${base}...${head}`]);
  if (!diff.ok) return fail('git could not list the pull request paths');
  const listed = String(diff.stdout ?? '')
    .split('\0')
    .filter((file) => safePath(file) !== '');
  return uniquePaths(listed);
}

function resolveCommit(git, ref, noun) {
  const out = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = String(out.stdout ?? '').trim();
  return out.ok && SHA_SHAPE.test(sha) ? { ok: true, sha } : fail(`${noun} does not resolve to a commit`);
}

function readBasePolicy(git, baseSha) {
  const entry = treeFile(git, baseSha, POLICY_PATH);
  if (!entry.ok) return entry;
  if (entry.mode === '') {
    return { ok: true, body: '', policy: { version: VERSION, protected: { include: [], exclude: [] }, relations: [] } };
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') return fail(`${POLICY_PATH} is not a regular file`);
  const shown = git(['show', `${baseSha}:${POLICY_PATH}`]);
  if (!shown.ok) return fail(`${POLICY_PATH} could not be read from the base tree`);
  const parsed = parsePolicy(String(shown.stdout ?? ''));
  return parsed.ok ? { ...parsed, body: String(shown.stdout ?? '') } : parsed;
}

function checkIdentity(checks) {
  return {
    failing: Array.isArray(checks?.failing)
      ? checks.failing.map((entry) => ({
          name: String(entry?.name ?? '').slice(0, 200),
          app: String(entry?.app ?? '').slice(0, 100),
          conclusion: String(entry?.conclusion ?? '').slice(0, 30),
        }))
      : [],
    statuses: Array.isArray(checks?.statuses)
      ? checks.statuses.map((entry) => ({
          context: String(entry?.context ?? '').slice(0, 200),
          state: String(entry?.state ?? '').slice(0, 30),
        }))
      : [],
  };
}

function createScope({ cwd, phase, headSha, baseRef, repo, pr, threads = null, checks = null, merging = false, outFile }) {
  if (!['fix', 'do'].includes(String(phase ?? ''))) return fail('only fix and do runs have an autofix change scope');
  const git = directGit(String(cwd ?? ''));
  if (!git.policy.ok) return fail(git.policy.reason);
  const head = resolveCommit(git, String(headSha ?? ''), 'the pull request head');
  if (!head.ok) return head;
  if (head.sha !== String(headSha ?? '')) return fail('the pull request head must be a full commit sha');
  const headTree = git(['rev-parse', `${head.sha}^{tree}`]);
  const originalTree = String(headTree.stdout ?? '').trim();
  if (!headTree.ok || !SHA_SHAPE.test(originalTree)) return fail('the pull request head tree could not be read');
  const namedBase = String(baseRef ?? '');
  if (namedBase !== '' && (!REF_SHAPE.test(namedBase) || namedBase.includes('..'))) {
    return fail('the pull request base ref is not usable');
  }
  const base = namedBase === '' ? { ok: true, sha: head.sha } : resolveCommit(git, namedBase, 'the pull request base');
  if (!base.ok) return base;

  let seeds;
  let intent;
  let evidence;
  if (phase === 'fix') {
    const offered = Array.isArray(threads) ? threads : [];
    const picked = uniquePaths(offered.map((thread) => thread?.path));
    if (!picked.ok) return picked;
    if (picked.paths.length === 0) return fail('the review pass has no authorized thread paths');
    seeds = picked.paths;
    intent = 'review';
    evidence = {
      threads: offered.map((thread) => ({
        id: String(thread?.id ?? '').slice(0, 100),
        path: String(thread?.path ?? ''),
      })),
    };
  } else {
    const picked = namedBase === '' ? { ok: true, paths: [] } : diffPaths(git, base.sha, head.sha);
    if (!picked.ok) return picked;
    seeds = picked.paths;
    const hasCheckFailures =
      Number(checks?.failingTotal || 0) > 0 ||
      Number(checks?.statusesTotal || 0) > 0;
    intent = merging ? 'merge' : hasCheckFailures ? 'ci' : 'request';
    if (checks && String(checks.sha ?? '') !== head.sha) return fail('the CI evidence does not match the pull request head');
    evidence = checks ? { checks: checkIdentity(checks) } : {};
  }

  const loaded = namedBase === ''
    ? { ok: true, body: '', policy: { version: VERSION, protected: { include: [], exclude: [] }, relations: [] } }
    : readBasePolicy(git, base.sha);
  if (!loaded.ok) return loaded;
  const patterns = { include: [], exclude: [] };
  const protectedPatterns = { include: [], exclude: [] };
  for (const relation of loaded.policy.relations) {
    if (!strictClaimsAnyGlob(relation.from, seeds)) continue;
    patterns.include.push(...relation.allow.include);
    patterns.exclude.push(...relation.allow.exclude);
    protectedPatterns.include.push(...relation.allowProtected.include);
    protectedPatterns.exclude.push(...relation.allowProtected.exclude);
  }
  const allowed = {
    exact: seeds,
    patterns: { include: [...new Set(patterns.include)].sort(), exclude: [...new Set(patterns.exclude)].sort() },
    protectedPatterns: {
      include: [...new Set(protectedPatterns.include)].sort(),
      exclude: [...new Set(protectedPatterns.exclude)].sort(),
    },
  };
  if (
    allowed.patterns.include.length +
      allowed.patterns.exclude.length +
      allowed.protectedPatterns.include.length +
      allowed.protectedPatterns.exclude.length >
    MAX_GLOBS
  ) {
    return fail(`the active change scope names more than ${MAX_GLOBS} globs`);
  }
  const unsigned = {
    version: VERSION,
    intent,
    repo: String(repo ?? ''),
    pr: String(pr ?? ''),
    phase,
    head: head.sha,
    originalTree,
    base: base.sha,
    policy: { path: POLICY_PATH, sha256: digest(loaded.body) },
    protected: loaded.policy.protected,
    seeds,
    allowed,
    evidence,
  };
  const scope = { ...unsigned, digest: digest(canonical(unsigned)) };
  const checked = validateScope(scope, { repo: String(repo ?? ''), pr: String(pr ?? ''), phase, head: head.sha });
  if (!checked.ok) return checked;
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outFile, canonical(scope), { mode: 0o600 });
    fs.chmodSync(outFile, 0o600);
  } catch {
    return fail('the trusted change scope could not be written');
  }
  return { ok: true, scope, file: outFile };
}

function verifyScopedPath({ scope, file, git, baseSha, treeish }) {
  const protectedState = isProtectedChange({ file, git, baseSha, treeish });
  if (!protectedState.ok) return protectedState;
  const policyProtected = strictClaimsAnyGlob(scope?.protected, [file]);
  const protectedPath = protectedState.protected || policyProtected;
  const reason = policyProtected ? 'protected by the base policy' : protectedState.reason;
  if (!allowedBy(scope, file, { protectedPath })) {
    return fail(
      protectedPath
        ? `\`${file}\` is ${reason} and the base-owned autofix policy does not allow it`
        : `\`${file}\` is outside the trusted change scope`,
    );
  }
  return { ok: true };
}

function renderAllowed(scope) {
  const lines = [
    ...scope.allowed.exact.map((file) => `  ${JSON.stringify(file)} (exact)`),
    ...scope.allowed.patterns.include.map((glob) => `  ${JSON.stringify(glob)} (base policy)`),
    ...scope.allowed.protectedPatterns.include.map((glob) => `  ${JSON.stringify(glob)} (base policy; protected)`),
  ];
  return lines.length === 0 ? ['  (none)'] : lines;
}

/**
 * @param {string} scopePath
 * @param {{ digest?: unknown } | null | undefined} scope
 * @param {{ outcome?: string, tree?: string, reason?: string }} options
 */
function writeScopeResult(scopePath, scope, options = {}) {
  const { outcome, tree = '', reason = '' } = options;
  if (!['published', 'refused', 'unchanged', 'verified'].includes(outcome)) {
    return fail('the change-scope result has an invalid outcome');
  }
  const result = {
    version: VERSION,
    scopeDigest: String(scope?.digest ?? ''),
    outcome,
    tree: String(tree ?? ''),
    reason: String(reason ?? '').replace(/[\r\n]+/g, ' ').slice(0, 500),
  };
  const target = path.join(path.dirname(String(scopePath ?? '')), 'result.json');
  const temporary = `${target}.tmp`;
  try {
    fs.writeFileSync(temporary, canonical(result), { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch {
    return fail('the change-scope result could not be written');
  }
  return { ok: true, file: target };
}

module.exports = {
  POLICY_PATH,
  PROTECTED_PATHS,
  allowedBy,
  createScope,
  isProtectedChange,
  parsePolicy,
  readScope,
  renderAllowed,
  validateScope,
  verifyScopedPath,
  writeScopeResult,
};
