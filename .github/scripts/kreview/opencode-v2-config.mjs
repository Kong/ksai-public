import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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
  CHANNEL_PLUGIN,
  CHILD_TOOLS_PLUGIN,
  GOVERNANCE_PLUGIN,
  GUARD_PLUGIN,
  POLICY_PLUGIN,
  PTY_PLUGIN,
  REVIEW_RESULT_PLUGIN,
  V2_PROVIDER_POLICY_CONFIG,
  governedRules,
  opencodeDataDir,
  permissionRules,
  phasePermissionRules,
  phaseShellRules,
  rule,
  runsOnV2,
  servedModels,
  shellRules,
  v2AgentEntry,
  v2RuntimeConfig,
  v2SandboxScopes,
  validateV2Version,
} from '../lib/opencode-v2.mjs';
import { AUTH_MODES, originProblem } from './federated-token.mjs';
import { LIMITS } from './review-pipeline.cjs';
import { ptyPilotEnabled } from './opencode-pty-core.mjs';

const TOOL_SHELL = fileURLToPath(new URL('./opencode-tool-shell.mjs', import.meta.url));

const PROMPTS = Object.freeze({
  stage: {
    tool: 'Complete the current independent review stage. Submit its result through submit_review_result, correcting and calling again while attempts remain if it refuses. Once accepted, end the turn without repeating it. Do not delegate.',
    text: 'Complete the current independent review stage using its JSON contract. A request for a summary, including a maximum-step reminder, must be answered in that JSON shape. Once the step-limit reminder arrives, stop using tools and return the best supported JSON immediately. Do not delegate.',
  },
  finish: {
    tool: 'Use the evidence already collected in this session. Call submit_review_result, correcting and calling again while attempts remain if it refuses, then end the turn once it accepts. Every other tool is denied. Missing evidence remains uncertain. Do not claim to have executed a reproduction.',
    text: 'Use the evidence already collected in this session. Return exactly the current stage JSON contract, without further investigation or tool calls. Missing evidence remains uncertain. Do not claim to have executed a reproduction.',
  },
  submit: 'Complete the review under the supplied contract. Submit the final result through submit_review_result, correcting and calling again while attempts remain if it refuses, then end the turn once it accepts, without repeating it.',
});

const FINALIZE_BODY = Object.freeze({
  thinking: { type: 'enabled', budget_tokens: LIMITS.finalizeThinkingTokens },
  output_config: { effort: 'low' },
});

function agentsUnder(root, options, notes, read = readFileSync, list = readdirSync) {
  const agents = {};
  if (!root) return agents;
  let entries = [];
  try {
    entries = list(join(root, 'agents')).filter((one) => one.endsWith('.md'));
  } catch (error) {
    notes.push(`::warning::no kreview agents at ${root}/agents (${error.message}); this review delegates to none`);
    return agents;
  }
  for (const file of entries.sort()) {
    const parsed = v2AgentEntry(read(join(root, 'agents', file), 'utf8'), options);
    if (!parsed) {
      notes.push(`::warning::${file} names no agent, so it was skipped`);
      continue;
    }
    agents[`kreview:${parsed.name}`] = parsed.entry;
  }
  return agents;
}

