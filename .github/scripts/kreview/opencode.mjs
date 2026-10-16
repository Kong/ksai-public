import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_SECRET_VARS, collectSecrets, scrub } from './secrets.cjs';

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

/** pointsAt answers where a path really leads, or the path itself where nothing is there to follow. */
function pointsAt(at, real) {
  try {
    return String(real(at));
  } catch {
    return at;
  }
}

/**
 * MASKED_HOMES names the credential stores the sandbox replaces with an empty tmpfs.
 *
 * It lives here, beside the scope resolver that has to refuse them, because it lived beside the
 * masks alone and nothing tied the two lists together: a caller-supplied write scope was bound
 * *after* the masks, last match wins, and `~` reopened every store the masks exist to hide.
 */
export const MASKED_HOMES = Object.freeze(['.config', '.claude', '.opencode']);

/** maskedHomes answers the absolute credential stores this run masks, for the home it runs under. */
export function maskedHomes(env, homes = MASKED_HOMES) {
  const home = String(env.HOME ?? '').trim();
  return home ? homes.map((name) => join(home, name)) : [];
}

/**
 * sandboxScopes answers the paths a caller named, resolved the way both the sandbox and the tool policy read them.
 *
 * `exists` is required rather than defaulted: a scope the runner does not hold is bound by neither
 * side, and a default answering yes would grant what no mount backs.
 *
 * `real` is required for the reason `exists` is: a default that did not follow a link would make
 * the refusal below lexical again, silently, for any caller that forgot to pass one.
 *
 * `real` is what makes the refusal of a masked home more than lexical. `resolve` and `expandHome`
 * normalise text and nothing else, so a symlink planted on the runner and named by the caller reads
 * as an ordinary path here - while bwrap resolves a bind source on the host, mounting the store's
 * contents at the alias. Both the name and what it points at are checked, and a path that resolves
 * to nothing keeps its lexical form, since the missing-scope filter below is what drops it.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(at: string) => boolean} exists
 * @param {(at: string) => string} real
 * @returns {{allow: string[], deny: string[], missing: string[], masked: string[]}}
 */
export function sandboxScopes(env, exists, real, homes = MASKED_HOMES) {
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim() || '/';
  const staged = [
    String(env.RUNNER_TEMP ?? ''),
    String(env.OPENCODE_HOME ?? ''),
    String(env.KSAI_CHANNEL_DIR ?? ''),
    join(workspace, '_ksai'),
  ]
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => resolve(workspace, expandHome(one, env)));
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const masked = [];
  /*
   * The stores are followed too, or a resolved scope is compared against an unresolved root and
   * matches nothing - `/var` is itself a link to `/private/var` on macOS, and a runner's home can
   * sit behind one just as easily. `pointsAt` answers the lexical path where nothing resolves, so
   * this covers a store that is not on the runner without naming that case twice.
   */
  const hidden = maskedHomes(env, homes).map((one) => pointsAt(one, real));
  const scoped = (value) =>
    listed(value)
      .map((one) => resolve(workspace, expandHome(one, env)))
      .filter((at) => !staged.some((root) => within(root, at) || within(at, root)))
      .filter((at) => {
        // A scope over a masked home is refused the way one over the trusted checkout is, and for
        // the same reason: the bind lands after the mask, so granting it hands back the credentials
        const over = (one) => hidden.some((root) => within(root, one) || within(one, root));
        if (!over(at) && !over(pointsAt(at, real))) return true;
        masked.push(at);
        return false;
      })
      .filter((at) => {
        if (exists(at)) return true;
        missing.push(at);
        return false;
      });
  const readable = [env.SANDBOX_DENY_WRITE, env.KSAI_GO_MODULE_CACHE].filter(Boolean).join('\n');
  return { allow: scoped(env.SANDBOX_ALLOW_WRITE), deny: scoped(readable), missing, masked };
}

