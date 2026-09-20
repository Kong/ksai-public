import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { canonicalJson, parseIJson } from '../../lib/json.cjs';
import {
  loadManifest, manifestStage, packageDigest, packageFile, sha256, validDigest, validVersion, validWorkflowId,
} from './manifest.mjs';
import { validateSchemaWithReferences } from '../../lib/json-schema.cjs';

const RECORD_VERSION = 'ksai.konghq.com/stage-record/v1alpha1';
const CANDIDATE_VERSION = 'ksai.konghq.com/stage-candidate/v1alpha1';
const JOB = /^job_[A-Za-z0-9._-]{1,120}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/;
const MAX_CANDIDATE_BYTES = 1024 * 1024;

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed, required, where) => {
  if (!object(value)) throw new Error(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where} has unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${where} is missing ${key}`);
};

function recordOf(value) {
  fields(value, ['apiVersion', 'workflow', 'job', 'stage'], ['apiVersion', 'workflow', 'job', 'stage'], 'stage record');
  if (value.apiVersion !== RECORD_VERSION) throw new Error('stage record version is unsupported');
  fields(value.workflow, ['name', 'version', 'digest', 'manifestDigest'], ['name', 'version', 'digest', 'manifestDigest'], 'stage record workflow');
  if (!validWorkflowId(value.workflow.name) || !validVersion(value.workflow.version) || !validDigest(value.workflow.digest) || !validDigest(value.workflow.manifestDigest)) {
    throw new Error('stage record workflow identity is invalid');
  }
  fields(value.job, ['id', 'subject', 'sourceRevision'], ['id', 'subject', 'sourceRevision'], 'stage record job');
  if (!JOB.test(value.job.id)) throw new Error('stage record job ID is invalid');
  fields(value.job.subject, ['type', 'repository', 'number', 'headSha'], ['type', 'repository', 'number', 'headSha'], 'stage record subject');
  const repository = typeof value.job.subject.repository === 'string' ? value.job.subject.repository.split('/') : [];
  if (value.job.subject.type !== 'pull-request' || repository.length !== 2 || !repository.every((part) => REPOSITORY_PART.test(part) && part !== '.' && part !== '..')
    || !Number.isSafeInteger(value.job.subject.number) || value.job.subject.number < 1 || !SHA.test(value.job.subject.headSha)) {
    throw new Error('stage record subject is invalid');
  }
  if (value.job.sourceRevision !== value.job.subject.headSha) throw new Error('stage record source revision does not match its subject');
  fields(value.stage, ['id', 'attempt'], ['id', 'attempt'], 'stage record stage');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.stage.id)
    || !Number.isSafeInteger(value.stage.attempt) || value.stage.attempt < 1) throw new Error('stage record stage or attempt is invalid');
  return value;
}

function under(root, relative, where) {
  if (typeof relative !== 'string' || relative === '' || relative.startsWith('/') || relative.includes('..') || relative.includes('\\')) {
    throw new Error(`${where} is not a registry-relative path`);
  }
  const path = resolve(root, relative);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${where} escapes the registry`);
  return path;
}

function registryEntry(registryRoot, identity) {
  const registry = parseIJson(readFileSync(join(registryRoot, 'registry.json')), 'workflow registry');
  fields(registry, ['apiVersion', 'packages'], ['apiVersion', 'packages'], 'workflow registry');
  if (registry.apiVersion !== 'ksai.konghq.com/package-registry/v1alpha1' || !Array.isArray(registry.packages)) {
    throw new Error('workflow registry version or packages are invalid');
  }
  const entries = registry.packages.filter((entry) => entry?.workflow === identity.name && entry?.version === identity.version);
  if (entries.length !== 1) throw new Error('workflow package is not uniquely admitted');
  const entry = entries[0];
  fields(entry, ['workflow', 'version', 'digest', 'manifestDigest', 'state', 'path'], ['workflow', 'version', 'digest', 'manifestDigest', 'state', 'path'], 'workflow registry entry');
  if (entry.state !== 'active') throw new Error(`workflow package is ${entry.state || 'not active'}`);
  for (const key of ['digest', 'manifestDigest']) if (entry[key] !== identity[key]) throw new Error(`stage record ${key} is not the admitted value`);
  const root = under(registryRoot, entry.path, 'workflow package path');
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('workflow package root is not a real directory');
  return { entry, root };
}

function verifiedStage(record, registryRoot) {
  const admitted = registryEntry(realpathSync(registryRoot), record.workflow);
  if (packageDigest(admitted.root) !== admitted.entry.digest) throw new Error('workflow package digest does not match the registry');
  const loaded = loadManifest(admitted.root);
  if (loaded.digest !== admitted.entry.manifestDigest) throw new Error('workflow manifest digest does not match the registry');
  if (loaded.manifest.metadata.name !== record.workflow.name || loaded.manifest.metadata.version !== record.workflow.version) {
    throw new Error('workflow manifest identity does not match the stage record');
  }
  return { ...admitted, ...loaded, ...manifestStage(admitted.root, loaded.manifest, record.stage.id) };
}

function freshDirectory(path) {
  if (existsSync(path)) throw new Error(`workflow runtime path already exists: ${path}`);
  mkdirSync(path, { recursive: false });
}

