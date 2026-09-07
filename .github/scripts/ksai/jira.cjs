'use strict';

const { safeEcho, JIRA_KEY_SHAPE } = require('../lib/select-arm.cjs');

const AUTH_URL = 'https://auth.atlassian.com/oauth/token';
const API_HOST = 'https://api.atlassian.com';

const API_VERSION = '2';

const CLOUD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SITE_SHAPE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}$/;

const PROJECT_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/;

const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

const MAX_COMMENTS = 30;

const API_LANGUAGE = 'en-US';

function jiraHeaders({ token = null, json = false } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': API_LANGUAGE };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function parseProjects(raw) {
  const seen = new Set();
  for (const word of String(raw ?? '').split(/[\s,]+/)) {
    if (word) seen.add(word.toUpperCase());
  }
  return Object.freeze([...seen]);
}

function resolveKey({ planKey = null, criteriaMarker = null, projects = null } = {}) {
  const fromMarker = criteriaMarker?.kind === 'jira' ? criteriaMarker.key : '';
  const key = String(fromMarker || planKey || '').toUpperCase();
  if (!key) return { none: true };

  if (!JIRA_KEY_SHAPE.test(key)) {
    return { error: `\`${safeEcho(key)}\` is not a Jira issue key, so there is no project to check it against` };
  }
  const project = key.slice(0, key.indexOf('-'));

  const allowed = Object.freeze([...(projects ?? [])]);
  if (!allowed.length) {
    return {
      error:
        'no Jira projects are allowed in this repository, so no ticket can be read. Set `jira_projects` in ' +
        'the workflow that calls this action to the project keys this repository may plan from.',
    };
  }
  const unusable = allowed.filter((one) => !PROJECT_SHAPE.test(String(one)));
  if (unusable.length) {
    return {
      error:
        `\`jira_projects\` names ${unusable.map((one) => `\`${safeEcho(one)}\``).join(', ')}, which is not a Jira ` +
        'project key. Fix the list rather than leaving it to refuse tickets that should have been allowed.',
    };
  }
  if (!allowed.includes(project)) {
    return {
      error: `the Jira project \`${safeEcho(project)}\` is not one this repository may read. Allowed: ${allowed.join(', ')}.`,
    };
  }
  return { key };
}

async function jiraCall({
  cloudId = null,
  route = null,
  token = null,
  method = 'GET',
  body = null,
  fetchImpl = fetch,
} = {}) {
  const call = fetchImpl ?? fetch;
  let response;
  try {
    response = await call(`${API_HOST}/ex/jira/${cloudId}/rest/api/${API_VERSION}/${route}`, {
      method,
      headers: jiraHeaders({ token, json: body !== null }),
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { unreachable: safeEcho(error?.message) };
  }
  if (!response.ok) return { status: response.status };
  if (response.status === 204) return { payload: null };
  try {
    return { payload: await response.json() };
  } catch {
    return { unreadable: true };
  }
}

function resolveKeyFrom(env) {
  return resolveKey({
    planKey: env.PLAN_KEY,
    criteriaMarker: env.STEP_KEY ? { kind: 'jira', key: env.STEP_KEY } : null,
    projects: parseProjects(env.JIRA_PROJECTS),
  });
}

function normalizeIssue(payload, { maxComments = MAX_COMMENTS } = {}) {
  const limit = Number.isInteger(maxComments) && maxComments >= 0 ? maxComments : MAX_COMMENTS;
  const fields = payload?.fields ?? {};
  const all = Array.isArray(fields.comment?.comments) ? fields.comment.comments : [];
  const kept = all.slice(Math.max(0, all.length - limit));
  const category = String(fields.status?.statusCategory?.key ?? '');

  return {
    key: String(payload?.key ?? ''),
    title: String(fields.summary ?? ''),
    body: String(fields.description ?? ''),
    state: category === 'done' ? 'CLOSED' : category ? 'OPEN' : 'UNKNOWN',
    status: String(fields.status?.name ?? ''),
    type: String(fields.issuetype?.name ?? ''),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    assignees: fields.assignee?.displayName ? [String(fields.assignee.displayName)] : [],
    comments: kept.map((comment) => ({
      author: String(comment?.author?.displayName ?? ''),
      created: String(comment?.created ?? ''),
      body: String(comment?.body ?? ''),
    })),
    commentsElided: all.length - kept.length,
  };
}

async function mintToken({ clientId = null, clientSecret = null, fetchImpl = fetch } = {}) {
  const call = fetchImpl ?? fetch;
  let response;
  try {
    response = await call(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
  } catch (error) {
    return { error: `could not reach Atlassian to authenticate: ${safeEcho(error?.message)}` };
  }
  if (!response.ok) {
    return {
      error:
        `Atlassian refused the Jira credential with ${response.status}. Check \`jira_client_id\` and ` +
        '`jira_client_secret` against the service account this repository is configured with.',
    };
  }
  let payload;
  try {
    payload = /** @type {{access_token?: string}} */ (await response.json());
  } catch {
    return { error: 'Atlassian answered the token request with something that is not JSON' };
  }
  const token = String(payload?.access_token ?? '');
  if (!token) return { error: 'Atlassian answered the token request with no access token' };
  return { token };
}

async function fetchIssue({ cloudId = null, key = null, clientId = null, clientSecret = null, fetchImpl = fetch, maxComments = null } = {}) {
  if (!CLOUD_ID_SHAPE.test(String(cloudId ?? ''))) {
    return { error: `\`jira_cloud_id\` is not an Atlassian cloud id: ${safeEcho(cloudId)}` };
  }

  const minted = await mintToken({ clientId, clientSecret, fetchImpl });
  if (minted.error) return { error: minted.error };

  const fieldList = 'summary,description,status,issuetype,labels,assignee,comment';
  const out = await jiraCall({
    cloudId,
    route: `issue/${encodeURIComponent(key)}?fields=${fieldList}`,
    token: minted.token,
    fetchImpl,
  });

  if (out.unreachable) return { error: `could not reach Jira to read \`${safeEcho(key)}\`: ${out.unreachable}` };
  if (out.status === 401) {
    return { error: `Jira rejected the credential reading \`${safeEcho(key)}\`. The token is valid but not for this endpoint - check \`jira_cloud_id\`.` };
  }
  if (out.status === 403) {
    return { error: `the Jira service account may not read \`${safeEcho(key)}\`. Grant it Browse Projects on that project.` };
  }
  if (out.status === 404) {
    return { error: `Jira has no issue \`${safeEcho(key)}\` that this service account can see.` };
  }
  if (out.status) return { error: `Jira answered ${out.status} reading \`${safeEcho(key)}\`.` };
  if (out.unreadable) return { error: `Jira answered with something that is not JSON reading \`${safeEcho(key)}\`` };

  return { issue: normalizeIssue(out.payload, { maxComments }) };
}

module.exports = {
  API_VERSION,
  CLOUD_ID_SHAPE,
  SITE_SHAPE,
  PROJECT_SHAPE,
  LABEL_SHAPE,
  MAX_COMMENTS,
  parseProjects,
  resolveKey,
  resolveKeyFrom,
  normalizeIssue,
  mintToken,
  jiraCall,
  fetchIssue,
};
