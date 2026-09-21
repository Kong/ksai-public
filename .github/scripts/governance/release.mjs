import { DIGEST, canonical, digest, sameDigest } from './artifacts.mjs';
import { signedWithDigest, statementOf } from './render.mjs';
import { TrustedRoot, Verifier, bundleFromJSON, toTrustMaterial } from './sigstore.mjs';

const LOCK_SUBJECT = /^ksai-cp-prompts-(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.lock\.json$/;
const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_PREFIX = 'static.runtime.opencode-tool-';
const REMINDER_ID = 'static.runtime.opencode-max-steps';

export function versionParts(version) {
  const parts = VERSION.exec(version);
  if (!parts) throw new Error(`${version} is not a release version`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

export function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function entriesOf(lock) {
  const parsed = JSON.parse(lock.toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.prompts)) {
    throw new Error('the catalog lock names no prompts');
  }
  return parsed.prompts.map((entry) => {
    if (typeof entry?.id !== 'string' || typeof entry.version !== 'string' ||
      !DIGEST.test(String(entry.source_digest)) || !DIGEST.test(String(entry.body_digest))) {
      throw new Error('the catalog lock holds a malformed entry');
    }
    return { id: entry.id, version: entry.version, source_digest: entry.source_digest, body_digest: entry.body_digest, dynamic: entry.dynamic === true };
  });
}

export function verifyRelease(attestation, lock, policy) {
  const bundle = bundleFromJSON(JSON.parse(attestation.toString('utf8')));
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(policy.trustedRoot)), {
    tlogThreshold: 0,
    ctlogThreshold: 0,
    timestampThreshold: 1,
  });
  verifier.verify(signedWithDigest(bundle), {
    subjectAlternativeName: `^${policy.signer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    extensions: { issuer: policy.issuer },
  });
  const statement = statementOf(bundle);
  const lockDigest = digest(lock);
  const named = (statement.subject ?? []).flatMap((subject) => {
    const version = LOCK_SUBJECT.exec(subject.name)?.[1];
    return version && sameDigest(`sha256:${subject.digest?.sha256}`, lockDigest) ? [version] : [];
  });
  if (named.length !== 1) throw new Error('the release attestation vouches for no lock with these bytes');
  const version = named[0];
  if (policy.minimum && compareVersions(version, policy.minimum) < 0) {
    throw new Error(`prompt release ${version} is older than the minimum ${policy.minimum} this runner admits`);
  }
  if (policy.revoked?.some((revoked) => revoked === version)) {
    throw new Error(`prompt release ${version} is revoked`);
  }
  return { version, lockDigest, entries: entriesOf(lock) };
}

export function rendered(release, receipt) {
  if (!sameDigest(receipt.catalog_digest, release.lockDigest)) {
    throw new Error('the render names a catalog other than the attested release');
  }
  const entry = release.entries.find((one) => one.id === receipt.prompt_id);
  if (!entry || entry.version !== receipt.prompt_version || !sameDigest(entry.source_digest, receipt.source_digest)) {
    throw new Error(`${receipt.prompt_id} ${receipt.prompt_version} is not in the attested release as the render names it`);
  }
  return entry;
}

export function governedTool(release, name, body) {
  if (!TOOL_NAME.test(name)) throw new Error(`${name} is not a tool name`);
  const entry = release.entries.find((one) => one.id === TOOL_PREFIX + name);
  if (!entry || entry.dynamic || !sameDigest(entry.body_digest, digest(body))) {
    throw new Error(`the ${name} tool is not the one the attested release governs`);
  }
  const parsed = JSON.parse(body.toString('utf8'));
  const lines = parsed?.description_lines;
  if (parsed?.name !== name || !Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    throw new Error(`the ${name} tool definition is malformed`);
  }
  return { name, description: lines.join('\n'), input_schema: parsed.input_schema, schema: canonical(parsed.input_schema) };
}

export function governedReminder(release, body) {
  const entry = release.entries.find((one) => one.id === REMINDER_ID);
  if (!entry || entry.dynamic || !sameDigest(entry.body_digest, digest(body))) {
    throw new Error("opencode's step-limit reminder is not the one the attested release governs");
  }
  const lines = JSON.parse(body.toString('utf8'))?.text_lines;
  if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line !== 'string')) {
    throw new Error("opencode's step-limit reminder is malformed");
  }
  return lines.join('\n');
}
