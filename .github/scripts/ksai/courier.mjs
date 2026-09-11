import { createRequire } from 'node:module';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { neutralCut } = require('../lib/prompt-text.cjs');
const { afterTrigger, triggerMatcher } = require('../lib/text.cjs');
const { HELP_COMMAND } = require('../lib/select-arm.cjs');
const { PAGE_SIZE, pagedProbe } = require('./pages.cjs');
const { wasEdited, withLastEdits } = require('./approval.cjs');
const { isOwnLogin } = require('./threads.cjs');

const DEFAULT_API_URL = 'https://api.github.com';

const MESSAGE_KIND = 'message';

const REVIEW_KIND = 'review-comment';

const STOP_KIND = 'stop';

const STOP_SHAPE = /^(stop|pause)\b([\s\S]*)$/i;

const HELP_SHAPE = new RegExp(`^${HELP_COMMAND}(?:[ \\t\\r\\n]|$)`, 'i');

const NOW_FLAG = /(^|\s)--now(?=[\s,:;.!-]|$)/;

const MAX_TEXT_CHARS = 600;

const POLL_SECONDS = 20;

const MAX_COMMENT_PAGES = 10;

const deliverySequence = new Map();

const cut = (value) => neutralCut(value, MAX_TEXT_CHARS);

export function wanted({ comment, kind, triggerPhrase = '', botLogin = null, ownPull = false }) {
  if (isOwnLogin(comment?.user?.login, botLogin)) return false;
  if (String(comment?.body ?? '').trim() === '') return false;
  if (wasEdited(comment)) return false;
  const addressed = afterTrigger(String(comment?.body ?? ''), triggerPhrase);
  if (addressed !== null && HELP_SHAPE.test(addressed.trimStart())) return false;
  if (kind === REVIEW_KIND || String(ownPull) === 'true') return true;
  return triggerMatcher(triggerPhrase).test(String(comment?.body ?? ''));
}

export function stopAsked(comment, triggerPhrase = '') {
  return haltAsked(comment, triggerPhrase)?.text ?? '';
}

export function haltAsked(comment, triggerPhrase = '') {
  const said = afterTrigger(String(comment?.body ?? ''), triggerPhrase);
  if (said === null) return null;
  const asked = said.trim().match(STOP_SHAPE);
  if (!asked) return null;
  const command = asked[1].toLowerCase();
  const rest = asked[2] ?? '';
  const now = NOW_FLAG.test(rest);
  const reason = rest.replace(NOW_FLAG, '$1').replace(/^[\s,:;.!-]+/, '').trim();
  const text = cut(reason) || `somebody asked this run to ${command}.`;
  return { command, text, now };
}

export function recordFor(comment, kind, triggerPhrase = '', { graceSeconds = 0, hardStop = false } = {}) {
  const halt = kind === MESSAGE_KIND ? haltAsked(comment, triggerPhrase) : null;
  if (halt !== null) {
    const hard = halt.now || hardStop === true;
    const grace = hard ? 0 : Math.max(0, Math.floor(Number(graceSeconds)) || 0);
    return { kind: STOP_KIND, text: halt.text, grace_seconds: grace, hard, hold: halt.command === 'pause' };
  }
  const createdAt = Date.parse(String(comment?.created_at ?? ''));
  const when = Number.isFinite(createdAt) ? ` at ${new Date(createdAt).toISOString()}` : '';
  const where =
    kind === REVIEW_KIND && comment?.path
      ? ` on ${cut(comment.path)}${comment?.line ? `:${Number(comment.line)}` : ''}`
      : '';
  const who = kind === REVIEW_KIND ? 'A review comment arrived' : 'A message arrived';
  return { kind, text: `${who}${where}${when} while you worked: "${cut(comment?.body)}"` };
}

export function octokitOver(token, fetchImpl = fetch, apiUrl = DEFAULT_API_URL) {
  const baseUrl = String(apiUrl).replace(/\/+$/, '');
  const call = async (path, headers = {}) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...headers,
      },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`${path} answered ${response.status}`), { status: response.status });
    }
    return { data: await response.json() };
  };
  return {
    rest: {
      repos: {
        getContent: ({ owner, repo, path, ref }) =>
          call(`/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`),
        getCollaboratorPermissionLevel: ({ owner, repo, username }) =>
          call(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`),
      },
      teams: {
        checkPermissionsForRepoInOrg: ({ org, team_slug: slug, owner, repo, headers }) =>
          call(`/orgs/${org}/teams/${slug}/repos/${owner}/${repo}`, headers),
        getMembershipForUserInOrg: ({ org, team_slug: slug, username }) =>
          call(`/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(username)}`),
        getByName: ({ org, team_slug: slug }) => call(`/orgs/${org}/teams/${slug}`),
      },
    },
  };
}

const listing = (repo, kind, number, since, page) =>
  kind === REVIEW_KIND
    ? `/repos/${repo}/pulls/${number}/comments?since=${encodeURIComponent(since)}&per_page=${PAGE_SIZE}&page=${page}`
    : `/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=${PAGE_SIZE}&page=${page}`;

export async function listComments({
  repo,
  number,
  kind,
  since,
  token,
  apiUrl = DEFAULT_API_URL,
  fetchImpl = fetch,
  maxPages = MAX_COMMENT_PAGES,
}) {
  const baseUrl = String(apiUrl).replace(/\/+$/, '');
  const comments = [];
  const probe = await pagedProbe({
    perPage: PAGE_SIZE,
    maxPages,
    fetchPage: async (page) => {
      const response = await fetchImpl(`${baseUrl}${listing(repo, kind, number, since, page)}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`${kind} comment page ${page} answered ${response.status}`);
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    },
    take: (comment) => comments.push(comment),
  });
  if (probe.threw || !probe.listed) return [];
  if (!probe.complete) {
    throw new Error(`${kind} comment listing exceeded the reported safety bound of ${maxPages * PAGE_SIZE}`);
  }
  return comments;
}

