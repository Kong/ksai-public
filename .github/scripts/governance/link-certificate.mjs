import { createHash } from 'node:crypto';

import { publicKeyOf } from '../lib/link-protocol.mjs';
import { rendererFor } from './anchors.mjs';
import shipped from './trust.json' with { type: 'json' };
import { certificateTrust, keyTrust, verifyStatement } from './render.mjs';

export function linkTrust(endpoint, pinned = shipped) {
  if (typeof pinned.linkPredicate !== 'string' || pinned.linkPredicate === '') {
    throw new Error('this KSAI release pins no link certificate type, so no engine it links to can be verified');
  }
  const renderer = rendererFor(endpoint, pinned);
  const trust = renderer.renderKey ? keyTrust(renderer.renderKey) : certificateTrust(renderer.renderAuthority, renderer.renderSigner);
  return { trust, predicate: pinned.linkPredicate };
}

export const CERTIFICATE_SUBJECT = 'link-key';

const KEY_BYTES = 32;

export function verifyLinkCertificate(bundle, { trust, predicate }, expected, now = new Date()) {
  const statement = verifyStatement(Buffer.from(typeof bundle === 'string' ? bundle : JSON.stringify(bundle)), trust, predicate, now);
  const certificate = statement.predicate ?? {};
  const raw = Buffer.from(String(certificate.key ?? ''), 'base64');
  if (raw.length !== KEY_BYTES) throw new Error('the link certificate names no ed25519 key');
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const digest = createHash('sha256').update(raw).digest('hex');
  if (subjects.length !== 1 || subjects[0]?.name !== CERTIFICATE_SUBJECT || subjects[0]?.digest?.sha256 !== digest) {
    throw new Error('the link certificate was signed for another key');
  }
  const named = {
    repository: String(expected.repository).toLowerCase(), run_id: Number(expected.runId), run_attempt: Number(expected.attempt), job: expected.job, link: expected.link,
  };
  for (const [field, value] of Object.entries(named)) {
    if (certificate[field] !== value) throw new Error(`the link certificate names ${field} ${JSON.stringify(certificate[field])}, and this run's is ${JSON.stringify(value)}`);
  }
  const notAfter = new Date(certificate.not_after);
  if (!(notAfter.getTime() > now.getTime())) throw new Error(`the link certificate expired at ${certificate.not_after}`);
  return { key: publicKeyOf(raw), raw, notAfter };
}
