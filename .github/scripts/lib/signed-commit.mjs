export const PLAIN_FILE = '100644';

export const MAX_COMMIT_LINE = 100;

const HAS_URL = /\bhttps?:\/\/\S/;
const LIST_LEAD = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?/;

function pieces(word, room) {
  const out = [''];
  for (const char of word) {
    if (out.at(-1).length + char.length > room) out.push('');
    out[out.length - 1] += char;
  }
  return out;
}

export function wrapped(line) {
  if (line.length <= MAX_COMMIT_LINE || HAS_URL.test(line)) return [line];
  const lead = LIST_LEAD.exec(line)[0].slice(0, MAX_COMMIT_LINE / 2);
  const hang = ' '.repeat(lead.length);
  const room = MAX_COMMIT_LINE - lead.length;
  const out = [];
  let current = '';
  for (const [, gap, word] of line.slice(lead.length).trimStart().matchAll(/(\s*)(\S+)/g)) {
    let joint = gap;
    for (const piece of pieces(word, room)) {
      if (current && `${current}${joint}${piece}`.length > room) {
        out.push(current);
        current = piece;
      } else {
        current = `${current}${joint}${piece}`;
      }
      joint = '';
    }
  }
  out.push(current);
  return out.map((one, at) => `${at ? hang : lead}${one}`);
}

export function splitMessage(raw) {
  const lines = String(raw ?? '').replace(/\s+$/, '').split('\n');
  const headline = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return body ? { headline, body } : { headline };
}

export const CREATE_COMMIT = `
  mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit {
        oid
        tree { oid }
        signature { state }
      }
    }
  }
`;
