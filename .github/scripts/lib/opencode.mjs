import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import claudeArgs from './claude-args.cjs';
import { resultRecord, stopReason } from './execution-log.mjs';
import modelCatalog from './model-catalog.json' with { type: 'json' };
import selectArm from './select-arm.cjs';
import { originProblem } from '../kreview/federated-token.mjs';
import { authHeaders } from './opencode-token.mjs';
import { DEFAULT_SECRET_VARS, collectSecrets, scrub } from '../kreview/secrets.cjs';

const { MODEL_SHAPE } = selectArm;
export const DEFAULT_OPENCODE_MODEL = modelCatalog.aliases[modelCatalog.defaultAlias];
const providerEntry = (model) => {
  const rate = modelCatalog.rates?.[model];
  if (!rate) return Object.freeze({});
  const cacheRead = Number.isFinite(rate.cacheRead) ? { cache_read: rate.cacheRead } : {};
  const thinking = modelCatalog.opencodeModels?.[model] ?? {};
  return Object.freeze({ cost: Object.freeze({ input: rate.input, output: rate.output, ...cacheRead }), ...thinking });
};

const PROVIDER_MODELS = Object.freeze(
  Object.fromEntries(
    [...new Set([...Object.values(modelCatalog.aliases), ...modelCatalog.knownModels])].map((model) => [
      model,
      providerEntry(model),
    ]),
  ),
);

const OPENCODE_TOOL = Object.assign(Object.create(null), {
  Bash: 'bash',
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'task',
  Agent: 'task',
  Skill: 'skill',
  Write: 'edit',
  Edit: 'edit',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
});

const EXTERNAL_DIRECTORY = 'external_directory';

const SANDBOX_TMPDIR = '/tmp';

/**
 * listed answers the entries of a comma- or newline-separated input, which is how a caller writes a list.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function listed(value) {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((one) => one.trim())
    .filter(Boolean);
}

/**
 * expandHome answers a path with a leading `~` or `$HOME` resolved, which a shell does and a script does not.
 *
 * @param {string | undefined} value
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function expandHome(value, env = process.env) {
  const at = String(value ?? '').trim();
  const home = String(env.HOME ?? '').trim();
  if (!home) return at;
  if (at === '~' || at === '$HOME') return home;
  for (const prefix of ['~/', '$HOME/']) {
    if (at.startsWith(prefix)) return join(home, at.slice(prefix.length));
  }
  return at;
}

const within = (at, root) => at === root || at.startsWith(`${root.replace(/\/+$/, '')}/`);

/**
 * sandboxScopes answers the paths a caller named, resolved the way both the sandbox and the tool policy read them.
 *
 * `exists` is required rather than defaulted: a scope the runner does not hold is bound by neither
 * side, and a default answering yes would grant what no mount backs.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(at: string) => boolean} exists
 * @returns {{allow: string[], deny: string[], missing: string[]}}
 */
export function sandboxScopes(env, exists) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim() || '/';
  const staged = [
    String(env.RUNNER_TEMP ?? ''),
    String(env.OPENCODE_HOME ?? ''),
    String(env.KSAI_TOKEN_DIR ?? ''),
    String(env.KSAI_CHANNEL_DIR ?? ''),
    String(env.KSAI_REVIEW_RESULT_DIR ?? ''),
    join(workspace, '_ksai'),
  ]
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => resolve(workspace, expandHome(one, env)));
  /** @type {string[]} */
  const missing = [];
  const scoped = (value) =>
    listed(value)
      .map((one) => resolve(workspace, expandHome(one, env)))
      .filter((at) => !staged.some((root) => within(root, at) || within(at, root)))
      .filter((at) => {
        if (exists(at)) return true;
        missing.push(at);
        return false;
      });
  return { allow: scoped(env.SANDBOX_ALLOW_WRITE), deny: scoped(env.SANDBOX_DENY_WRITE), missing };
}

/**
 * externalDirectory answers the `external_directory` rules for the scopes a caller named.
 *
 * @param {string[]} [scopes]
 * @returns {Record<string, string>}
 */
export function externalDirectory(scopes = []) {
  /** @type {Record<string, string>} */
  const rules = { '*': 'deny' };
  for (const one of [SANDBOX_TMPDIR, ...scopes]) {
    const at = String(one ?? '').trim().replace(/\/+$/, '');
    if (!at) continue;
    rules[`${at}/*`] = 'allow';
  }
  return rules;
}