export function v2Config(env, { exists = existsSync, real = realpathSync, read = readFileSync, list = readdirSync, catalog = modelCatalog } = {}) {
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

  const model = String(env.OPENCODE_MODEL ?? '').trim() || catalog.aliases[catalog.defaultAlias];
  if (!runsOnV2(model, catalog)) {
    return refuse(`the control plane serves no OpenCode 2 options for ${model}, so a v5 run cannot configure it; add them to the model in the control plane's catalog`);
  }
  const models = servedModels(catalog);
  const allowed = String(env.ALLOWED_MODELS ?? '').split(/[\s,]+/).filter(Boolean);

  if (String(env.OPENCODE_LSP_TOOL ?? '').trim() === 'native') return refuse('lsp_tool: native has no OpenCode 2 equivalent: OpenCode 2 runs no language servers');
  const phase = String(env.OPENCODE_PHASE ?? '').trim();
  const resultTransport = String(env.REVIEW_RESULT_TRANSPORT ?? '').trim() || (phase === 'review' ? 'tool' : 'text');
  if (resultTransport === 'structured') return refuse('result_transport: structured has no OpenCode 2 equivalent; use tool');
  if (!['text', 'tool'].includes(resultTransport) || (resultTransport !== 'text' && phase !== 'review')) {
    return refuse(`review result transport ${resultTransport || '(empty)'} is not valid for ${phase || '(empty)'}`);
  }
  const staged = phase === 'review' && ['evidence', 'dual'].includes(env.REVIEW_STRATEGY);
  const governing = String(env.GOVERNANCE_OPTIONS_FILE ?? '').trim();
  let governance = null;
  if (governing) {
    if (resultTransport !== 'text') return refuse(`a governed run answers in text, and this one asked for ${resultTransport}`);
    try {
      governance = JSON.parse(read(governing, 'utf8'));
    } catch (error) {
      return refuse(`the governance options at ${governing} cannot be read: ${error.message}`);
    }
  }
  const governedTools = governance?.tools ?? [];

  const stated = String(env.OPENCODE_ALLOWED ?? '').trim();
  const policy = { allowed: stated, disallowed: env.OPENCODE_DISALLOWED };
  for (const { name, key, granted } of stated ? mergedDenials(policy) : phaseDenials(phase)) {
    notes.push(`::warning::${name} is denied and ${granted.join(' and ')} granted, and OpenCode gates them all behind one ${key} permission - so the denial is dropped and ${name} is reachable here where the shared policy refuses it`);
  }
  const scopes = v2SandboxScopes(env, exists, real);
  const reachable = [...scopes.allow, ...scopes.deny];
  const dataDir = opencodeDataDir(home);
  const base = stated ? permissionRules(policy, reachable, dataDir) : phasePermissionRules(phase, reachable, dataDir);
  if (!base) {
    return refuse(`opencode_phase ${phase || '(empty)'} names no entry in the shared tool table, so this run has no tool policy - a phase resolving to a default would run a write flow read-only, or hand a reviewer the tools to change the tree it is reviewing`);
  }
  const pty = ptyPilotEnabled(env) && !governance;
  const permissions = governance
    ? governedRules(base, governedTools)
    : pty
      ? [...base, ...['pty_spawn', 'pty_write', 'pty_read', 'pty_list', 'pty_kill'].map((name) => rule(name, '*', 'allow'))]
      : base;

  const workspace = String(env.GITHUB_WORKSPACE ?? '').trim();
  const agents = governance
    ? (governance.steps === undefined ? {} : { build: { steps: governance.steps } })
    : {
        ...agentsUnder(underWorkspace(env.KREVIEW_PLUGIN_ROOT, env), { model, allowed, permissions }, notes, read, list),
        'general-purpose': {
          mode: 'subagent',
          description: 'General-purpose agent for researching complex questions and executing multi-step tasks, named the way the shared prompts and skills name it',
          permissions: [...permissions, rule('question', '*', 'deny'), rule('subagent', '*', 'deny')],
        },
      };
  const submitting = resultTransport === 'tool' ? [rule('submit_review_result', '*', 'allow')] : [];
  if (staged && !governance) {
    agents['ksai-review-stage'] = {
      mode: 'primary',
      description: 'Bounded independent review stage',
      steps: LIMITS.stageSteps,
      permissions: [...permissions, rule('subagent', '*', 'deny'), ...submitting],
      system: PROMPTS.stage[resultTransport],
    };
    agents['ksai-review-finish'] = {
      mode: 'primary',
      description: 'Return the stage result from collected evidence',
      permissions: [rule('*', '*', 'deny'), ...submitting],
      request: { body: FINALIZE_BODY },
      system: PROMPTS.finish[resultTransport],
    };
  } else if (phase === 'review' && resultTransport === 'tool') {
    agents['ksai-review-submit'] = { mode: 'primary', description: 'Review and submit the final result', permissions: [...permissions, ...submitting], system: PROMPTS.submit };
  }
  const defaultAgent = staged && !governance ? 'ksai-review-stage' : phase === 'review' && resultTransport === 'tool' ? 'ksai-review-submit' : '';

  const isolated = isolatedToolPhase(phase);
  const shell = stated ? shellRules(policy) : phaseShellRules(phase);
  const plugins = [
    [
      POLICY_PLUGIN,
      {
        models: Object.keys(models),
        output_limits: Object.fromEntries(Object.entries(models).filter(([, one]) => Number.isInteger(one.limit?.output)).map(([id, one]) => [id, one.limit.output])),
        deadline_ms: Number(env.KSAI_CHANNEL_KILL_AT) || 0,
        workspace,
        strip_instructions: phase === 'review' || governance !== null,
      },
    ],
    ...(String(env.KSAI_CHANNEL_NONCE ?? '').trim() ? [CHANNEL_PLUGIN] : []),
    ...(isolated ? [GUARD_PLUGIN, [CHILD_TOOLS_PLUGIN, { permissions }]] : []),
    ...(pty ? [[PTY_PLUGIN, { shell, permissions }]] : []),
    ...(resultTransport === 'tool' ? [REVIEW_RESULT_PLUGIN] : []),
    ...(governance ? [[GOVERNANCE_PLUGIN, governance]] : []),
  ];
  const skills = governance && !governedTools.includes('skill')
    ? []
    : String(env.OPENCODE_SKILLS ?? '')
      .split('\n')
      .map((one) => underWorkspace(one, env))
      .filter(Boolean);
  const config = v2RuntimeConfig({
    plugins,
    shell: isolated ? TOOL_SHELL : '',
    agents,
    skills,
    permissions,
    attribution: headerLines(env.ATTRIBUTION_HEADERS),
    titleModel: model,
    defaultAgent,
    models,
    compacting: !governance,
  });
  if (governance) {
    notes.push(`this run is governed: it sends the model only the prompt ${governing} names, with its governed tools`);
  }
  if (!Object.keys(config.providers.anthropic.headers).length) {
    notes.push('::warning::this review carries no cost-attribution headers, so the gateway attributes its spend to nothing');
  }
  for (const at of scopes.masked) notes.push(`::warning::the sandbox scope ${at} names a masked credential store, so it is refused rather than bound back`);
  notes.push(
    `opencode ${env.OPENCODE_VERSION} runtime config written to ${env.OPENCODE_CONFIG}`,
    `model calls go through the provider relay to ${String(env.ANTHROPIC_BASE_URL).trim()}, authenticated by ${auth}`,
    `this run works under the ${stated ? 'tool list its caller named' : `${phase} tool policy`}${skills.length ? `, with skills from ${skills.join(', ')}` : ' and no skills'}`,
    `review results use the ${resultTransport} transport`,
    pty ? `the audited PTY pilot is enabled for ${phase}` : `the PTY pilot is not loaded for ${phase || '(empty)'}`,
  );
  return { config, policy: V2_PROVIDER_POLICY_CONFIG, policyFile: providerPolicyFile(home), notes };
}

export function main(env = process.env, deps = {}) {
  const written = v2Config(env, deps);
  for (const line of written.notes) console.log(line);
  if (written.error) {
    console.log(`::error::${written.error}`);
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
