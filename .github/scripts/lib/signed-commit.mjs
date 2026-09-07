export const PLAIN_FILE = '100644';

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