function bashPatterns(token) {
  const inner = token.slice('Bash('.length, -1);
  if (inner === '') return ['*'];
  return inner.endsWith(':*') ? [inner.slice(0, -2), `${inner.slice(0, -2)} *`] : [inner];
}

function classify(list) {
  const tools = [];
  const bash = [];
  for (const token of String(list ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)) {
    if (token === 'Bash') bash.push('*');
    else if (token.startsWith('Bash(') && token.endsWith(')')) bash.push(...bashPatterns(token));
    else if (OPENCODE_TOOL[token]) tools.push([token, OPENCODE_TOOL[token]]);
  }
  return { tools, bash };
}

/**
 * opencodePermissions answers the permission map for one phase of `TOOL_POLICY`, so both engines
 * read one table. Everything not named is denied, and a denial is written after the grant that
 * would otherwise cover it because opencode resolves a command by the last rule that matches it.
 */
export function mergedDenials(policy) {
  const allow = classify(policy?.allowed);
  const grantedKeys = new Set(allow.tools.map(([, key]) => key));
  const grantedNames = new Set(allow.tools.map(([name]) => name));
  return classify(policy?.disallowed)
    .tools.filter(([name, key]) => grantedKeys.has(key) && !grantedNames.has(name))
    .map(([name, key]) => ({ name, key, granted: allow.tools.filter(([, one]) => one === key).map(([one]) => one) }));
}

export function opencodePermissions(policy, scopes = []) {
  const allow = classify(policy?.allowed);
  const deny = classify(policy?.disallowed);
  const dropped = new Set(mergedDenials(policy).map(({ name }) => name));
  const permission = { '*': 'deny' };
  for (const [, key] of allow.tools) permission[key] = 'allow';
  for (const [name, key] of deny.tools) {
    if (dropped.has(name)) continue;
    permission[key] = 'deny';
  }
  permission[EXTERNAL_DIRECTORY] = externalDirectory(scopes);
  const bash = { '*': 'deny' };
  for (const pattern of allow.bash) bash[pattern] = 'allow';
  for (const pattern of deny.bash) {
    delete bash[pattern];
    bash[pattern] = 'deny';
  }
  permission.bash = bash;
  return permission;
}

/** RUNTIME_CONFIG is the opencode configuration a review runs under, without the provider its origin decides. */
export const RUNTIME_CONFIG = Object.freeze({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  snapshot: false,
  share: 'disabled',
  compaction: Object.freeze({ auto: true, prune: true }),
  subagent_depth: 1,
  permission: opencodePermissions(claudeArgs.TOOL_POLICY.review),
});

export function phasePermissions(phase, scopes = []) {
  const policy = claudeArgs.toolPolicy(phase);
  return policy ? opencodePermissions(policy, scopes) : null;
}

export function phaseDenials(phase) {
  const policy = claudeArgs.toolPolicy(phase);
  return policy ? mergedDenials(policy) : [];
}

export function underWorkspace(value, env = process.env) {
  const at = String(value ?? '').trim();
  if (at === '' || isAbsolute(at)) return at;
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  return workspace ? resolve(workspace, at) : at;
}

/** BEARER is the placeholder opencode expands from the environment, so no token lands on a file. */
export const BEARER = '{env:ANTHROPIC_FEDERATED_TOKEN}';

/**
 * providerBaseUrl answers where this engine sends a model call, or null for a value that is no origin.
 *
 * **The `/v1` is this function's whole reason to exist.** Claude Code appends the version segment to
 * `ANTHROPIC_BASE_URL` itself; opencode hands its provider option to the AI SDK, which appends only
 * `/messages`. Passing the same origin to both would leave this engine posting to the gateway's root
 * and reporting a reviewer that wrote nothing.
 *
 * Which is also why what may be appended to is `originProblem`'s answer rather than this function's:
 * an origin already ending in `/v1` would be doubled here and appended to by the Claude engine, so
 * one rule refuses it for both.
 *
 * @param {string | undefined} origin
 * @returns {string | null}
 */
