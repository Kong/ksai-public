import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOVERNANCE_PLUGIN } from '../governance/config.mjs';
import { renderThroughControlPlane } from '../lib/cp-prompts.mjs';
import { pluginEntry } from '../lib/opencode.mjs';
import { GOVERNANCE_PLUGIN as GOVERNANCE_PLUGIN_V2, isV2, pluginEntry as pluginEntryV2 } from '../lib/opencode-v2.mjs';
import { SINKS, renderRequest } from '../lib/render-request.cjs';
import { reviewTools } from './governed-flow.mjs';
import { optionsOf, rootOf } from './governed-review.mjs';

export function stageRequest({ stage, context, model, mandate }) {
  const timing = { research_seconds: stage?.research_seconds, step_target: stage?.step_target };
  const envelope = { sink: SINKS.review, model };
  if (stage?.kind === 'discovery') {
    const scope = stage.scope ?? null;
    return renderRequest({
      ...envelope,
      promptId: 'runtime.review-discovery',
      inputs: [
        { name: 'context', value: context },
        {
          name: 'stage',
          value: { changed_files_path: scope?.changedFilesPath ?? '', diff_path: scope?.diffPath ?? '', focus: stage.focus, has_scope: scope !== null, scope_id: scope?.id ?? '', ...timing },
        },
      ],
    });
  }
  if (stage?.kind === 'audit') {
    return renderRequest({
      ...envelope,
      promptId: 'runtime.review-findings-audit',
      inputs: [
        { name: 'context', value: context },
        { name: 'stage', value: timing },
        { name: 'auditor_mandate', value: mandate },
        { name: 'candidates', value: stage.candidates },
        { name: 'prior', value: stage.prior },
      ],
    });
  }
  throw new Error(`a review stage of kind ${String(stage?.kind)} has no governed prompt`);
}

function governStage(env, options) {
  const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8'));
  const v2 = isV2(env.OPENCODE_VERSION);
  const key = v2 ? 'plugins' : 'plugin';
  const entry = v2 ? pluginEntryV2([GOVERNANCE_PLUGIN_V2, options]) : pluginEntry([GOVERNANCE_PLUGIN, options]);
  const sourceOf = (one) => (typeof one === 'string' ? one : Array.isArray(one) ? one[0] : one?.package);
  const governs = (one) => sourceOf(one) === sourceOf(entry);
  const governed = (config[key] ?? []).filter((one) => governs(one));
  if (governed.length !== 1) throw new Error(`the opencode config loads the governance plugin ${governed.length} times`);
  config[key] = config[key].map((one) => (governs(one) ? entry : one));
  writeFileSync(env.OPENCODE_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

export function governedStages(env, context, deps = {}) {
  const root = rootOf(env);
  const plan = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8'));
  let sequence = 0;
  return async ({ name, stage }) => {
    sequence += 1;
    const request = stageRequest({ stage, context, model: plan.model, mandate: plan.mandate });
    const rendered = await renderThroughControlPlane({ request, dir: join(root, 'stages', `${sequence}-${name}`), tools: reviewTools(env), steps: stage.step_target, env, ...deps });
    governStage(env, optionsOf(env, root, rendered, 0, deps.pinned));
    return { dir: rendered.dir, prompt: readFileSync(rendered.prompt, 'utf8'), sha256: rendered.expect.finalDigest.slice('sha256:'.length) };
  };
}