function bashPatterns(token) {
  const inner = token.slice('Bash('.length, -1);
  if (inner === '') return ['*'];
  return inner.endsWith(':*') ? [inner.slice(0, -2), `${inner.slice(0, -2)} *`] : [inner];
}

export function classify(list, table = OPENCODE_TOOL) {
  const tools = [];
  const bash = [];
  for (const token of String(list ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)) {
    if (token === 'Bash') bash.push('*');
    else if (token.startsWith('Bash(') && token.endsWith(')')) bash.push(...bashPatterns(token));
    else if (table[token]) tools.push([token, table[token]]);
  }
  return { tools, bash };
}

export function mergedDenials(policy) {
  const allow = classify(policy?.allowed);
  const grantedKeys = new Set(allow.tools.map(([, key]) => key));
  const grantedNames = new Set(allow.tools.map(([name]) => name));
  return classify(policy?.disallowed)
    .tools.filter(([name, key]) => grantedKeys.has(key) && !grantedNames.has(name))
    .map(([name, key]) => ({ name, key, granted: allow.tools.filter(([, one]) => one === key).map(([one]) => one) }));
}

export const PROVIDER_TIMEOUTS = Object.freeze({ headerTimeout: 120_000, chunkTimeout: 120_000 });

export const UNCONTINUED = 'this rework found the conversation export its planning session left, which no control plane verified, so the governed run does not continue it and starts from the context the control plane renders. The plan and its export are kept as they are; a conversation the control plane verified is carried instead as a checkpoint it restores';

export const PROVIDER_POLICY = Object.freeze([
  Object.freeze({ effect: 'deny', action: 'provider.use', resource: '*' }),
  Object.freeze({ effect: 'allow', action: 'provider.use', resource: 'anthropic' }),
]);

export const PROVIDER_POLICY_GITIGNORE = 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore';

export function providerPolicyDirectory(home) {
  const root = String(home ?? '').trim();
  if (!root) throw new Error('OPENCODE_HOME names no path for the trusted provider policy');
  return join(root, 'config', 'opencode');
}

export function providerPolicyFile(home) {
  return join(providerPolicyDirectory(home), 'opencode.json');
}

export function underWorkspace(value, env = process.env) {
  const at = String(value ?? '').trim();
  if (at === '' || isAbsolute(at)) return at;
  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  return workspace ? resolve(workspace, at) : at;
}

/**
 * headerLines answers the headers a trusted step computed, read back from the text it wrote them in.
 *
 * The cost-attribution block is a `printf` in the manifest. OpenCode receives the same trusted text,
 * so the gateway attributes one review's spend from one source.
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

export const isolatedToolPhase = (phase) => String(phase ?? '').trim() !== '';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function frontmatterOf(source) {
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

/**
 * detailed answers the OpenCode 2 input that the shared timeline reads.
 *
 * A command becomes a digest because the breaker fingerprints this input to find a repeat. No
 * renderer reads that digest, and the command text reaches no published surface.
 */
export function detailed(name, input, keys) {
  const out = { ...input };
  for (const [from, to] of keys[name] ?? []) {
    if (typeof input?.[from] === 'string' && out[to] === undefined) out[to] = input[from];
  }
  if (typeof out.command === 'string') {
    out.command_digest = createHash('sha256').update(out.command).digest('hex').slice(0, 16);
  }
  delete out.command;
  return out;
}

export function programOf(command) {
  const words = String(command ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'export' || word === 'env') continue;
    return /^[A-Za-z0-9._/-]{1,40}$/.test(word) ? word : '';
  }
  return '';
}

export function elapsed(events, stampOf = (one) => Number(one?.timestamp)) {
  let first = Infinity;
  let last = -Infinity;
  let counted = 0;
  for (const one of events) {
    const stamp = stampOf(one);
    if (!Number.isFinite(stamp)) continue;
    counted += 1;
    first = Math.min(first, stamp);
    last = Math.max(last, stamp);
  }
  return counted < 2 ? 0 : Math.max(0, last - first);
}

export function totals(steps) {
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