export function providerBaseUrl(origin) {
  if (originProblem(origin)) return null;
  return `${String(origin).trim().replace(/\/+$/, '')}/v1`;
}

/**
 * headerLines answers the headers a trusted step computed, read back from the text it wrote them in.
 *
 * The cost-attribution block is a `printf` in the manifest, which is what base-action reads as
 * `ANTHROPIC_CUSTOM_HEADERS` for the Claude engine. This engine is handed the same text rather than
 * a second block of its own, so the gateway attributes one review's spend by one shape whichever
 * reviewer ran it.
 *
 * @param {string | undefined} text
 * @returns {Record<string, string>}
 */
export function headerLines(text) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * AUTH_PLUGIN is the renewing auth plugin, resolved from this module's own location.
 *
 * Derived rather than passed in: this module is read from the staged copy under `RUNNER_TEMP`, so
 * its neighbour is the staged plugin and no caller can name a path the reviewed tree reaches. A
 * plugin is code opencode executes at startup, which makes where it comes from the whole question.
 * Naming it by a specifier is also what puts it in the release closure, so a fix to it ships.
 */
export const AUTH_PLUGIN = fileURLToPath(new URL('../kreview/opencode-auth.mjs', import.meta.url));

export const CHANNEL_PLUGIN = fileURLToPath(new URL('../kreview/opencode-channel.mjs', import.meta.url));

export const REVIEW_RESULT_PLUGIN = fileURLToPath(new URL('../kreview/opencode-review-result.mjs', import.meta.url));

const asFileUrl = (path) => (path.startsWith('file://') ? path : `file://${path}`);

/**
 * runtimeConfig answers that configuration with the origin, the headers and the renewing auth plugin.
 *
 * The static header stays beside the hook: it authenticates a request the hook does not reach, and
 * both are written by `authHeaders`, so the two cannot disagree about how this run authenticates.
 *
 * @returns {Record<string, any>}
 */
