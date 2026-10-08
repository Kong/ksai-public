import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import modelCatalog from '../lib/model-catalog.cjs';

import {
  PROVIDER_POLICY_GITIGNORE,
  headerLines,
  isolatedToolPhase,
  mergedDenials,
  phaseDenials,
  providerPolicyFile,
  underWorkspace,
} from '../lib/opencode.mjs';
import {
  KSAI_PLUGIN,
  SHELL_TIMEOUT_MS,
  V2_PROVIDER_POLICY_CONFIG,
  governedRules,
  opencodeDataDir,
  permissionRules,
  phasePermissionRules,
  rule,
  v2RuntimeConfig,
  v2SandboxScopes,
  validateV2Version,
} from '../lib/opencode-v2.mjs';
import { LINK_TOOLS } from '../governance/release.mjs';
import { REPLYING_PHASES } from '../ksai/reply-limit.cjs';
import { annotation } from '../lib/text.cjs';
import { AUTH_MODES, originProblem } from './federated-token.mjs';

const TOOL_SHELL = fileURLToPath(new URL('./opencode-tool-shell.mjs', import.meta.url));

export function v2Config(env, { exists = existsSync, real = realpathSync, read = readFileSync } = {}) {
  const notes = [];
  const refuse = (error) => ({ error, notes });
  if (!env.OPENCODE_CONFIG) return refuse('OPENCODE_CONFIG names no path, so the review would run on a config it discovered itself');
  try {
    validateV2Version(env.OPENCODE_VERSION);
  } catch (error) {
    return refuse(error.message);
  }
  const home = String(env.OPENCODE_HOME ?? '').trim();
  if (!home) return refuse('OPENCODE_HOME names no path for the trusted provider policy');
  const origin = originProblem(env.ANTHROPIC_BASE_URL);
  if (origin) {
    return refuse(`anthropic_base_url ${origin} - the provider relay forwards every model call to it, and empty takes the review off Kong AI Gateway rather than falling back to Anthropic`);
  }
  const auth = String(env.ANTHROPIC_AUTH ?? '').trim();
  if (!AUTH_MODES.includes(auth)) return refuse(`anthropic_auth must be one of ${AUTH_MODES.join(', ')}, got: ${auth || '(empty)'}`);

  const model = String(env.OPENCODE_MODEL ?? '').trim();
  if (!model) return refuse('OPENCODE_MODEL names no model, and an OpenCode 2 run configures only the model it was dispatched with');

  if (String(env.OPENCODE_LSP_TOOL ?? '').trim() === 'native') return refuse('lsp_tool: native has no OpenCode 2 equivalent: OpenCode 2 runs no language servers');
  const phase = String(env.OPENCODE_PHASE ?? '').trim();
  const resultTransport = String(env.REVIEW_RESULT_TRANSPORT ?? '').trim() || 'text';
  if (resultTransport !== 'text') return refuse(`an OpenCode 2 run is governed and answers in text, and this one asked for the ${resultTransport} result transport`);
  const governing = String(env.GOVERNANCE_OPTIONS_FILE ?? '').trim();
  const linked = String(env.KSAI_LINK_DIR ?? '').trim();
  let governance;
  let served;
  if (linked) {
    const steps = Number(env.KSAI_GOVERNED_STEPS ?? 0);
    governance = {
      from: join(linked, 'governance.json'),
      tools: String(env.KSAI_GOVERNED_TOOLS ?? '').split(',').map((one) => one.trim()).filter(Boolean),
      ...(Number.isInteger(steps) && steps > 0 ? { steps } : {}),
    };
    served = join(linked, 'model.json');
  } else if (governing) {
    try {
      governance = JSON.parse(read(governing, 'utf8'));
    } catch (error) {
      return refuse(`the governance options at ${governing} cannot be read: ${error.message}`);
    }
    const listed = servedModel(env, model, read);
    if (listed.error) return refuse(listed.error);
    served = listed.model;
  } else {
    return refuse('an OpenCode 2 run is governed, and this one names neither a link nor the governance options it is held to');
  }
  const governedTools = governance.tools ?? [];

  const stated = String(env.OPENCODE_ALLOWED ?? '').trim();
  const policy = { allowed: stated, disallowed: env.OPENCODE_DISALLOWED };
  for (const { name, key, granted } of stated ? mergedDenials(policy) : phaseDenials(phase)) {
    notes.push(annotation(`${name} is denied and ${granted.join(' and ')} granted, and OpenCode gates them all behind one ${key} permission - so the denial is dropped and ${name} is reachable here where the shared policy refuses it`, 'warning'));
  }
  const scopes = v2SandboxScopes(env, exists, real);
  const reachable = [...scopes.allow, ...scopes.deny];
  const dataDir = opencodeDataDir(home);
  const base = stated ? permissionRules(policy, reachable, dataDir) : phasePermissionRules(phase, reachable, dataDir);
  if (!base) {
    return refuse(`opencode_phase ${phase || '(empty)'} names no entry in the shared tool table, so this run has no tool policy - a phase resolving to a default would run a write flow read-only, or hand a reviewer the tools to change the tree it is reviewing`);
  }
  const permissions = [...governedRules(base, governedTools), ...(linked ? LINK_TOOLS.map((name) => rule(name, '*', 'allow')) : [])];

  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  const isolated = isolatedToolPhase(phase);
  const plugins = [[KSAI_PLUGIN, {
    governance: linked ? { from: governance.from } : governance,
    model: served,
    shell: linked ? join(linked, 'shell.json') : { timeout_ms: SHELL_TIMEOUT_MS },
    ...(linked ? { content: join(linked, 'content.json') } : {}),
    policy: { models: [model], workspace, strip_instructions: true },
    ...(isolated ? { guard: true, children: { permissions } } : {}),
    ...(REPLYING_PHASES.includes(phase) ? { replies: true } : {}),
  }]];
  const skills = governedTools.includes('skill')
    ? String(env.OPENCODE_SKILLS ?? '')
      .split('\n')
      .map((one) => underWorkspace(one, env))
      .filter(Boolean)
    : [];
  const config = v2RuntimeConfig({
    plugins,
    shell: isolated ? TOOL_SHELL : '',
    agents: governance.steps === undefined ? {} : { build: { steps: governance.steps } },
    skills,
    permissions,
    attribution: headerLines(env.ATTRIBUTION_HEADERS),
    titleModel: model,
    defaultAgent: '',
    compacting: false,
  });
  notes.push(`this run is governed: it sends the model only the prompt ${linked ? governance.from : governing} names, with its governed tools`);
  if (!Object.keys(config.providers.anthropic.headers).length) {
    notes.push('::warning::this review carries no cost-attribution headers, so the gateway attributes its spend to nothing');
  }
  for (const at of scopes.masked) notes.push(annotation(`the sandbox scope ${at} names a masked credential store, so it is refused rather than bound back`, 'warning'));
  notes.push(
    `opencode ${env.OPENCODE_VERSION} runtime config written to ${env.OPENCODE_CONFIG}`,
    `model calls go through the provider relay to ${String(env.ANTHROPIC_BASE_URL).trim()}, authenticated by ${auth}`,
    `this run works under the ${stated ? 'tool list its caller named' : `${phase} tool policy`}${skills.length ? `, with skills from ${skills.join(', ')}` : ' and no skills'}`,
  );
  return { config, policy: V2_PROVIDER_POLICY_CONFIG, policyFile: providerPolicyFile(home), notes };
}

