import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';

import { canonicalJson, parseIJson } from './json.mjs';
import { collectSchemaIds, validateSchemaDefinitionWithReferences } from './schema.mjs';

export const PROFILES = Object.freeze([
  'read', 'mutate', 'product-read', 'product-test', 'browser-read', 'browser-test',
]);
export const SUBJECTS = Object.freeze(['pull-request', 'github-issue', 'jira-issue', 'repository-revision']);
export const GATES = Object.freeze(['repository-write', 'environment-write', 'independent-human']);
export const PUBLISHERS = Object.freeze(['comment', 'review', 'branch-update', 'pull-request']);

const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKFLOW_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const TOP = new Set(['apiVersion', 'kind', 'metadata', 'spec']);
const STAGE = new Set([
  'id', 'kind', 'needs', 'profile', 'entrypoint', 'outputSchema', 'timeoutMinutes',
  'integrations', 'artifacts', 'retry', 'foreach', 'gate', 'publisher',
]);
const BYTES = new Set([
  'checkout', 'writableFile', 'attemptScratch', 'candidateResult', 'artifact',
  'attemptArtifacts', 'attemptLogs', 'jobRetained',
]);

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fields(value, allowed, required, where) {
  if (!object(value)) throw new Error(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${where} has unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${where} is missing ${key}`);
}

function positive(value, where) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${where} is not a positive integer`);
}

function identifiers(value, where) {
  if (!Array.isArray(value) || value.some((held) => typeof held !== 'string' || !ID.test(held))
    || new Set(value).size !== value.length) throw new Error(`${where} is not a unique ID list`);
  return value;
}

function jsonPointer(value) {
  return typeof value === 'string' && (value === '' || (value.startsWith('/')
    && value.slice(1).split('/').every((token) => !/~(?:[^01]|$)/u.test(token))));
}

export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Resolve one package-relative regular file without crossing a symlink. */
export function packageFile(root, relative, where = 'package path') {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\\')) throw new Error(`${where} is not relative`);
  const normalized = posix.normalize(relative);
  if (normalized !== relative || normalized.startsWith('../') || relative.startsWith('/')) throw new Error(`${where} escapes the package`);
  let current = resolve(root);
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    let held;
    try {
      held = lstatSync(current);
    } catch {
      throw new Error(`${where} is missing`);
    }
    if (held.isSymbolicLink()) throw new Error(`${where} crosses a symlink`);
  }
  const held = lstatSync(current);
  if (!held.isFile()) throw new Error(`${where} is not a regular file`);
  if (!(current === resolve(root) || current.startsWith(`${resolve(root)}${sep}`))) throw new Error(`${where} escapes the package`);
  return current;
}

