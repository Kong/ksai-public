'use strict';

const { LOGIN_SHAPE } = require('./plan.cjs');
const { nativeApprovalRef, readNativeApprovalRef } = require('./native-approval-ref.cjs');

const DECIDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function latestNativeApprovals(reviews = []) {
  const latest = new Map();
  for (const review of reviews) {
    const state = String(review?.state ?? '').trim().toUpperCase();
    const login = String(review?.user?.login ?? '').trim();
    if (!DECIDING.has(state) || !LOGIN_SHAPE.test(login) || review?.user?.type === 'Bot') continue;
    const approvalRef = nativeApprovalRef(review);
    const candidate = {
      state,
      login,
      url: String(review?.html_url ?? ''),
      body: String(review?.body ?? ''),
      id: review.id,
      forced: false,
      association: String(review?.author_association ?? ''),
      commitId: readNativeApprovalRef(approvalRef)?.commitId ?? '',
      approvalRef: approvalRef ?? '',
      at: Date.parse(String(review?.submitted_at ?? '')) || 0,
    };
    const held = latest.get(login);
    if (!held || candidate.at > held.at || (candidate.at === held.at && Number(candidate.id) > Number(held.id))) {
      latest.set(login, candidate);
    }
  }
  return [...latest.values()].filter((candidate) => candidate.state === 'APPROVED' && candidate.approvalRef !== '');
}

module.exports = { latestNativeApprovals };
