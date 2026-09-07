const { asAlert, safeEcho, scrubTrigger } = require('../lib/select-arm.cjs');
const { counted, safeText } = require('../lib/text.cjs');
const { neutralizeSections } = require('../lib/prompt-text.cjs');

const RULES_PATH = '.ksai/review-rules.md';
const MAX_BYTES = 16 * 1024;
const MODES = Object.freeze(['auto', 'off']);

/**
 * parseRules validates one repository's review-rules document and answers the text a prompt carries.
 *
 * Returns `{ rules }` or `{ error }`, and never both: an error path carrying a usable value is what
 * lets a caller that forgets to check it review with rules nobody validated.
 */
function parseRules(raw) {
  const bytes = Buffer.byteLength(String(raw ?? ''), 'utf-8');
  if (bytes > MAX_BYTES) {
    return { error: `\`${RULES_PATH}\` is ${bytes} bytes, over the limit of ${MAX_BYTES}` };
  }
  const rules = neutralizeSections(String(raw ?? '').replace(/\r\n/g, '\n')).trimEnd();
  if (rules.trim() === '') {
    return { error: `\`${RULES_PATH}\` holds no rules; delete the file, or write the rules the review must apply` };
  }
  return { rules, bytes: Buffer.byteLength(rules, 'utf-8') };
}

/** renderRulesRejection answers the comment a run publishes when it refused to review without the rules. */
function renderRulesRejection(error, trigger) {
  return asAlert(
    'WARNING',
    scrubTrigger(
      [
        `**${error}**`,
        '',
        'Nothing was reviewed. Fix `review-rules.md` in `.ksai/` on the default branch, or set the',
        '`repo_rules` input to `off`, then ask again',
      ].join('\n'),
      trigger,
    ),
  );
}

async function fetchRules({ github, owner, repo }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: RULES_PATH });
    return { data };
  } catch (err) {
    if (err.status === 404) return { missing: true };
    const detail = `(${err.status ?? 'no status'}: ${safeText(err.message)})`;
    const blame =
      typeof err.status === 'number' && err.status < 500
        ? `the token needs contents:read ${detail}`
        : `GitHub could not answer, and the retries are exhausted ${detail}`;
    return { error: `cannot read \`${RULES_PATH}\` from ${owner}/${repo}; ${blame}` };
  }
}

/**
 * loadRepoRules reads `.ksai/review-rules.md` from the default branch and stages it for the review.
 *
 * Answers the step outputs, plus `failure` when the run must stop before a model is called.
 */
async function loadRepoRules({ github, core, owner, repo, mode, trigger }) {
  const outputs = {
    rules: '',
    path: RULES_PATH,
    sha: '',
    bytes: '',
    enabled: 'false',
    mode: '',
    rejection: '',
  };
  const stop = (error) => {
    outputs.rejection = renderRulesRejection(error, trigger);
    return { outputs, failure: error };
  };

  const wanted = String(mode ?? '').trim().toLowerCase();
  if (!MODES.includes(wanted)) {
    return stop(`\`repo_rules\` must be \`${MODES.join('` or `')}\`, got \`${safeEcho(mode)}\``);
  }
  outputs.mode = wanted;
  if (wanted === 'off') {
    core.info(`repo_rules is off, so ${RULES_PATH} is not read and this review applies no repository rules.`);
    return { outputs, failure: null };
  }

  const found = await fetchRules({ github, owner, repo });
  if (found.error) return stop(found.error);
  if (found.missing) {
    core.info(`No ${RULES_PATH} on ${owner}/${repo}'s default branch, so this review applies no repository rules.`);
    return { outputs, failure: null };
  }

  const { data } = found;
  if (Array.isArray(data) || data?.encoding !== 'base64' || typeof data.content !== 'string') {
    return stop(`\`${RULES_PATH}\` in ${owner}/${repo} is not an inline file, so its rules cannot be read`);
  }
  if (typeof data.size === 'number' && data.size > MAX_BYTES) {
    return stop(`\`${RULES_PATH}\` is ${data.size} bytes, over the limit of ${MAX_BYTES}`);
  }

  const parsed = parseRules(Buffer.from(data.content, 'base64').toString('utf-8'));
  if (parsed.error) return stop(parsed.error);

  core.info(`Loaded ${counted(parsed.bytes, 'byte')} of review rules from ${RULES_PATH} at ${safeText(data.sha)}.`);
  outputs.rules = parsed.rules;
  outputs.sha = String(data.sha ?? '');
  outputs.bytes = String(parsed.bytes);
  outputs.enabled = 'true';
  return { outputs, failure: null };
}

module.exports = loadRepoRules;
Object.assign(module.exports, { RULES_PATH, MAX_BYTES, MODES, parseRules, renderRulesRejection });
