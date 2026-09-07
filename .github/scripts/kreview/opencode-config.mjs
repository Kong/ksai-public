import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import modelCatalog from '../lib/model-catalog.json' with { type: 'json' };
import { counted } from '../lib/text.cjs';
import { AUTH_MODES, originProblem } from './federated-token.mjs';
import {
  CHANNEL_PLUGIN,
  agentEntry,
  headerLines,
  mergedDenials,
  opencodePermissions,
  phaseDenials,
  phasePermissions,
  providerBaseUrl,
  runtimeConfig,
  underWorkspace,
} from '../lib/opencode.mjs';

const destination = process.env.OPENCODE_CONFIG;
if (!destination) {
  console.log('::error::OPENCODE_CONFIG names no path, so the review would run on a config it discovered itself');
  process.exit(1);
}

const baseUrl = providerBaseUrl(process.env.ANTHROPIC_BASE_URL);
if (!baseUrl) {
  console.log(
    `::error::anthropic_base_url ${originProblem(process.env.ANTHROPIC_BASE_URL)} - this engine's model calls go to it, and empty takes the review off Kong AI Gateway rather than falling back to Anthropic`,
  );
  process.exit(1);
}

const auth = String(process.env.ANTHROPIC_AUTH ?? '').trim();
if (!AUTH_MODES.includes(auth)) {
  console.log(`::error::anthropic_auth must be one of ${AUTH_MODES.join(', ')}, got: ${auth || '(empty)'}`);
  process.exit(1);
}

const attribution = headerLines(process.env.ATTRIBUTION_HEADERS);
if (!Object.keys(attribution).length) {
  console.log('::warning::this review carries no cost-attribution headers, so the gateway attributes its spend to nothing');
}

const pluginRoot = underWorkspace(process.env.KREVIEW_PLUGIN_ROOT);
const model = String(process.env.OPENCODE_MODEL ?? '').trim() || modelCatalog.aliases[modelCatalog.defaultAlias];
const allowed = String(process.env.ALLOWED_MODELS ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

const phase = String(process.env.OPENCODE_PHASE ?? '').trim();
const stated = String(process.env.OPENCODE_ALLOWED ?? '').trim();
const policy = { allowed: stated, disallowed: process.env.OPENCODE_DISALLOWED };
for (const { name, key, granted } of stated ? mergedDenials(policy) : phaseDenials(phase)) {
  console.log(
    `::warning::${name} is denied and ${granted.join(' and ')} granted, and opencode gates them all behind one ${key} key - so the denial is dropped and ${name} is reachable here where the Claude engine refuses it`,
  );
}
const permission = stated ? opencodePermissions(policy) : phasePermissions(phase);
if (!permission) {
  console.log(
    `::error::opencode_phase ${phase || '(empty)'} names no entry in the shared tool table, so this run has no tool policy - a phase resolving to a default would run a write flow read-only, or hand a reviewer the tools to change the tree it is reviewing`,
  );
  process.exit(1);
}

const skills = String(process.env.OPENCODE_SKILLS ?? '')
  .split('\n')
  .map((one) => underWorkspace(one))
  .filter(Boolean);

/**
 * agentsUnder answers the kreview agents beside a plugin root, as opencode subagent entries.
 *
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function agentsUnder(root) {
  /** @type {Record<string, unknown>} */
  const agents = {};
  if (!root) return agents;
  let entries = [];
  try {
    entries = readdirSync(join(root, 'agents')).filter((one) => one.endsWith('.md'));
  } catch (error) {
    console.log(`::warning::no kreview agents at ${root}/agents (${error.message}); this review delegates to none`);
    return agents;
  }
  for (const file of entries.sort()) {
    const parsed = agentEntry(readFileSync(join(root, 'agents', file), 'utf8'), { model, allowed, permission });
    if (!parsed) {
      console.log(`::warning::${file} names no agent, so it was skipped`);
      continue;
    }
    // `kreview:<name>` is the `subagent_type` the shared prompt names first. Registering it under
    // that key is what makes the audit step resolve here rather than fall back to a general agent.
    agents[`kreview:${parsed.name}`] = parsed.entry;
  }
  return agents;
}

/**
 * missing answers a line about something absent, as a warning only where it was meant to be there.
 *
 * The channel and the agent mandates belong to a flow the reviewer and the implement action drive.
 * A caller naming its own tool list is `claude-run`, which registers no channel and points at no
 * plugin root by design, so warning it about both published two annotations per run that named
 * nothing to fix - one of them telling a `fixer` about "the audit this review must run". A warning
 * that fires where nothing is wrong is read as noise everywhere else too, which costs the one that
 * is real.
 *
 * @param {string} said
 * @returns {string}
 */
const missing = (said) => (stated ? said : `::warning::${said}`);

const agents = agentsUnder(pluginRoot);
const channel = String(process.env.KSAI_CHANNEL_NONCE ?? '').trim() === '' ? '' : CHANNEL_PLUGIN;
const config = runtimeConfig({ channel, agents, skills, permission, baseUrl, auth, attribution });

writeFileSync(destination, JSON.stringify(config, null, 2) + '\n');

console.log(`opencode runtime config written to ${destination}`);
console.log(`model calls go to ${baseUrl}, authenticated by ${auth}`);
console.log(
  `this run works under the ${stated ? 'tool list its caller named' : `${phase} tool policy`}${skills.length ? `, with skills from ${skills.join(', ')}` : ' and no skills'}`,
);
console.log(
  channel
    ? 'the run channel is registered, so this run can be told something and asked to stop'
    : missing('this run drew no channel token, so nothing can be delivered to it and a stop cannot be honoured'),
);
console.log(config.plugin ? `the renewing auth plugin is ${config.plugin[0]}` : '::warning::no auth plugin, so this run lasts one token');
console.log(
  Object.keys(agents).length
    ? `delegating to ${counted(Object.keys(agents).length, 'subagent')}: ${Object.entries(agents)
        .map(([name, one]) => `${name}=${/** @type {{model?: string}} */ (one).model ?? 'arm'}`)
        .join(', ')}`
    : pluginRoot
      ? '::warning::no kreview agent mandates, so the audit a review must run has nowhere to go'
      : 'no plugin root, so this run delegates to no subagent',
);
