import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listed,
  providerPolicyDirectory,
  sandboxScopes,
} from './opencode.mjs';
import { V2_MASKED_HOMES } from './opencode-v2.mjs';
import { attributionSummary } from './opencode-runtime.mjs';
import { npmCachePayload, pinnedToolRoot, TOOL_INJECTION_ENV } from './opencode-tool-sandbox.mjs';

export { listed };

/**
 * DENIED_CREDENTIALS names what a tool call may not read, and it is a declaration rather than a copy.
 *
 * The fact is declared here and specified in `opencode-wiring.test.mjs`, which names what each one
 * costs. Restating them inside the loop that consumes them would not do: a name dropped from an
 * unchecked list is a credential silently handed back to a write phase's shell.
 *
 * The trusted host keeps the Anthropic bearer outside the OpenCode sandbox.
 */
export const DENIED_CREDENTIALS = Object.freeze([
  // The OTLP auth header, which is a write credential for the fleet's telemetry
  'OTEL_EXPORTER_OTLP_HEADERS',
  // The request pair this action's own steps mint the gateway bearer from
  'KSAI_OIDC_REQUEST_URL',
  'KSAI_OIDC_REQUEST_TOKEN',
]);

/**
 * DENIED_MINTS names the runner credentials that mint an identity for **any** audience.
 *
 * That is escalation rather than spend, which is why these are unset whatever the subprocess scrub
 * says. Bwrap refuses nothing that this runtime does not declare.
 */
export const DENIED_MINTS = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
]);

const UNSET = [...DENIED_CREDENTIALS, ...DENIED_MINTS, ...TOOL_INJECTION_ENV, 'OPENCODE_CONFIG_CONTENT'];

const EXPORTER_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';

const SCRUBBED = ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const BROKERED = ['KSAI_MODEL_TOKEN', 'KSAI_MODEL_TOKEN_EXPIRES_AT'];

export const PROCESS_SAMPLE_MS = 5_000;

const READ_ONLY_ON_TEST = ['.git', '.ksai'];

const HISTORY_KEPT_ON = Object.freeze(['test', 'run']);

const RESOLVER = '/etc/resolv.conf';

const MASKED_RUNTIME = '/run';

export function processTable(run = spawnSync) {
  let result;
  try {
    result = run('ps', ['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='], { encoding: 'utf8' });
  } catch {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const output = String(result.stdout ?? '').trim();
  if (!output) return null;
  const rows = output.split('\n').map((line) => {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== 3 || !tokens.every((value) => /^[0-9]+$/.test(value))) return null;
    const values = tokens.map(Number);
    if (!values.every((value) => Number.isSafeInteger(value))) return null;
    const [pid, ppid, rss_kb] = values;
    return pid > 0 && ppid >= 0 && rss_kb >= 0 ? { pid, ppid, rss_kb } : null;
  });
  return rows.some((row) => row === null) ? null : rows;
}

