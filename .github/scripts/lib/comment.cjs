const { writerFor } = require('./cp-effects.cjs');

/**
 * updateOrCreate publishes one body, replacing the run's own earlier comment where there is one to
 * replace and posting a new one where there is not.
 */
async function updateOrCreate({ github, core, owner, repo, issueNumber, body, commentId,
  env = process.env, fetch = globalThis.fetch }) {
  const writer = writerFor({ github, owner, repo, env, fetch });
  const id = Number(commentId);
  if (Number.isInteger(id) && id > 0) {
    try {
      await writer.editComment({ comment: id, body });
      return { mode: 'updated', id, reason: '' };
    } catch (error) {
      core?.warning?.(`the comment this run opened with could not be updated (${error.message}); posting a new one.`);
      const out = await writer.comment({ number: issueNumber, body });
      return { mode: 'created', id: out.id, reason: error.message };
    }
  }
  const out = await writer.comment({ number: issueNumber, body });
  return { mode: 'created', id: out.id, reason: '' };
}

module.exports = { updateOrCreate };