export function runtimeConfig({
  plugin = AUTH_PLUGIN,
  plugins = [],
  channel = '',
  agents = {},
  skills = [],
  permission = null,
  baseUrl = '',
  auth = '',
  attribution = {},
} = {}) {
  const loadedPlugins = [plugin, channel, ...plugins].filter(Boolean).map((one) => asFileUrl(one));
  return {
    ...RUNTIME_CONFIG,
    ...(permission ? { permission } : {}),
    provider: {
      anthropic: {
        models: PROVIDER_MODELS,
        options: {
          apiKey: 'unused-the-authorization-header-answers-every-request',
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          headers: { ...attribution, ...authHeaders(BEARER, { ANTHROPIC_AUTH: auth }) },
        },
      },
    },
    ...(loadedPlugins.length ? { plugin: loadedPlugins } : {}),
    ...(skills.length ? { skills: { paths: skills } } : {}),
    ...(Object.keys(agents).length ? { agent: agents } : {}),
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function frontmatterOf(source) {
  const match = FRONTMATTER.exec(String(source ?? ''));
  if (!match) return { fields: Object.create(null), body: String(source ?? '') };
  const fields = Object.create(null);
  let key = null;
  for (const line of match[1].split('\n')) {
    const named = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (named) {
      key = named[1];
      fields[key] = named[2].trim().replace(/^\|$/, '');
      continue;
    }
    if (key && /^\s/.test(line) && line.trim()) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return { fields, body: String(source).slice(match[0].length) };
}

/**
 * agentEntry answers one kreview agent as an opencode subagent, or null when it names no name.
 *
 * The prompt is inlined rather than pointed at: `agent/agent.ts` takes `prompt` straight off the
 * config entry, which avoids depending on how `{file:...}` resolves a path.
 *
 * **The frontmatter's own `model` is honoured, and bounded.** kreview pins its reviewers to
 * `sonnet` while the parent runs on the arm, which is how the Claude engine runs them and most of
 * why it is not slower still. Dropping it put every subagent on the arm's model, and one review
 * spent thirty-four minutes and was cancelled with nothing salvaged.
 *
 * It is bounded rather than trusted: the alias resolves through the same null-prototype table the
 * selector uses, and the result must appear in `allowed`, which is the caller's `allowed_models`.
 * Anything else falls back to the arm, so a plugin file can pick a cheaper model the repository
 * already permits and can pick nothing else. The permission map is the reviewer's own either way,
 * so a subagent reaches nothing its parent cannot.
 *
 * @param {string} source
 * @param {{model?: string, allowed?: string[], permission?: Record<string, unknown>}} [options]
 */
export function agentEntry(source, { model, allowed = [], permission } = {}) {
  const { fields, body } = frontmatterOf(source);
  const name = fields.name?.trim();
  if (!name) return null;
  const chosen = boundedModel(fields.model, allowed) ?? model;
  const narrowedPermission = permission ? narrowed(permission, declaredTools(fields.tools)) : permission;
  return {
    name,
    entry: {
      description: fields.description?.trim() || name,
      mode: 'subagent',
      ...(chosen ? { model: `anthropic/${chosen}` } : {}),
      prompt: body.trim(),
      ...(narrowedPermission ? { permission: narrowedPermission } : {}),
    },
  };
}

/**
 * boundedModel answers the model a plugin file asked for when it is one the repository permits.
 *
 * An empty `allowed` is not an empty allowlist here. `allowed_models` documents its empty value as
 * permitting no *comment* override, and these files are trusted content out of the ksai checkout
 * rather than something a commenter wrote - read the other way, a repository that empties the input
 * puts every kreview subagent on the parent's arm and pays opus prices for the audit. So an empty
 * list falls back to the alias table, which is the same set the selector itself resolves.
 *
 * **The vendor's own spellings are translated here**, because this file's `model:` is read by Claude
 * Code when the other engine runs it: `sonnet` is that tool's vocabulary and not ours to rename.
 * Reading it through the tier table alone left the declared model unresolvable, which put every
 * subagent on the parent's arm - the cost this bound exists to avoid.
 */
export function boundedModel(declared, allowed = []) {
  const asked = String(declared ?? '').trim();
  if (!asked) return null;
  const tier = modelCatalog.vendorTiers?.[asked];
  const named =
    selectArm.ALIASES?.[asked] ??
    (tier ? selectArm.ALIASES?.[tier] : undefined) ??
    selectArm.VENDOR_ALIASES?.[asked];
  const resolved = named ?? (MODEL_SHAPE.test(asked) ? asked : null);
  if (!resolved) return null;
  const permitted = allowed.length ? allowed : Object.values(selectArm.ALIASES ?? {});
  return permitted.includes(resolved) ? resolved : null;
}

export function declaredTools(value) {
  return String(value ?? '').match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
}

export function narrowed(base, declared) {
  if (!declared.length) return base;
  const keep = new Set(declared.map((one) => OPENCODE_TOOL[one]).filter(Boolean));
  const out = { ...base, bash: keep.has('bash') ? base.bash : 'deny' };
  for (const key of Object.keys(out)) {
    if (key === '*' || key === 'bash') continue;
    if (out[key] === 'allow' && !keep.has(key)) out[key] = 'deny';
  }
  return out;
}

export { DEFAULT_SECRET_VARS, collectSecrets, scrub };

/** parsed answers every event a stream carries, skipping a line that is not one rather than failing the run. */
export function parsed(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const one = JSON.parse(trimmed);
      if (one !== null && typeof one === 'object') out.push(one);
    } catch {
      continue;
    }
  }
  return out;
}

export const CLAUDE_NAME = Object.assign(Object.create(null), {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Glob',
  task: 'Task',
  skill: 'Skill',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
});

const INPUT_KEY = Object.assign(Object.create(null), {
  Read: [['filePath', 'file_path']],
  Write: [['filePath', 'file_path']],
  Edit: [['filePath', 'file_path']],
  Glob: [
    ['pattern', 'pattern'],
    ['path', 'pattern'],
  ],
  Grep: [['pattern', 'pattern']],
  Task: [['description', 'description']],
  Skill: [['name', 'skill']],
  WebFetch: [['url', 'url']],
  WebSearch: [['query', 'query']],
  Bash: [['description', 'description']],
});

/**
 * detailed answers the input the shared timeline reads a detail out of.
 *
 * `Bash` carries its `description` and never its `command`, which is the rule
 * `docs/decisions/run-visibility.md` states for the Claude engine and which holds here for the same
 * reason: the command is the string most likely to carry a value that should not be repeated. Where
 * opencode's caller wrote no description the row is the tool name and its elapsed time, which is
 * less than the Claude engine shows and more than nothing.
 *
 * The command is replaced by a digest of itself rather than dropped, because the breaker fingerprints
 * this same input to find a repeat. Dropping it left every `bash` call fingerprinting as `{}`, so nine
 * different commands read as nine identical ones and the repeat breaker killed a healthy run at its
 * twenty-second step. The digest distinguishes them and no renderer reads the key, so the command text
 * still reaches nothing that prints.
 */
export function detailed(name, input) {
  const out = { ...input };
  for (const [from, to] of INPUT_KEY[name] ?? []) {
    if (typeof input?.[from] === 'string' && out[to] === undefined) out[to] = input[from];
  }
  if (typeof out.command === 'string') {
    out.command_digest = createHash('sha256').update(out.command).digest('hex').slice(0, 16);
  }
  delete out.command;
  return out;
}

/**
 * answer answers what opencode wrote at the end of the run, or null when the stream carried no text
 * at all.
 *
 * A part is kept by id and the last state of it wins, because opencode may update a part while the
 * model writes it. Joining every event instead concatenates each snapshot of one part, which reads
 * as a review that repeats itself.
 *
 * **One step's text is the answer, never the whole run's.** The Claude engine's `result` is the
 * model's last message, and this stream carries a text part for every turn that said anything, so
 * joining all of them published a forty-five step fix's running commentary ahead of the summary it
 * was asked for - glued together without a space where two turns met. A caller whose prompt says the
 * final message is posted verbatim got the monologue instead. So the parts are grouped at
 * `step_start` and the last group holding text wins: the last group holding text rather than the
 * last step, because a run whose final step called a tool and said nothing would otherwise answer
 * with the empty string and lose a summary that was written.
 */
export function answer(events) {
  const said = spoken(events);
  return said.length ? said.at(-1) : null;
}

/**
 * everything answers every turn that spoke, joined, which is what `answer` used to return.
 *
 * It exists for one reader: the review flow's structured output is a contract, and a reviewer that
 * wrote its findings and then said one more thing would have that contract land in a turn `answer`
 * no longer returns. Publishing the trailing sentence as the review is the failure this whole change
 * is about, so the caller that knows a review is expected checks both and takes the one carrying it.
 */
export function everything(events) {
  const said = spoken(events);
  return said.length ? said.join('\n') : null;
}

function spoken(events) {
  const groups = [new Map()];
  for (const [index, one] of events.entries()) {
    if (one?.type === 'step_start') {
      groups.push(new Map());
      continue;
    }
    if (one?.type !== 'text' || typeof one?.part?.text !== 'string') continue;
    groups.at(-1).set(one.part.id ?? `#${index}`, one.part.text);
  }
  return groups.filter((one) => one.size).map((one) => [...one.values()].join(''));
}

/** spending answers what each step of the run reported, dropping a step that reported neither figure. */
export function spending(events) {
  const out = [];
  for (const one of events) {
    if (one?.type !== 'step_finish') continue;
    const part = one.part ?? {};
    if (part.tokens === undefined && part.cost === undefined) continue;
    out.push({
      tokens: part.tokens ?? {},
      cost: typeof part.cost === 'number' ? part.cost : 0,
    });
  }
  return out;
}

/*
 * opencode's own wording when a tool call is refused by the permission map. It is matched rather than
 * inferred from the error status, because a `bash` command that merely exits non-zero is an error too
 * and counting those would report a reviewer's failed `grep` as a denied one.
 */
const REFUSED = /prevents you from using this specific tool call/i;

/**
 * denials answers the calls the permission map refused, in the shape the run report counts.
 *
 * It was a hardcoded empty list, so every opencode run reported no denials whatever it had been
 * refused - a constant sitting in a column that reads as a measurement.
 *
 * **A count answers how often and never what**, which is the complaint `run-visibility.md` opens on:
 * a kong-mesh run finished with sixteen denials that "were not diagnosable", and a fixer run this
 * engine drove finished with fourteen `bash` entries that named nothing but `bash`. An operator
 * reading them cannot tell a profile scoped too tightly from a model that kept asking for what it
 * was told not to do. So each entry carries the same detail the timeline is allowed to print,
 * through the same `detailed` - the description and never the command, so what is recorded here is
 * bounded by the rule that already decided what a row may show.
 *
 * The digest that rule keeps for the repeat breaker is dropped here: `deniedCall` takes the first
 * string it finds as the head the run report prints, so a refused call carrying no description would
 * put sixteen hex characters in a column that answers what was asked.
 */
export function denials(events) {
  const out = [];
  for (const one of events) {
    if (one?.type !== 'tool_use') continue;
    const state = one.part?.state ?? {};
    if (state.status !== 'error') continue;
    if (!REFUSED.test(String(state.output ?? state.error ?? ''))) continue;
    const tool = String(one.part?.tool ?? 'unknown');
    const input = state.input && typeof state.input === 'object' ? state.input : {};
    const { command_digest: _digest, ...detail } = detailed(CLAUDE_NAME[tool] ?? tool, input);
    out.push({ tool_name: tool, tool_input: detail });
  }
  return out;
}

/**
 * endedOn answers the failure the stream itself reports, as one line, or null where it reports none.
 *
 * opencode writes its terminal failure as an `error` event and exits 1 without printing it, so the
 * job log said `opencode exit=1` and nothing else. A review that died on a gateway 429 - the token
 * window spent, `isRetryable: true`, nothing retrying - was diagnosable only by downloading the raw
 * stream artifact and reading its last line. One line in the log is what that investigation was
 * worth.
 *
 * The status code is carried because it is what separates the answers: a 429 is a budget, a 401 is
 * the token, a 500 is theirs. Everything here is bounded and flattened - the message is a provider's
 * text, so it is one line of at most `MAX_FAILURE_CHARS` and nothing that could open a row of its own.
 */
export function endedOn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const one = events[index];
    if (one?.type !== 'error') continue;
    const error = one.error ?? {};
    const said = String(error.data?.message ?? error.message ?? '').replace(/\s+/g, ' ').trim();
    const status = Number(error.data?.statusCode);
    const named = String(error.name ?? '').replace(/\s+/g, ' ').trim() || 'error';
    const detail = said ? `${named}: ${said}` : named;
    const shown = Number.isFinite(status) ? `${detail} (${status})` : detail;
    return shown.slice(0, MAX_FAILURE_CHARS);
  }
  return null;
}

