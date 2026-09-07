'use strict';

async function pagedProbe({
  perPage = 100,
  maxPages = 5,
  fetchPage = async (_page) => [],
  take = (_item) => {},
  stop = (_item) => Boolean(false),
} = {}) {
  const last = Math.max(1, Math.trunc(Number(maxPages)) || 1);
  for (let page = 1; page <= last + 1; page += 1) {
    let batch = null;
    try {
      batch = await fetchPage(page);
    } catch (error) {
      return { complete: false, threw: true, failed: String(error?.message ?? error ?? ''), listed: true, page };
    }
    if (!Array.isArray(batch)) return { complete: false, threw: false, failed: '', listed: false, page };
    if (page > last) return { complete: batch.length === 0, threw: false, failed: '', listed: true, page };
    for (const item of batch) {
      take(item);
      if (stop(item)) return { complete: true, threw: false, failed: '', listed: true, page };
    }
    if (batch.length < perPage) return { complete: true, threw: false, failed: '', listed: true, page };
  }
}

const PAGE_SIZE = 100;

async function probeComments({
  github = null,
  owner = null,
  repo = null,
  prNumber = null,
  maxPages = 5,
  take = (_item) => {},
  stop = (_item) => Boolean(false),
  cannot = '',
} = {}) {
  const probe = await pagedProbe({
    perPage: PAGE_SIZE,
    maxPages,
    fetchPage: async (page) => {
      const response = await github.rest.issues.listComments({
        owner,
        repo,
        issue_number: Number(prNumber),
        per_page: PAGE_SIZE,
        page,
      });
      return response?.data;
    },
    take,
    stop,
  });

  const at = `${owner}/${repo}#${String(prNumber)}`;
  if (probe.threw) return { probe, unreadable: `could not read the comments on #${String(prNumber)}: ${probe.failed}` };
  if (!probe.listed) return { probe, unreadable: `${at} returned no comment list` };
  if (!probe.complete) {
    return { probe, unreadable: `${at} has more than ${maxPages * PAGE_SIZE} comments, so this ${cannot}` };
  }
  return { probe, unreadable: null };
}

module.exports = { PAGE_SIZE, pagedProbe, probeComments };
