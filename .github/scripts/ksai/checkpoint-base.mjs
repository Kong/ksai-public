import trustedGit from './trusted-git.cjs';

const COMMIT = /^[0-9a-f]{40}$/;
const PULL = /^[1-9][0-9]{0,9}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function checkpointPull(env) {
  if (env.RECORD_READ === 'true') return String(env.RECORD_PR ?? '').trim();
  if (env.FLOW === 'review' || env.FLOW === 'test') return String(env.THREAD_NUM ?? '').trim();
  if (env.FLOW === 'implement') return String(env.EXISTING_PR ?? '').trim();
  return '';
}

async function checkpointBase(env, { head = () => String(''), readPull = async (_repo, _number) => ({ number: 0, base: { sha: '' } }) } = {}) {
  const number = checkpointPull(env);
  const pr = number && number !== '0' ? number : '0';
  const refused = (error) => ({ sha: '', pr, error });
  const commit = (sha) => {
    const value = String(sha ?? '').trim();
    return COMMIT.test(value) ? { sha: value, pr, error: '' } : refused('the run names no exact base commit for its checkpoint');
  };
  if (pr === '0') return commit(env.SOURCE_BASE_SHA || head());
  if (!PULL.test(pr)) return refused('the run names no pull request its checkpoint base can be read from');
  if (env.FLOW === 'review') return commit(env.REVIEW_BASE_SHA);
  if (env.FLOW === 'test') return commit(env.TEST_BASE_SHA);
  const repo = String(env.REPO ?? '').trim();
  if (!REPO.test(repo)) return refused('the run names no repository its checkpoint base can be read from');
  try {
    const pull = await readPull(repo, Number(pr));
    if (pull?.number !== Number(pr)) return refused('GitHub returned another pull request for the checkpoint base');
    return commit(pull?.base?.sha);
  } catch {
    return refused('the pull request base could not be read, so no checkpoint can be restored from this attempt');
  }
}

async function captureCheckpointBase({ env = process.env, github, core, git = trustedGit.directGit(String(env.GITHUB_WORKSPACE ?? '')) }) {
  const result = await checkpointBase(env, {
    head: () => {
      const read = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      return read.ok ? String(read.stdout ?? '').trim() : '';
    },
    readPull: async (repo, number) => {
      const [owner, name] = repo.split('/');
      return (await github.rest.pulls.get({ owner, repo: name, pull_number: number })).data;
    },
  });
  core.setOutput('sha', result.sha);
  core.setOutput('pr', result.pr);
  if (result.error) core.warning(result.error);
  return result;
}

export { captureCheckpointBase, checkpointBase, checkpointPull };
