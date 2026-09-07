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

function stageCandidates(git, excludedPaths) {
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
    'HEAD',
  ]);
  if (!tracked?.ok || !untracked?.ok || !deleted?.ok) {
    return deny('the working tree could not be listed safely, so nothing was staged');
  }
  const omitted = new Set(excludedPaths.map((entry) => String(entry ?? '')).filter(Boolean));
  const keptTracked = [...new Set([...splitZ(tracked.stdout), ...splitZ(deleted.stdout)])].filter(
    (entry) => !omitted.has(entry),
  );
  const paths = [...new Set([...keptTracked, ...splitZ(untracked.stdout)])].filter((entry) => !omitted.has(entry));
  const checked = checkStagePaths(git, paths);
  return checked.ok ? { ok: true, omitted, paths, tracked: keptTracked } : checked;
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

function stagePaths(git, paths) {
  const checked = checkStagePaths(git, paths);
  if (!checked.ok) return checked;
  const reset = runPathBatches(git, ['reset', '--quiet', 'HEAD'], paths);
  if (!reset) return deny('git could not rebuild the requested index entries safely');
  if (!rebuildTrackedPathBatches(git, paths)) return deny('git could not normalize the requested index entries safely');
  const staged = runPathBatches(git, ['add'], paths);
  return staged ? { ok: true, reason: '' } : deny('git could not stage the requested paths safely');
}

function stageAll(git, excludedPaths = []) {
  const candidates = stageCandidates(git, excludedPaths);
  if (!candidates.ok) return candidates;
  const reset = git(['reset', '--mixed', '--no-refresh', '--quiet', 'HEAD']);
  if (!reset?.ok) return deny('git could not rebuild the index safely, so nothing was pushed');
  if (!rebuildTrackedPathBatches(git, candidates.paths)) {
    return deny('git could not normalize the rebuilt index safely, so nothing was pushed');
  }
  const staged = runPathBatches(git, ['add', '--all'], candidates.paths);
  return staged ? { ok: true, reason: '' } : deny('git could not stage the working tree safely');
}

function stageMerge(git, excludedPaths = []) {
  const candidates = stageCandidates(git, excludedPaths);
  if (!candidates.ok) return candidates;
  const reset = runPathBatches(git, ['reset', '--quiet', '--no-refresh', 'HEAD'], candidates.tracked);
  if (!reset) return deny('git could not rebuild the merge index safely, so nothing was pushed');
  if (!rebuildTrackedPathBatches(git, candidates.paths)) {
    return deny('git could not normalize the rebuilt merge index safely, so nothing was pushed');
  }
  const staged = runPathBatches(git, ['add', '--all'], candidates.paths);
  return staged ? { ok: true, reason: '' } : deny('git could not stage the merged tree safely');
}

function stageAllowed(git, exclusionPathspecs = []) {
  if (!git?.policy?.ok) return deny(git?.policy?.reason || 'git filter configuration could not be read safely');
  const pathspec = [':(top)', ...exclusionPathspecs];
  const cached = git([
    'ls-files',
    '--cached',
    '-z',
    '--',
    ...pathspec,
  ]);
  const others = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...pathspec,
  ]);
  const deleted = git([
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=D',
    '-z',
    'HEAD',
    '--',
    ...pathspec,
  ]);
  if (!cached?.ok || !others?.ok || !deleted?.ok) {
    return deny('the recoverable working tree could not be listed safely');
  }
  const tracked = [...new Set([...splitZ(cached.stdout), ...splitZ(deleted.stdout)])];
  const paths = [...new Set([...tracked, ...splitZ(others.stdout)])];
  const checked = checkStagePaths(git, paths);
  if (!checked.ok) return checked;
  const reset = runPathBatches(git, ['reset', '--quiet', '--no-refresh', 'HEAD'], paths);
  if (!reset) return deny('git could not rebuild the recoverable index safely');
  if (!rebuildTrackedPathBatches(git, paths)) return deny('git could not normalize the recoverable index safely');
  const staged = runPathBatches(git, ['add', '--all'], paths);
  return staged ? { ok: true, reason: '' } : deny('git could not stage the recoverable tree safely');
}

module.exports = { checkStagePaths, stageAll, stageAllowed, stageMerge, stagePaths };
