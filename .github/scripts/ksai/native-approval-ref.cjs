'use strict';

const { markerValues } = require('../lib/text.cjs');
const { POSITIVE_ID_SHAPE } = require('./plan.cjs');

const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

const REF_SHAPE = new RegExp(`^review/(${POSITIVE_ID_SHAPE.source.slice(1, -1)})/(${COMMIT_SHAPE.source.slice(1, -1)})$`);

const MARKER_PREFIX = '<!-- ksai-plan:native-review:';

function nativeApprovalRef({ id = null, commit_id: commitId = null } = {}) {
  const review = String(id ?? '').trim();
  const commit = String(commitId ?? '').trim().toLowerCase();
  if (!POSITIVE_ID_SHAPE.test(review) || !COMMIT_SHAPE.test(commit)) return null;
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
  return markerValues(body, MARKER_PREFIX, (value) => (readNativeApprovalRef(value) ? value : null)).at(-1) ?? null;
}

module.exports = {
  nativeApprovalRef,
  readNativeApprovalRef,
  nativeApprovalMarker,
  nativeApprovalOf,
};
