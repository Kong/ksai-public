'use strict';

const REVIEW_ID_SHAPE = /^[1-9][0-9]{0,18}$/;

const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const REF_SHAPE = new RegExp(`^review/(${REVIEW_ID_SHAPE.source.slice(1, -1)})/(${COMMIT_SHAPE.source.slice(1, -1)})$`);

const MARKER_PREFIX = '<!-- ksai-plan:native-review:';

function nativeApprovalRef({ id = null, commit_id: commitId = null } = {}) {
  const review = String(id ?? '').trim();
  const commit = String(commitId ?? '').trim().toLowerCase();
  if (!REVIEW_ID_SHAPE.test(review) || !COMMIT_SHAPE.test(commit)) return null;
  return `review/${review}/${commit}`;
}

function readNativeApprovalRef(value) {
  const found = REF_SHAPE.exec(String(value ?? '').trim());
  return found ? { reviewId: found[1], commitId: found[2] } : null;
}

function nativeApprovalMarker(value) {
  const ref = String(value ?? '').trim();
  return readNativeApprovalRef(ref) ? `${MARKER_PREFIX}${ref} -->` : null;
}

function nativeApprovalOf(body) {
  let found = null;
  for (const line of String(body ?? '').split('\n')) {
    const value = line.trim().startsWith(MARKER_PREFIX) && line.trim().endsWith(' -->')
      ? line.trim().slice(MARKER_PREFIX.length, -4).trim()
      : '';
    if (readNativeApprovalRef(value)) found = value;
  }
  return found;
}

module.exports = {
  COMMIT_SHAPE,
  MARKER_PREFIX,
  nativeApprovalRef,
  readNativeApprovalRef,
  nativeApprovalMarker,
  nativeApprovalOf,
};