/** Verify an admitted stage and create its isolated runtime ABI. */
export function prepareStage({ record: raw, registryRoot, runtimeRoot }) {
  const record = recordOf(raw);
  const held = verifiedStage(record, registryRoot);
  if (existsSync(runtimeRoot)) throw new Error('workflow runtime already exists');
  mkdirSync(runtimeRoot, { recursive: true });
  const requestDirectory = join(runtimeRoot, 'request');
  const resultDirectory = join(runtimeRoot, 'result');
  const artifacts = join(runtimeRoot, 'artifacts');
  const inputs = join(runtimeRoot, 'inputs');
  for (const path of [requestDirectory, resultDirectory, artifacts, inputs]) freshDirectory(path);
  const request = join(requestDirectory, 'stage-request.json');
  const result = join(resultDirectory, 'candidate.json');
  const descriptor = join(runtimeRoot, 'descriptor.json');
  writeFileSync(request, `${canonicalJson({
    apiVersion: 'ksai.konghq.com/stage-request/v1alpha1',
    workflow: record.workflow,
    job: record.job,
    stage: record.stage,
    dependencies: [],
  })}\n`, { mode: 0o444, flag: 'wx' });
  chmodSync(requestDirectory, 0o555);
  chmodSync(inputs, 0o555);
  writeFileSync(descriptor, `${canonicalJson({ record, registryRoot: realpathSync(registryRoot), runtimeRoot: realpathSync(runtimeRoot) })}\n`, { mode: 0o600, flag: 'wx' });
  return {
    package: held.root, request, result, resultDirectory, artifacts, inputs,
    entrypoint: held.entrypoint, profile: held.stage.profile, descriptor,
  };
}

function regular(path, where) {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    throw new Error(`${where} is missing`);
  }
  if (!held.isFile() || held.isSymbolicLink() || held.nlink !== 1) throw new Error(`${where} is not one regular file`);
  return held;
}

/** Validate one parsed candidate with the same checks used by trusted acceptance. */
export function validateCandidate({ candidate, bytes, artifactsRoot, held }) {
  const limit = Math.min(MAX_CANDIDATE_BYTES, held.manifest.spec.limits?.bytes?.candidateResult ?? MAX_CANDIDATE_BYTES);
  if (bytes > limit) throw new Error(`stage candidate exceeds ${limit} bytes`);
  fields(candidate, ['apiVersion', 'output', 'artifacts'], ['apiVersion', 'output', 'artifacts'], 'stage candidate');
  if (candidate.apiVersion !== CANDIDATE_VERSION || !Array.isArray(candidate.artifacts)) throw new Error('stage candidate version or artifacts are invalid');
  const declarations = new Map((held.stage.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const seen = new Set();
  for (const artifact of candidate.artifacts) {
    fields(artifact, ['id', 'path'], ['id', 'path'], 'stage candidate artifact');
    if (!declarations.has(artifact.id) || artifact.path !== artifact.id || seen.has(artifact.id)) throw new Error('stage candidate artifact is undeclared or duplicated');
    seen.add(artifact.id);
    packageFile(artifactsRoot, artifact.path, `stage artifact ${artifact.id}`);
  }
  const problems = validateSchemaWithReferences(
    held.schema, candidate.output, 'output', held.schemaDocumentPath, held.schemaReference,
  );
  if (problems.length) throw new Error(`stage output failed its declared schema: ${problems.join('; ')}`);
  return { output: candidate.output, digest: sha256(Buffer.from(canonicalJson(candidate.output))) };
}

/** Validate a candidate against its pinned manifest before returning trusted output. */
export function acceptStage({ descriptor: descriptorPath }) {
  regular(descriptorPath, 'workflow descriptor');
  const descriptor = parseIJson(readFileSync(descriptorPath), 'workflow descriptor');
  fields(descriptor, ['record', 'registryRoot', 'runtimeRoot'], ['record', 'registryRoot', 'runtimeRoot'], 'workflow descriptor');
  const record = recordOf(descriptor.record);
  const held = verifiedStage(record, descriptor.registryRoot);
  const candidatePath = join(descriptor.runtimeRoot, 'result', 'candidate.json');
  const stat = regular(candidatePath, 'stage candidate');
  const limit = Math.min(MAX_CANDIDATE_BYTES, held.manifest.spec.limits?.bytes?.candidateResult ?? MAX_CANDIDATE_BYTES);
  if (stat.size > limit) throw new Error(`stage candidate exceeds ${limit} bytes`);
  const candidate = parseIJson(readFileSync(candidatePath), 'stage candidate');
  const acceptedCandidate = validateCandidate({
    candidate, bytes: stat.size, artifactsRoot: join(descriptor.runtimeRoot, 'artifacts'), held,
  });
  const accepted = join(descriptor.runtimeRoot, 'accepted-output.json');
  writeFileSync(accepted, `${canonicalJson(acceptedCandidate.output)}\n`, { mode: 0o600, flag: 'wx' });
  return { output: accepted, digest: acceptedCandidate.digest };
}

/** Construct the pinned compatibility record for the existing pull request tester. */
export function builtInTestRecord(env, registryRoot) {
  const registry = parseIJson(readFileSync(join(registryRoot, 'registry.json')), 'workflow registry');
  const entry = registry.packages?.find((held) => held.workflow === 'adversarial-pull-request-test' && held.version === '1.0.0');
  if (!entry) throw new Error('built-in adversarial test package is not admitted');
  const number = Number(env.THREAD_NUM);
  const headSha = String(env.WORKFLOW_HEAD ?? '').toLowerCase();
  return {
    apiVersion: RECORD_VERSION,
    workflow: { name: entry.workflow, version: entry.version, digest: entry.digest, manifestDigest: entry.manifestDigest },
    job: {
      id: `job_${env.WORKFLOW_JOB}`,
      subject: { type: 'pull-request', repository: env.WORKFLOW_REPOSITORY, number, headSha },
      sourceRevision: headSha,
    },
    stage: { id: 'test', attempt: Number(env.WORKFLOW_ATTEMPT) },
  };
}
