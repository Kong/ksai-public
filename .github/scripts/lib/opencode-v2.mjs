import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import claudeArgs from './claude-args.cjs';
import { killedBySignal, resultRecord, stopReason } from './execution-log.mjs';
import {
  MASKED_HOMES,
  PROVIDER_POLICY,
  classify,
  detailed,
  elapsed,
  mergedDenials,
  programOf,
  sandboxScopes,
  scrub,
  totals,
} from './opencode.mjs';

export const OPENCODE_V2_VERSION = '2.0.21';

export const majorOf = (version) => {
  const major = /^([0-9]{1,4})\./.exec(String(version ?? '').trim())?.[1];
  return major === undefined ? 0 : Number(major);
};

export const isV2 = (version) => majorOf(version) === 2;

const ESCAPE = '\u001B';
const STYLE = /\[[0-9;]*m/g;
const REPORTED = /^(?:opencode v)?([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})$/;

export function reportedVersion(output) {
  const said = String(output ?? '').split(ESCAPE).join('').replace(STYLE, '').trim();
  return REPORTED.exec(said)?.[1] ?? '';
}

export function validateV2Version(version) {
  const actual = String(version ?? '').trim();
  if (actual !== OPENCODE_V2_VERSION) {
    throw new Error(`opencode ${actual || '(unknown)'} is not the OpenCode ${OPENCODE_V2_VERSION} this runtime was verified against`);
  }
  return actual;
}

export const V2_MASKED_HOMES = Object.freeze([...MASKED_HOMES, '.agents']);

export const v2SandboxScopes = (env, exists, real) => sandboxScopes(env, exists, real, V2_MASKED_HOMES);

const OPENCODE_TOOL = Object.assign(Object.create(null), {
  Bash: 'shell',
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'subagent',
  Agent: 'subagent',
  Skill: 'skill',
  Write: 'edit',
  Edit: 'edit',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
});

export const ALWAYS_DENIED = Object.freeze(['question', 'opencode', 'mcp-resource', 'execute']);

const TOOL_PERMISSION_V2 = Object.freeze(Object.assign(Object.create(null), {
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  read: 'read',
  shell: 'shell',
  skill: 'skill',
  write: 'edit',
}));

export const GOVERNED_TOOLS_V2 = Object.freeze(Object.keys(TOOL_PERMISSION_V2));

export function storeEnv(env) {
  const home = String(env.OPENCODE_HOME ?? '').trim();
  const { OPENCODE_CONFIG: _unused, ...rest } = env;
  return {
    ...rest,
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  };
}

export function governedToolsV2(policy) {
  const rules = permissionRules(policy);
  return GOVERNED_TOOLS_V2.filter((name) => {
    const action = TOOL_PERMISSION_V2[name];
    return action === 'shell' ? rules.some((one) => one.action === 'shell' && one.effect === 'allow') : evaluate(rules, action, '*') === 'allow';
  });
}

export const REMOVED_PLUGINS = Object.freeze([
  'opencode.browser',
  'opencode.plan',
  'opencode.warming',
  'opencode.config.compatibility',
  'opencode.config.instruction',
  'opencode.tool.question',
  'opencode.tool.webfetch',
  'opencode.tool.websearch',
  'opencode.tools',
  'opencode.tools.mcp-resources',
  'opencode.websearch.exa',
  'opencode.websearch.firecrawl',
  'opencode.websearch.parallel',
  'opencode.websearch.tavily',
  'opencode.websearch.tinyfish',
]);

const SANDBOX_TMPDIR = '/tmp';

export const rule = (action, resource, effect) => Object.freeze({ action, resource, effect });

export function opencodeDataDir(home) {
  const root = String(home ?? '').trim();
  return root ? join(root, 'opencode') : '';
}

export function externalDirectoryRules(scopes = [], dataDir = '') {
  const rules = [rule('external_directory', '*', 'deny')];
  for (const one of [SANDBOX_TMPDIR, ...scopes]) {
    const at = String(one ?? '').trim().replace(/\/+$/, '');
    if (at) rules.push(rule('external_directory', `${at}/*`, 'allow'));
  }
  if (dataDir) {
    rules.push(
      rule('external_directory', join(dataDir, 'tool-output', '*'), 'allow'),
      rule('external_directory', join(dataDir, 'shell', '*', '*'), 'allow'),
    );
  }
  return rules;
}

const classified = (list) => classify(list, OPENCODE_TOOL);

export function shellRules(policy) {
  const allow = classified(policy?.allowed);
  const deny = classified(policy?.disallowed);
  return [
    rule('shell', '*', 'deny'),
    ...allow.bash.map((pattern) => rule('shell', pattern, 'allow')),
    ...deny.bash.map((pattern) => rule('shell', pattern, 'deny')),
  ];
}

export function permissionRules(policy, scopes = [], dataDir = '') {
  const allow = classified(policy?.allowed);
  const deny = classified(policy?.disallowed);
  const dropped = new Set(mergedDenials(policy).map(({ name }) => name));
  const granted = [...new Set(allow.tools.map(([, key]) => key))];
  const denied = [...new Set(deny.tools.filter(([name]) => !dropped.has(name)).map(([, key]) => key))];
  return [
    rule('*', '*', 'deny'),
    ...granted.map((key) => rule(key, '*', 'allow')),
    ...denied.map((key) => rule(key, '*', 'deny')),
    ...externalDirectoryRules(scopes, dataDir),
    ...shellRules(policy),
    ...ALWAYS_DENIED.map((key) => rule(key, '*', 'deny')),
  ];
}

export function phasePermissionRules(phase, scopes = [], dataDir = '') {
  const policy = claudeArgs.toolPolicy(phase);
  return policy ? permissionRules(policy, scopes, dataDir) : null;
}

const compiled = new Map();

const wildcard = (pattern) => {
  const key = String(pattern);
  if (compiled.has(key)) return compiled.get(key);
  let escaped = key
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  const made = new RegExp(`^${escaped}$`, 's');
  compiled.set(key, made);
  return made;
};

export function evaluate(rules, action, resource) {
  const found = rules.findLast((one) => wildcard(one.action).test(String(action)) && wildcard(one.resource).test(String(resource)));
  return found?.effect ?? 'ask';
}

const V2_RUNTIME_CONFIG = Object.freeze({
  $schema: 'https://opencode.ai/config.json',
  update: 'disable',
  formatter: false,
  snapshots: false,
  share: 'disabled',
  warming: false,
  experimental: Object.freeze({ subagent_depth: 1 }),
});

export const V2_PROVIDER_POLICY_CONFIG = Object.freeze({
  $schema: 'https://opencode.ai/config.json',
  experimental: Object.freeze({ policies: PROVIDER_POLICY }),
});

export const PROVIDER_BASE_URL = '{env:KSAI_PROVIDER_RELAY}/v1';

export const KSAI_PLUGIN = fileURLToPath(new URL('../kreview/opencode-v2-plugins/ksai/index.mjs', import.meta.url));

export const SHELL_TIMEOUT_MS = 120_000;

const pluginDirectory = (file) => String(file).replace(/\/index\.mjs$/, '');

export const pluginEntry = (one) => {
  const [file, options] = Array.isArray(one) ? one : [one, undefined];
  return options === undefined ? { package: pluginDirectory(file) } : { package: pluginDirectory(file), options };
};

export function v2RuntimeConfig({
  plugins = [],
  shell = '',
  agents = {},
  skills = [],
  permissions = null,
  attribution = {},
  titleModel = '',
  defaultAgent = '',
  compacting = true,
} = {}) {
  return {
    ...V2_RUNTIME_CONFIG,
    compaction: { auto: compacting },
    ...(shell ? { shell } : {}),
    permissions: permissions ?? permissionRules(claudeArgs.TOOL_POLICY.review),
    ...(defaultAgent ? { default_agent: defaultAgent } : {}),
    providers: {
      anthropic: {
        settings: { apiKey: 'unused-the-provider-relay-answers-every-request', baseURL: PROVIDER_BASE_URL },
        headers: { ...attribution },
      },
    },
    plugins: [...plugins.filter(Boolean).map((one) => pluginEntry(one)), ...REMOVED_PLUGINS.map((id) => `-${id}`)],
    ...(skills.length ? { skills: [...skills] } : {}),
    agents: {
      ...(titleModel ? { title: { model: `anthropic/${titleModel}` } } : {}),
      ...agents,
    },
  };
}

function keptOnly(base, kept) {
  const granted = [
    ...new Set(
      base
        .filter((one) => one.effect === 'allow' && one.resource === '*' && !['*', 'external_directory', 'shell'].includes(one.action))
        .map((one) => one.action),
    ),
  ];
  return [
    ...base,
    ...granted.filter((action) => !kept.has(action)).map((action) => rule(action, '*', 'deny')),
    ...(kept.has('shell') ? [] : [rule('shell', '*', 'deny')]),
  ];
}

export function governedRules(base, tools) {
  return [...keptOnly(base, new Set(tools.map((name) => TOOL_PERMISSION_V2[name]).filter(Boolean))), rule('subagent', '*', 'deny')];
}

export const SESSION_EVENT = 'ksai.session';

export const sessionOf = (event) => (typeof event?.data?.sessionID === 'string' ? event.data.sessionID : '');

export const isNativeStream = (events) =>
  Array.isArray(events) && events.some((event) => typeof event?.type === 'string' && (event.type.startsWith('session.') || event.type === SESSION_EVENT));

export function rootSessions(events) {
  const roots = new Set();
  const children = new Set();
  for (const one of events) {
    if (one?.type !== SESSION_EVENT) continue;
    const id = sessionOf(one);
    if (!id) continue;
    if (typeof one.data.parentID === 'string' && one.data.parentID) children.add(id);
    else roots.add(id);
  }
  if (roots.size === 0) {
    const first = events.map((one) => sessionOf(one)).find(Boolean);
    if (first) roots.add(first);
  }
  return { roots, children };
}

export const CLAUDE_NAME = Object.assign(Object.create(null), {
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  subagent: 'Task',
  skill: 'Skill',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
});

export const INPUT_KEY = Object.assign(Object.create(null), {
  Read: [['path', 'file_path']],
  Write: [['path', 'file_path']],
  Edit: [['path', 'file_path']],
  Glob: [
    ['pattern', 'pattern'],
    ['path', 'pattern'],
  ],
  Grep: [['pattern', 'pattern']],
  Task: [['description', 'description']],
  Skill: [['name', 'skill']],
  WebFetch: [['url', 'url']],
  WebSearch: [['query', 'query']],
});

const callKey = (event) => `${sessionOf(event)}\u0000${event?.data?.id ?? ''}`;

const millis = (value) => {
  const at = Number(value);
  return Number.isFinite(at) ? at : Number.NaN;
};

export const openCallOf = (call) => ({ message_id: call.message_id, tool: call.tool, input: call.input, started: call.started, called: call.called });

export function toolCalls(events, open = new Map()) {
  const calls = new Map();
  const touch = (event) => {
    const key = callKey(event);
    if (!calls.has(key)) {
      calls.set(key, {
        session_id: sessionOf(event),
        message_id: String(event.data.assistantMessageID ?? ''),
        id: String(event.data.id ?? ''),
        tool: '',
        input: {},
        status: 'pending',
        started: millis(event.created),
        called: Number.NaN,
        ended: Number.NaN,
        content: [],
        metadata: {},
        error: null,
        ...open.get(key),
      });
    }
    return calls.get(key);
  };
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data.id !== 'string') continue;
    if (event.type === 'session.tool.input.started') {
      const call = touch(event);
      if (typeof data.name === 'string') call.tool = data.name;
    } else if (event.type === 'session.tool.called') {
      const call = touch(event);
      call.called = millis(event.created);
      if (data.input && typeof data.input === 'object') call.input = data.input;
    } else if (event.type === 'session.tool.success') {
      const call = touch(event);
      call.status = 'completed';
      call.ended = millis(event.created);
      call.content = Array.isArray(data.content) ? data.content : [];
      call.metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    } else if (event.type === 'session.tool.failed') {
      const call = touch(event);
      call.status = 'error';
      call.ended = millis(event.created);
      call.error = data.error && typeof data.error === 'object' ? data.error : { type: 'unknown', message: String(data.error ?? '') };
      call.metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    }
  }
  return [...calls.values()].filter((call) => call.tool !== '');
}

