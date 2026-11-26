import { listed } from './step-sandbox.mjs';

export const TOOL_DENIED_ENV = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'KSAI_MODEL_TOKEN',
  'KSAI_MODEL_TOKEN_EXPIRES_AT',
  'GH_TOKEN',
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TOKEN',
  'KSAI_OIDC_REQUEST_TOKEN',
  'KSAI_OIDC_REQUEST_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_RESOURCE_ATTRIBUTES',
]);

export const TOOL_INJECTION_ENV = Object.freeze([
  'BASH_ENV',
  'BUN_OPTIONS',
  'CLASSPATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5LIB',
  'PERL5OPT',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'ZDOTDIR',
]);

const SESSION_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const RESERVED_SESSION = /^(?:(?:PATH|HOME|TMPDIR)$|LD_|KSAI_SECRET_)/u;
const PLACEHOLDERS = new Set(['tool_root', 'tool_path', 'workspace']);
const PLACEHOLDER = /\$\{([^{}]*)\}|\$\{/gu;

export function callerDeniedEnvironment(env = process.env) {
  return listed(env.SANDBOX_DENY_ENV);
}

export function validSessionEnvironment(value, env) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const denied = new Set([...TOOL_DENIED_ENV, ...callerDeniedEnvironment(env)]);
  return Object.entries(value).every(([name, entry]) => SESSION_NAME.test(name) && !RESERVED_SESSION.test(name) && !denied.has(name)
    && typeof entry === 'string' && !entry.includes('\0')
    && [...entry.matchAll(PLACEHOLDER)].every(([, placeholder]) => PLACEHOLDERS.has(placeholder)));
}

export function expandSessionEnvironment(value, replacements, env) {
  if (!validSessionEnvironment(value, env)) throw Object.assign(new Error('invalid harness session environment'), { code: 'invalid_session_env' });
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
    name, entry.replace(PLACEHOLDER, (_token, placeholder) => replacements[placeholder]),
  ]));
}
