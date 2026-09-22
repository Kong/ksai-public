const { writerFor } = require('./cp-effects.cjs');

/** react puts one reaction on the comment that asked, and never lets failing to do it fail the run. */
async function react({ github, core, owner, repo, commentId, threadRootId = null, content = 'rocket',
  env = process.env, fetch = globalThis.fetch }) {
  const id = Number(commentId);
  if (!Number.isInteger(id) || id <= 0) {
    return { reacted: false, reason: 'this run has no comment to react to' };
  }
  const inThread = String(threadRootId ?? '').trim() !== '';
  try {
    await writerFor({ github, owner, repo, env, fetch })
      .react({ comment: id, on: inThread ? 'review_comment' : 'issue_comment', content });
    return { reacted: true, reason: '' };
  } catch (error) {
    const scope = inThread ? 'pull-requests:write' : 'issues:write';
    core?.info?.(`Skipped the ${content} reaction (${error.message}); the token may lack ${scope}.`);
    return { reacted: false, reason: error.message };
  }
}

module.exports = { react };