function packageFiles(root, at = '', found = []) {
  if (at === '') {
    const held = lstatSync(root);
    if (!held.isDirectory() || held.isSymbolicLink() || realpathSync(root) !== resolve(root)) {
      throw new Error('package root is not a real directory');
    }
  }
  for (const name of readdirSync(join(root, at)).sort()) {
    const relative = at ? `${at}/${name}` : name;
    if (relative !== relative.normalize('NFC')) throw new Error(`package path ${relative} is not NFC`);
    if ([...relative].some((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127 || character === '\\';
    })) throw new Error(`package path ${relative} has a forbidden byte`);
    if (relative.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`package path ${relative} is invalid`);
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

function* packageChunks(root) {
  const files = packageFiles(root).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const relative of files) {
    const content = readFileSync(join(root, relative));
    yield headerFor(relative, content.length);
    yield content;
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

/** Encode a package directory using the contract's canonical ustar bytes. */
export function packageArchive(root) {
  return Buffer.concat([...packageChunks(root)]);
}

/** Hash a package directory using the contract's canonical ustar bytes. */
export function packageDigest(root) {
  const hash = createHash('sha256');
  for (const chunk of packageChunks(root)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function schemaPath(relative, where) {
  if (typeof relative !== 'string' || !relative.startsWith('schemas/') || !relative.endsWith('.json')) {
    throw new Error(`${where} is not a package schema path`);
  }
  return relative;
}

/** Load one schema closure using the same supported subset as result acceptance. */
export function loadSchema(root, initialPath) {
  const documents = new Map();
  const ids = new Map();
  const load = (relative) => {
    schemaPath(relative, 'schema path');
    if (!documents.has(relative)) {
      const schema = parseIJson(readFileSync(packageFile(root, relative, `schema ${relative}`)), relative);
      documents.set(relative, schema);
      if (object(schema) && schema.$id !== undefined) {
        if (ids.has(schema.$id) && ids.get(schema.$id) !== relative) throw new Error(`schema $id ${schema.$id} is duplicated`);
        ids.set(schema.$id, relative);
      }
    }
    return documents.get(relative);
  };
  const resolveReference = (relative, fromPath) => {
    if (relative === '' || relative.startsWith('/') || relative.includes('\\') || relative.includes('?')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relative)) {
      throw new Error(`schema reference ${relative} is not package-relative`);
    }
    const target = posix.normalize(posix.join(posix.dirname(fromPath), relative));
    schemaPath(target, `schema reference ${relative}`);
    return { schema: load(target), path: target };
  };
  const schema = load(initialPath);
  validateSchemaDefinitionWithReferences(schema, initialPath, resolveReference);
  return { schema, path: initialPath, resolveReference, documents };
}

function validateAgent(root, stage) {
  for (const key of ['profile', 'entrypoint', 'outputSchema']) {
    if (!Object.hasOwn(stage, key)) throw new Error(`agent stage ${stage.id} is missing ${key}`);
  }
  if (Object.hasOwn(stage, 'gate') || Object.hasOwn(stage, 'publisher')) throw new Error(`agent stage ${stage.id} declares a trusted-only field`);
  if (!PROFILES.includes(stage.profile)) throw new Error(`stage ${stage.id} names no fixed platform profile`);
  fields(stage.entrypoint, new Set(['type', 'path']), ['type', 'path'], `stage ${stage.id} entrypoint`);
  if (stage.entrypoint.type !== 'skill' || typeof stage.entrypoint.path !== 'string'
    || !stage.entrypoint.path.startsWith('stages/') || !stage.entrypoint.path.endsWith('/SKILL.md')) {
    throw new Error(`stage ${stage.id} entrypoint is unsupported`);
  }
  packageFile(root, stage.entrypoint.path, `stage ${stage.id} entrypoint`);
  schemaPath(stage.outputSchema, `stage ${stage.id} output schema`);
  loadSchema(root, stage.outputSchema);
  if (stage.timeoutMinutes !== undefined) positive(stage.timeoutMinutes, `stage ${stage.id} timeoutMinutes`);
  if (stage.integrations !== undefined) identifiers(stage.integrations, `stage ${stage.id} integrations`);
  if (stage.retry !== undefined) {
    fields(stage.retry, new Set(['maxAttempts', 'backoff']), ['maxAttempts', 'backoff'], `stage ${stage.id} retry`);
    positive(stage.retry.maxAttempts, `stage ${stage.id} retry maxAttempts`);
    if (!['fixed', 'exponential'].includes(stage.retry.backoff)) throw new Error(`stage ${stage.id} retry backoff is unsupported`);
  }
  if (stage.artifacts !== undefined) {
    if (!Array.isArray(stage.artifacts)) throw new Error(`stage ${stage.id} artifacts is not an array`);
    const ids = new Set();
    for (const artifact of stage.artifacts) {
      fields(artifact, new Set(['id', 'mediaType']), ['id', 'mediaType'], `stage ${stage.id} artifact`);
      if (typeof artifact.id !== 'string' || !ID.test(artifact.id) || ids.has(artifact.id)) throw new Error(`stage ${stage.id} artifact ID is invalid or duplicated`);
      if (typeof artifact.mediaType !== 'string' || !MEDIA_TYPE.test(artifact.mediaType)) throw new Error(`stage ${stage.id} artifact media type is invalid`);
      ids.add(artifact.id);
    }
  }
  if (stage.foreach !== undefined) {
    fields(stage.foreach, new Set(['from', 'pointer', 'itemSchema', 'maxItems']),
      ['from', 'pointer', 'itemSchema', 'maxItems'], `stage ${stage.id} foreach`);
    if (typeof stage.foreach.from !== 'string' || !ID.test(stage.foreach.from)) throw new Error(`stage ${stage.id} foreach source is invalid`);
    if (!jsonPointer(stage.foreach.pointer)) {
      throw new Error(`stage ${stage.id} foreach pointer is invalid`);
    }
    schemaPath(stage.foreach.itemSchema, `stage ${stage.id} foreach item schema`);
    loadSchema(root, stage.foreach.itemSchema);
    positive(stage.foreach.maxItems, `stage ${stage.id} foreach maxItems`);
  }
}

function validateApproval(stage) {
  if (!Object.hasOwn(stage, 'gate')) throw new Error(`approval stage ${stage.id} is missing gate`);
  for (const key of ['profile', 'entrypoint', 'outputSchema', 'timeoutMinutes', 'integrations', 'artifacts', 'retry', 'foreach', 'publisher']) {
    if (Object.hasOwn(stage, key)) throw new Error(`approval stage ${stage.id} has incompatible field ${key}`);
  }
  if (!GATES.includes(stage.gate)) throw new Error(`approval stage ${stage.id} gate is unsupported`);
}

function validatePublisher(stage) {
  if (!Object.hasOwn(stage, 'publisher')) throw new Error(`publisher stage ${stage.id} is missing publisher`);
  for (const key of ['profile', 'entrypoint', 'outputSchema', 'timeoutMinutes', 'integrations', 'artifacts', 'retry', 'foreach', 'gate']) {
    if (Object.hasOwn(stage, key)) throw new Error(`publisher stage ${stage.id} has incompatible field ${key}`);
  }
  fields(stage.publisher, new Set(['type', 'from']), ['type', 'from'], `stage ${stage.id} publisher`);
  if (!PUBLISHERS.includes(stage.publisher.type)) throw new Error(`stage ${stage.id} publisher type is unsupported`);
  fields(stage.publisher.from, new Set(['result', 'artifact']), [], `stage ${stage.id} publisher source`);
  const choices = ['result', 'artifact'].filter((key) => Object.hasOwn(stage.publisher.from, key));
  if (choices.length !== 1) throw new Error(`stage ${stage.id} publisher source is not tagged`);
  const choice = choices[0];
  const required = choice === 'result' ? ['stage'] : ['stage', 'id'];
  fields(stage.publisher.from[choice], new Set(required), required, `stage ${stage.id} publisher ${choice}`);
  if (typeof stage.publisher.from[choice].stage !== 'string' || !ID.test(stage.publisher.from[choice].stage)
    || (choice === 'artifact' && (typeof stage.publisher.from[choice].id !== 'string'
      || !ID.test(stage.publisher.from[choice].id)))) throw new Error(`stage ${stage.id} publisher source is invalid`);
}

function graph(manifest) {
  const stages = manifest.spec.stages;
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const consumers = new Map(stages.map((stage) => [stage.id, []]));
  for (const stage of stages) {
    const needs = stage.needs ?? [];
    identifiers(needs, `stage ${stage.id} needs`);
    for (const dependency of needs) {
      if (!byId.has(dependency)) throw new Error(`stage ${stage.id} needs missing stage ${dependency}`);
      if (dependency === stage.id) throw new Error(`stage ${stage.id} depends on itself`);
      consumers.get(dependency).push(stage.id);
    }
  }
  const state = new Map();
  for (const stage of stages) {
    if (state.get(stage.id) === 'visited') continue;
    const pending = [{ id: stage.id, dependency: 0 }];
    state.set(stage.id, 'visiting');
    while (pending.length) {
      const current = pending.at(-1);
      const needs = byId.get(current.id).needs ?? [];
      if (current.dependency === needs.length) {
        state.set(current.id, 'visited');
        pending.pop();
        continue;
      }
      const dependency = needs[current.dependency];
      current.dependency += 1;
      if (state.get(dependency) === 'visiting') throw new Error(`manifest graph has a cycle at ${dependency}`);
      if (state.get(dependency) === 'visited') continue;
      state.set(dependency, 'visiting');
      pending.push({ id: dependency, dependency: 0 });
    }
  }
  for (const stage of stages.filter((held) => held.kind === 'publisher')) {
    if (consumers.get(stage.id).length) throw new Error(`publisher stage ${stage.id} is not terminal`);
    const source = stage.publisher.from.result ?? stage.publisher.from.artifact;
    if (!(stage.needs ?? []).includes(source.stage)) throw new Error(`publisher stage ${stage.id} source is not a direct dependency`);
    const producer = byId.get(source.stage);
    if (producer.kind !== 'agent' || producer.foreach !== undefined) throw new Error(`publisher stage ${stage.id} source is not a singleton agent`);
    if (stage.publisher.from.artifact) {
      const artifact = (producer.artifacts ?? []).find((held) => held.id === source.id);
      if (!artifact) throw new Error(`publisher stage ${stage.id} source artifact is not declared`);
      if (['branch-update', 'pull-request'].includes(stage.publisher.type)
        && artifact.mediaType !== 'application/vnd.ksai.git-tree') throw new Error(`publisher stage ${stage.id} artifact is incompatible`);
    } else if (['branch-update', 'pull-request'].includes(stage.publisher.type)) {
      throw new Error(`publisher stage ${stage.id} requires an artifact source`);
    }
  }
  for (const stage of stages.filter((held) => held.foreach !== undefined)) {
    if (!(stage.needs ?? []).includes(stage.foreach.from)) throw new Error(`stage ${stage.id} foreach source is not a direct dependency`);
    const producer = byId.get(stage.foreach.from);
    if (producer.kind !== 'agent' || producer.foreach !== undefined) throw new Error(`stage ${stage.id} foreach source is not a singleton agent`);
  }
  return { byId, consumers };
}

function validateTriggers(root, manifest, byId, consumers) {
  if (!Array.isArray(manifest.spec.triggers) || manifest.spec.triggers.length === 0) throw new Error('manifest has no triggers');
  const triggerIds = new Set();
  const reachable = new Set();
  let maximumInstances = 0;
  for (const trigger of manifest.spec.triggers) {
    fields(trigger, new Set(['id', 'subject', 'inputSchema', 'starts']),
      ['id', 'subject', 'inputSchema', 'starts'], 'manifest trigger');
    if (typeof trigger.id !== 'string' || !ID.test(trigger.id) || triggerIds.has(trigger.id)) throw new Error('manifest trigger ID is invalid or duplicated');
    triggerIds.add(trigger.id);
    if (!SUBJECTS.includes(trigger.subject)) throw new Error(`trigger ${trigger.id} subject is unsupported`);
    schemaPath(trigger.inputSchema, `trigger ${trigger.id} input schema`);
    loadSchema(root, trigger.inputSchema);
    identifiers(trigger.starts, `trigger ${trigger.id} starts`);
    if (trigger.starts.length === 0) throw new Error(`trigger ${trigger.id} has no starts`);
    for (const id of trigger.starts) {
      if (!byId.has(id)) throw new Error(`trigger ${trigger.id} starts missing stage ${id}`);
      if ((byId.get(id).needs ?? []).length) throw new Error(`trigger ${trigger.id} starts non-root stage ${id}`);
    }
    const eligible = new Set(trigger.starts);
    const pending = [...trigger.starts];
    while (pending.length) {
      for (const consumer of consumers.get(pending.pop())) {
        if (eligible.has(consumer)) continue;
        eligible.add(consumer);
        pending.push(consumer);
      }
    }
    for (const id of eligible) {
      for (const dependency of byId.get(id).needs ?? []) {
        if (!eligible.has(dependency)) throw new Error(`trigger ${trigger.id} graph omits dependency ${dependency}`);
      }
      reachable.add(id);
    }
    const instances = [...eligible].reduce(
      (total, id) => total + (byId.get(id).foreach?.maxItems ?? 1), 0,
    );
    maximumInstances = Math.max(maximumInstances, instances);
  }
  for (const id of byId.keys()) if (!reachable.has(id)) throw new Error(`manifest stage ${id} is unreachable`);
  return maximumInstances;
}

/** Load and fully validate the supported workflow manifest. */
export function loadManifest(root) {
  const path = packageFile(root, 'workflow.yaml', 'workflow manifest');
  const manifest = parseIJson(readFileSync(path), 'workflow.yaml');
  fields(manifest, TOP, ['apiVersion', 'kind', 'metadata', 'spec'], 'manifest');
  if (manifest.apiVersion !== 'ksai.konghq.com/v1alpha1' || manifest.kind !== 'AgentWorkflow') {
    throw new Error('manifest version or kind is unsupported');
  }
  fields(manifest.metadata, new Set(['name', 'version']), ['name', 'version'], 'manifest metadata');
  if (!validWorkflowId(manifest.metadata.name)) throw new Error('manifest workflow ID is invalid');
  if (!validVersion(manifest.metadata.version)) throw new Error('manifest version is not immutable SemVer');
  fields(manifest.spec, new Set(['triggers', 'limits', 'stages']), ['triggers', 'limits', 'stages'], 'manifest spec');
  fields(manifest.spec.limits, new Set(['maxParallel', 'maxStages', 'bytes']),
    ['maxParallel', 'maxStages'], 'manifest limits');
  positive(manifest.spec.limits.maxParallel, 'manifest maxParallel');
  positive(manifest.spec.limits.maxStages, 'manifest maxStages');
  if (manifest.spec.limits.bytes !== undefined) {
    fields(manifest.spec.limits.bytes, BYTES, [], 'manifest byte limits');
    for (const [name, value] of Object.entries(manifest.spec.limits.bytes)) positive(value, `manifest byte limit ${name}`);
  }
  if (!Array.isArray(manifest.spec.stages) || manifest.spec.stages.length === 0) throw new Error('manifest has no stages');
  const ids = new Set();
  for (const stage of manifest.spec.stages) {
    fields(stage, STAGE, ['id', 'kind'], 'manifest stage');
    if (typeof stage.id !== 'string' || !ID.test(stage.id) || ids.has(stage.id)) throw new Error('manifest stage ID is invalid or duplicated');
    ids.add(stage.id);
    if (stage.kind === 'agent') validateAgent(root, stage);
    else if (stage.kind === 'approval') validateApproval(stage);
    else if (stage.kind === 'publisher') validatePublisher(stage);
    else throw new Error(`stage ${stage.id} kind is unsupported`);
  }
  const held = graph(manifest);
  const schemaIds = new Map();
  const schemaFiles = packageFiles(root).filter((relative) => relative.startsWith('schemas/') && relative.endsWith('.json'));
  for (const relative of schemaFiles) {
    const closure = loadSchema(root, relative);
    for (const { id, location } of collectSchemaIds(closure.schema, relative)) {
      if (schemaIds.has(id)) throw new Error(`schema $id ${id} is duplicated`);
      schemaIds.set(id, location);
    }
  }
  const instances = validateTriggers(root, manifest, held.byId, held.consumers);
  if (instances > manifest.spec.limits.maxStages) throw new Error(`manifest graph can create ${instances} stages above maxStages`);
  return { manifest, digest: sha256(Buffer.from(canonicalJson(manifest))) };
}

/** Resolve one validated manifest-backed agent stage. */
export function manifestStage(root, manifest, id) {
  const stage = manifest.spec.stages.find((held) => held.id === id);
  if (!stage) throw new Error(`manifest has no stage ${id}`);
  if (stage.kind !== 'agent') throw new Error(`stage ${id} is trusted-only, not an agent stage`);
  const entrypoint = packageFile(root, stage.entrypoint.path, `stage ${id} entrypoint`);
  const held = loadSchema(root, stage.outputSchema);
  return {
    stage, entrypoint, schemaPath: packageFile(root, stage.outputSchema, `stage ${id} output schema`),
    schema: held.schema, schemaReference: held.resolveReference, schemaDocumentPath: held.path,
  };
}

export const validDigest = (value) => typeof value === 'string' && DIGEST.test(value);
export const validVersion = (value) => typeof value === 'string' && VERSION.test(value);
export const validWorkflowId = (value) => typeof value === 'string' && value.length <= 253 && WORKFLOW_ID.test(value);
