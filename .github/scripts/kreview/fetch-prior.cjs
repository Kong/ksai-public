// Lists this PR's existing kreview findings (identified by a hidden marker) so the reviewer
// can be told what was already reported and only surface new issues. Only findings authored
// by this bot are trusted: a marker is plain text any PR participant could type to suppress a
// real finding, so identity — not the marker alone — gates what feeds the reviewer prompt.

const MARKER = '<!-- kreview-finding -->';
const { parseFoldedFindings } = require('../lib/folded-findings.cjs');

function foldedBullets(text) {
  return parseFoldedFindings(text).map(
    (f) => `- ${f.path ?? '?'}:${f.line ?? '?'} — ${String(f.body ?? '').replace(/\s+/g, ' ').trim()}`,
  );
}
// Publisher-owned as well, on every comment posted since the reaction footer landed. A finding whose
// body was empty renders as the header, this footer and the marker, so without removing it the
// description fed to the next run is the publisher asking for a 👍. Delimited pair for the current
// shape, bare marker for the single-line comments posted before the render was fixed.
const FEEDBACK_FOOTER = /<!--\s*kreview-feedback\s*-->[\s\S]*?<!--\s*\/kreview-feedback\s*-->/g;
const FEEDBACK_MARKER = '<!-- kreview-feedback -->';

module.exports = async ({ github, core, owner, repo, prNumber, botLogin }) => {
  // A user/PAT token resolves to a login to match on; an App installation token cannot call
  // /user (403), so fall back to the caller-supplied bot login (e.g. `<app-slug>[bot]`) when
  // given. Only when neither is available do we widen to any Bot-type actor — the MARKER is
  // plain text any bot able to comment could plant, so that fallback is a real trust widening.
  let selfLogin;
  try {
    selfLogin = (await github.rest.users.getAuthenticated()).data.login;
  } catch {
    selfLogin = null;
  }
  const knownLogin = selfLogin || botLogin || null;
  if (!knownLogin) {
    core.warning('No bot login available for identity gating; trusting any Bot-type actor.');
  }
  const mine = (user) => (knownLogin ? user?.login === knownLogin : user?.type === 'Bot');

  const out = [];

  try {
    const comments = await github.paginate(github.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    for (const c of comments) {
      if (!mine(c.user) || !(c.body || '').includes(MARKER)) continue;
      // line is null on comments outdated by a force-push; fall back to what we have.
      const at = c.line ?? c.original_line ?? c.start_line ?? '?';
      out.push(`- ${c.path}:${at} — ${describe(c.body)}`);
    }
  } catch (e) {
    core.warning(`Could not fetch prior review comments: ${e.message}`);
  }

  // Findings that could not anchor to a diff line were folded into the review body, not
  // posted as inline comments, so they need a second pass over review bodies to be deduped.
  try {
    const reviews = await github.paginate(github.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    for (const r of reviews) {
      if (!mine(r.user) || !(r.body || '').includes(MARKER)) continue;
      out.push(...foldedBullets(r.body || ''));
    }
  } catch (e) {
    core.warning(`Could not fetch prior reviews: ${e.message}`);
  }

  // When every createReview attempt fails, kreview/post-review.cjs's last resort posts the
  // same folded-findings body as a plain issue comment instead of a review, so it needs the
  // same heading scan here or the dedup never sees it and it re-reports forever.
  try {
    const issueComments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    for (const c of issueComments) {
      if (!mine(c.user) || !(c.body || '').includes(MARKER)) continue;
      out.push(...foldedBullets(c.body || ''));
    }
  } catch (e) {
    core.warning(`Could not fetch prior issue comments: ${e.message}`);
  }

  core.setOutput('prior_findings', out.length ? out.join('\n') : '(none)');
};

// The first body line is the severity label; skip it so the reviewer gets the actual
// description it needs to recognize a repeat, not just "Critical".
function describe(body) {
  const lines = (body || '')
    .replace(FEEDBACK_FOOTER, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const ours = (s) => s.includes(MARKER) || s.includes(FEEDBACK_MARKER);
  const prose = lines.find(
    (s) =>
      !ours(s) &&
      !/^(❗|🔴|🟠|🔵)/.test(s) &&
      !/^\*\*(Critical|High|Medium|Low|Note)\*\*/i.test(s),
  );
  const fallback = lines.find((s) => !ours(s)) || '';
  return (prose || fallback).replace(/\s+/g, ' ').slice(0, 300);
}
