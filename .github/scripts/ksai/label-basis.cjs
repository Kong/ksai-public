const { AUTHZ_LOGIN_SHAPE } = require('./context.cjs');

const LABEL_COMMANDS = Object.freeze(['fix']);

const PR_SHAPE = /^[1-9][0-9]{0,9}$/;

const SHA_SHAPE = /^[0-9a-f]{40}$/;

const LABEL_MAX = 50;

const hasControl = (text) => [...text].some((character) => {
  const point = character.codePointAt(0) ?? 0;
  return point < 32 || point === 127;
});

const sameName = (one, other) => String(one ?? '').toLowerCase() === String(other ?? '').toLowerCase();

/**
 * recordBasis reads what a dispatch record says a run nobody typed rests on, from the RECORD_* values
 * the dispatch-record action passed on. It answers null where the record names no label, which is every
 * run a comment started, so those keep their own authorization untouched.
 */
function recordBasis(env = {}) {
  const command = String(env.RECORD_COMMAND ?? '').trim();
  const label = String(env.RECORD_LABEL ?? '');
  const pr = String(env.RECORD_PR ?? '').trim();
  const headSha = String(env.RECORD_HEAD_SHA ?? '').trim().toLowerCase();
  const grants = LABEL_COMMANDS.map((one) => `\`${one}\``).join(' or ');

  if (label === '') {
    if (!LABEL_COMMANDS.includes(command)) return null;
    return {
      error: `the control plane asked for \`${command}\` with no label behind it, and a run nobody typed has to rest on one, so nothing ran`,
    };
  }
  if (!LABEL_COMMANDS.includes(command)) {
    return { error: `a label can ask for ${grants} and nothing else, and this record asked for \`${command || 'no command'}\`, so nothing ran` };
  }
  if (label.trim() === '' || label.length > LABEL_MAX || hasControl(label)) {
    return { error: 'the record names a label GitHub could not hold, so nothing ran' };
  }
  if (!PR_SHAPE.test(pr)) return { error: 'the record names no pull request, so there is nothing the label could be on, and nothing ran' };
  if (!SHA_SHAPE.test(headSha)) {
    return { error: 'the record names no head commit, so there is no telling the pull request has not moved on since, and nothing ran' };
  }
  return { command, label, pr: Number(pr), headSha };
}

/**
 * readLabelBasis reads back from GitHub every fact a labelled run rests on, and answers the account that
 * last applied the label - the one the run is authorized as. The pull request comes from the record,
 * never from a dispatch input, so a caller holding only actions: write cannot point a record at another
 * pull request; and the head is compared rather than trusted, so a late or replayed run stands down
 * rather than work on a commit nobody decided for.
 */
async function readLabelBasis({ basis, pullsGet, listIssueEvents }) {
  const { pr, label, headSha, command } = basis;
  let pull;
  try {
    pull = await pullsGet(pr);
  } catch (error) {
    return { error: `pull request #${pr} could not be read (${error?.status ?? error?.message ?? 'unknown'}), so the label behind this run was not checked and nothing ran` };
  }
  if (pull?.state !== 'open') return { error: `pull request #${pr} is not open, so the label behind this run asks for nothing and nothing ran` };

  const head = pull?.head?.repo?.full_name;
  if (!head || !sameName(head, pull?.base?.repo?.full_name)) {
    return { error: `pull request #${pr} comes from a fork, and a run nobody typed never works on one, so nothing ran` };
  }
  if (String(pull?.head?.sha ?? '').toLowerCase() !== headSha) {
    return { error: `pull request #${pr} has moved past the commit this run was decided for, so it stood down rather than work on a head nobody asked about` };
  }
  if (!(pull?.labels ?? []).some((held) => sameName(held?.name, label))) {
    return { error: `pull request #${pr} no longer carries the label that asked for this run, so nothing ran` };
  }

  let events;
  try {
    events = await listIssueEvents(pr);
  } catch (error) {
    return { error: `the history of pull request #${pr} could not be read (${error?.status ?? error?.message ?? 'unknown'}), so nobody could be authorized for this run and nothing ran` };
  }
  const applied = [...(events ?? [])].toReversed().find((one) => one?.event === 'labeled' && sameName(one?.label?.name, label));
  if (!applied) return { error: `nothing on pull request #${pr} says who applied the label, so nobody could be authorized for this run and nothing ran` };

  const login = String(applied?.actor?.login ?? '');
  if (applied?.actor?.type === 'Bot' || login.endsWith('[bot]')) {
    return { error: `the label on pull request #${pr} was applied by an App, which asks on nobody's behalf, so nothing ran` };
  }
  if (!AUTHZ_LOGIN_SHAPE.test(login)) {
    return { error: `the label on pull request #${pr} names no account this gate can authorize, so nothing ran` };
  }
  return { login, pr, label, headSha, command };
}

const labelReaders = ({ github, context }) => ({
  pullsGet: async (pull_number) => (await github.rest.pulls.get({ ...context.repo, pull_number })).data,
  listIssueEvents: (issue_number) => github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number, per_page: 100 }),
});

module.exports = { LABEL_COMMANDS, labelReaders, readLabelBasis, recordBasis };
