import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { conclusionOf, exitedOn, stopReason } from '../lib/execution-log.mjs';
import modelCatalog from '../lib/model-catalog.json' with { type: 'json' };
import { listed, sandboxScopes } from '../lib/opencode.mjs';
import { writeOutputs } from '../lib/outputs.mjs';
import { bearer, heldExpiry } from '../lib/opencode-token.mjs';

export { listed };

const MASKED_HOMES = ['.config', '.claude'];

const UNSET = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_OIDC_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
];

const SCRUBBED = ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export const scrubbing = (env) => String(env.SUBPROCESS_ENV_SCRUB ?? '1').trim() !== '0';

const BROKER_PERIOD_MS = 60_000;

const READ_ONLY_ON_TEST = ['.git', '.ksai'];

const RESOLVER = '/etc/resolv.conf';

const MASKED_RUNTIME = '/run';

export function scopeBinds(env = process.env, exists = existsSync) {
  const scopes = sandboxScopes(env, exists);
  for (const at of scopes.missing) {
    console.log(
      `::warning::the sandbox scope ${at} is not on this runner, so nothing is bound there and no tool may reach it`,
    );
  }
  const args = [];
  for (const { flag, named } of [
    { flag: '--bind', named: scopes.allow },
    { flag: '--ro-bind', named: scopes.deny },
  ]) {
    for (const at of named) args.push(flag, at, at);
  }
  return args;
}

export function resolverBinds(real = realpathSync) {
  let at = '';
  try {
    at = String(real(RESOLVER));
  } catch {
    return [];
  }
  return at.startsWith(`${MASKED_RUNTIME}/`) ? ['--ro-bind', at, at] : [];
}

export function sandboxArgs(
  env = process.env,
  exists = existsSync,
  kind = (at) => statSync(at),
  real = realpathSync,
) {
  const home = String(env.HOME ?? '');
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const temp = String(env.RUNNER_TEMP ?? '');
  const opencodeHome = String(env.OPENCODE_HOME ?? '');
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    MASKED_RUNTIME,
    ...resolverBinds(real),
  ];
  if (temp) args.push('--tmpfs', temp);

  for (const name of MASKED_HOMES) {
    const at = join(home, name);
    if (!exists(at)) continue;
    if (kind(at).isDirectory()) args.push('--tmpfs', at);
    else args.push('--ro-bind', '/dev/null', at);
  }

  const config = String(env.OPENCODE_CONFIG ?? '');
  const scripts = String(env.SCRIPTS ?? '');
  args.push('--bind', workspace, workspace);
  const trusted = join(workspace, '_ksai');
  if (exists(trusted)) args.push('--ro-bind', trusted, trusted);
  args.push('--ro-bind', config, config, '--ro-bind', scripts, scripts, '--bind', opencodeHome, opencodeHome);

  const channel = String(env.KSAI_CHANNEL_DIR ?? '');
  if (channel && exists(channel)) {
    args.push('--ro-bind', channel, channel, '--bind', join(channel, 'run'), join(channel, 'run'));
  }

  if (String(env.FLOW ?? '') === 'test') {
    for (const name of READ_ONLY_ON_TEST) {
      const at = join(workspace, name);
      if (exists(at)) args.push('--ro-bind', at, at);
    }
  }

  const tokenDir = String(env.KSAI_TOKEN_DIR ?? '');
  if (tokenDir && exists(tokenDir)) {
    args.push('--ro-bind', tokenDir, tokenDir, '--setenv', 'KSAI_TOKEN_FILE', String(env.KSAI_TOKEN_FILE ?? ''));
  }

  args.push(
    ...scopeBinds(env, exists),
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'XDG_DATA_HOME',
    opencodeHome,
    '--setenv',
    'XDG_CONFIG_HOME',
    join(opencodeHome, 'config'),
    '--setenv',
    'XDG_CACHE_HOME',
    join(opencodeHome, 'cache'),
    '--setenv',
    'XDG_STATE_HOME',
    join(opencodeHome, 'state'),
    '--setenv',
    'OPENCODE_DISABLE_AUTOUPDATE',
    '1',
    '--setenv',
    'TAR_OPTIONS',
    '--no-same-owner',
  );
  const scrubbed = scrubbing(env) ? SCRUBBED : [];
  for (const name of new Set([...UNSET, ...scrubbed, ...listed(env.SANDBOX_DENY_ENV)])) {
    args.push('--unsetenv', name);
  }
  args.push('--unshare-user', '--unshare-pid', '--new-session', '--die-with-parent', '--chdir', workspace, '--');
  return args;
}

