import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';

import { canonicalJson, parseIJson } from './json.mjs';

export const PROFILES = Object.freeze([
  'read', 'mutate', 'product-read', 'product-test', 'browser-read', 'browser-test',
]);

const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKFLOW_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOP = new Set(['apiVersion', 'kind', 'metadata', 'spec']);
const STAGE = new Set([
  'id', 'kind', 'needs', 'profile', 'entrypoint', 'outputSchema', 'timeoutMinutes',
  'integrations', 'artifacts', 'retry', 'foreach', 'gate', 'publisher',
]);

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, where) => {
  if (!object(value)) throw new Error(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${where} has unknown field ${key}`);
};

export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Resolve one package-relative regular file without crossing a symlink. */
export function packageFile(root, relative, where = 'package path') {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\\')) throw new Error(`${where} is not relative`);
  const normalized = posix.normalize(relative);
  if (normalized !== relative || normalized.startsWith('../') || relative.startsWith('/')) throw new Error(`${where} escapes the package`);
  let current = resolve(root);
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    const held = lstatSync(current);
    if (held.isSymbolicLink()) throw new Error(`${where} crosses a symlink`);
  }
  const held = lstatSync(current);
  if (!held.isFile()) throw new Error(`${where} is not a regular file`);
  if (!(current === resolve(root) || current.startsWith(`${resolve(root)}${sep}`))) throw new Error(`${where} escapes the package`);
  return current;
}

function packageFiles(root, at = '', found = []) {
  for (const name of readdirSync(join(root, at)).sort()) {
    const relative = at ? `${at}/${name}` : name;
    if (relative !== relative.normalize('NFC')) throw new Error(`package path ${relative} is not NFC`);
    const path = join(root, relative);
    const held = lstatSync(path);
    if (held.isSymbolicLink()) throw new Error(`package path ${relative} is a symlink`);
    if (held.isDirectory()) packageFiles(root, relative, found);
    else if (held.isFile()) found.push(relative);
    else throw new Error(`package path ${relative} is not a regular file`);
  }
  return found;
}

function octal(header, offset, width, value) {
  const encoded = value.toString(8).padStart(width - 1, '0');
  if (encoded.length !== width - 1) throw new Error('package exceeds ustar field bounds');
  header.write(encoded, offset, width - 1, 'ascii');
  header[offset + width - 1] = 0;
}

function headerFor(relative, size) {
  const bytes = Buffer.from(relative);
  let name = bytes;
  let prefix = Buffer.alloc(0);
  if (bytes.length > 100) {
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      if (bytes[index] !== 0x2f || index > 155 || bytes.length - index - 1 > 100) continue;
      prefix = bytes.subarray(0, index);
      name = bytes.subarray(index + 1);
      break;
    }
  }
  if (name.length > 100 || prefix.length > 155) throw new Error(`package path ${relative} does not fit ustar`);
  const header = Buffer.alloc(512);
  name.copy(header, 0);
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  octal(header, 329, 8, 0);
  octal(header, 337, 8, 0);
  prefix.copy(header, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  if (checksum.length !== 6) throw new Error('package checksum does not fit ustar');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Hash a package directory using the contract's canonical ustar bytes. */
export function packageDigest(root) {
  const hash = createHash('sha256');
  const files = packageFiles(root).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const relative of files) {
    const content = readFileSync(join(root, relative));
    hash.update(headerFor(relative, content.length));
    hash.update(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) hash.update(Buffer.alloc(padding));
  }
  hash.update(Buffer.alloc(1024));
  return `sha256:${hash.digest('hex')}`;
}

/** Load the admitted manifest subset needed by one agent stage. */
export function loadManifest(root) {
  const path = packageFile(root, 'workflow.yaml', 'workflow manifest');
  const manifest = parseIJson(readFileSync(path), 'workflow.yaml');
  exact(manifest, TOP, 'manifest');
  if (manifest.apiVersion !== 'ksai.konghq.com/v1alpha1' || manifest.kind !== 'AgentWorkflow') {
    throw new Error('manifest version or kind is unsupported');
  }
  exact(manifest.metadata, new Set(['name', 'version']), 'manifest metadata');
  if (!WORKFLOW_ID.test(manifest.metadata.name) || manifest.metadata.name.length > 253) throw new Error('manifest workflow ID is invalid');
  if (!VERSION.test(manifest.metadata.version)) throw new Error('manifest version is not immutable SemVer');
  exact(manifest.spec, new Set(['triggers', 'limits', 'stages']), 'manifest spec');
  if (!Array.isArray(manifest.spec.stages) || manifest.spec.stages.length === 0) throw new Error('manifest has no stages');
  const ids = new Set();
  for (const stage of manifest.spec.stages) {
    exact(stage, STAGE, 'manifest stage');
    if (!ID.test(stage.id) || ids.has(stage.id)) throw new Error('manifest stage ID is invalid or duplicated');
    ids.add(stage.id);
  }
  return { manifest, digest: sha256(Buffer.from(canonicalJson(manifest))) };
}

/** Resolve and validate one manifest-backed agent stage. */
export function manifestStage(root, manifest, id) {
  const stage = manifest.spec.stages.find((held) => held.id === id);
  if (!stage) throw new Error(`manifest has no stage ${id}`);
  if (stage.kind !== 'agent') throw new Error(`stage ${id} is not an agent stage`);
  if (!PROFILES.includes(stage.profile)) throw new Error(`stage ${id} names no fixed platform profile`);
  exact(stage.entrypoint, new Set(['type', 'path']), `stage ${id} entrypoint`);
  if (stage.entrypoint.type !== 'skill' || !stage.entrypoint.path.endsWith('/SKILL.md')) throw new Error(`stage ${id} entrypoint is unsupported`);
  if (typeof stage.outputSchema !== 'string' || !stage.outputSchema.startsWith('schemas/') || !stage.outputSchema.endsWith('.json')) {
    throw new Error(`stage ${id} output schema is unsupported`);
  }
  const entrypoint = packageFile(root, stage.entrypoint.path, `stage ${id} entrypoint`);
  const schemaPath = packageFile(root, stage.outputSchema, `stage ${id} output schema`);
  const schema = parseIJson(readFileSync(schemaPath), stage.outputSchema);
  return { stage, entrypoint, schemaPath, schema };
}

export const validDigest = (value) => typeof value === 'string' && DIGEST.test(value);
export const validVersion = (value) => typeof value === 'string' && VERSION.test(value);
export const validWorkflowId = (value) => typeof value === 'string' && value.length <= 253 && WORKFLOW_ID.test(value);
