'use strict';

const APPROVAL_ID_SHAPE = /^[0-9a-f]{32}$/;

const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const LOGIN_SHAPE = /^[A-Za-z0-9-]{1,39}$/;

const REF_SHAPE = /^cp\/([0-9a-f]{32})\/([0-9a-f]{40})$/;

const MARKER_PREFIX = '<!-- ksai-plan:control-plane-approval:';

function controlPlaneApprovalRef({ approvalId = null, headSha = null } = {}) {
  const id = String(approvalId ?? '').trim();
  const head = String(headSha ?? '').trim().toLowerCase();
  if (!APPROVAL_ID_SHAPE.test(id) || !COMMIT_SHAPE.test(head)) return null;
  return `cp/${id}/${head}`;
}

function readControlPlaneApprovalRef(value) {
  const found = REF_SHAPE.exec(String(value ?? '').trim());
  return found ? { approvalId: found[1], commitId: found[2] } : null;
}

function controlPlaneApprovalMarker(value, login) {
  const ref = String(value ?? '').trim();
  const by = String(login ?? '').trim();
  if (readControlPlaneApprovalRef(ref) === null || !LOGIN_SHAPE.test(by)) return null;
  return `${MARKER_PREFIX}${ref} ${by} -->`;
}

function controlPlaneApprovalsIn(body) {
  const found = [];
  for (const line of String(body ?? '').split('\n')) {
    const held = line.trim();
    if (!held.startsWith(MARKER_PREFIX) || !held.endsWith(' -->')) continue;
    const parts = held.slice(MARKER_PREFIX.length, -4).trim().split(' ');
    if (parts.length !== 2) continue;
    const [approvalRef, login] = parts;
    if (readControlPlaneApprovalRef(approvalRef) === null || !LOGIN_SHAPE.test(login)) continue;
    found.push({ approvalRef, login });
  }
  return found;
}

module.exports = {
  controlPlaneApprovalRef,
  readControlPlaneApprovalRef,
  controlPlaneApprovalMarker,
  controlPlaneApprovalsIn,
};
