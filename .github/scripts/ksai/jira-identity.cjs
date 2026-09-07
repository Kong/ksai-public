'use strict';

const { JIRA_ACCOUNT_SHAPE: ACCOUNT_SHAPE } = require('../lib/select-arm.cjs');
const { CLOUD_ID_SHAPE, jiraCall, mintToken } = require('./jira.cjs');
const { MAX_ACTOR_CHARS, readRelease } = require('./plan.cjs');

const EMAIL_SHAPE = /^[^\s<>@,;:\\"[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const SERVICE_DOMAIN = /@serviceaccount\.atlassian\.com$/i;

const UNPRINTABLE = /\p{C}/gu;

function actorName(value) {
  const flattened = String(value ?? '')
    .replace(UNPRINTABLE, ' ')
    .replace(/[<>()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flattened].slice(0, MAX_ACTOR_CHARS).join('').trim();
}

function accountFrom({ accountId = null, releaseRef = null } = {}) {
  const said = String(accountId ?? '').trim();
  if (ACCOUNT_SHAPE.test(said)) return said;
  const read = readRelease(String(releaseRef ?? '').trim());
  return read?.kind === 'jira' ? read.accountId : '';
}

function actorTrailers({ accountId = null, displayName = null, emailAddress = null, accountType = null } = {}) {
  const account = String(accountId ?? '').trim();
  const name = actorName(displayName);
  if (!ACCOUNT_SHAPE.test(account) || name === '') return { name: '', coAuthor: '', releasedBy: '' };

  const releasedBy = `${name} (jira:${account})`;
  const mail = String(emailAddress ?? '').trim();
  const person = String(accountType ?? '') !== 'app';
  const usable = person && EMAIL_SHAPE.test(mail) && !SERVICE_DOMAIN.test(mail);
  return { name, coAuthor: usable ? `${name} <${mail}>` : '', releasedBy };
}

async function fetchActor({
  cloudId = null,
  accountId = null,
  clientId = null,
  clientSecret = null,
  fetchImpl = fetch,
} = {}) {
  const account = String(accountId ?? '').trim();
  if (!ACCOUNT_SHAPE.test(account)) return { actor: null, error: '' };
  if (!CLOUD_ID_SHAPE.test(String(cloudId ?? ''))) {
    return { actor: null, error: '`jira_cloud_id` is not an Atlassian cloud id, so nobody is credited' };
  }

  const minted = await mintToken({ clientId, clientSecret, fetchImpl });
  if (!minted.token) return { actor: null, error: `could not authenticate to Atlassian: ${minted.error}` };

  const out = await jiraCall({
    cloudId,
    route: `user?accountId=${encodeURIComponent(account)}`,
    token: minted.token,
    fetchImpl,
  });
  if (out.unreachable) return { actor: null, error: `could not reach Jira: ${out.unreachable}` };
  if (out.status) return { actor: null, error: `Jira answered ${out.status} for the account that acted` };

  const said = out.payload && typeof out.payload === 'object' ? out.payload : {};
  return {
    actor: {
      accountId: account,
      displayName: 'displayName' in said ? String(said.displayName ?? '') : '',
      emailAddress: 'emailAddress' in said ? String(said.emailAddress ?? '') : '',
      accountType: 'accountType' in said ? String(said.accountType ?? '') : '',
    },
    error: '',
  };
}

module.exports = {
  actorName,
  accountFrom,
  actorTrailers,
  fetchActor,
};
