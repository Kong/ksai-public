const SHA = /^[a-f0-9]{40}$/;
const nonempty = (value, max = 2000) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

export function readHypotheses(raw, { headSha, baseSha }) {
  if (!raw) return null;
  if (Buffer.byteLength(raw) > 16_384) throw new Error('test_hypotheses exceeds 16 KiB');
  const packet = JSON.parse(raw);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.version !== 1) throw new Error('test_hypotheses needs version 1');
  if (Object.keys(packet).some((key) => !['version', 'head_sha', 'base_sha', 'candidates'].includes(key))) throw new Error('unknown test_hypotheses field');
  if (!SHA.test(packet.head_sha) || !SHA.test(packet.base_sha) || packet.head_sha !== headSha || packet.base_sha !== baseSha) throw new Error('test_hypotheses does not match the tested head and base');
  if (!Array.isArray(packet.candidates) || packet.candidates.length > 12) throw new Error('test_hypotheses needs at most 12 candidates');
  const ids = new Set();
  for (const candidate of packet.candidates) {
    if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).some((key) => !['id', 'hypothesis'].includes(key))) throw new Error('unknown hypothesis field');
    if (!nonempty(candidate.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(candidate.id) || !nonempty(candidate.hypothesis) || ids.has(candidate.id)) throw new Error('invalid or duplicate hypothesis');
    ids.add(candidate.id);
  }
  return packet;
}

export function hypothesesOf(ledger) {
  const candidates = ledger.candidates.filter((c) => nonempty(c.finding?.verification_hypothesis)).slice(0, 12).map((c) => ({ id: c.id, hypothesis: c.finding.verification_hypothesis }));
  const packet = { version: 1, head_sha: ledger.head_sha, base_sha: ledger.base_sha, candidates };
  try {
    return readHypotheses(JSON.stringify(packet), { headSha: ledger.head_sha, baseSha: ledger.base_sha });
  } catch {
    return null;
  }
}
