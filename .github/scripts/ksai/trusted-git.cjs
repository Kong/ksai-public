const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const GIT_CONFIG_OVERRIDES = Object.freeze([
  '-c',
  'core.commitGraph=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.sshCommand=false',
  '-c',
  'core.gitProxy=none',
  '-c',
  'diff.external=false',
  '-c',
  'submodule.recurse=false',
]);

const GIT_TIMEOUT_MS = 120000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_LFS_POINTER_BYTES = 1024;
const MAX_LFS_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_LFS_PROCESSING_BYTES = 2 * MAX_LFS_OBJECT_BYTES;
const LFS_BATCH_SIZE = 256;
const LFS_V1_VERSIONS = new Set([
  'http://git-media.io/v/2',
  'https://hawser.github.com/spec/v1',
  'https://git-lfs.github.com/spec/v1',
]);
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const TRUSTED_REF_NAMESPACES = Object.freeze(['heads', 'remotes', 'tags']);
const TRUSTED_EXCLUDES = Object.freeze(['.ksai-manifest.json', '.mcp.json', '_ksai/']);
const WORKTREE_STATE = Object.freeze([
  'HEAD',
  'index',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'MERGE_MODE',
  'MERGE_MSG',
  'ORIG_HEAD',
  'REVERT_HEAD',
  'SQUASH_MSG',
]);
const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9._+\-[\] ]{0,100}$/;
const IDENTITY_EMAIL = /^[A-Za-z0-9][A-Za-z0-9._+\-[\]]{0,100}@users\.noreply\.github\.com$/;
const REF_LINE = /^([0-9a-f]{40}) (refs\/.+)$/;
const PACKED_REFS_HEADER = /^# pack-refs with: (?:peeled|fully-peeled|sorted)(?: (?:peeled|fully-peeled|sorted))*$/;
const PEELED_LINE = /^\^[0-9a-f]{40}$/;
const REF_FORBIDDEN = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const trustedViews = new Set();
let lfsStorage = '';

process.once('exit', () => {
  for (const view of trustedViews) rmSync(view, { recursive: true, force: true });
  if (lfsStorage) rmSync(lfsStorage, { recursive: true, force: true });
});

const splitZ = (stdout) =>
  String(stdout ?? '')
    .split('\0')
    .filter(Boolean);

const refusePolicy = (reason) => ({
  ok: false,
  reason,
  overrides: [],
  commonDir: '',
  gitDir: '',
  viewGitDir: '',
  worktree: '',
  objects: '',
  alternateObjects: '',
});

function gitArgs(cwd, args, overrides = []) {
  return ['-C', cwd, ...GIT_CONFIG_OVERRIDES, ...overrides, ...args];
}

function trustedLfsStorage() {
  if (lfsStorage) return lfsStorage;
  const root = realpathSync(process.env.RUNNER_TEMP || tmpdir());
  lfsStorage = realpathSync(mkdtempSync(path.join(root, 'ksai-lfs-')));
  return lfsStorage;
}

function trustedIdentity() {
  const configuredName = String(process.env.KSAI_GIT_AUTHOR_NAME ?? '');
  const configuredEmail = String(process.env.KSAI_GIT_AUTHOR_EMAIL ?? '');
  if (!configuredName && !configuredEmail) {
    return { ok: true, name: 'ksai[bot]', email: 'ksai[bot]@users.noreply.github.com' };
  }
  return IDENTITY_NAME.test(configuredName) && IDENTITY_EMAIL.test(configuredEmail)
    ? { ok: true, name: configuredName, email: configuredEmail }
    : { ok: false, reason: 'the trusted commit identity is not usable, so no trusted git command ran' };
}

function trustedFileMode() {
  const configured = String(process.env.KSAI_GIT_FILEMODE ?? '');
  if (!configured) return { ok: true, value: 'false' };
  return configured === 'true' || configured === 'false'
    ? { ok: true, value: configured }
    : { ok: false, reason: 'the trusted checkout file mode is not usable, so no trusted git command ran' };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function plainDirectory(target, root) {
  try {
    const entry = lstatSync(target);
    const resolved = realpathSync(target);
    return entry.isDirectory() && !entry.isSymbolicLink() && within(root, resolved) ? resolved : '';
  } catch {
    return '';
  }
}

function plainFile(target, root, optional = false) {
  try {
    const entry = lstatSync(target);
    const resolved = realpathSync(target);
    return entry.isFile() && !entry.isSymbolicLink() && within(root, resolved) ? resolved : '';
  } catch (error) {
    return optional && error?.code === 'ENOENT' ? null : '';
  }
}

function plainTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return true;
}

