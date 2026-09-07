'use strict';

const { CLOUD_ID_SHAPE, mintToken, jiraCall } = require('./jira.cjs');
const { safeEcho } = require('../lib/select-arm.cjs');
const { GITHUB_URL_SHAPE, escapeWiki } = require('./wiki.cjs');
const { MAX_ACTOR_CHARS } = require('./plan.cjs');

const PR_URL_SHAPE = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;

const TRANSITION_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/;

const REPORTS = Object.freeze(
  Object.assign(Object.create(null), {
    planned: Object.freeze({
      text: 'ksai has opened a draft pull request for this ticket and is working through it one step at a time.',
      shape: PR_URL_SHAPE,
      reason: false,
    }),
    ready: Object.freeze({
      text: 'ksai has finished every step of its plan and marked the pull request ready for review.',
      shape: PR_URL_SHAPE,
      reason: false,
      actor: true,
    }),
    waiting: Object.freeze({
      text: 'ksai has published a plan for this ticket and is waiting for it to be released before it writes any code.',
      shape: PR_URL_SHAPE,
      reason: true,
    }),
    released: Object.freeze({
      text: 'ksai has taken the approval on this ticket and is writing the plan out one step at a time.',
      shape: PR_URL_SHAPE,
      reason: false,
      actor: true,
    }),
    paused: Object.freeze({
      text:
        'ksai has finished a phase of its plan and is waiting for approval before it writes any more ' +
        'code. If this project releases phases by label, remove the approval label and add it again; ' +
        'otherwise the approval is given on the pull request.',
      shape: PR_URL_SHAPE,
      reason: false,
    }),
    stepped: Object.freeze({
      text: 'ksai has landed one more step of its plan. The task list on the pull request says what is left.',
      shape: PR_URL_SHAPE,
      reason: false,
      actor: true,
    }),
    blocked: Object.freeze({
      text: 'ksai could not plan this ticket and has written no code. It reported:',
      shape: GITHUB_URL_SHAPE,
      reason: true,
    }),
    stopped: Object.freeze({
      text: 'ksai stopped working on this ticket. It reported:',
      shape: GITHUB_URL_SHAPE,
      reason: true,
    }),
  }),
);

function releasedBy(notice, actor) {
  const who = String(actor ?? '').trim();
  if (!notice.actor || who === '') return '';
  return ` Released by ${escapeWiki(who, { max: MAX_ACTOR_CHARS })}.`;
}

function renderReport({ event = null, prUrl = null, reason = null, actor = null } = {}) {
  const notice = REPORTS[String(event ?? '')];
  if (!notice || typeof notice.text !== 'string') {
    return { error: `\`${safeEcho(event)}\` is not an event this reports on` };
  }

  const said = `${notice.text}${releasedBy(notice, actor)}`;
  const built = String(prUrl ?? '');
  const url = built.endsWith('/') ? '' : built;
  if (notice.shape && !notice.shape.test(url)) {
    if (notice.reason && url === '') {
      return { body: [said, '', escapeWiki(reason)].join('\n') };
    }
    return { error: `\`${safeEcho(url)}\` is not a pull request URL on github.com, so nothing is posted` };
  }

  const lines = [said];
  if (notice.reason && String(reason ?? '').trim() !== '') lines.push('', escapeWiki(reason));
  if (url) lines.push('', url);
  return { body: lines.join('\n') };
}

async function request({ cloudId = null, token = null, route = null, method = 'GET', body = null, fetchImpl = fetch } = {}) {
  if (!CLOUD_ID_SHAPE.test(String(cloudId ?? ''))) {
    return { error: `\`jira_cloud_id\` is not an Atlassian cloud id: ${safeEcho(cloudId)}` };
  }
  const out = await jiraCall({ cloudId, route, token, method, body, fetchImpl });

  if (out.unreachable) return { error: `could not reach Jira: ${out.unreachable}` };
  if (out.status === 403) {
    return { error: `the Jira service account is missing a permission for this write (403 on ${method} ${route})` };
  }
  if (out.status) return { error: `Jira answered ${out.status} to ${method} ${route}` };
  if (out.unreadable) return { error: `Jira answered ${method} ${route} with something that is not JSON` };
  return { payload: /** @type {Record<string, unknown>} */ (out.payload) };
}

async function addComment({ cloudId = null, key = null, body = null, token = null, fetchImpl = fetch } = {}) {
  const route = `issue/${encodeURIComponent(String(key ?? ''))}/comment`;
  return request({ cloudId, token, route, method: 'POST', body: { body }, fetchImpl });
}

function pickTransition(transitions, wanted) {
  const name = String(wanted ?? '').trim().toLowerCase();
  if (!name) return null;
  const list = Array.isArray(transitions) ? transitions : [];
  const matches = (value) => String(value ?? '').trim().toLowerCase() === name;
  return list.find((one) => matches(one?.name)) ?? list.find((one) => matches(one?.to?.name)) ?? null;
}

async function applyTransition({ cloudId = null, key = null, to = null, token = null, fetchImpl = fetch } = {}) {
  const wanted = String(to ?? '').trim();
  if (!wanted) return { skipped: 'no transition is configured' };
  if (!TRANSITION_NAME_SHAPE.test(wanted)) {
    return { error: `\`${safeEcho(wanted)}\` is not a Jira transition name` };
  }

  const route = `issue/${encodeURIComponent(String(key ?? ''))}/transitions`;
  const listed = await request({ cloudId, token, route, fetchImpl });
  if (listed.error) return { error: listed.error };

  const offers = /** @type {{id?: string, name?: string, to?: {name?: string}}[]} */ (listed.payload?.transitions ?? []);
  const found = pickTransition(offers, wanted);
  if (!found?.id) {
    const offered = offers
      .map((one) => String(one?.name ?? ''))
      .filter((name) => TRANSITION_NAME_SHAPE.test(name))
      .join(', ');
    return {
      skipped: `\`${wanted}\` is not a transition this ticket offers right now. It offers: ${offered || '(none)'}`,
    };
  }

  const moved = await request({
    cloudId,
    token,
    route,
    method: 'POST',
    body: { transition: { id: String(found.id) } },
    fetchImpl,
  });
  if (moved.error) return { error: moved.error };
  return { moved: String(found.to?.name ?? found.name ?? wanted) };
}

async function report({
  cloudId = null,
  key = null,
  event = null,
  prUrl = null,
  reason = null,
  transitionTo = null,
  actor = null,
  clientId = null,
  clientSecret = null,
  fetchImpl = fetch,
} = {}) {
  const problems = [];
  const rendered = renderReport({ event, prUrl, reason, actor });
  if (rendered.error) return { commented: false, transitioned: '', problems: [rendered.error] };

  const minted = await mintToken({ clientId, clientSecret, fetchImpl });
  if (minted.error) return { commented: false, transitioned: '', problems: [minted.error] };

  const commented = await addComment({ cloudId, key, body: rendered.body, token: minted.token, fetchImpl });
  if (commented.error) problems.push(commented.error);

  const moved = await applyTransition({ cloudId, key, to: transitionTo, token: minted.token, fetchImpl });
  if (moved.error) problems.push(moved.error);
  else if (moved.skipped && String(transitionTo ?? '').trim()) problems.push(moved.skipped);

  return { commented: !commented.error, transitioned: moved.moved ?? '', problems };
}

module.exports = {
  REPORTS,
  renderReport,
  pickTransition,
  applyTransition,
  report,
};
