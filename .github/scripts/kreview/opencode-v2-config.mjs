import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROVIDER_POLICY_GITIGNORE,
  headerLines,
  isolatedToolPhase,
  mergedDenials,
  providerPolicyFile,
  underWorkspace,
} from './opencode.mjs';
import {
  V2_PROVIDER_POLICY_CONFIG,
  governedRules,
  opencodeDataDir,
  permissionRules,
  rule,
  v2RuntimeConfig,
  v2SandboxScopes,
  validateV2Version,
} from './opencode-v2.mjs';
import { LINK_TOOLS } from '../governance/release.mjs';
import { annotation } from '../lib/text.cjs';
import { originProblem } from './gateway-token.mjs';
import { GOVERNED_FILE, PLUGIN_DIR, PLUGIN_ENTRY } from './link-governed.mjs';
import {
  TOOL_DENIED_ENV,
  TOOL_INJECTION_ENV,
  TOOL_WRAPPER_ENV,
  callerDeniedEnvironment,
  toolPathRoots,
  toolProtectedPaths,
} from './opencode-tool-sandbox.mjs';

const TOOL_SHELL = fileURLToPath(new URL('./opencode-tool-shell.mjs', import.meta.url));

const REPLYING_PHASES = Object.freeze(['fix', 'revise']);

export function governedSessionOf(env) {
  const plugin = String(env.KSAI_GOVERNED_PLUGIN ?? '').trim();
  const root = String(env.KSAI_GOVERNED_DIR ?? '').trim();
  const at = dirname(dirname(plugin));
  const laid = isAbsolute(plugin) && isAbsolute(root) && normalize(plugin) === plugin && basename(plugin) === PLUGIN_ENTRY &&
    basename(dirname(plugin)) === PLUGIN_DIR && dirname(at) === join(root, 'link');
  return laid ? at : '';
}

export function guardOptions(env, workspace) {
  return {
    keep: [...TOOL_WRAPPER_ENV],
    blank: [...new Set([...TOOL_DENIED_ENV, ...TOOL_INJECTION_ENV, ...callerDeniedEnvironment(env)])],
    roots: toolPathRoots(env, workspace),
    protected: toolProtectedPaths(env),
  };
}

export function v2Config(env, { exists = existsSync, real = realpathSync } = {}) {
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
  const model = String(env.OPENCODE_MODEL ?? '').trim();
  if (!model) return refuse('OPENCODE_MODEL names no model, and an OpenCode 2 run configures only the model it was dispatched with');

  const phase = String(env.OPENCODE_PHASE ?? '').trim();
  const linked = String(env.KSAI_LINK_DIR ?? '').trim();
  if (!linked) return refuse('the control plane supplied no linked OpenCode session');
  const session = governedSessionOf(env);
  if (!session) return refuse('the governed OpenCode plugin is named nowhere this host lays the plugin the control plane supplies');
  const plugin = String(env.KSAI_GOVERNED_PLUGIN).trim();
  const steps = Number(env.KSAI_GOVERNED_STEPS ?? 0);
  const governance = {
    from: join(session, GOVERNED_FILE),
    tools: String(env.KSAI_GOVERNED_TOOLS ?? '').split(',').map((one) => one.trim()).filter(Boolean),
    ...(Number.isInteger(steps) && steps > 0 ? { steps } : {}),
  };
  const governedTools = governance.tools ?? [];

  const stated = String(env.OPENCODE_ALLOWED ?? '').trim();
  if (!stated) return refuse('the control plane supplied no allowed tool policy');
  const policy = { allowed: stated, disallowed: env.OPENCODE_DISALLOWED };
  for (const { name, key, granted } of mergedDenials(policy)) {
    notes.push(annotation(`${name} is denied and ${granted.join(' and ')} granted, and OpenCode gates them all behind one ${key} permission - so the denial is dropped and ${name} is reachable here where the shared policy refuses it`, 'warning'));
  }
  const scopes = v2SandboxScopes(env, exists, real);
  const reachable = [...scopes.allow, ...scopes.deny];
  const dataDir = opencodeDataDir(home);
  const base = permissionRules(policy, reachable, dataDir);
  const permissions = [...governedRules(base, governedTools), ...LINK_TOOLS.map((name) => rule(name, '*', 'allow'))];

  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  const isolated = isolatedToolPhase(phase);
  const trustedSkills = String(env.OPENCODE_SKILLS ?? '')
    .split('\n')
    .map((one) => underWorkspace(one, env))
    .filter(Boolean);
  const plugins = [[plugin, {
    governance: { from: governance.from },
    model: join(session, 'model.json'),
    shell: join(session, 'shell.json'),
    content: join(session, 'content.json'),
    policy: { models: [model], workspace, strip_instructions: true },
    ...(isolated ? { guard: guardOptions(env, workspace), children: { permissions, launcher: TOOL_SHELL, skills: trustedSkills } } : {}),
    ...(REPLYING_PHASES.includes(phase) ? { replies: true } : {}),
  }]];
  const skills = governedTools.includes('skill') ? trustedSkills : [];
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
  notes.push(`this run is governed: it sends the model only the prompt ${governance.from} names, with its governed tools`);
  if (!Object.keys(config.providers.anthropic.headers).length) {
    notes.push('::warning::this review carries no cost-attribution headers, so the gateway attributes its spend to nothing');
  }
  for (const at of scopes.masked) notes.push(annotation(`the sandbox scope ${at} names a masked credential store, so it is refused rather than bound back`, 'warning'));
  notes.push(
    `opencode ${env.OPENCODE_VERSION} runtime config written to ${env.OPENCODE_CONFIG}`,
    `model calls go through the provider relay to ${String(env.ANTHROPIC_BASE_URL).trim()}, authenticated by GitHub OIDC`,
    `this run works under the tool list its caller named${skills.length ? `, with skills from ${skills.join(', ')}` : ' and no skills'}`,
  );
  return { config, policy: V2_PROVIDER_POLICY_CONFIG, policyFile: providerPolicyFile(home), notes };
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
