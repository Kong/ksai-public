import { X509Certificate, createHash, createPublicKey, verify } from 'node:crypto';

import { DIGEST, digest, record, sameDigest } from './artifacts.mjs';
import { bundleFromJSON, toSignedEntity } from './sigstore.mjs';

const RENDER_SUBJECT = 'prompt.md';
const IN_TOTO = 'application/vnd.in-toto+json';
const BUNDLE_MEDIA = 'application/vnd.dev.sigstore.bundle.v0.3+json';
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const CHAIN_DEPTH = 8;

export function keyTrust(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('the render key is not an ECDSA P-256 public key');
  }
  const hint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64');
  return { kind: 'key', key, hint };
}

export function certificateTrust(pem, name) {
  const authorities = (pem.match(CERTIFICATE_BLOCK) ?? []).map((block) => new X509Certificate(block));
  if (!authorities.length) throw new Error('the render authority holds no PEM certificate');
  if (authorities.some((authority) => !authority.ca)) throw new Error('the render authority names a certificate that is not a CA');
  if (!name) throw new Error('a render authority is trusted only for one named signer');
  return { kind: 'certificate', authorities, name };
}

function text(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is missing`);
  return value;
}

function current(certificate, now) {
  return new Date(certificate.validFrom) <= now && now <= new Date(certificate.validTo);
}

function issuerOf(child, authorities) {
  return authorities.find((one) => child.checkIssued(one) && child.verify(one.publicKey));
}

function chained(leaf, authorities, now) {
  let child = leaf;
  for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
    const issuer = issuerOf(child, authorities);
    if (!issuer || !current(issuer, now)) break;
    if (issuer.checkIssued(issuer) && issuer.verify(issuer.publicKey)) return;
    child = issuer;
  }
  throw new Error('the render certificate does not chain to the render authority');
}

function named(leaf, name) {
  return (leaf.subjectAltName ?? '').split(', ').some((entry) => entry === `URI:${name}` || entry === `DNS:${name}`);
}

function signerKey(material, trust, now) {
  if (trust.kind === 'key') {
    if (material.$case !== 'publicKey' || material.publicKey.hint !== trust.hint) {
      throw new Error('the render names a key other than the one trusted to sign renders');
    }
    return trust.key;
  }
  if (material.$case !== 'certificate') throw new Error('the render carries no certificate');
  const leaf = new X509Certificate(material.certificate.rawBytes);
  if (!current(leaf, now)) throw new Error('the render certificate is not valid now');
  chained(leaf, trust.authorities, now);
  if (!named(leaf, trust.name)) throw new Error(`the render certificate is not issued to ${trust.name}`);
  return leaf.publicKey;
}

function digestFor(key) {
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve === 'secp384r1' ? 'sha384' : curve === 'secp521r1' ? 'sha512' : 'sha256';
}

export function signedWithDigest(bundle) {
  const entity = toSignedEntity(bundle);
  const content = entity.signature;
  return {
    ...entity,
    signature: {
      signature: content.signature,
      compareSignature: (signature) => content.compareSignature(signature),
      compareDigest: (value) => content.compareDigest(value),
      compareSignedDigest: (value) => content.compareSignedDigest(value),
      verifySignature: (key) => verify(digestFor(key), content.preAuthEncoding, key, content.signature),
    },
  };
}

export function statementOf(bundle) {
  if (bundle.mediaType !== BUNDLE_MEDIA || bundle.content.$case !== 'dsseEnvelope') {
    throw new Error('the signed statement is not a v0.3 Sigstore bundle carrying one envelope');
  }
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== IN_TOTO || envelope.signatures.length !== 1) {
    throw new Error('the envelope does not carry one signed in-toto statement');
  }
  return record(JSON.parse(envelope.payload.toString('utf8')), 'the statement');
}

function receiptOf(predicate) {
  const receipt = record(predicate, 'the render receipt');
  for (const field of ['sink', 'prompt_id', 'prompt_version', 'contract_version', 'renderer_version']) {
    text(receipt[field], `the receipt's ${field}`);
  }
  for (const field of ['source_digest', 'catalog_digest', 'final_digest']) {
    if (!DIGEST.test(text(receipt[field], `the receipt's ${field}`))) throw new Error(`the receipt's ${field} is not a digest`);
  }
  if (!Number.isSafeInteger(receipt.final_bytes)) throw new Error("the receipt's final_bytes is not a count");
  record(receipt.run, "the receipt's run");
  if (receipt.model !== undefined) text(receipt.model, "the receipt's model");
  return receipt;
}

export function verifyRender(bundleJSON, prompt, trust, predicateType, now = new Date()) {
  const bundle = bundleFromJSON(JSON.parse(bundleJSON.toString('utf8')));
  const statement = statementOf(bundle);
  const key = signerKey(bundle.verificationMaterial.content, trust, now);
  if (!signedWithDigest(bundle).signature.verifySignature(key)) throw new Error('the render signature does not verify');
  if (statement.predicateType !== predicateType) throw new Error('the render statement is not a render receipt');
  const promptDigest = digest(prompt);
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (subjects.length !== 1 || subjects[0]?.name !== RENDER_SUBJECT || !sameDigest(`sha256:${subjects[0]?.digest?.sha256}`, promptDigest)) {
    throw new Error('the render was signed for other prompt bytes');
  }
  const receipt = receiptOf(statement.predicate);
  if (!sameDigest(receipt.final_digest, promptDigest) || receipt.final_bytes !== prompt.length) {
    throw new Error('the receipt describes other prompt bytes');
  }
  return receipt;
}