export function processTree(rows, rootPid) {
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!pids.has(row.pid) && pids.has(row.ppid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

export function monitorProcess(rootPid, table = processTable, everyMs = PROCESS_SAMPLE_MS) {
  const seen = new Set();
  let peakRssKb = 0;
  let complete = true;
  const sample = () => {
    const rows = table();
    if (!Array.isArray(rows) || rows.length === 0) {
      complete = false;
      return null;
    }
    const tree = processTree(rows, rootPid);
    for (const row of tree) seen.add(row.pid);
    peakRssKb = Math.max(peakRssKb, tree.reduce((sum, row) => sum + row.rss_kb, 0));
    return rows;
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    const rows = sample();
    if (!complete || !seen.has(rootPid)) return { peak_rss_kb: null, lingering_processes: null };
    const alive = new Set(rows.map((row) => row.pid));
    return {
      peak_rss_kb: peakRssKb,
      lingering_processes: [...seen].filter((pid) => pid !== rootPid && alive.has(pid)).length,
    };
  };
}

export function runtimeSummary(invocations, mcpServers = null) {
  const complete = (field, rows = invocations) => rows.length > 0 && rows.every(
    (metric) => Number.isFinite(metric[field]) && metric[field] >= 0,
  );
  const sum = (field, rows = invocations) => complete(field, rows)
    ? rows.reduce((total, metric) => total + metric[field], 0)
    : null;
  const withMcp = invocations.filter((metric) => Number(metric.mcp_connects) > 0);
  const withTool = invocations.filter((metric) => Number(metric.tool_calls) > 0);
  const failed = invocations.filter((metric) => metric.exit_code !== 0).length;
  const compactionAvailable = invocations.length > 0 && invocations.every(
    (metric) => Number.isInteger(metric.compaction_count) && metric.compaction_count >= 0,
  );
  return {
    mode: 'one-shot',
    span_source: 'unauthenticated-loopback',
    compaction_source: 'unauthenticated-sandbox-sidecar',
    event_source: 'unauthenticated-json-stream',
    mcp_servers: mcpServers,
    invocation_count: invocations.length,
    ...(invocations.some((one) => one.attribution !== undefined) ? { attribution: attributionSummary(invocations) } : {}),
    failed_invocations: failed,
    failure_rate: invocations.length ? failed / invocations.length : null,
    total_ms: sum('total_ms'),
    startup_ms: sum('startup_ms'),
    model_ms: sum('model_ms'),
    mcp_connect_ms: sum('mcp_connect_ms', withMcp),
    first_mcp_ms: complete('first_mcp_ms', withMcp)
      ? sum('first_mcp_ms', withMcp) / withMcp.length
      : null,
    first_tool_ms: complete('tool_calls') && complete('first_tool_ms', withTool)
      ? sum('first_tool_ms', withTool) / withTool.length
      : null,
    model_calls: sum('model_calls'),
    side_calls: sum('side_calls'),
    side_ms: sum('side_ms'),
    mcp_connects: sum('mcp_connects'),
    tool_calls: sum('tool_calls'),
    compaction_count: compactionAvailable ? sum('compaction_count') : null,
    compacted_invocations: compactionAvailable
      ? invocations.filter((metric) => metric.compaction_count > 0).length
      : null,
    compaction_unavailable_invocations: invocations.filter(
      (metric) => !Number.isInteger(metric.compaction_count) || metric.compaction_count < 0,
    ).length,
    invocations,
    peak_rss_kb: complete('peak_rss_kb') ? Math.max(...invocations.map((metric) => metric.peak_rss_kb)) : null,
    lingering_processes: sum('lingering_processes'),
  };
}

export function scopeBinds(env = process.env, exists = existsSync, real = realpathSync) {
  const scopes = sandboxScopes(env, exists, real, V2_MASKED_HOMES);
  for (const at of scopes.missing) {
    console.log(
      `::warning::the sandbox scope ${at} is not on this runner, so nothing is bound there and no tool may reach it`,
    );
  }
  for (const at of scopes.masked) {
    console.log(
      `::warning::the sandbox scope ${at} names a masked credential store, so it is refused rather than bound back`,
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

export function since(file, offset) {
  const fd = openSync(file, 'r');
  try {
    const held = Buffer.alloc(Math.max(0, fstatSync(fd).size - offset));
    readSync(fd, held, 0, held.length, offset);
    return held.toString('utf8');
  } finally {
    closeSync(fd);
  }
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
  sockets = join(String(env.RUNNER_TEMP ?? ''), 'ksai-relays'),
) {
  const home = String(env.HOME ?? '');
  const workspace = String(env.GITHUB_WORKSPACE ?? '');
  const temp = String(env.RUNNER_TEMP ?? '');
  const opencodeHome = String(env.OPENCODE_HOME ?? '');
  const providerPolicyDir = providerPolicyDirectory(opencodeHome);
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
  if (temp) {
    args.push('--tmpfs', temp);
    const tools = join(temp, 'ksai-opencode', 'bin');
    if (exists(tools)) args.push('--ro-bind', tools, tools);
    const pinned = pinnedToolRoot(env);
    if (pinned && exists(pinned)) args.push('--ro-bind', pinned, pinned);
    const governed = String(env.KSAI_GOVERNED_DIR ?? '');
    if (governed && exists(governed)) args.push('--ro-bind', governed, governed);
  }

  const linkDir = String(env.KSAI_LINK_DIR ?? '');
  if (linkDir && exists(linkDir)) args.push('--bind', linkDir, linkDir);
  for (const name of V2_MASKED_HOMES) {
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
  args.push(
    '--ro-bind',
    config,
    config,
    '--ro-bind',
    scripts,
    scripts,
    '--bind',
    opencodeHome,
    opencodeHome,
    '--ro-bind',
    providerPolicyDir,
    providerPolicyDir,
  );

  const channel = String(env.KSAI_CHANNEL_DIR ?? '');
  if (channel && exists(channel)) {
    args.push('--ro-bind', channel, channel, '--bind', join(channel, 'run'), join(channel, 'run'));
  }

  if (HISTORY_KEPT_ON.includes(String(env.FLOW ?? ''))) {
    for (const name of READ_ONLY_ON_TEST) {
      const at = join(workspace, name);
      if (exists(at)) args.push('--ro-bind', at, at);
    }
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
  const relay = String(env.KSAI_OTEL_RELAY ?? '').trim();
  if (relay) args.push('--setenv', EXPORTER_ENDPOINT, relay);
  args.push('--ro-bind', sockets, sockets);
  for (const [name, file] of [['KSAI_PROVIDER_SOCKET', 'provider.sock'], ['KSAI_OTEL_SOCKET', 'otel.sock'], ['KSAI_LINK_SOCKET', 'link.sock'], ['KSAI_GUARD_SOCKET', 'guard.sock']]) {
    if (exists(join(sockets, file))) args.push('--setenv', name, join(sockets, file));
  }
  const npmCache = npmCachePayload(env);
  if (npmCache && exists(npmCache)) args.push('--ro-bind', npmCache, npmCache);
  const denied = listed(env.SANDBOX_DENY_ENV);
  if (relay && denied.includes(EXPORTER_ENDPOINT)) {
    console.log(
      `::warning::this caller denies ${EXPORTER_ENDPOINT} to the sandbox, which is the relay's own address, so this run exports no trace and no log line`,
    );
  }
  const exporter = relay ? [] : [EXPORTER_ENDPOINT];
  for (const name of new Set([...UNSET, ...exporter, ...SCRUBBED, ...BROKERED, ...denied])) {
    args.push('--unsetenv', name);
  }
  args.push(
    '--setenv',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    '1',
    '--setenv',
    'OPENCODE_DISABLE_MODELS_FETCH',
    '1',
    '--setenv',
    'OPENCODE_CONFIG_DIR',
    providerPolicyDirectory(opencodeHome),
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--new-session',
    '--die-with-parent',
    '--chdir',
    workspace,
    '--',
    '/bin/bash',
    fileURLToPath(new URL('./opencode-proc.sh', import.meta.url)),
  );
  return args;
}
