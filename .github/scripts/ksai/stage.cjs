const splitZ = (stdout) =>
  String(stdout ?? '')
    .split('\0')
    .filter(Boolean);

const deny = (reason) => ({ ok: false, reason });
const PATH_BATCH_SIZE = 256;

function safeEcho(value) {
  const scrubbed = String(value ?? '').replace(/[^A-Za-z0-9._/-]/g, '?');
  return scrubbed.length > 60 ? `${scrubbed.slice(0, 60)}…` : scrubbed;
}

const literal = (entry) => `:(top,literal)${entry}`;

function runPathBatches(git, args, paths) {
  for (let at = 0; at < paths.length; at += PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + PATH_BATCH_SIZE).map((entry) => literal(entry));
    if (!git([...args, '--', ...batch])?.ok) return false;
  }
  return true;
}

function rebuildTrackedPathBatches(git, paths) {
  for (let at = 0; at < paths.length; at += PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + PATH_BATCH_SIZE).map((entry) => literal(entry));
    const listed = git(['ls-files', '--stage', '-z', '--', ...batch]);
    if (!listed?.ok) return false;
    if (listed.stdout && !git(['update-index', '-z', '--index-info'], { input: listed.stdout })?.ok) return false;
  }
  return true;
}

function ignoredOf(git, paths) {
  const ignored = [];
  for (let at = 0; at < paths.length; at += PATH_BATCH_SIZE) {
    const batch = paths.slice(at, at + PATH_BATCH_SIZE).map((entry) => literal(entry));
    const listed = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...batch]);
    if (!listed?.ok) return null;
    const asked = new Set(paths.slice(at, at + PATH_BATCH_SIZE));
    ignored.push(...splitZ(listed.stdout).filter((entry) => asked.has(entry)));
  }
  return ignored;
}

function stageCandidates(git, base, excludedPaths) {
  if (!git?.policy?.ok) return deny(git?.policy?.reason || 'git filter configuration could not be read safely');
  const tracked = git(['ls-files', '-z']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const deleted = git([
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=D',
    '-z',
    base,
  ]);
  const atHead = git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD']);
  if (!tracked?.ok || !untracked?.ok || !deleted?.ok || !atHead?.ok) {
    return deny('the working tree could not be listed safely, so nothing was staged');
  }
  const indexed = new Set(splitZ(tracked.stdout));
  const restored = ignoredOf(git, splitZ(atHead.stdout).filter((entry) => !indexed.has(entry)));
  if (!restored) return deny('the working tree could not be listed safely, so nothing was staged');
  const omitted = new Set(excludedPaths.map((entry) => String(entry ?? '')).filter(Boolean));
  const keptTracked = [...new Set([...indexed, ...splitZ(deleted.stdout), ...restored])].filter(
    (entry) => !omitted.has(entry),
  );
  const paths = [...new Set([...keptTracked, ...splitZ(untracked.stdout)])].filter((entry) => !omitted.has(entry));
  const checked = checkStagePaths(git, paths);
  return checked.ok ? { ok: true, paths, tracked: new Set(keptTracked) } : checked;
}

function unstageStrays(git, tracked) {
  const ignored = git(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']);
  if (!ignored?.ok) return false;
  return runPathBatches(git, ['rm', '--cached', '--quiet', '--ignore-unmatch'], splitZ(ignored.stdout).filter((entry) => !tracked.has(entry)));
}

function checkStagePaths(git, paths) {
  if (!git?.policy?.ok) return deny(git?.policy?.reason || 'git filter configuration could not be read safely');
  const unique = [...new Set(paths.map((entry) => String(entry ?? '')).filter(Boolean))];
  if (unique.length === 0) return { ok: true, reason: '' };
  for (let at = 0; at < unique.length; at += PATH_BATCH_SIZE) {
    const batch = unique.slice(at, at + PATH_BATCH_SIZE);
    const checked = git(['check-attr', '-z', '--stdin', 'filter'], { input: `${batch.join('\0')}\0` });
    if (!checked?.ok) return deny('git attributes could not be read safely, so nothing was staged');
    const fields = splitZ(checked.stdout);
    if (fields.length !== batch.length * 3) {
      return deny('git returned an unreadable filter attribute result, so nothing was staged');
    }
    for (let index = 0; index < fields.length; index += 3) {
      const [file, attribute, value] = fields.slice(index, index + 3);
      if (file !== batch[index / 3] || attribute !== 'filter') {
        return deny('git returned an unreadable filter attribute result, so nothing was staged');
      }
      if (value === 'unspecified' || value === 'unset') continue;
      if (value !== 'lfs') {
        return deny(
          `the path \`${safeEcho(file)}\` names the unsupported git filter \`${safeEcho(value)}\`; nothing was staged or pushed`,
        );
      }
    }
  }
  return { ok: true, reason: '' };
}

function stageAll(git, base, excludedPaths) {
  const candidates = stageCandidates(git, base, excludedPaths);
  if (!candidates.ok) return candidates;
  const reset = git(['read-tree', base]);
  if (!reset?.ok) return deny('git could not rebuild the index safely, so nothing was pushed');
  if (!rebuildTrackedPathBatches(git, candidates.paths)) {
    return deny('git could not normalize the rebuilt index safely, so nothing was pushed');
  }
  const staged = runPathBatches(git, ['add', '--all', '--force'], candidates.paths) && unstageStrays(git, candidates.tracked);
  return staged ? { ok: true, reason: '' } : deny('git could not stage the working tree safely');
}

function workTree(git, base, index, excludedPaths = []) {
  const indexed = Object.assign((args, options = {}) => git(args, { ...options, index }), { policy: git.policy });
  if (!indexed(['read-tree', base])?.ok) return deny('the checkout could not be read into an index of its own');
  const staged = stageAll(indexed, base, excludedPaths);
  if (!staged.ok) return staged;
  const written = indexed(['write-tree']);
  const tree = String(written?.stdout ?? '').trim();
  return written?.ok && /^[0-9a-f]{40}$/.test(tree) ? { ok: true, reason: '', tree } : deny('the working tree could not be written as a tree');
}

module.exports = { workTree, PATH_BATCH_SIZE };
