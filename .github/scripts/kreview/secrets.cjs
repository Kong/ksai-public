/** DEFAULT_SECRET_VARS names the environment values a review must never be able to quote back. */
const DEFAULT_SECRET_VARS = Object.freeze([
  'ANTHROPIC_FEDERATED_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'GITHUB_TOKEN',
]);

/** collectSecrets answers the name/value pairs worth redacting, skipping anything too short to be one. */
function collectSecrets(env, names = DEFAULT_SECRET_VARS) {
  return names.map((name) => [name, env[name] ?? '']).filter(([, value]) => value.length > 8);
}

/** scrub replaces every collected secret in `text`, longest value first so a substring cannot split a longer one. */
function scrub(text, secrets) {
  const longestFirst = [...secrets].sort(([, a], [, b]) => b.length - a.length);
  return longestFirst.reduce((out, [name, value]) => out.replaceAll(value, `***redacted ${name}***`), String(text ?? ''));
}

module.exports = { DEFAULT_SECRET_VARS, collectSecrets, scrub };