export function servedModel(env, model, read = readFileSync) {
  const at = String(env.KSAI_MODEL_CATALOG ?? '').trim();
  if (!at) return { error: `the control plane served no model catalog, so ${model} has no limits for OpenCode 2 to run it under` };
  let catalog;
  try {
    catalog = JSON.parse(read(at, 'utf8'));
  } catch (error) {
    return { error: `the served model catalog at ${at} cannot be read: ${error.message}` };
  }
  const entry = Array.isArray(catalog?.models) ? catalog.models.find((one) => one?.id === model) : undefined;
  if (entry?.runnable !== true) return { error: `the control plane runs no model ${model}` };
  if (!Number.isInteger(entry.limit?.context) || !Number.isInteger(entry.limit?.output)) return { error: `the control plane knows no limit for model ${model}` };
  const optional = (value) => value === undefined || modelCatalog.rate(value) !== null;
  if (modelCatalog.rate(entry.input) === null || modelCatalog.rate(entry.output) === null || !optional(entry.cache_read) || !optional(entry.cache_write)) {
    return { error: `the control plane serves no price for model ${model}, so its spend could not be counted` };
  }
  return {
    model: {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      limit: { context: entry.limit.context, output: entry.limit.output },
      cost: { input: entry.input, output: entry.output, cache_read: entry.cache_read ?? 0, cache_write: entry.cache_write ?? 0 },
      image: entry.image === true,
      variants: Array.isArray(entry.variants) ? entry.variants : [],
    },
  };
}

export function main(env = process.env, deps = {}) {
  const written = v2Config(env, deps);
  for (const line of written.notes) console.log(line);
  if (written.error) {
    console.log(annotation(written.error));
    return 1;
  }
  mkdirSync(dirname(written.policyFile), { recursive: true });
  writeFileSync(written.policyFile, `${JSON.stringify(written.policy, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dirname(written.policyFile), '.gitignore'), PROVIDER_POLICY_GITIGNORE, { mode: 0o600 });
  writeFileSync(String(env.OPENCODE_CONFIG), `${JSON.stringify(written.config, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