const graphqlOver = ({ token, apiUrl, fetchImpl }) => async (query, variables) => {
  const response = await fetchImpl(`${String(apiUrl).replace(/\/+$/, '').replace(/\/v3$/, '')}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`the GraphQL API answered ${response.status}`);
  const body = await response.json();
  if (body?.errors?.length) throw new Error(`the GraphQL API answered ${body.errors.length} errors`);
  return body?.data;
};

async function readReviewEdits(comments, { seen, botLogin, token, apiUrl, fetchImpl }) {
  const asked = comments.filter(
    (comment) => !seen.has(`${REVIEW_KIND}-${comment?.id}`) && !isOwnLogin(comment?.user?.login, botLogin),
  );
  try {
    return await withLastEdits(asked, { graphql: graphqlOver({ token, apiUrl, fetchImpl }) });
  } catch {
    return asked;
  }
}

export async function sweep({
  repo,
  number,
  since,
  token,
  triggerPhrase = '',
  botLogin = null,
  ownPull = false,
  graceSeconds = 0,
  hardStop = false,
  authorize,
  seen = new Set(),
  apiUrl = DEFAULT_API_URL,
  fetchImpl = fetch,
}) {
  const records = [];
  const refused = [];
  const unresolved = [];
  const candidates = [];
  let order = 0;
  for (const kind of [MESSAGE_KIND, REVIEW_KIND]) {
    const listed = await listComments({ repo, number, kind, since, token, apiUrl, fetchImpl });
    const comments =
      kind === REVIEW_KIND ? await readReviewEdits(listed, { seen, botLogin, token, apiUrl, fetchImpl }) : listed;
    for (const comment of comments) {
      const id = `${kind}-${comment?.id}`;
      if (seen.has(id) || !wanted({ comment, kind, triggerPhrase, botLogin, ownPull })) continue;
      candidates.push({ comment, id, kind, order: order += 1 });
    }
  }
  candidates.sort((left, right) => {
    const leftAt = Date.parse(String(left.comment?.created_at ?? ''));
    const rightAt = Date.parse(String(right.comment?.created_at ?? ''));
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1;
    const leftId = String(left.comment?.id ?? '').padStart(24, '0');
    const rightId = String(right.comment?.id ?? '').padStart(24, '0');
    return leftId.localeCompare(rightId) || left.kind.localeCompare(right.kind) || left.order - right.order;
  });
  for (const { comment, id, kind } of candidates) {
    const login = String(comment?.user?.login ?? '');
    let allowed = null;
    try {
      allowed = await authorize(login);
    } catch {
      allowed = null;
    }
    if (allowed === null) {
      unresolved.push(login);
      continue;
    }
    if (allowed === false) {
      seen.add(id);
      refused.push(login);
    }
    else {
      records.push({
        id,
        record: recordFor(comment, kind, triggerPhrase, { graceSeconds, hardStop }),
        at: Date.parse(String(comment?.created_at ?? '')),
      });
    }
  }
  return { records, refused, unresolved };
}

export function deliver(
  stateDir,
  id,
  record,
  now = Date.now(),
  { write = writeFileSync, move = renameSync, clock = Date.now } = {},
) {
  const inbox = join(stateDir, 'inbox');
  const proposed = Number(now);
  const ordered = Number.isFinite(proposed) && proposed >= 0 ? Math.floor(proposed) : Date.now();
  const sequence = (deliverySequence.get(stateDir) ?? 0) + 1;
  deliverySequence.set(stateDir, sequence);
  const name = `${String(ordered).padStart(14, '0')}-${String(sequence).padStart(8, '0')}-${id}.json`;
  const stamped = record?.kind === STOP_KIND ? { ...record, deadline: deadlineFor(record, delivered(clock)) } : record;
  const staged = join(inbox, `.${name}.${process.pid}.tmp`);
  write(staged, JSON.stringify(stamped));
  move(staged, join(inbox, name));
  if (stamped !== record) keepStop(stateDir, stamped, { write, move });
}

function delivered(clock) {
  const read = Number(typeof clock === 'function' ? clock() : clock);
  return Number.isFinite(read) && read > 0 ? Math.floor(read) : Date.now();
}

export function deadlineFor(record, now) {
  const grace = Math.max(0, Math.floor(Number(record?.grace_seconds)) || 0);
  return record?.hard === true ? now : now + grace * 1000;
}

function keepStop(stateDir, record, { write = writeFileSync, move = renameSync } = {}) {
  const path = join(stateDir, 'stop.json');
  const staged = `${path}.${process.pid}.tmp`;
  try {
    write(
      staged,
      JSON.stringify({
        text: record.text,
        deadline: record.deadline,
        hold: record.hold === true,
        hard: record.hard === true,
      }),
    );
    move(staged, path);
  } catch {
    return false;
  }
  return true;
}

export { MAX_COMMENT_PAGES, MESSAGE_KIND, POLL_SECONDS, REVIEW_KIND, STOP_KIND };