export function runArgs(env = process.env) {
  const named = String(env.MODEL ?? '').trim() || modelCatalog.aliases[modelCatalog.defaultAlias];
  const args = ['run', '--model', `anthropic/${named}`, '--format', 'json'];
  const variant = String(env.VARIANT ?? '').trim();
  if (variant) args.push('--variant', variant);
  const session = String(env.OPENCODE_RESUME_SESSION ?? '').trim();
  if (session) args.push('--session', session, '--fork');
  return args;
}

export async function writeToken(at, env, now = Date.now(), ask = bearer, expiry = heldExpiry) {
  const token = await ask({ env, now });
  if (!token) return false;
  const staged = `${at}.staged`;
  writeFileSync(staged, `${JSON.stringify({ token, expires_at: expiryOf(env, now, expiry()) })}\n`);
  renameSync(staged, at);
  return true;
}

function expiryOf(env, now, held) {
  if (Number.isFinite(held) && held > 0) return held;
  const seeded = Number(env.ANTHROPIC_FEDERATED_TOKEN_EXPIRES_AT);
  return Number.isFinite(seeded) && seeded > now ? seeded : now + BROKER_PERIOD_MS * 2;
}

async function broker(at, env) {
  const said = await writeToken(at, env).catch((error) => {
    console.log(`::warning::the run's token could not be brokered (${error?.message}), so it holds the one it started on`);
    return false;
  });
  return said;
}

async function main(env = process.env) {
  const home = String(env.OPENCODE_HOME ?? '');
  for (const name of ['config', 'cache', 'state']) mkdirSync(join(home, name), { recursive: true });
  const events = String(env.EVENTS_FILE ?? '');
  const execution = String(env.EXECUTION_FILE ?? '');
  writeFileSync(events, '');
  writeOutputs(env.GITHUB_OUTPUT, {
    events_file: events,
    execution_file: execution,
  });

  const tokenDir = String(env.RUNNER_TEMP ?? '') ? join(String(env.RUNNER_TEMP), 'ksai-token') : '';
  const tokenFile = tokenDir ? join(tokenDir, 'token.json') : '';
  if (tokenDir) mkdirSync(tokenDir, { recursive: true });

  const sandbox = sandboxArgs({ ...env, KSAI_TOKEN_DIR: tokenDir, KSAI_TOKEN_FILE: tokenFile });
  const probe = spawnSync('bwrap', [...sandbox, 'opencode', '--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    const said = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || String(probe.error?.message ?? 'no output');
    console.log(
      `::error::opencode cannot start inside the sandbox on runner ${env.RUNNER_NAME ?? 'unknown'}, so no run was attempted: ${said}`,
    );
    return 1;
  }
  console.log(`sandboxed opencode ${String(probe.stdout ?? '').trim()}`);

  const out = openSync(events, 'w');
  let code = 0;
  let ticking = null;
  try {
    if (tokenFile) {
      await broker(tokenFile, env);
      ticking = setInterval(() => void broker(tokenFile, env), BROKER_PERIOD_MS);
      ticking.unref?.();
    }
    const ran = spawn('bwrap', [...sandbox, 'opencode', ...runArgs(env)], {
      stdio: [openSync(String(env.PROMPT_FILE ?? ''), 'r'), out, 'inherit'],
    });
    code = await new Promise((ended) => {
      ran.on('error', () => ended(127));
      ran.on('close', (status, signal) => ended(exitedOn(status, signal)));
    });
  } finally {
    if (ticking) clearInterval(ticking);
    closeSync(out);
  }
  const reason = stopReason(code);
  console.log(`opencode exit=${code}`);
  if (code > 128) {
    console.log(
      `::error::${reason}; a run killed from outside is usually the runner out of memory, and nothing it wrote is a finished answer`,
    );
  }

  const reduced = spawnSync(process.execPath, [join(String(env.SCRIPTS ?? ''), 'kreview/opencode-log.mjs')], {
    env: { ...env, OPENCODE_EXIT: String(code), OPENCODE_EVENTS_FILE: events, OPENCODE_EXECUTION_FILE: execution },
    stdio: 'inherit',
  });
  if (reduced.status !== 0) {
    console.log('::error::the opencode event stream could not be reduced to an execution log, so this run reports nothing it spent');
    return 1;
  }
  writeOutputs(env.GITHUB_OUTPUT, {
    conclusion: conclusionOf(execution),
  });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
