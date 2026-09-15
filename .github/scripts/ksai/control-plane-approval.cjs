'use strict';

const { markerValues } = require('../lib/text.cjs');

const APPROVAL_ID_SHAPE = /^[0-9a-f]{32}$/;

const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const LOGIN_SHAPE = /^[A-Za-z0-9-]{1,39}$/;

const REF_SHAPE = new RegExp(`^cp/(${APPROVAL_ID_SHAPE.source.slice(1, -1)})/(${COMMIT_SHAPE.source.slice(1, -1)})$`);

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
  return markerValues(body, MARKER_PREFIX, (value) => {
    const parts = value.split(' ');
    if (parts.length !== 2) return null;
    const [approvalRef, login] = parts;
    return readControlPlaneApprovalRef(approvalRef) === null || !LOGIN_SHAPE.test(login) ? null : { approvalRef, login };
  });
}

module.exports = {
  controlPlaneApprovalRef,
  readControlPlaneApprovalRef,
  controlPlaneApprovalMarker,
  controlPlaneApprovalsIn,
};