function spoken(events) {
  const { roots } = rootSessions(events);
  const messages = new Map();
  for (const one of events) {
    if (one?.type !== 'session.text.ended' || typeof one.data?.text !== 'string') continue;
    if (!roots.has(sessionOf(one))) continue;
    const id = String(one.data.assistantMessageID ?? '');
    if (!messages.has(id)) messages.set(id, new Map());
    messages.get(id).set(Number(one.data.ordinal ?? 0), one.data.text);
  }
  return [...messages.values()].map((texts) =>
    [...texts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join(''),
  );
}

export function answer(events) {
  const said = spoken(events).filter((one) => one !== '');
  return said.length ? said.at(-1) : null;
}

export function everything(events) {
  const said = spoken(events).filter((one) => one !== '');
  return said.length ? said.join('\n') : null;
}

const SPENDING = new Set(['session.step.ended', 'session.step.failed', 'session.compaction.ended', 'session.compaction.failed']);

export function spending(events) {
  const out = [];
  for (const one of events) {
    if (!SPENDING.has(one?.type)) continue;
    const { tokens, cost } = one.data ?? {};
    if (tokens === undefined && cost === undefined) continue;
    out.push({ tokens: tokens ?? {}, cost: typeof cost === 'number' ? cost : 0, step: one.type.startsWith('session.step.') });
  }
  return out;
}

export function refused(call) {
  return call?.status === 'error' && String(call.error?.type ?? '').startsWith('permission.');
}

export function denials(events) {
  const out = [];
  for (const call of toolCalls(events)) {
    if (!refused(call)) continue;
    const { command_digest: _digest, ...detail } = detailed(CLAUDE_NAME[call.tool] ?? call.tool, call.input, INPUT_KEY);
    const asked = programOf(call.input?.command);
    out.push({ tool_name: call.tool, tool_input: asked === '' ? detail : { program: asked, ...detail } });
  }
  return out;
}

const MAX_FAILURE_CHARS = 300;

const FAILURES = new Set(['session.execution.failed', 'session.step.failed', 'ksai.error']);

export function endedOn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const one = events[index];
    if (!FAILURES.has(one?.type)) continue;
    const error = one.data?.error ?? {};
    const said = String(error.message ?? '').replace(/\s+/g, ' ').trim();
    const status = Number(error.status);
    const named = String(error.type ?? '').replace(/\s+/g, ' ').trim() || 'error';
    const detail = said ? `${named}: ${said}` : named;
    const shown = Number.isFinite(status) && status > 0 ? `${detail} (${status})` : detail;
    return shown.slice(0, MAX_FAILURE_CHARS);
  }
  return null;
}

export const retries = (events) => events.filter((one) => one?.type === 'session.retry.scheduled').length;

export function executionLog({ events, exitCode, secrets = [], said }) {
  const spent = spending(events);
  const { usage, cost } = totals(spent);
  const text = said === undefined ? answer(events) : said;
  const code = Number(exitCode);
  const failed = code !== 0;
  return resultRecord({
    text: text === null ? (failed ? null : '') : scrub(text, secrets),
    usage,
    cost,
    turns: spent.filter((one) => one.step).length,
    durationMs: elapsed(events, (one) => millis(one?.created)),
    denials: denials(events),
    truncated: killedBySignal(code),
    failed,
    reason: [stopReason(code), endedOn(events)].filter(Boolean).join(' - '),
  });
}