function copyPlainTree(source, destination) {
  const pending = [{ source, destination }];
  try {
    while (pending.length) {
      const current = pending.pop();
      mkdirSync(current.destination, { mode: 0o700 });
      for (const entry of readdirSync(current.source, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
        const from = path.join(current.source, entry.name);
        const to = path.join(current.destination, entry.name);
        if (entry.isDirectory()) pending.push({ source: from, destination: to });
        else copyFileSync(from, to);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sealObjectStore(cwd) {
  let sealedRoot = '';
  try {
    const worktree = realpathSync(cwd);
    const gitDir = plainDirectory(path.join(worktree, '.git'), worktree);
    const objects = gitDir ? plainDirectory(path.join(gitDir, 'objects'), gitDir) : '';
    if (!objects || !plainTree(objects)) {
      return { ok: false, path: '', reason: 'the repository object store could not be sealed safely' };
    }
    for (const alternate of ['alternates', 'http-alternates']) {
      if (plainFile(path.join(objects, 'info', alternate), objects, true) !== null) {
        return { ok: false, path: '', reason: 'the repository uses an unselected object store' };
      }
    }
    const root = realpathSync(process.env.RUNNER_TEMP || tmpdir());
    sealedRoot = realpathSync(mkdtempSync(path.join(root, 'ksai-objects-')));
    const destination = path.join(sealedRoot, 'objects');
    if (!copyPlainTree(objects, destination) || !plainTree(destination)) throw new Error('copy failed');
    return { ok: true, path: realpathSync(destination), reason: '' };
  } catch {
    if (sealedRoot) rmSync(sealedRoot, { recursive: true, force: true });
    return { ok: false, path: '', reason: 'the repository object store could not be sealed safely' };
  }
}

function packNames(objects) {
  try {
    return new Set(readdirSync(path.join(objects, 'pack')));
  } catch (error) {
    return error?.code === 'ENOENT' ? new Set() : null;
  }
}

function sealedPacks(selected, objects) {
  const sealed = packNames(selected);
  const writable = packNames(objects);
  if (!sealed || !writable) return false;
  for (const name of writable) if (!sealed.has(name)) return false;
  return true;
}

function selectedObjectStores(objects) {
  const configured = String(process.env.KSAI_GIT_OBJECTS ?? '');
  if (!configured) return { ok: true, objects, alternateObjects: '' };
  try {
    const root = realpathSync(process.env.RUNNER_TEMP || tmpdir());
    const selected = plainDirectory(configured, root);
    if (!selected || selected === objects || !plainTree(selected)) return { ok: false, reason: '' };
    for (const alternate of ['alternates', 'http-alternates']) {
      if (plainFile(path.join(selected, 'info', alternate), selected, true) !== null)
        return { ok: false, reason: '' };
    }
    if (!sealedPacks(selected, objects))
      return { ok: false, reason: 'the repository packed objects after they were sealed' };
    return { ok: true, objects: selected, alternateObjects: objects };
  } catch {
    return { ok: false, reason: '' };
  }
}

function configValues(config) {
  const read = directRun('git', ['config', '--file', config, '--no-includes', '--list', '-z'], { env: gitEnv() });
  if (!read.ok && read.status !== 1) return null;
  const values = new Map();
  for (const record of String(read.stdout ?? '').split('\0')) {
    if (record === '') continue;
    const border = record.indexOf('\n');
    const key = border === -1 ? record : record.slice(0, border);
    const value = border === -1 ? '' : record.slice(border + 1);
    const held = values.get(key);
    if (held) held.push(value);
    else values.set(key, [value]);
  }
  return values;
}

function optionalConfigValue(values, key) {
  const held = values.get(key);
  if (!held) return { ok: true, value: '' };
  const lines = held
    .map((value) => `${value}\n`)
    .join('')
    .trimEnd()
    .split('\n');
  return lines.length === 1 ? { ok: true, value: lines[0] } : { ok: false };
}

function repositoryFormat(config) {
  const values = configValues(config);
  if (!values) return false;
  const version = optionalConfigValue(values, 'core.repositoryformatversion');
  const objectFormat = optionalConfigValue(values, 'extensions.objectformat');
  const refStorage = optionalConfigValue(values, 'extensions.refstorage');
  return version.ok && objectFormat.ok && refStorage.ok && (!version.value || version.value === '0') &&
    (!objectFormat.value || objectFormat.value === 'sha1') && (!refStorage.value || refStorage.value === 'files');
}

function validRef(ref) {
  if (
    typeof ref !== 'string' ||
    ref.length > 1024 ||
    [...ref].some((character) => {
      const point = character.codePointAt(0);
      return point <= 32 || point === 127 || REF_FORBIDDEN.has(character);
    }) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.')
  ) {
    return false;
  }
  return ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function allowedRef(ref) {
  return validRef(ref) && TRUSTED_REF_NAMESPACES.some((namespace) => ref.startsWith(`refs/${namespace}/`));
}

function plainRefs(root, namespace) {
  const pending = [{ dir: root, relative: '' }];
  while (pending.length) {
    const { dir, relative } = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push({ dir: child, relative: childRelative });
        continue;
      }
      const ref = `refs/${namespace}/${childRelative}`;
      if (!allowedRef(ref) || lstatSync(child).size > 256) return false;
      let value;
      try {
        value = readFileSync(child, 'utf8').replace(/\n$/, '');
      } catch {
        return false;
      }
      if (!/^[0-9a-f]{40}$/.test(value) && !(value.startsWith('ref: ') && allowedRef(value.slice(5)))) return false;
    }
  }
  return true;
}

function filteredPackedRefs(file) {
  if (file === null) return { ok: true, body: '' };
  try {
    if (lstatSync(file).size > MAX_PACKED_REFS_BYTES) return { ok: false };
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept = [];
    let header = '';
    let keepPeeled = false;
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('#')) {
        const normalized = line.replace(/[ \t]+$/, '');
        if (header || kept.length || !PACKED_REFS_HEADER.test(normalized)) return { ok: false };
        header = normalized;
        keepPeeled = false;
        continue;
      }
      if (line.startsWith('^')) {
        if (!PEELED_LINE.test(line)) return { ok: false };
        if (keepPeeled) kept.push(line);
        keepPeeled = false;
        continue;
      }
      const match = REF_LINE.exec(line);
      if (!match || !validRef(match[2])) return { ok: false };
      keepPeeled = allowedRef(match[2]);
      if (keepPeeled) kept.push(line);
    }
    return { ok: true, body: kept.length ? `${header ? `${header}\n` : ''}${kept.join('\n')}\n` : '' };
  } catch {
    return { ok: false };
  }
}

function selectedShallow(file) {
  if (file === null) return { ok: true, body: '' };
  try {
    if (lstatSync(file).size > MAX_PACKED_REFS_BYTES) return { ok: false };
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    return lines.length > 0 && lines.every((line) => /^[0-9a-f]{40}$/.test(line))
      ? { ok: true, body: `${[...new Set(lines)].join('\n')}\n` }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function stateFile(root, name, required = false) {
  const file = plainFile(path.join(root, name), root, !required);
  if (file === '' || (required && file === null)) return { ok: false, body: null };
  if (file === null) return { ok: true, body: null };
  try {
    if (lstatSync(file).size > GIT_MAX_BUFFER) return { ok: false, body: null };
    return { ok: true, body: readFileSync(file) };
  } catch {
    return { ok: false, body: null };
  }
}

function syncWorktreeState(from, to) {
  for (const name of WORKTREE_STATE) {
    const selected = stateFile(from, name, name === 'HEAD');
    if (!selected.ok) return false;
    const target = path.join(to, name);
    const existing = plainFile(target, to, true);
    if (existing === '') return false;
    try {
      if (selected.body === null) {
        if (existing !== null) unlinkSync(target);
      } else {
        writeFileSync(target, selected.body, { mode: 0o600 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

function syncShallowState(from, to) {
  const selected = selectedShallow(plainFile(path.join(from, 'shallow'), from, true));
  if (!selected.ok) return false;
  const target = path.join(to, 'shallow');
  const existing = plainFile(target, to, true);
  if (existing === '') return false;
  try {
    if (!selected.body) {
      if (existing !== null) unlinkSync(target);
    } else {
      writeFileSync(target, selected.body, { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

function syncRepositoryState(policy) {
  return syncWorktreeState(policy.viewGitDir, policy.gitDir) && syncShallowState(policy.commonDir, policy.gitDir);
}

function missingMetadataReason(worktree) {
  try {
    lstatSync(path.join(worktree, '.git'));
    return 'the repository metadata layout is not supported, so no trusted git command ran';
  } catch {}
  let current = path.dirname(worktree);
  while (current !== path.dirname(current)) {
    try {
      if (lstatSync(path.join(current, '.git')).isDirectory()) {
        return 'the workspace directory is not the root of the repository.';
      }
    } catch {}
    current = path.dirname(current);
  }
  return 'the workspace is not a git repository.';
}

function repositoryView(cwd) {
  const identity = trustedIdentity();
  if (!identity.ok) return refusePolicy(identity.reason);
  const fileMode = trustedFileMode();
  if (!fileMode.ok) return refusePolicy(fileMode.reason);
  try {
    const worktree = realpathSync(cwd);
    const gitDir = plainDirectory(path.join(worktree, '.git'), worktree);
    if (!gitDir) return refusePolicy(missingMetadataReason(worktree));
    const config = plainFile(path.join(gitDir, 'config'), gitDir);
    const head = plainFile(path.join(gitDir, 'HEAD'), gitDir);
    const index = plainFile(path.join(gitDir, 'index'), gitDir, true);
    const objects = plainDirectory(path.join(gitDir, 'objects'), gitDir);
    const refs = plainDirectory(path.join(gitDir, 'refs'), gitDir);
    if (!config || !head || index === '' || !objects || !refs || !repositoryFormat(config)) {
      return refusePolicy('the repository metadata layout is not supported, so no trusted git command ran');
    }
    for (const alternate of ['alternates', 'http-alternates']) {
      if (plainFile(path.join(objects, 'info', alternate), objects, true) !== null) {
        return refusePolicy('the repository uses an unselected object store, so no trusted git command ran');
      }
    }
    if (!plainTree(objects)) {
      return refusePolicy('the repository object store is not structurally safe, so no trusted git command ran');
    }
    const selectedObjects = selectedObjectStores(objects);
    if (!selectedObjects.ok) {
      return refusePolicy(
        `${selectedObjects.reason || 'the sealed repository object store is not usable'}, so no trusted git command ran`,
      );
    }
    const headValue = readFileSync(head, 'utf8').trim();
    const headRef = headValue.startsWith('ref: ') ? headValue.slice(5) : '';
    if (!/^[0-9a-f]{40}$/.test(headValue) && !(headRef.startsWith('refs/heads/') && allowedRef(headRef))) {
      return refusePolicy('the repository HEAD is outside the trusted ref namespace, so no trusted git command ran');
    }
    const packed = filteredPackedRefs(plainFile(path.join(gitDir, 'packed-refs'), gitDir, true));
    if (!packed.ok) return refusePolicy('the repository packed refs could not be selected safely');
    const shallow = selectedShallow(plainFile(path.join(gitDir, 'shallow'), gitDir, true));
    if (!shallow.ok) return refusePolicy('the repository shallow boundary could not be selected safely');
    for (const namespace of TRUSTED_REF_NAMESPACES) {
      const source = path.join(refs, namespace);
      try {
        mkdirSync(source);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (!plainDirectory(source, refs) || !plainRefs(source, namespace)) {
        return refusePolicy('the repository refs are not structurally safe, so no trusted git command ran');
      }
    }

    const root = realpathSync(process.env.RUNNER_TEMP || tmpdir());
    const viewRoot = realpathSync(mkdtempSync(path.join(root, 'ksai-git-')));
    const commonDir = path.join(viewRoot, 'common');
    const viewGitDir = path.join(viewRoot, 'worktree');
    mkdirSync(commonDir);
    mkdirSync(viewGitDir);
    trustedViews.add(viewRoot);
    mkdirSync(path.join(commonDir, 'hooks'));
    mkdirSync(path.join(commonDir, 'info'));
    mkdirSync(path.join(commonDir, 'refs'));
    writeFileSync(
      path.join(commonDir, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = ${fileMode.value}\n`,
    );
    writeFileSync(path.join(commonDir, 'info', 'exclude'), `${TRUSTED_EXCLUDES.join('\n')}\n`);
    if (packed.body) writeFileSync(path.join(commonDir, 'packed-refs'), packed.body);
    if (shallow.body) writeFileSync(path.join(commonDir, 'shallow'), shallow.body);
    for (const namespace of TRUSTED_REF_NAMESPACES) {
      symlinkSync(path.join(refs, namespace), path.join(commonDir, 'refs', namespace), 'dir');
    }
    writeFileSync(path.join(viewGitDir, 'commondir'), '../common\n');
    if (!syncWorktreeState(gitDir, viewGitDir)) {
      return refusePolicy('the repository worktree state could not be selected safely');
    }
    const storage = trustedLfsStorage();
    return {
      ok: true,
      reason: '',
      commonDir,
      gitDir,
      viewGitDir,
      worktree,
      objects: selectedObjects.objects,
      alternateObjects: selectedObjects.alternateObjects,
      identity,
      overrides: [
        '-c',
        `lfs.storage=${storage}`,
        '-c',
        'filter.lfs.clean=git-lfs clean -- %f',
        '-c',
        'filter.lfs.smudge=git-lfs smudge --skip -- %f',
        '-c',
        'filter.lfs.process=git-lfs filter-process',
        '-c',
        'filter.lfs.required=true',
      ],
    };
  } catch {
    return refusePolicy('the trusted repository view could not be created, so no trusted git command ran');
  }
}

const gitEnv = (policy = null) => {
  const identity = policy?.identity ?? trustedIdentity();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_GRAFT_FILE: NULL_DEVICE,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: 'false',
    SSH_ASKPASS: 'false',
    GIT_SSH_COMMAND: 'false',
    GIT_EDITOR: 'true',
    GIT_AUTHOR_NAME: identity.ok ? identity.name : '',
    GIT_AUTHOR_EMAIL: identity.ok ? identity.email : '',
    GIT_COMMITTER_NAME: identity.ok ? identity.name : '',
    GIT_COMMITTER_EMAIL: identity.ok ? identity.email : '',
  };
  if (!policy?.ok) return env;
  const selected = {
    ...env,
    GIT_DIR: policy.viewGitDir,
    GIT_COMMON_DIR: policy.commonDir,
    GIT_INDEX_FILE: path.join(policy.viewGitDir, 'index'),
    GIT_WORK_TREE: policy.worktree,
    GIT_OBJECT_DIRECTORY: policy.objects,
  };
  return policy.alternateObjects
    ? { ...selected, GIT_ALTERNATE_OBJECT_DIRECTORIES: policy.alternateObjects }
    : selected;
};

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LFS_OBJECT_ID = /^[0-9a-f]{64}$/;
const denyLfs = (reason) => ({ ok: false, reason, pointers: [], objects: [], remoteObjects: [] });

function lfsPointer(body) {
  const text = String(body ?? '').replaceAll('\r\n', '\n');
  if (text.includes('\r')) return null;
  const lines = text.trim().split('\n');
  const version = lines[0]?.startsWith('version ') ? lines[0].slice('version '.length) : '';
  if (!LFS_V1_VERSIONS.has(version)) return null;
  const oid = lines.find((line) => line.startsWith('oid sha256:'))?.slice('oid sha256:'.length) ?? '';
  const stated = lines.find((line) => line.startsWith('size '))?.slice('size '.length) ?? '';
  const size = Number(stated);
  return LFS_OBJECT_ID.test(oid) && /^[0-9]+$/.test(stated) && Number.isSafeInteger(size)
    ? { oid, size }
    : null;
}

function lfsProcessingBudget(pointers) {
  let total = 0;
  for (const pointer of pointers) {
    const size = Number(pointer?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LFS_OBJECT_BYTES) return false;
    total += size;
    if (!Number.isSafeInteger(total) || total > MAX_LFS_PROCESSING_BYTES) return false;
  }
  return true;
}

function batchBlobs(git, objects) {
  if (objects.length === 0) return [];
  const read = git(['cat-file', '--batch'], { input: `${objects.map(({ oid }) => oid).join('\n')}\n`, base64: true });
  if (!read?.ok) return null;
  const buffer = Buffer.from(String(read.stdout ?? ''), 'base64');
  const blobs = [];
  let at = 0;
  for (const expected of objects) {
    const lineEnd = buffer.indexOf(0x0a, at);
    if (lineEnd === -1) return null;
    const [oid, type, rawSize] = buffer.subarray(at, lineEnd).toString().split(' ');
    const size = Number(rawSize);
    const bodyAt = lineEnd + 1;
    const bodyEnd = bodyAt + size;
    if (oid !== expected.oid || type !== 'blob' || size !== expected.size || buffer[bodyEnd] !== 0x0a) return null;
    blobs.push(buffer.subarray(bodyAt, bodyEnd).toString());
    at = bodyEnd + 1;
  }
  return at === buffer.length ? blobs : null;
}

function lfsPointersFromObjects(git, ids) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, pointers: [] };
  const checked = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: `${unique.join('\n')}\n`,
  });
  if (!checked?.ok) return denyLfs('the objects to inspect for Git LFS pointers could not be read safely');
  const lines = String(checked.stdout ?? '').trimEnd().split('\n');
  if (lines.length !== unique.length) return denyLfs('the objects to inspect for Git LFS pointers were incomplete');
  const objects = [];
  for (let index = 0; index < lines.length; index += 1) {
    const [oid, type, rawSize] = lines[index].split(' ');
    const size = Number(rawSize);
    if (oid !== unique[index] || !Number.isSafeInteger(size) || size < 0) {
      return denyLfs('the objects to inspect for Git LFS pointers were not readable safely');
    }
    if (type !== 'blob') continue;
    if (size <= MAX_LFS_POINTER_BYTES) objects.push({ oid, size });
  }
  const pointers = new Map();
  for (let at = 0; at < objects.length; at += LFS_BATCH_SIZE) {
    const batch = objects.slice(at, at + LFS_BATCH_SIZE);
    const blobs = batchBlobs(git, batch);
    if (!blobs) return denyLfs('the possible Git LFS pointers could not be read safely');
    for (let index = 0; index < blobs.length; index += 1) {
      const pointer = lfsPointer(blobs[index]);
      if (!pointer) continue;
      const prior = pointers.get(pointer.oid);
      if (prior && prior.size !== pointer.size) {
        return denyLfs(`Git LFS object ${pointer.oid.slice(0, 12)} has conflicting sizes`);
      }
      if (prior) prior.blobs.push(batch[index].oid);
      else pointers.set(pointer.oid, { ...pointer, blobs: [batch[index].oid] });
    }
  }
  return { ok: true, pointers: [...pointers.values()] };
}

function rawDiffEntries(stdout) {
  const fields = splitZ(stdout);
  if (fields.length % 2 !== 0) return null;
  const entries = [];
  for (let at = 0; at < fields.length; at += 2) {
    const header = fields[at];
    const file = fields[at + 1];
    if (!header.startsWith(':') || !file) return null;
    const [, newMode, , newOid, status] = header.slice(1).split(' ');
    if (String(status ?? '').startsWith('D') || newMode === '000000') {
      entries.push({ oid: '', file });
      continue;
    }
    if (!GIT_OBJECT_ID.test(newOid)) return null;
    entries.push({ oid: newOid, file });
  }
  return entries;
}

function lfsObjectIdsAtPaths(git, entries, sourceArgs) {
  const ids = new Set();
  for (let at = 0; at < entries.length; at += LFS_BATCH_SIZE) {
    const batch = entries.slice(at, at + LFS_BATCH_SIZE);
    const checked = git(['check-attr', ...sourceArgs, '-z', '--stdin', 'filter'], {
      input: `${batch.map(({ file }) => file).join('\0')}\0`,
    });
    if (!checked?.ok) return null;
    const fields = splitZ(checked.stdout);
    if (fields.length !== batch.length * 3) return null;
    for (let index = 0; index < fields.length; index += 3) {
      const [file, attribute, value] = fields.slice(index, index + 3);
      const entry = batch[index / 3];
      if (file !== entry.file || attribute !== 'filter') return null;
      if (value === 'lfs') ids.add(entry.oid);
    }
  }
  return [...ids];
}

function treeBlobEntries(git, tree) {
  const listed = git(['ls-tree', '-r', '-z', '--full-tree', tree]);
  if (!listed?.ok) return null;
  const entries = [];
  for (const record of splitZ(listed.stdout)) {
    const tab = record.indexOf('\t');
    if (tab === -1 || tab === record.length - 1) return null;
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (!mode || !type || !GIT_OBJECT_ID.test(oid)) return null;
    if (type === 'blob') entries.push({ oid, file: record.slice(tab + 1) });
    else if (type !== 'commit') return null;
  }
  return entries;
}

function indexBlobEntries(git, pathspec) {
  const listed = git(['ls-files', '--stage', '-z', '--', ':(top)', ...pathspec]);
  if (!listed?.ok) return null;
  const entries = [];
  for (const record of splitZ(listed.stdout)) {
    const tab = record.indexOf('\t');
    if (tab === -1 || tab === record.length - 1) return null;
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (!mode || !GIT_OBJECT_ID.test(oid) || stage !== '0') return null;
    if (mode !== '160000') entries.push({ oid, file: record.slice(tab + 1) });
  }
  return entries;
}

function lfsPointersAtPaths(git, entries, sourceArgs) {
  const readable = entries.filter(({ oid }) => GIT_OBJECT_ID.test(oid));
  const found = lfsPointersFromObjects(git, readable.map(({ oid }) => oid));
  if (!found.ok || found.pointers.length === 0) return found;
  const pointerBlobs = new Set(found.pointers.flatMap(({ blobs }) => blobs));
  const candidates = readable.filter(({ oid }) => pointerBlobs.has(oid));
  const selected = lfsObjectIdsAtPaths(git, candidates, sourceArgs);
  if (!selected) return denyLfs('the Git LFS attributes could not be read safely');
  const kept = new Set(selected);
  return {
    ok: true,
    pointers: found.pointers
      .map((pointer) => ({ ...pointer, blobs: pointer.blobs.filter((blob) => kept.has(blob)) }))
      .filter(({ blobs }) => blobs.length > 0),
  };
}

function mergePointers(lists) {
  const merged = new Map();
  for (const pointer of lists.flat()) {
    const prior = merged.get(pointer.oid);
    if (prior && prior.size !== pointer.size) return null;
    if (prior) prior.blobs = [...new Set([...prior.blobs, ...pointer.blobs])];
    else merged.set(pointer.oid, { ...pointer, blobs: [...new Set(pointer.blobs)] });
  }
  return [...merged.values()];
}

function baseLfsObjectIds(git, from, candidateBlobs) {
  const entries = treeBlobEntries(git, from);
  if (!entries) return null;
  const candidates = new Set(candidateBlobs);
  const found = lfsPointersAtPaths(
    git,
    entries.filter(({ oid }) => candidates.has(oid)),
    [`--source=${from}`],
  );
  return found.ok ? new Set(found.pointers.map(({ oid }) => oid)) : null;
}

function remoteLfsObjectIds(git, refs, candidateBlobs) {
  const remote = new Set();
  for (const ref of new Set(refs)) {
    if (!GIT_OBJECT_ID.test(ref)) return null;
    const found = baseLfsObjectIds(git, ref, candidateBlobs);
    if (!found) return null;
    for (const oid of found) remote.add(oid);
  }
  return remote;
}

const attributesChanged = (entries) => entries.some(({ file }) => path.posix.basename(file) === '.gitattributes');

function commitChangedEntries(git, commit) {
  const changed = git([
    'diff-tree',
    '--root',
    '-m',
    '--no-commit-id',
    '--raw',
    '-r',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--abbrev=64',
    commit,
  ]);
  return changed?.ok ? rawDiffEntries(changed.stdout) : null;
}

function lfsPointersBetween(git, from, to, remoteRefs = []) {
  const listed = git(['rev-list', '--reverse', `${from}..${to}`]);
  if (!listed?.ok) return denyLfs('the commits to inspect for Git LFS objects could not be read');
  const commits = String(listed.stdout ?? '').split('\n').filter(Boolean);
  if (!commits.every((commit) => GIT_OBJECT_ID.test(commit))) {
    return denyLfs('the commits to inspect for Git LFS objects could not be read safely');
  }
  const lists = [];
  for (const commit of commits) {
    const changed = commitChangedEntries(git, commit);
    if (!changed) return denyLfs('the committed paths to inspect for Git LFS objects could not be read safely');
    const entries = attributesChanged(changed) ? treeBlobEntries(git, commit) : changed;
    if (!entries) return denyLfs('the committed paths to inspect for Git LFS objects could not be read safely');
    const found = lfsPointersAtPaths(git, entries, [`--source=${commit}`]);
    if (!found.ok) return found;
    lists.push(found.pointers);
  }
  const pointers = mergePointers(lists);
  if (!pointers) return denyLfs('a Git LFS object has conflicting sizes');
  if (pointers.length === 0) return { ok: true, pointers: [] };
  const blobs = pointers.flatMap(({ blobs: pointerBlobs }) => pointerBlobs);
  const remote = remoteLfsObjectIds(git, [from, ...remoteRefs], blobs);
  if (!remote) return denyLfs('the remote Git LFS paths could not be read safely');
  return { ok: true, pointers: pointers.filter(({ oid }) => !remote.has(oid)) };
}

function indexChangedEntries(git, from, pathspec) {
  const listed = git([
    'diff',
    '--cached',
    '--raw',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--ignore-submodules=none',
    '--abbrev=64',
    from,
    '--',
    ...pathspec,
  ]);
  return listed?.ok ? rawDiffEntries(listed.stdout) : null;
}

function sha256File(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, 'r');
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function validLfsObject(file, pointer, allowedRoot) {
  if (!lfsProcessingBudget([pointer])) return false;
  try {
    const root = realpathSync(allowedRoot);
    const entry = lstatSync(file);
    const resolved = realpathSync(file);
    return (
      entry.isFile() &&
      within(root, resolved) &&
      lstatSync(resolved).size === pointer.size &&
      sha256File(resolved) === pointer.oid
    );
  } catch {
    return false;
  }
}

function lfsObjectPath(storage, pointer, allowedRoot = null) {
  try {
    const root = realpathSync(storage);
    if (allowedRoot && !within(realpathSync(allowedRoot), root)) return '';
    const candidate = path.join(root, 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
    return validLfsObject(candidate, pointer, root) ? realpathSync(candidate) : '';
  } catch {
    return '';
  }
}

function localLfsObjects(git, pointers, baseObjects = null) {
  const localPointers = baseObjects ? pointers.filter(({ oid }) => !baseObjects.has(oid)) : pointers;
  if (!lfsProcessingBudget(localPointers)) {
    return denyLfs('the Git LFS objects exceed the trusted processing limit');
  }
  let commonRoot = '';
  try {
    if (git?.policy?.gitDir) {
      commonRoot = realpathSync(git.policy.gitDir);
    } else {
      const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
      commonRoot = common?.ok ? realpathSync(String(common.stdout ?? '').trim()) : '';
    }
  } catch {}
  const repositoryStorage = commonRoot ? path.join(commonRoot, 'lfs') : '';
  const objects = [];
  const remoteObjects = [];
  for (const pointer of pointers) {
    if (baseObjects?.has(pointer.oid)) {
      remoteObjects.push({ oid: pointer.oid, size: pointer.size });
      continue;
    }
    const trusted = lfsObjectPath(lfsStorage, pointer);
    const repository = repositoryStorage ? lfsObjectPath(repositoryStorage, pointer, commonRoot) : '';
    const source = trusted || repository;
    const storage = trusted ? lfsStorage : repository ? repositoryStorage : '';
    if (!source) return denyLfs(`Git LFS object ${pointer.oid.slice(0, 12)} is not available in trusted storage`);
    objects.push({ ...pointer, source, storage });
  }
  return { ok: true, reason: '', objects, remoteObjects };
}

function lfsObjectsFromIndex({ git, from, pathspec = [] }) {
  const changed = indexChangedEntries(git, from, pathspec);
  if (!changed) return denyLfs('the staged work could not be inspected for Git LFS objects');
  const changedPointers = lfsPointersAtPaths(git, changed, ['--cached']);
  if (!changedPointers.ok) return changedPointers;
  let indexedPointers = { ok: true, pointers: [] };
  if (attributesChanged(changed)) {
    const indexed = indexBlobEntries(git, pathspec);
    if (!indexed) return denyLfs('the staged work could not be inspected for Git LFS objects');
    indexedPointers = lfsPointersAtPaths(git, indexed, ['--cached']);
    if (!indexedPointers.ok) return indexedPointers;
  }
  const candidates = mergePointers([changedPointers.pointers, indexedPointers.pointers]);
  if (!candidates) return denyLfs('a Git LFS object has conflicting sizes');
  if (candidates.length === 0) return { ok: true, reason: '', objects: [], remoteObjects: [] };
  const blobs = candidates.flatMap(({ blobs: pointerBlobs }) => pointerBlobs);
  const baseObjects = baseLfsObjectIds(git, from, blobs);
  if (!baseObjects) return denyLfs('the base tree could not be inspected for existing Git LFS objects');
  const pointers = mergePointers([
    changedPointers.pointers,
    indexedPointers.pointers.filter(({ oid }) => !baseObjects.has(oid)),
  ]);
  if (!pointers) return denyLfs('a Git LFS object has conflicting sizes');
  if (pointers.length === 0) return { ok: true, reason: '', objects: [], remoteObjects: [] };
  const local = localLfsObjects(git, pointers);
  if (local.ok) return local;
  return localLfsObjects(git, pointers, baseObjects);
}

function lfsPushArgs(storage, pushUrl) {
  const remote = 'ksai-lfs';
  return [
    '-c',
    `lfs.storage=${storage}`,
    '-c',
    'lfs.url=',
    '-c',
    'lfs.pushurl=',
    '-c',
    'lfs.remote.autodetect=false',
    '-c',
    'lfs.basictransfersonly=true',
    '-c',
    'lfs.standalonetransferagent=',
    '-c',
    'lfs.transfer.enablehrefrewrite=false',
    '-c',
    `remote.${remote}.url=${pushUrl}`,
    '-c',
    `remote.${remote}.pushurl=${pushUrl}`,
    '-c',
    `remote.${remote}.lfsurl=`,
    '-c',
    `remote.${remote}.lfspushurl=`,
    'lfs',
    'push',
    '--object-id',
    remote,
    '--stdin',
  ];
}

function uploadLfsObjects({ git, from, to, pushUrl, remoteRefs = [] }) {
  const found = lfsPointersBetween(git, from, to, remoteRefs);
  if (!found.ok || found.pointers.length === 0) return found.ok ? { ok: true, reason: '', count: 0 } : found;
  if (!String(pushUrl ?? '') || /[\0\r\n]/.test(String(pushUrl))) {
    return denyLfs('the Git LFS destination is not usable');
  }

  const local = localLfsObjects(git, found.pointers);
  if (!local.ok) return local;
  const groups = new Map();
  for (const object of local.objects) {
    groups.set(object.storage, [...(groups.get(object.storage) ?? []), object.oid]);
  }

  for (const [storage, oids] of groups) {
    const pushed = git(lfsPushArgs(storage, String(pushUrl)), {
      input: `${oids.join('\n')}\n`,
      stderr: 'ignore',
    });
    if (!pushed?.ok) return denyLfs('the Git LFS objects could not be uploaded');
  }
  return { ok: true, reason: '', count: found.pointers.length };
}

function gitVia(run, cwd) {
  const policy = repositoryView(cwd);
  const invoke = (args, options = {}) => {
    if (!policy.ok) return { ok: false, stdout: '', status: null, reason: policy.reason };
    const result = run('git', gitArgs(cwd, args, policy.overrides), {
      ...options,
      env: gitEnv(policy),
      maxBuffer: GIT_MAX_BUFFER,
    });
    return syncRepositoryState(policy)
      ? result
      : { ok: false, stdout: '', status: null, reason: 'trusted Git state could not be written back safely' };
  };
  return Object.assign(invoke, { policy });
}

function directRun(file, args, { input = null, env = null, base64 = false } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: base64 ? null : 'utf8',
      input,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env,
    });
    return { ok: true, stdout: base64 ? Buffer.from(stdout ?? []).toString('base64') : String(stdout ?? ''), status: 0 };
  } catch (error) {
    const stdout = base64
      ? Buffer.from(error?.stdout ?? []).toString('base64')
      : String(error?.stdout ?? '');
    return { ok: false, stdout, status: typeof error?.status === 'number' ? error.status : null };
  }
}

const directGit = (cwd) => gitVia(directRun, cwd);

module.exports = {
  GIT_CONFIG_OVERRIDES,
  directGit,
  gitArgs,
  gitEnv,
  gitVia,
  lfsObjectsFromIndex,
  lfsPointer,
  lfsProcessingBudget,
  repositoryView,
  sealObjectStore,
  uploadLfsObjects,
  validLfsObject,
};
