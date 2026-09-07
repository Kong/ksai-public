/**
 * updateOrCreate publishes one body, replacing the run's own earlier comment where there is one to
 * replace and posting a new one where there is not.
 */
async function updateOrCreate({ github, core, owner, repo, issueNumber, body, commentId }) {
  const id = Number(commentId);
  if (Number.isInteger(id) && id > 0) {
    try {
      await github.rest.issues.updateComment({ owner, repo, comment_id: id, body });
      return { mode: 'updated', id, reason: '' };
    } catch (error) {
      core?.warning?.(`the comment this run opened with could not be updated (${error.message}); posting a new one.`);
      const out = await github.rest.issues.createComment({ owner, repo, issue_number: Number(issueNumber), body });
      return { mode: 'created', id: idOf(out), reason: error.message };
    }
  }
  const out = await github.rest.issues.createComment({ owner, repo, issue_number: Number(issueNumber), body });
  return { mode: 'created', id: idOf(out), reason: '' };
}

function idOf(response) {
  const id = Number(response?.data?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = { updateOrCreate };