const MAX_FAILURE_CHARS = 300;

function elapsed(events) {
  const stamps = events.map((one) => Number(one?.timestamp)).filter((one) => Number.isFinite(one));
  if (stamps.length < 2) return 0;
  return Math.max(0, Math.max(...stamps) - Math.min(...stamps));
}

function totals(steps) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let cost = 0;
  for (const { tokens, cost: spent } of steps) {
    usage.input_tokens += Number(tokens.input) || 0;
    usage.output_tokens += Number(tokens.output) || 0;
    usage.cache_creation_input_tokens += Number(tokens.cache?.write) || 0;
    usage.cache_read_input_tokens += Number(tokens.cache?.read) || 0;
    cost += spent;
  }
  return { usage, cost };
}

/**
 * truncated answers whether a signal ended the run, which the watchdog's SIGTERM does.
 *
 * Whatever such a run wrote is a fragment. Published it reads as a review, because the publisher
 * has no way to tell a partial answer from a short one - the first run stopped this way posted the
 * sentence "I'll start by reading the diff." as its review.
 */
function truncated(exitCode) {
  return Number.isFinite(exitCode) && exitCode > 128;
}


/**
 * executionLog answers the run in the shape `runSpend` reads, so the whole publish path stays
 * one reader whichever engine produced the review. A run a signal ended reports what it spent and
 * no review at all, so the salvage notice speaks instead of the publisher.
 */
export function executionLog({ events, exitCode, secrets = [], said }) {
  const steps = spending(events);
  const { usage, cost } = totals(steps);
  const text = said === undefined ? answer(events) : said;
  const code = Number(exitCode);
  const failed = code !== 0;
  return resultRecord({
    text: text === null ? (failed ? null : '') : scrub(text, secrets),
    usage,
    cost,
    turns: steps.length,
    durationMs: elapsed(events),
    denials: denials(events),
    truncated: truncated(code),
    failed,
    reason: [stopReason(code), endedOn(events)].filter(Boolean).join(' - '),
  });
}
