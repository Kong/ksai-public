'use strict';

const { createHash } = require('node:crypto');

const { CLOUD_ID_SHAPE, LABEL_SHAPE, mintToken, jiraCall } = require('./jira.cjs');
const { safeEcho, JIRA_KEY_SHAPE, JIRA_ACCOUNT_SHAPE: ACCOUNT_SHAPE } = require('../lib/select-arm.cjs');


const GROUP_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

const CREATED_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:?[0-9]{2})$/;


const MAX_HISTORIES = 200;

function approverOf(payload, { label = null } = {}) {
  const wanted = String(label ?? '');
  const labels = Array.isArray(payload?.fields?.labels) ? payload.fields.labels.map(String) : [];
  if (!labels.includes(wanted)) return { none: true };

  const histories = Array.isArray(payload?.changelog?.histories) ? payload.changelog.histories : [];
  const recent = histories.slice(Math.max(0, histories.length - MAX_HISTORIES));
  let found = null;
  for (const history of recent) {
    const items = Array.isArray(history?.items) ? history.items : [];
    const added = items.some((item) => {
      if (String(item?.field ?? '') !== 'labels') return false;
      const to = ownText(item, 'toString').split(/\s+/);
      const from = ownText(item, 'fromString').split(/\s+/);
      return to.includes(wanted) && !from.includes(wanted);
    });
    if (!added) continue;
    const accountId = String(history?.author?.accountId ?? '');
    if (!ACCOUNT_SHAPE.test(accountId)) continue;
    const at = String(history?.created ?? '');
    if (!CREATED_SHAPE.test(at)) continue;
    found = { accountId, at };
  }

  if (!found) {
    return {
      error:
        `the \`${safeEcho(wanted)}\` label is on the ticket but no change record says who added it, so there is ` +
        'nobody to authorize. Remove the label and add it again.',
    };
  }
  return found;
}

function ownText(source, key) {
  if (source === null || typeof source !== 'object') return '';
  return Object.hasOwn(source, key) ? String(source[key] ?? '') : '';
}

async function fetchApprovalIssue({ cloudId = null, key = null, clientId = null, clientSecret = null, fetchImpl = fetch } = {}) {
  if (!CLOUD_ID_SHAPE.test(String(cloudId ?? ''))) {
    return { error: `\`jira_cloud_id\` is not an Atlassian cloud id: ${safeEcho(cloudId)}` };
  }
  if (!JIRA_KEY_SHAPE.test(String(key ?? '').toUpperCase())) {
    return { error: `\`${safeEcho(key)}\` is not a Jira issue key` };
  }
  const minted = await mintToken({ clientId, clientSecret, fetchImpl });
  if (minted.error) return { error: minted.error };

  const base = `issue/${encodeURIComponent(key)}`;
  const get = async (route, what) => {
    const out = await jiraCall({ cloudId, route, token: minted.token, fetchImpl });
    if (out.unreachable) return { error: `could not reach Jira to read ${what} on \`${safeEcho(key)}\`: ${out.unreachable}` };
    if (out.status) return { error: `Jira answered ${out.status} reading ${what} on \`${safeEcho(key)}\`` };
    if (out.unreadable) return { error: `Jira answered ${what} on \`${safeEcho(key)}\` with something that is not JSON` };
    return { payload: /** @type {Record<string, unknown>} */ (out.payload) };
  };

  const fields = await get(`${base}?fields=labels`, 'the approval label');
  if (fields.error) return { error: fields.error };

  const head = await get(`${base}/changelog?startAt=0&maxResults=1`, 'the change history');
  if (head.error) return { error: head.error };
  const total = Number(head.payload?.total);
  const count = Number.isInteger(total) && total > 0 ? total : 0;
  const startAt = Math.max(0, count - MAX_HISTORIES);
  const tail =
    count === 0
      ? { payload: { values: [] } }
      : await get(`${base}/changelog?startAt=${startAt}&maxResults=${MAX_HISTORIES}`, 'the change history');
  if (tail.error) return { error: tail.error };

  const values = Array.isArray(tail.payload?.values) ? tail.payload.values : [];
  return { payload: { ...fields.payload, changelog: { histories: values } }, token: minted.token };
}

async function inGroup({ cloudId = null, accountId = null, group = null, token = null, fetchImpl = fetch } = {}) {
  const wanted = String(group ?? '');
  const out = await jiraCall({
    cloudId,
    route: `user/groups?accountId=${encodeURIComponent(accountId)}`,
    token,
    fetchImpl,
  });
  if (out.unreachable) return { error: `could not reach Jira to read group membership: ${out.unreachable}` };
  if (out.status === 401 || out.status === 403) {
    return {
      error:
        'the Jira service account may not read group membership, so it cannot tell who approved. Grant it the ' +
        '`Browse users and groups` global permission and the `read:jira-user` scope.',
    };
  }
  if (out.status) return { error: `Jira answered ${out.status} reading group membership` };
  if (out.unreadable) return { error: 'Jira answered the group membership read with something that is not JSON' };
  const groups = Array.isArray(out.payload) ? out.payload : [];
  return { member: groups.some((one) => String(one?.name ?? '') === wanted) };
}

async function resolveJiraApproval({ cloudId = null, key = null, label = null, group = null, clientId = null, clientSecret = null, fetchImpl = fetch } = {}) {
  const wantedGroup = String(group ?? '').trim();
  if (wantedGroup === '') return { none: true };
  if (!GROUP_SHAPE.test(wantedGroup)) {
    return { error: `\`jira_approver_group\` is not a Jira group name: ${safeEcho(wantedGroup)}` };
  }
  const wantedLabel = String(label ?? '').trim();
  if (!LABEL_SHAPE.test(wantedLabel)) {
    return { error: `\`jira_approve_label\` is not a Jira label: ${safeEcho(wantedLabel)}` };
  }

  const read = await fetchApprovalIssue({ cloudId, key, clientId, clientSecret, fetchImpl });
  if (read.error) return { error: read.error };

  const approver = approverOf(read.payload, { label: wantedLabel });
  if (approver.none) return { none: true };
  if (approver.error) return { error: approver.error };

  const membership = await inGroup({
    cloudId,
    accountId: approver.accountId,
    group: wantedGroup,
    token: read.token,
    fetchImpl,
  });
  if (membership.error) return { error: membership.error };
  if (membership.member !== true) {
    return {
      refused:
        `the \`${safeEcho(wantedLabel)}\` label was added by somebody who is not in the \`${safeEcho(wantedGroup)}\` ` +
        'Jira group, so it does not release this plan. Ask a member of that group to remove the label and add it again.',
    };
  }
  return { accountId: approver.accountId, at: approver.at ?? '' };
}

function phaseToken({ accountId = null, at = null } = {}) {
  const who = String(accountId ?? '');
  const when = String(at ?? '');
  if (!ACCOUNT_SHAPE.test(who) || !CREATED_SHAPE.test(when)) return '';
  return `jira/${who}/${createHash('sha256').update(when).digest('hex').slice(0, 12)}`;
}

module.exports = {
  phaseToken,
  MAX_HISTORIES,
  approverOf,
  fetchApprovalIssue,
  inGroup,
  resolveJiraApproval,
};
