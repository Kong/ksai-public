/** react puts one reaction on the comment that asked, and never lets failing to do it fail the run. */
async function react({ github, core, owner, repo, commentId, threadRootId = null, content = 'rocket' }) {
  const id = Number(commentId);
  if (!Number.isInteger(id) || id <= 0) {
    return { reacted: false, reason: 'this run has no comment to react to' };
  }
  const inThread = String(threadRootId ?? '').trim() !== '';
  try {
    if (inThread) {
      await github.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: id, content });
    } else {
      await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: id, content });
    }
    return { reacted: true, reason: '' };
  } catch (error) {
    const scope = inThread ? 'pull-requests:write' : 'issues:write';
    core?.info?.(`Skipped the ${content} reaction (${error.message}); the token may lack ${scope}.`);
    return { reacted: false, reason: error.message };
  }
}

module.exports = { react };
