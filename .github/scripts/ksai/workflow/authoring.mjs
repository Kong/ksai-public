import {
  closeSync, constants as fsConstants, existsSync, fstatSync, ftruncateSync,
  lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { canonicalJson, parseIJson } from './json.mjs';
import {
  loadManifest, loadSchema, manifestStage, packageArchive, packageDigest, sha256,
  validDigest, validVersion, validWorkflowId,
} from './manifest.mjs';
import { validateCandidate } from './runner.mjs';
import { validateSchemaWithReferences } from './schema.mjs';

const REQUEST_VERSION = 'ksai.konghq.com/local-stage-fixture/v1alpha1';
const CAPTURE_VERSION = 'ksai.konghq.com/local-stage-capture/v1alpha1';
const BUILD_VERSION = 'ksai.konghq.com/package-build/v1alpha1';
const CONFORMANCE_VERSION = 'ksai.konghq.com/conformance-report/v1alpha1';
const SOURCE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fields(value, allowed, required, where) {
  if (!object(value)) throw new Error(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where} has unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${where} is missing ${key}`);
}

function rootOf(path) {
  return realpathSync(resolve(path));
}

function outputPath(root, path, where) {
  const requested = resolve(path);
  const outside = (target) => {
    if (target === root || target.startsWith(`${root}${sep}`)) throw new Error(`${where} must be outside the package`);
  };
  outside(requested);
  let ancestor = dirname(requested);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`${where} has no existing parent`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  outside(resolve(realpathSync(ancestor), ...missing, basename(requested)));
  mkdirSync(dirname(requested), { recursive: true });
  const target = join(realpathSync(dirname(requested)), basename(requested));
  outside(target);
  let held;
  try {
    held = lstatSync(requested);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (held) {
    if (held.isSymbolicLink() || !held.isFile() || held.nlink !== 1) {
      throw new Error(`${where} is not one safe output file`);
    }
    const existing = realpathSync(requested);
    outside(existing);
    return existing;
  }
  return target;
}

function openOutput(root, path, where) {
  const target = outputPath(root, path, where);
  let descriptor;
  try {
    descriptor = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o644,
    );
    const held = fstatSync(descriptor);
    if (!held.isFile() || held.nlink !== 1) throw new Error(`${where} is not one safe output file`);
    return { descriptor, held, path: target };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function writeOutput(root, path, bytes, where) {
  const output = openOutput(root, path, where);
  try {
    ftruncateSync(output.descriptor, 0);
    writeFileSync(output.descriptor, bytes);
  } finally {
    closeSync(output.descriptor);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function scaffoldManifest(name, version) {
  return {
    apiVersion: 'ksai.konghq.com/v1alpha1',
    kind: 'AgentWorkflow',
    metadata: { name, version },
    spec: {
      triggers: [{ id: 'pull-request', subject: 'pull-request', inputSchema: 'schemas/pull-request.json', starts: ['run'] }],
      limits: { maxParallel: 1, maxStages: 1, bytes: { candidateResult: 131_072 } },
      stages: [{
        id: 'run', kind: 'agent', profile: 'read',
        entrypoint: { type: 'skill', path: 'stages/run/SKILL.md' },
        outputSchema: 'schemas/result.json', timeoutMinutes: 15,
      }],
    },
  };
}

/** Create one minimal package with a stage, schemas and local conformance fixtures. */
export function scaffoldPackage(destination, { name, version = '0.1.0' }) {
  if (!validWorkflowId(name)) throw new Error('scaffold workflow name is invalid');
  if (!validVersion(version)) throw new Error('scaffold workflow version is not immutable SemVer');
  const root = resolve(destination);
  if (existsSync(root)) throw new Error('scaffold destination already exists');
  for (const relative of ['schemas', 'stages/run', 'tests']) mkdirSync(join(root, relative), { recursive: true });
  writeJson(join(root, 'workflow.yaml'), scaffoldManifest(name, version));
  writeJson(join(root, 'schemas/pull-request.json'), { type: 'object', additionalProperties: false });
  writeJson(join(root, 'schemas/result.json'), {
    type: 'object', required: ['summary'], additionalProperties: false,
    properties: { summary: { type: 'string', minLength: 1, maxLength: 2000 } },
  });
  writeFileSync(join(root, 'stages/run/SKILL.md'), [
    '# Run',
    '',
    'Read the canonical request at `KSAI_STAGE_REQUEST`. Inspect only the assigned repository.',
    'Write one candidate to `KSAI_STAGE_RESULT` with a concise `output.summary` and no artifacts.',
    '',
  ].join('\n'));
  writeJson(join(root, 'tests/run.request.json'), {
    apiVersion: REQUEST_VERSION,
    trigger: { id: 'pull-request', input: {} },
    dependencies: [],
  });
  writeJson(join(root, 'tests/run.candidate.json'), {
    apiVersion: 'ksai.konghq.com/stage-candidate/v1alpha1',
    output: { summary: 'Local conformance fixture passed.' },
    artifacts: [],
  });
  const loaded = loadManifest(rootOf(root));
  return {
    root, workflow: loaded.manifest.metadata.name, version: loaded.manifest.metadata.version,
    digest: packageDigest(rootOf(root)), manifestDigest: loaded.digest,
  };
}

/** Return the immutable identity and graph summary after full static validation. */
export function validatePackage(packageRoot) {
  const root = rootOf(packageRoot);
  const loaded = loadManifest(root);
  return {
    workflow: loaded.manifest.metadata.name,
    version: loaded.manifest.metadata.version,
    digest: packageDigest(root),
    manifestDigest: loaded.digest,
    stages: loaded.manifest.spec.stages.map((stage) => ({ id: stage.id, kind: stage.kind })),
  };
}

function reachableStage(manifest, triggerId, stageId) {
  const trigger = manifest.spec.triggers.find((held) => held.id === triggerId);
  if (!trigger) throw new Error(`fixture names missing trigger ${triggerId}`);
  const reached = new Set(trigger.starts);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of manifest.spec.stages) {
      if (reached.has(stage.id) || !(stage.needs ?? []).some((dependency) => reached.has(dependency))) continue;
      reached.add(stage.id);
      changed = true;
    }
  }
  if (!reached.has(stageId)) throw new Error(`trigger ${triggerId} does not reach stage ${stageId}`);
  return trigger;
}

function dependencyArtifact(artifact, declaration, instance) {
  fields(artifact, [
    'id', 'mediaType', 'locator', 'digest', 'size', 'producerInstance',
    'acceptedAttempt', 'retentionDeadline',
  ], [
    'id', 'mediaType', 'locator', 'digest', 'size', 'producerInstance',
    'acceptedAttempt', 'retentionDeadline',
  ], `dependency ${instance.id} artifact`);
  if (!declaration || artifact.mediaType !== declaration.mediaType) {
    throw new Error(`dependency ${instance.id} artifact ${artifact.id} is undeclared`);
  }
  if (typeof artifact.locator !== 'string' || artifact.locator === '' || !validDigest(artifact.digest)
    || !Number.isSafeInteger(artifact.size) || artifact.size < 0
    || artifact.producerInstance !== instance.id || artifact.acceptedAttempt !== instance.acceptedAttempt
    || typeof artifact.retentionDeadline !== 'string' || artifact.retentionDeadline === '') {
    throw new Error(`dependency ${instance.id} artifact ${artifact.id} descriptor is invalid`);
  }
}

function agentDependency(root, manifest, dependency, producer) {
  fields(dependency, ['kind', 'stage', 'instances'], ['kind', 'stage', 'instances'], `dependency ${dependency.stage}`);
  if (!Array.isArray(dependency.instances)) throw new Error(`dependency ${dependency.stage} instances are invalid`);
  const expectedInstances = producer.foreach === undefined ? 1 : undefined;
  if ((expectedInstances !== undefined && dependency.instances.length !== expectedInstances)
    || (producer.foreach !== undefined && dependency.instances.length > producer.foreach.maxItems)) {
    throw new Error(`dependency ${dependency.stage} instance count is invalid`);
  }
  const held = manifestStage(root, manifest, producer.id);
  for (const [index, instance] of dependency.instances.entries()) {
    fields(instance, ['id', 'acceptedAttempt', 'output', 'resultDigest', 'artifacts'],
      ['id', 'acceptedAttempt', 'output', 'resultDigest', 'artifacts'], `dependency ${producer.id} instance`);
    const expectedId = producer.foreach === undefined ? producer.id : `${producer.id}[${index}]`;
    if (instance.id !== expectedId || !Number.isSafeInteger(instance.acceptedAttempt)
      || instance.acceptedAttempt < 1
      || instance.acceptedAttempt > (producer.retry?.maxAttempts ?? 1)
      || instance.resultDigest !== sha256(Buffer.from(canonicalJson(instance.output)))
      || !Array.isArray(instance.artifacts)) {
      throw new Error(`dependency ${producer.id} instance ${index} is invalid`);
    }
    const problems = validateSchemaWithReferences(
      held.schema, instance.output, `dependency ${producer.id} output`,
      held.schemaDocumentPath, held.schemaReference,
    );
    if (problems.length) throw new Error(`dependency ${producer.id} output failed its declared schema: ${problems.join('; ')}`);
    const declarations = new Map((producer.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
    const seen = new Set();
    for (const artifact of instance.artifacts) {
      if (seen.has(artifact?.id)) throw new Error(`dependency ${producer.id} duplicates artifact ${artifact.id}`);
      dependencyArtifact(artifact, declarations.get(artifact?.id), instance);
      seen.add(artifact.id);
    }
  }
}

function approvalDependency(dependency, producer) {
  fields(dependency, ['kind', 'stage', 'result', 'resultDigest'],
    ['kind', 'stage', 'result', 'resultDigest'], `dependency ${dependency.stage}`);
  fields(dependency.result, [
    'apiVersion', 'decision', 'gate', 'approvalRecordDigest', 'dependencyResultDigests', 'policyDigest',
  ], [
    'apiVersion', 'decision', 'gate', 'approvalRecordDigest', 'dependencyResultDigests', 'policyDigest',
  ], `dependency ${dependency.stage} approval result`);
  const result = dependency.result;
  if (result.apiVersion !== 'ksai.konghq.com/approval-result/v1alpha1'
    || result.decision !== 'approved' || result.gate !== producer.gate
    || !validDigest(result.approvalRecordDigest) || !validDigest(result.policyDigest)
    || !Array.isArray(result.dependencyResultDigests)
    || result.dependencyResultDigests.some((digest) => !validDigest(digest))
    || !validDigest(dependency.resultDigest)
    || dependency.resultDigest !== sha256(Buffer.from(canonicalJson(result)))) {
    throw new Error(`dependency ${dependency.stage} approval result is invalid`);
  }
}

function dependencyStages(root, manifest, dependencies) {
  const stages = [];
  for (const dependency of dependencies) {
    if (!object(dependency) || typeof dependency.stage !== 'string') throw new Error('stage request fixture dependency has no stage');
    const producer = manifest.spec.stages.find((stage) => stage.id === dependency.stage);
    if (!producer || producer.kind === 'publisher' || dependency.kind !== producer.kind) {
      throw new Error(`stage request fixture dependency ${dependency.stage} kind is invalid`);
    }
    if (producer.kind === 'agent') agentDependency(root, manifest, dependency, producer);
    else approvalDependency(dependency, producer);
    stages.push(dependency.stage);
  }
  if (new Set(stages).size !== stages.length) throw new Error('stage request fixture duplicates a dependency');
  return stages.sort();
}

function inputSchema(root, trigger, value) {
  const held = loadSchema(root, trigger.inputSchema);
  const problems = validateSchemaWithReferences(
    held.schema, value, 'trigger input', held.path, held.resolveReference,
  );
  if (problems.length) throw new Error(`trigger input failed its declared schema: ${problems.join('; ')}`);
}

function pointerValue(value, pointer, where) {
  let held = value;
  if (pointer === '') return held;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if ((!object(held) && !Array.isArray(held)) || !Object.hasOwn(held, key)) {
      throw new Error(`${where} does not resolve`);
    }
    held = held[key];
  }
  return held;
}

/** Validate local request/candidate fixtures and return the canonical captured stage result. */
export function dryRunPackage(packageRoot, {
  stage: stageId, request, candidate, artifacts, out = '',
}) {
  const root = rootOf(packageRoot);
  const loaded = loadManifest(root);
  const held = { ...manifestStage(root, loaded.manifest, stageId), manifest: loaded.manifest };
  const fixture = parseIJson(readFileSync(request), `stage request fixture ${request}`);
  fields(fixture, ['apiVersion', 'trigger', 'dependencies', 'shard'],
    ['apiVersion', 'trigger', 'dependencies'], 'stage request fixture');
  if (fixture.apiVersion !== REQUEST_VERSION || !Array.isArray(fixture.dependencies)) throw new Error('stage request fixture version or dependencies are invalid');
  fields(fixture.trigger, ['id', 'input'], ['id', 'input'], 'stage request fixture trigger');
  const trigger = reachableStage(loaded.manifest, fixture.trigger.id, stageId);
  inputSchema(root, trigger, fixture.trigger.input);
  const expected = [...(held.stage.needs ?? [])].sort();
  if (canonicalJson(dependencyStages(root, loaded.manifest, fixture.dependencies)) !== canonicalJson(expected)) {
    throw new Error(`stage request fixture dependencies do not match stage ${stageId}`);
  }
  const candidateBytes = readFileSync(candidate);
  const parsedCandidate = parseIJson(candidateBytes, `stage candidate fixture ${candidate}`);
  const accepted = validateCandidate({
    candidate: parsedCandidate, bytes: candidateBytes.length,
    artifactsRoot: artifacts ?? dirname(candidate), held,
  });
  const digest = packageDigest(root);
  let instance = stageId;
  if (held.stage.foreach === undefined && fixture.shard !== undefined) throw new Error(`stage ${stageId} is not fan-out but fixture declares a shard`);
  if (held.stage.foreach !== undefined) {
    fields(fixture.shard, ['index', 'item'], ['index', 'item'], 'stage request fixture shard');
    if (!Number.isSafeInteger(fixture.shard.index) || fixture.shard.index < 0
      || fixture.shard.index >= held.stage.foreach.maxItems) throw new Error('stage request fixture shard index is invalid');
    const dependency = fixture.dependencies.find((item) => item.stage === held.stage.foreach.from);
    const items = pointerValue(
      dependency.instances[0].output, held.stage.foreach.pointer,
      `stage ${stageId} foreach pointer`,
    );
    if (!Array.isArray(items) || items.length > held.stage.foreach.maxItems
      || fixture.shard.index >= items.length
      || canonicalJson(items[fixture.shard.index]) !== canonicalJson(fixture.shard.item)) {
      throw new Error('stage request fixture shard does not match its foreach dependency');
    }
    const item = loadSchema(root, held.stage.foreach.itemSchema);
    const problems = validateSchemaWithReferences(
      item.schema, fixture.shard.item, 'shard item', item.path, item.resolveReference,
    );
    if (problems.length) throw new Error(`shard item failed its declared schema: ${problems.join('; ')}`);
    instance = `${stageId}[${fixture.shard.index}]`;
  }
  const stageRequest = {
    apiVersion: 'ksai.konghq.com/stage-request/v1alpha1',
    workflow: {
      name: loaded.manifest.metadata.name, version: loaded.manifest.metadata.version,
      digest, manifestDigest: loaded.digest,
    },
    job: {
      id: 'job_local-dry-run', subject: { type: trigger.subject },
      sourceRevision: '0'.repeat(40),
    },
    trigger: fixture.trigger,
    stage: { id: stageId, instance, attempt: 1, ...(fixture.shard === undefined ? {} : { shard: fixture.shard }) },
    dependencies: fixture.dependencies,
  };
  const capture = {
    apiVersion: CAPTURE_VERSION,
    request: stageRequest,
    accepted: { output: accepted.output, resultDigest: accepted.digest },
  };
  if (out) writeOutput(root, out, `${canonicalJson(capture)}\n`, 'dry-run capture');
  return capture;
}

function rejectedProbe(held, accepted) {
  const probes = [null, true, false, 0, 1, '', 'invalid', [], {}];
  for (const probe of probes) {
    if (canonicalJson(probe) === canonicalJson(accepted)) continue;
    const problems = validateSchemaWithReferences(
      held.schema, probe, 'output', held.schemaDocumentPath, held.schemaReference,
    );
    if (problems.length) return probe;
  }
  throw new Error(`stage ${held.stage.id} output schema accepts every conformance probe`);
}

/** Bound one local conformance probe by a finite timeout. */
export async function withTimeout(work, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`local conformance probe exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run package fixtures plus the fixed profile, timeout and trusted-stage checks. */
export async function conformancePackage(packageRoot, { fixtures }) {
  const root = rootOf(packageRoot);
  const loaded = loadManifest(root);
  const agents = loaded.manifest.spec.stages.filter((stage) => stage.kind === 'agent');
  if (agents.length === 0) throw new Error('conformance needs at least one agent stage');
  for (const stage of agents) {
    if (stage.timeoutMinutes === undefined) throw new Error(`stage ${stage.id} needs an explicit timeout for local conformance`);
  }
  const accepted = [];
  for (const stage of agents) {
    const request = join(fixtures, `${stage.id}.request.json`);
    const candidate = join(fixtures, `${stage.id}.candidate.json`);
    if (!existsSync(request) || !existsSync(candidate)) throw new Error(`stage ${stage.id} has no conformance fixtures`);
    const capture = dryRunPackage(root, {
      stage: stage.id, request, candidate,
      artifacts: join(fixtures, `${stage.id}.artifacts`),
    });
    const held = manifestStage(root, loaded.manifest, stage.id);
    rejectedProbe(held, capture.accepted.output);
    accepted.push({ stage: stage.id, resultDigest: capture.accepted.resultDigest });
  }
  let timeout = false;
  try {
    await withTimeout(() => new Promise(() => {}), 2);
  } catch (error) {
    if (!/exceeded 2ms/u.test(error.message)) throw error;
    timeout = true;
  }
  if (!timeout) throw new Error('local conformance timeout did not stop a blocked probe');
  const trusted = loaded.manifest.spec.stages.filter((stage) => stage.kind !== 'agent');
  for (const stage of trusted) {
    try {
      manifestStage(root, loaded.manifest, stage.id);
      throw new Error(`trusted stage ${stage.id} entered the agent runner`);
    } catch (error) {
      if (!/trusted-only/u.test(error.message)) throw error;
    }
  }
  return {
    apiVersion: CONFORMANCE_VERSION,
    workflow: {
      name: loaded.manifest.metadata.name, version: loaded.manifest.metadata.version,
      digest: packageDigest(root), manifestDigest: loaded.digest,
    },
    checks: [
      { name: 'manifest-and-graph', status: 'pass' },
      { name: 'fixed-profile-restrictions', status: 'pass', profiles: [...new Set(agents.map((stage) => stage.profile))].sort() },
      { name: 'output-validation', status: 'pass', accepted },
      {
        name: 'finite-timeout', status: 'pass',
        stages: agents.map((stage) => ({ id: stage.id, minutes: stage.timeoutMinutes })),
      },
      { name: 'trusted-publisher-separation', status: 'pass', stages: trusted.map((stage) => stage.id) },
    ],
  };
}

/** Write the canonical archive and a registry-neutral immutable build descriptor. */
export function buildPackage(packageRoot, { out, metadata, sourceRepository, sourceCommit }) {
  const root = rootOf(packageRoot);
  const archivePath = outputPath(root, out, 'build output');
  const metadataRequest = metadata ?? `${archivePath}.json`;
  const metadataPath = outputPath(root, metadataRequest, 'build metadata');
  if (metadataPath === archivePath) throw new Error('build archive and metadata paths must differ');
  const repositoryParts = typeof sourceRepository === 'string' ? sourceRepository.split('/') : [];
  if (!SOURCE_REPOSITORY.test(sourceRepository) || repositoryParts.some((part) => part === '.' || part === '..')) {
    throw new Error('source repository is not owner/name');
  }
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new Error('source commit is not a full lowercase commit SHA');
  const loaded = loadManifest(root);
  const archive = packageArchive(root);
  const descriptor = {
    apiVersion: BUILD_VERSION,
    workflow: loaded.manifest.metadata.name,
    version: loaded.manifest.metadata.version,
    digest: sha256(archive),
    manifestDigest: loaded.digest,
    source: { repository: sourceRepository, commit: sourceCommit },
    profiles: [...new Set(loaded.manifest.spec.stages
      .filter((stage) => stage.kind === 'agent').map((stage) => stage.profile))].sort(),
  };
  const archiveOutput = openOutput(root, archivePath, 'build output');
  let metadataOutput;
  try {
    metadataOutput = openOutput(root, metadataPath, 'build metadata');
    if (archiveOutput.held.dev === metadataOutput.held.dev
      && archiveOutput.held.ino === metadataOutput.held.ino) {
      throw new Error('build archive and metadata paths resolve to one file');
    }
    ftruncateSync(archiveOutput.descriptor, 0);
    writeFileSync(archiveOutput.descriptor, archive);
    ftruncateSync(metadataOutput.descriptor, 0);
    writeFileSync(metadataOutput.descriptor, `${canonicalJson(descriptor)}\n`);
  } finally {
    closeSync(archiveOutput.descriptor);
    if (metadataOutput !== undefined) closeSync(metadataOutput.descriptor);
  }
  return descriptor;
}
